import { ONBOARDING_PROBE_UNIT, SessionHeartbeat } from '@aisdlc/contracts';
import { callJson } from '@aisdlc/service-kit';
import type { RunningSession } from './controller.js';

// The heartbeat reporter (PLAN M19; DM Heartbeat): while a session runs on this host, the controller tells core it
// is alive, so a busy session that makes no model call for a while (a long test run, a build) is not drawn stuck on
// the floor. The controller is the reporter because it is the one process that knows a session is still running: it
// holds the slot until the driver returns. What it says is content-free (who, which grant, when), and it says it to
// core's `POST /v1/sessions/heartbeat` (scope `activity`, nothing else), which records it first.
//
// A beat is best effort and never touches a session: core unreachable, a refusal or a slow answer is counted and
// logged, and the session runs on. Silence is what the floor reads as stuck, so a reporter that cannot reach core
// fails towards "stuck", never towards "alive".

/** Where a heartbeat goes. */
export interface HeartbeatSink {
  post(hb: SessionHeartbeat): Promise<'recorded' | 'refused' | 'unreachable'>;
}

/** The project of a grant (a heartbeat names it; core checks the item is in it). `null`: none or unreadable. */
export interface GrantProjects {
  projectOf(grantId: string): Promise<string | null>;
}

/** Core's heartbeat route, with this host's `activity` token. */
export class CoreHeartbeats implements HeartbeatSink {
  constructor(
    private readonly o: {
      readonly baseUrl: string;
      readonly token: string;
      readonly timeoutMs?: number;
      readonly fetchImpl?: typeof fetch;
    },
  ) {}

  async post(hb: SessionHeartbeat): Promise<'recorded' | 'refused' | 'unreachable'> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method: 'POST',
      path: '/v1/sessions/heartbeat',
      body: hb,
      timeoutMs: this.o.timeoutMs ?? 5_000,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return 'unreachable';
    if (r.status === 200 || r.status === 201) return 'recorded';
    return r.status >= 500 ? 'unreachable' : 'refused';
  }
}

/** A heartbeat sink that keeps what it was given (tests). */
export class FakeHeartbeatSink implements HeartbeatSink {
  readonly beats: SessionHeartbeat[] = [];
  answer: 'recorded' | 'refused' | 'unreachable' = 'recorded';
  async post(hb: SessionHeartbeat): Promise<'recorded' | 'refused' | 'unreachable'> {
    if (this.answer === 'recorded') this.beats.push(hb);
    return this.answer;
  }
}

/** The Unit key of a grant's Unit id (`<item>:<unit key>` in core's grants), as a heartbeat may carry it. */
export function unitKeyOf(itemId: string, unitId: string): string | null {
  const key = unitId.startsWith(`${itemId}:`) ? unitId.slice(itemId.length + 1) : unitId;
  return SessionHeartbeat.shape.unit_id.safeParse(key).success ? key : null;
}

export interface ReporterStats {
  readonly sent: number;
  readonly refused: number;
  readonly unreachable: number;
  readonly skipped: number;
  readonly last_recorded_at: string | null;
}

export class HeartbeatReporter {
  private readonly projects = new Map<string, string | null>();
  private s = { sent: 0, refused: 0, unreachable: 0, skipped: 0 };
  private lastAt: string | null = null;
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly o: {
      readonly sessions: () => readonly RunningSession[];
      readonly grants: GrantProjects;
      readonly sink: HeartbeatSink;
      readonly now?: () => Date;
      readonly log?: (line: string) => void;
    },
  ) {}

  private now(): Date {
    return (this.o.now ?? (() => new Date()))();
  }

  /** The heartbeat of one running session, or `null` when it names no work item (a probe) or does not fit. */
  async heartbeatOf(s: RunningSession): Promise<SessionHeartbeat | null> {
    if (s.unit_id === ONBOARDING_PROBE_UNIT) return null;
    let project = this.projects.get(s.grant_id);
    if (project === undefined) {
      project = await this.o.grants.projectOf(s.grant_id);
      // an unreadable project is asked again next time; a found one is kept for the session's length
      if (project !== null) this.projects.set(s.grant_id, project);
    }
    if (project === null) return null;
    const hb = SessionHeartbeat.safeParse({
      item_id: s.item_id,
      project_id: project,
      session_id: s.session_id,
      unit_id: unitKeyOf(s.item_id, s.unit_id),
      sandbox_class: s.class,
      at: this.now().toISOString(),
    });
    return hb.success ? hb.data : null;
  }

  /** Beats one session now. Never throws. */
  async beat(s: RunningSession): Promise<void> {
    try {
      const hb = await this.heartbeatOf(s);
      if (hb === null) {
        this.s.skipped += 1;
        return;
      }
      const r = await this.o.sink.post(hb);
      if (r === 'recorded') {
        this.s.sent += 1;
        this.lastAt = hb.at;
      } else {
        this.s[r] += 1;
        this.o.log?.(
          `sandbox-controller: heartbeat ${r} for session ${s.session_id} (the floor reads it as silence)`,
        );
      }
    } catch {
      this.s.unreachable += 1;
    }
  }

  /** Beats every running session, and forgets the projects of grants no longer running. */
  async tick(): Promise<void> {
    const running = this.o.sessions();
    const live = new Set(running.map((r) => r.grant_id));
    for (const g of [...this.projects.keys()]) if (!live.has(g)) this.projects.delete(g);
    await Promise.all(running.map((r) => this.beat(r)));
  }

  start(intervalMs: number): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  stats(): ReporterStats {
    return { ...this.s, last_recorded_at: this.lastAt };
  }
}
