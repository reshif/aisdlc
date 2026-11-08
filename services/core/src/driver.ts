import {
  REPO_EVENT,
  S0_CONFIG_KEYS,
  S0_DEFAULT_CALENDAR,
  S0_DEFAULT_FAILURE_MODEL,
  S0_DEFAULT_TIMEBOXES,
  S0_EVENT,
  S0Calendar,
  S0FailureModel,
  S0TimeBoxes,
  levelRank,
  repoKeyOf,
  repoStream,
  s0Stream,
  type CauseCode,
  type CodeHostNotOk,
} from '@aisdlc/contracts';
import type { ConfigReader } from '@aisdlc/config';
import { addBusinessDays, businessCalendar, type BusinessCalendar } from '@aisdlc/decisions';
import { ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { LoopSpec } from '@aisdlc/loops';
import { repoKey, type CodeHostPort } from '@aisdlc/ports';
import type pg from 'pg';
import { z } from 'zod';
import type { KnowledgePort, RemoteError } from './clients.js';
import type { CoreError } from './errors.js';
import { STEPS, type S0State, type StepProgress } from './fold.js';
import { inCoreTx, readS0, type Journal } from './journal.js';
import { activeS0Ids } from './queries.js';
import {
  SYSTEM_ACTOR,
  applySignableLevel,
  changeStatus,
  changeStatusVia,
  changeStep,
  openS0,
  raiseCard,
} from './s0.js';

// The S0 step driver (PLAN M7.2; OB §6.2, §6.4): deterministic, no chat. One `driveS0` call looks at
// one S0 record and does the next thing it can, or nothing; `s0DriverLoop` runs it for every record
// that is `app`, `running` or `card` and is hosted by core-worker. Every change is a record event
// on the `s0:<uuid>` stream, written under the record's lock after the I/O (never inside a
// transaction that waits for the network), and only if the stream did not move meanwhile: a write
// whose record changed under it (a person withdrew it, another driver got there first) is dropped
// and the next tick looks again.
//
//   0.1  precondition: the App is installed on the repo (the code host's installation read and the
//        repo's place in it). Not installed: status `app`, "0.1 waiting: App not installed", and
//        nothing else (items for the repo stay N8; the hold itself is M7.6). Then the repo is read;
//        a blank repo goes to `starter`. Then the knowledge census-intake job runs and the driver
//        waits for the census. The census raises card 1 (and the security card for an open secret,
//        which also lowers the signable level to Census: Light and Full are blocked).
//   0.2, 0.3 only if requested (recorded `skip` at the intake otherwise, DEC-3); 0.4, 0.5 always,
//        Census included (a reduced 0.4). For now each only advances to "card needed": a
//        `card_required` event with the card kind is the hand-off to the card layer (cards 1, 4 and 5
//        and the security card: M7.3; card 5 builds the PRR and carries the M4 gate: M7.4, M7.5).
//
//   DEC-9 failure model, all of it configuration (`s0.failure_model`):
//        a machine failure is recorded with a cause code and retried after a delay; once the
//        retries are used the next failure BLOCKS the step with that cause;
//        silence at a human step (no decision for the park period, in business days) PARKs the
//        record; one send-back per human step is the card layer's call (`sendBackStep`).

export interface S0Settings {
  readonly failure: S0FailureModel;
  readonly timeboxes: S0TimeBoxes;
  readonly calendar: BusinessCalendar;
  /** DEC-4: a T0 tier needs the owner's positive attestation on card 1 (behind config, default on). */
  readonly t0AttestationRequired: boolean;
}

export const DEFAULT_S0_SETTINGS: S0Settings = {
  failure: S0_DEFAULT_FAILURE_MODEL,
  timeboxes: S0_DEFAULT_TIMEBOXES,
  calendar: businessCalendar({
    weekend: S0_DEFAULT_CALENDAR.weekend,
    holidays: S0_DEFAULT_CALENDAR.holidays,
    utcOffsetMinutes: S0_DEFAULT_CALENDAR.utc_offset_minutes,
  }),
  t0AttestationRequired: true,
};

/** The settings in force from a config reader; a value that no longer fits its schema keeps the default. */
export function s0SettingsFrom(reader: ConfigReader): () => S0Settings {
  return () => {
    const v = reader.current();
    const failure = S0FailureModel.safeParse(v.get(S0_CONFIG_KEYS.failure_model));
    const boxes = S0TimeBoxes.safeParse(v.get(S0_CONFIG_KEYS.timeboxes));
    const cal = S0Calendar.safeParse(v.get(S0_CONFIG_KEYS.calendar));
    const t0 = z.boolean().safeParse(v.get(S0_CONFIG_KEYS.t0_attestation));
    return {
      // A value that is not a boolean keeps the default, which is the stricter one (on).
      t0AttestationRequired: t0.success ? t0.data : DEFAULT_S0_SETTINGS.t0AttestationRequired,
      failure: failure.success ? failure.data : DEFAULT_S0_SETTINGS.failure,
      timeboxes: boxes.success ? boxes.data : DEFAULT_S0_SETTINGS.timeboxes,
      calendar: cal.success
        ? businessCalendar({
            weekend: cal.data.weekend,
            holidays: cal.data.holidays,
            utcOffsetMinutes: cal.data.utc_offset_minutes,
          })
        : DEFAULT_S0_SETTINGS.calendar,
    };
  };
}

export interface DriverDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  /** The code host's reads: the installation and its repos (the allow-list), and a branch head. */
  readonly source: Pick<CodeHostPort, 'list_repos' | 'installation' | 'branch_head'>;
  readonly knowledge: KnowledgePort;
  readonly settings?: () => S0Settings;
}

