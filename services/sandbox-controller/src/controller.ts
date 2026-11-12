import {
  CODING_CLASSES,
  IMAGE_PINNED_CLASSES,
  SandboxClassValues,
  type SandboxClass,
  type SandboxSlots,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  preflightSpec,
  sandboxError,
  slotsUnder,
  type PreflightOptions,
  type SandboxError,
  type SandboxPort,
  type SandboxRun,
  type SandboxSpec,
} from '@aisdlc/ports';
import type { CapsReader } from './caps.js';
import type { GrantVerifier } from './grants.js';

// The sandbox-controller (PLAN M14.2; ADR-0003 §6 "Placement is owned by the sandbox-controller", §7 caps).
//
// It owns the driver of its runner host and decides nothing about order: core admits (6.0, H2 reads `slots()`),
// records the grant, then asks for a session naming it. For each session, in this order:
//   1. the class ceilings and the spec rules (`preflightSpec`, the same function the driver and the fake run);
//   2. the grant: active, at the item, Unit and lease epoch named (`GrantVerifier`); no grant, no session;
//   3. the two caps of the host, read now (a reload takes effect on the next session): the total across classes
//      and the coding cap (`CODING_CLASSES`). Over either: `busy`, nothing started, nothing queued;
//   4. the driver runs the session to its end; the slot is released in `finally`, whatever the driver did.
// Its state is the running sessions, in memory only: a restart forgets them. Their containers do NOT die with the
// process (the daemon runs them on): the next controller sweeps at boot (M19, `sweep`), and the proxy's owner label
// says which sandboxes are this host's to remove. A session whose controller died is never answered to core: core's
// call fails, the stage command is not answered and is delivered again (same key, same grant and lease epoch).

export interface ControllerDeps {
  readonly driver: SandboxPort;
  readonly caps: CapsReader;
  readonly grants: GrantVerifier;
  readonly hostId: string;
  /** The driver's trusted commands (a class that runs no repo code may run only these). */
  readonly preflight?: PreflightOptions;
  /**
   * M16 (DEC-17 refined): the onboarding probe image approved in config (`onboarding.sandbox_image`, by digest). A
   * K-exec session must name exactly this image; `null` or absent (none approved, or unreadable): no K-exec runs.
   */
  readonly probeImage?: () => string | null;
  /**
   * M16 part 3 (LF4): the W check. `lf4` is `onboarding.light_tests.worker_image` now (`null`: none named or
   * unreadable); `host` is the image id this host's driver runs W sessions on (`null`: not named by digest). A W
   * session starts only when both are named and are the same image; otherwise it is refused `image_unverified` with
   * the reason (the coding port records it on the item). Absent: no check (a test controller only; boot always sets it).
   */
  readonly workerImage?: { readonly lf4: () => string | null; readonly host: string | null };
  readonly now?: () => Date;
  /** M19: told when a session takes its slot (the heartbeat reporter beats it at once). Never awaited, never fails a run. */
  readonly onStart?: (s: RunningSession) => void;
  /**
   * M19 (the runner-killed drill): removes what this host's driver left behind of every session not in `keep` (the
   * `DockerSandboxDriver`'s `sweep`). Absent: nothing to sweep (a fake driver keeps nothing).
   */
  readonly sweep?: (keep: ReadonlySet<string>) => Promise<SweepResult>;
}

/** What a sweep removed (session ids) and what it could not. */
export interface SweepResult {
  readonly containers: readonly string[];
  readonly networks: readonly string[];
  readonly scratch: readonly string[];
  readonly errors: readonly string[];
}

/** The digest of an image reference (`name@sha256:...` or `sha256:...`), or the reference itself. */
export const digestOf = (ref: string): string => ref.slice(ref.lastIndexOf('@') + 1);

/** Why the W image of this host is not LF4's, or `null` when it is (pure; the controller calls it per session). */
export function workerImageWhyNot(lf4: string | null, host: string | null): string | null {
  if (lf4 === null) {
    return 'onboarding.light_tests names no worker_image (LF4 is unknown): no W session runs';
  }
  if (host === null) {
    return "this host's W image is not named by digest (SANDBOX_CONTROLLER_WORKER_IMAGE_ID): no W session runs";
  }
  if (digestOf(lf4) !== digestOf(host)) {
    return `this host runs W image ${digestOf(host).slice(0, 19)}, not ${digestOf(lf4).slice(0, 19)} that LF4 (SP-STD-1) was recorded for: no W session runs`;
  }
  return null;
}

/** A session this host is running, with the grant it runs under (what a heartbeat names). */
export interface RunningSession {
  readonly session_id: string;
  readonly class: SandboxClass;
  readonly grant_id: string;
  readonly item_id: string;
  readonly unit_id: string;
  readonly started_at: string;
}

export class SandboxController {
  private readonly running = new Map<string, RunningSession>();

  constructor(private readonly d: ControllerDeps) {}