export type DriveAction =
  | 'none'
  | 'stale'
  | 'waiting_app'
  | 'starter'
  | 'job_started'
  | 'job_pending'
  | 'card_raised'
  | 'retry_wait'
  | 'machine_failed'
  | 'blocked'
  | 'parked'
  | 'reminded'
  | 'overdue';

export interface DriveOutcome {
  readonly s0_id: string;
  readonly action: DriveAction;
}

/** Why the signable level dropped to Census (cause codes, S0SignableLevelPayload.reason). */
const SECURITY_CAUSE = {
  open: 'security.open_secret',
  incomplete: 'security.scan_incomplete',
} as const satisfies Record<string, CauseCode>;

const trim = (s: string): string => s.slice(0, 500);
const clockOf = (d: DriverDeps): Clock => d.clock ?? systemClock;
const settingsOf = (d: DriverDeps): S0Settings => (d.settings ?? (() => DEFAULT_S0_SETTINGS))();

function mustOk<T>(r: Result<T, CoreError>): T {
  if (!r.ok) throw new Error(`[${r.error.code}] ${r.error.message}`);
  return r.value;
}

/** Runs a write against the record only if its stream is still where the I/O started from. */
async function act(
  d: DriverDeps,
  s0: S0State,
  fn: (j: Journal, cur: S0State) => Promise<Result<unknown, CoreError>>,
): Promise<'done' | 'stale'> {
  const r = await inCoreTx<'done' | 'stale'>(d, async (j) => {
    const cur = await openS0(j, s0.record.s0_id);
    if (!cur.ok) return cur;
    if (cur.value.head_seq !== s0.head_seq) return ok('stale' as const);
    const w = await fn(j, cur.value);
    return w.ok ? ok('done' as const) : w;
  });
  return mustOk(r);
}

const causeOfCodeHost = (r: CodeHostNotOk): CauseCode =>
  (r.state === 'unknown' ? 'codehost.unreachable' : 'codehost.refused') as CauseCode;
const causeOfRemote = (service: string, e: RemoteError): CauseCode =>
  `${service}.${e.kind}` as CauseCode;

// ---------------------------------------------------------------- one record

/** Does the next thing the record needs, or nothing. Never throws on an I/O failure: that is a machine failure. */
export async function driveS0(d: DriverDeps, s0Id: string): Promise<DriveOutcome> {
  const out = (action: DriveAction): DriveOutcome => ({ s0_id: s0Id, action });
  const s0 = await readS0(d.pool, s0Id);
  if (!s0) return out('none');
  const status = s0.record.status;
  if (status !== 'app' && status !== 'running' && status !== 'card') return out('none');

  const timed = await timers(d, s0);
  if (timed !== null) return out(timed);

  if (status === 'card') return out('none');
  const step = STEPS.find((s) => {
    const st = s0.steps.get(s)?.state;
    return st !== 'done' && st !== 'skip';
  });
  if (!step) return out('none');
  if (step === '0.1') return out(await step01(d, s0));
  // 0.2 to 0.5 only advance to "card needed": the card layer owns what each card does.
  const done = await act(d, s0, (j, cur) => raiseCard(j, cur, step, { actor: SYSTEM_ACTOR }));
  return out(done === 'stale' ? 'stale' : 'card_raised');
}

// ---------------------------------------------------------------- timers (DEC-9, OB §6.2)

/**
 * The clock-driven rules. PARK: silence at a human step for the park period (business days from the
 * card). The reminder (2 business days on 0.1) and the overall time box are recorded once each.
 * Returns what it did, or `null` when nothing was due.
 */
async function timers(d: DriverDeps, s0: S0State): Promise<DriveAction | null> {
  const cfg = settingsOf(d);
  const now = clockOf(d).now();
  const at = (iso: string, bd: number): Date => addBusinessDays(cfg.calendar, new Date(iso), bd);

  if (s0.record.status === 'card') {
    const st = [...s0.steps.values()].find((s) => s.state === 'card');
    if (st?.card_raised_at) {
      if (now >= at(st.card_raised_at, cfg.failure.park_business_days)) {
        const r = await act(d, s0, async (j, cur) => {
          const c = await changeStep(j, cur, st.step, 'running', {
            actor: SYSTEM_ACTOR,
            reason: 'park.timeout',
          });
          if (!c.ok) return c;
          return changeStatusVia(j, c.value, 'parked', {
            actor: SYSTEM_ACTOR,
            cause: 'park.timeout',
            reason: `no decision for ${cfg.failure.park_business_days} business days`,
          });
        });
        return r === 'stale' ? 'stale' : 'parked';
      }
      const bd = cfg.timeboxes[st.step].reminder_business_days;
      if (bd !== null && !st.reminded) {
        const due = at(st.card_raised_at, bd);
        if (now >= due) {
          const r = await act(d, s0, (j) =>
            j.emit(
              s0Stream(s0.record.s0_id),
              S0_EVENT.reminder,
              { step: st.step, due_at: due.toISOString() },
              SYSTEM_ACTOR,
            ),
          );
          return r === 'stale' ? 'stale' : 'reminded';
        }
      }
    }
  }
  for (const st of s0.steps.values()) {
    const bd = cfg.timeboxes[st.step].overall_business_days;
    if (bd === null || st.overdue || st.started_at === null) continue;
    if (st.state === 'done' || st.state === 'skip') continue;
    const due = at(st.started_at, bd);
    if (now < due) continue;
    const r = await act(d, s0, (j) =>
      j.emit(
        s0Stream(s0.record.s0_id),
        S0_EVENT.timebox_exceeded,
        { step: st.step, overall_business_days: bd, due_at: due.toISOString() },
        SYSTEM_ACTOR,
      ),
    );
    return r === 'stale' ? 'stale' : 'overdue';
  }
  return null;
}

// ---------------------------------------------------------------- step 0.1