  private used(): Record<SandboxClass, number> {
    const u = Object.fromEntries(SandboxClassValues.map((c) => [c, 0])) as Record<
      SandboxClass,
      number
    >;
    for (const r of this.running.values()) u[r.class] += 1;
    return u;
  }

  /** What H2 reads: the caps now, and the free and used slots per class under both. */
  slots(): SandboxSlots {
    const { caps, source } = this.d.caps.current();
    const used = this.used();
    const u = slotsUnder(caps, used);
    return {
      host_id: this.d.hostId,
      caps,
      caps_source: source,
      used_total: u.used_total,
      used,
      free: u.free,
      sessions: [...this.running.values()].map((r) => ({
        session_id: r.session_id,
        class: r.class,
        grant_id: r.grant_id,
        started_at: r.started_at,
      })),
    };
  }

  /**
   * M19: removes what a dead predecessor (or a driver that could not clean up) left on this host: every sandbox whose
   * session is not running HERE. At boot nothing runs, so everything of this host's owner goes; later, a running
   * session is kept (its slot is taken before its container is made, so a sweep never races a session it keeps).
   */
  async sweep(): Promise<SweepResult> {
    if (!this.d.sweep) return { containers: [], networks: [], scratch: [], errors: [] };
    return this.d.sweep(new Set(this.running.keys()));
  }

  /** The sessions running now (M19: the heartbeat reporter beats each of them). */
  sessions(): RunningSession[] {
    return [...this.running.values()].map((r) => ({ ...r }));
  }

  /** Takes a slot or says why not. Synchronous: no other session can slip in between the count and the take. */
  private acquire(
    spec: SandboxSpec,
    grant: NonNullable<SandboxSpec['grant']>,
  ): Result<() => void, SandboxError> {
    if (this.running.has(spec.session_id)) {
      return err(sandboxError('refused', `session ${spec.session_id} is already running`));
    }
    const { caps } = this.d.caps.current();
    const used = this.used();
    const total = SandboxClassValues.reduce((n, c) => n + used[c], 0);
    if (total >= caps.total) {
      return err(sandboxError('busy', `the runner host is at its total cap (${caps.total})`));
    }
    if (CODING_CLASSES.includes(spec.class)) {
      const coding = CODING_CLASSES.reduce((n, c) => n + used[c], 0);
      if (coding >= caps.coding) {
        return err(sandboxError('busy', `the runner host is at its coding cap (${caps.coding})`));
      }
    }
    const r: RunningSession = {
      session_id: spec.session_id,
      class: spec.class,
      grant_id: grant.grant_id,
      item_id: grant.item_id,
      unit_id: grant.unit_id,
      started_at: (this.d.now ?? (() => new Date()))().toISOString(),
    };
    this.running.set(spec.session_id, r);
    try {
      this.d.onStart?.({ ...r });
    } catch {
      // a reporter's fault never touches the session
    }
    let released = false;
    return ok(() => {
      if (released) return;
      released = true;
      this.running.delete(spec.session_id);
    });
  }

  async run(spec: SandboxSpec): Promise<Result<SandboxRun, SandboxError>> {
    const pre = preflightSpec(spec, this.d.preflight);
    if (!pre.ok) return pre;
    if (IMAGE_PINNED_CLASSES.includes(spec.class)) {
      const approved = this.d.probeImage?.() ?? null;
      if (approved === null) {
        return err(
          sandboxError('refused', `no ${spec.class} image is approved (onboarding.sandbox_image)`),
        );
      }
      if (spec.image !== approved) {
        return err(
          sandboxError(
            'refused',
            `a ${spec.class} session runs the approved image only (onboarding.sandbox_image)`,
          ),
        );
      }
    } else if (spec.image !== undefined) {
      return err(sandboxError('refused', `a ${spec.class} session runs the host's image`));
    }
    if (spec.class === 'W' && this.d.workerImage) {
      let lf4: string | null;
      try {
        lf4 = this.d.workerImage.lf4();
      } catch {
        lf4 = null;
      }
      const why = workerImageWhyNot(lf4, this.d.workerImage.host);
      if (why !== null) return err(sandboxError('image_unverified', why));
    }
    const grant = spec.grant;
    if (grant === undefined) {
      return err(
        sandboxError('refused', 'no admission grant: nothing starts that core did not grant'),
      );
    }
    const g = await this.d.grants.check(grant, spec.class);
    if (!g.ok) {
      return err(sandboxError('unavailable', `the grant could not be checked: ${g.error.message}`));
    }
    if (g.value !== 'active') {
      return err(
        sandboxError(
          'refused',
          `grant ${grant.grant_id} is not active at lease epoch ${grant.lease_epoch}: no session`,
        ),
      );
    }
    const slot = this.acquire(spec, grant);
    if (!slot.ok) return slot;
    try {
      return await this.d.driver.run(spec);
    } catch (e) {
      return err(
        sandboxError(
          'driver_failure',
          `the driver failed: ${e instanceof Error ? e.message.slice(0, 200) : 'unknown error'}`,
        ),
      );
    } finally {
      slot.value();
    }
  }
}