async function step01(d: DriverDeps, s0: S0State): Promise<DriveAction> {
  const cfg = settingsOf(d);
  const now = clockOf(d).now();
  const st = s0.steps.get('0.1') as StepProgress;

  // The census is in: the step is waiting for its card (again, after a send-back, a park or a restore).
  if (s0.census) {
    const done = await act(d, s0, (j, cur) => raiseCard(j, cur, '0.1', { actor: SYSTEM_ACTOR }));
    return done === 'stale' ? 'stale' : 'card_raised';
  }

  // A failed attempt waits out the retry delay.
  if (st.failures > 0 && st.last_failure_at) {
    const due =
      new Date(st.last_failure_at).getTime() + cfg.failure.machine_retry_delay_seconds * 1000;
    if (now.getTime() < due) return 'retry_wait';
  }

  // 1. The precondition: the App is installed on the repo (DEC-2).
  const [inst, repos] = await Promise.all([d.source.installation(), d.source.list_repos()]);
  if (inst.state !== 'ok') return failMachine(d, s0, causeOfCodeHost(inst), inst.message);
  if (repos.state !== 'ok') return failMachine(d, s0, causeOfCodeHost(repos), repos.message);
  const found = repos.value.find((r) => repoKey(r.full_name) === repoKeyOf(s0.repo));
  const missing = !found ? 'App not installed' : inst.value.suspended ? 'App suspended' : null;
  if (missing !== null || !found) {
    const text = `0.1 waiting: ${missing ?? 'App not installed'}`;
    if (s0.waiting === text) return 'waiting_app';
    const r = await act(d, s0, (j) =>
      j.emit(
        s0Stream(s0.record.s0_id),
        S0_EVENT.waiting,
        {
          step: '0.1',
          waiting: text,
          cause: missing === 'App suspended' ? 'app.suspended' : 'app.not_installed',
        },
        SYSTEM_ACTOR,
      ),
    );
    return r === 'stale' ? 'stale' : 'waiting_app';
  }

  // The App is there: the waiting note ends, 0.1 starts, and what the code host says of the repo is recorded.
  if (s0.waiting !== null || s0.record.status === 'app' || st.state === 'todo') {
    const r = await act(d, s0, async (j, cur) => {
      if (cur.waiting !== null) {
        const w = await j.emit(
          s0Stream(cur.record.s0_id),
          S0_EVENT.waiting,
          { step: '0.1', waiting: null, cause: null },
          SYSTEM_ACTOR,
        );
        if (!w.ok) return w;
      }
      let now0 = (await j.s0(cur.record.s0_id)) as S0State;
      if (now0.record.status === 'app') {
        const c = await changeStatus(j, now0, 'running', {
          actor: SYSTEM_ACTOR,
          cause: 'app.installed',
        });
        if (!c.ok) return c;
        now0 = c.value;
      }
      if (now0.steps.get('0.1')?.state === 'todo') {
        const c = await changeStep(j, now0, '0.1', 'running', { actor: SYSTEM_ACTOR });
        if (!c.ok) return c;
      }
      const repo = await j.repo(cur.repo);
      const visibility = found.private ? 'private' : 'public';
      if (
        repo &&
        (repo.visibility !== visibility || repo.default_branch !== found.default_branch)
      ) {
        return j.emit(
          repoStream(cur.repo),
          REPO_EVENT.observed,
          { visibility, owner_type: repo.owner_type, default_branch: found.default_branch },
          SYSTEM_ACTOR,
        );
      }
      return ok(undefined);
    });
    return r === 'stale' ? 'stale' : 'job_pending';
  }

  // 2. A blank repo has no census to take: it goes to `starter` (a starter PR waits for a human merge).
  if (s0.job === null) {
    const head = await d.source.branch_head({ repo: s0.repo, branch: found.default_branch });
    if (head.state === 'unreadable' && head.reason === 'not_found') {
      const r = await act(d, s0, (j, cur) =>
        changeStatus(j, cur, 'starter', {
          actor: SYSTEM_ACTOR,
          cause: 'blank_repo',
          reason: `the default branch ${found.default_branch} has no commit`,
        }),
      );
      return r === 'stale' ? 'stale' : 'starter';
    }
    if (head.state !== 'ok') return failMachine(d, s0, causeOfCodeHost(head), head.message);

    // 3. The census-intake job.
    const started = await d.knowledge.startCensus(s0.repo);
    if (!started.ok) {
      return failMachine(d, s0, causeOfRemote('knowledge', started.error), started.error.message);
    }
    const r = await act(d, s0, (j) =>
      j.emit(
        s0Stream(s0.record.s0_id),
        S0_EVENT.job_started,
        { step: '0.1', job_id: started.value.job_id },
        SYSTEM_ACTOR,
      ),
    );
    return r === 'stale' ? 'stale' : 'job_started';
  }

  // 4. Waiting for the job, and then for the census.
  const job = s0.job;
  const box = cfg.timeboxes['0.1'].machine_minutes;
  const view = await d.knowledge.job(job.job_id);
  if (!view.ok)
    return failMachine(d, s0, causeOfRemote('knowledge', view.error), view.error.message);
  if (view.value.state === 'error') {
    return failMachine(d, s0, 'knowledge.job_error', view.value.error ?? 'the job failed');
  }
  if (view.value.state !== 'done') {
    if (box !== null && now.getTime() - new Date(job.started_at).getTime() > box * 60_000) {
      return failMachine(d, s0, 'machine.timebox', `no census within ${box} minutes`);
    }
    return 'job_pending';
  }
  const census = await d.knowledge.latestCensus(s0.repo);
  if (!census.ok) {
    return failMachine(d, s0, causeOfRemote('knowledge', census.error), census.error.message);
  }
  if (census.value === null || census.value.job_id !== job.job_id) {
    return failMachine(d, s0, 'census.missing', 'the job is done but its census is not there');
  }
  const c = census.value;
  const r = await act(d, s0, async (j, cur) => {
    const w = await j.emit(
      s0Stream(cur.record.s0_id),
      S0_EVENT.census_ready,
      {
        job_id: c.job_id,
        census_id: c.census_id,
        census_hash: c.census_hash,
        b1_blocked: c.b1_blocked,
        secrets_not_met: c.secrets_not_met,
      },
      SYSTEM_ACTOR,
    );
    if (!w.ok) return w;
    let now1 = (await j.s0(cur.record.s0_id)) as S0State;
    // An open secret (or a scan that did not complete): Light and Full are blocked, Census may still sign.
    if (c.secrets_not_met && levelRank(now1.record.signable_level) > levelRank('census')) {
      const l = await applySignableLevel(j, now1, 'census', {
        actor: SYSTEM_ACTOR,
        reason: c.b1_blocked ? SECURITY_CAUSE.open : SECURITY_CAUSE.incomplete,
      });
      if (!l.ok) return l;
      now1 = l.value;
    }
    return raiseCard(j, now1, '0.1', {
      actor: SYSTEM_ACTOR,
      ...(c.b1_blocked ? { extra: ['SECR' as const] } : {}),
    });
  });
  return r === 'stale' ? 'stale' : 'card_raised';
}

// ---------------------------------------------------------------- machine failure (DEC-9)

/**
 * A machine failure of step 0.1: recorded with its cause code; a retry follows after the delay; once
 * the configured retries are used, the next failure BLOCKS the step with the cause (the record is
 * `blocked` until a person resumes it).
 */
async function failMachine(
  d: DriverDeps,
  s0: S0State,
  cause: CauseCode,
  detail: string,
): Promise<DriveAction> {
  const cfg = settingsOf(d);
  let blocked = false;
  const r = await act(d, s0, async (j, cur) => {
    let s = cur;
    // The access check is part of step 0.1: a record still in `app` is running it.
    if (s.record.status === 'app') {
      const c = await changeStatus(j, s, 'running', { actor: SYSTEM_ACTOR, cause: 'access_check' });
      if (!c.ok) return c;
      s = c.value;
    }
    if (s.steps.get('0.1')?.state === 'todo') {
      const c = await changeStep(j, s, '0.1', 'running', { actor: SYSTEM_ACTOR });
      if (!c.ok) return c;
      s = c.value;
    }
    const attempt = (s.steps.get('0.1')?.failures ?? 0) + 1;
    const w = await j.emit(
      s0Stream(s.record.s0_id),
      S0_EVENT.machine_failed,
      { step: '0.1', attempt, cause, detail: trim(detail) },
      SYSTEM_ACTOR,
    );
    if (!w.ok) return w;
    if (attempt <= cfg.failure.machine_retries) return ok(undefined);
    blocked = true;
    s = (await j.s0(s.record.s0_id)) as S0State;
    const c = await changeStep(j, s, '0.1', 'blocked', {
      actor: SYSTEM_ACTOR,
      blocked_cause: cause,
      reason: `${attempt} failed attempts`,
    });
    if (!c.ok) return c;
    return changeStatus(j, c.value, 'blocked', {
      actor: SYSTEM_ACTOR,
      cause: 'machine.retries_exhausted',
      reason: trim(detail),
    });
  });
  if (r === 'stale') return 'stale';
  return blocked ? 'blocked' : 'machine_failed';
}

// ---------------------------------------------------------------- the loop

export interface DriverLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
  /** Observes every outcome (tests, metrics). */
  readonly onOutcome?: (o: DriveOutcome) => void;
}

export const S0_DRIVER_INTERVAL_MS = 15_000;

/** The `s0_driver` loop of core-worker: `driveS0` for every record that is `app`, `running` or `card`. */
export function s0DriverLoop(d: DriverDeps, o: DriverLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? S0_DRIVER_INTERVAL_MS;
  return {
    name: 's0_driver',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(30_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick(ctx) {
      const ids = await activeS0Ids(d.pool);
      return ctx.eachItem(
        ids,
        (id) => `s0 ${id}`,
        async (id) => {
          // (Not `o.onOutcome?.(await driveS0(...))`: an absent callback would skip the call.)
          const outcome = await driveS0(d, id);
          o.onOutcome?.(outcome);
        },
      );
    },
  };
}
