import {
  AGENT_DEFINITIONS,
  foldAgentScores,
  scoreSignals,
  type RunWithOutcome,
} from '@aisdlc/agents';
import { readFloorConfig } from '@aisdlc/config';
import {
  AGENT_EVENT,
  AgentIdValues,
  AgentRunDispatchedPayload,
  DEFAULT_FLOOR_CONFIG,
  GATEWAY_EVENT,
  ModelCallPayload,
  SESSION_EVENT,
  SESSION_STREAM_PREFIX,
  STEPS,
  SessionHeartbeat,
  sessionStream,
  stuckAfterS,
  type ActivitySource,
  type AgentScore,
  type FloorActivity,
  type FloorKill,
  type FloorLiveness,
  type FloorScoreChip,
  type FloorStage,
  type KillQuery,
  type RecordEvent,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { admitAgentWork, type AgentAdmission, type KillStatePort } from '@aisdlc/ports';
import { runProjection, type Executor, type Projection, type Tx } from '@aisdlc/record';
import { floorStageOf } from '@aisdlc/work';
import type pg from 'pg';
import { listAgentRunsOf } from './agent-runs.js';
import { coreError, type CoreError } from './errors.js';
import { loadAllEvalRuns } from './evals.js';
import { inCoreTx, lockKeys, type CoreDeps } from './journal.js';

// The floor's live overlays (PLAN M19): SessionActivity and Heartbeat (an item in a session that falls silent is
// stuck), the agent score chips of each station, and the kill switch's verdict on the project. Each is read, never
// written, on the floor's read path; the only write is the heartbeat, which is recorded first.
//
//   POST /v1/sessions/heartbeat   scope activity   a session reports that it is alive (`session.heartbeat`)

export const SESSION_ACTOR = 'system.session';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ---------------------------------------------------------------- Heartbeat: recorded first

/**
 * Records a session's heartbeat as `session.heartbeat` on `session:<item>`, at most one per session and minute (a
 * second one in the same minute is the same fact). The item must exist and belong to the project; a heartbeat dated
 * after core's now is refused (a reporter cannot keep an item alive in advance).
 */
export async function recordHeartbeat(
  d: CoreDeps,
  raw: unknown,
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  const p = SessionHeartbeat.safeParse(raw);
  if (!p.success) {
    return err(coreError('invalid_input', `not a heartbeat: ${p.error.issues[0]?.message ?? ''}`));
  }
  const hb = p.data;
  const now = (d.clock ?? { now: () => new Date() }).now().getTime();
  const at = Date.parse(hb.at);
  if (at > now + 5_000)
    return err(coreError('invalid_input', 'a heartbeat cannot be in the future'));
  const item = await d.pool.query<{ body: { project_id?: unknown } }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
    [`item:${hb.item_id}`],
  );
  const owner = item.rows[0]?.body.project_id;
  if (owner === undefined) return err(coreError('not_found', 'no such item'));
  if (owner !== hb.project_id)
    return err(coreError('invalid_input', 'the item is not in that project'));
  const minute = Math.floor(at / 60_000);
  return inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [sessionStream(hb.item_id)]);
    const w = await j.emitAll(sessionStream(hb.item_id), [
      {
        type: SESSION_EVENT.heartbeat,
        body: hb as unknown as Record<string, unknown>,
        actor: SESSION_ACTOR,
        idempotency_key: `session.heartbeat:${hb.session_id}:${minute}`,
      },
    ]);
    return w.ok ? ok({ duplicate: w.value.duplicate === true }) : w;
  });
}

// ---------------------------------------------------------------- SessionActivity: the fold

/** The activity an event says about an item, or `null`: (item, project, at, source, session). */
function activityOf(e: RecordEvent): {
  item: string;
  project: string;
  at: Date;
  source: ActivitySource;
  session: string | null;
} | null {
  const occurred = new Date(e.occurred_at);
  if (e.type === SESSION_EVENT.heartbeat && e.stream_id.startsWith(SESSION_STREAM_PREFIX)) {
    const p = SessionHeartbeat.safeParse(e.payload);
    if (!p.success) return null;
    const at = new Date(Math.min(Date.parse(p.data.at), occurred.getTime()));
    return {
      item: p.data.item_id,
      project: p.data.project_id,
      at,
      source: 'heartbeat',
      session: p.data.session_id,
    };
  }
  if (e.type === GATEWAY_EVENT.model_call) {
    const p = ModelCallPayload.safeParse(e.payload);
    if (!p.success || p.data.item_id === null || !UUID.test(p.data.item_id)) return null;
    return {
      item: p.data.item_id,
      project: p.data.project_id,
      at: occurred,
      source: 'model_call',
      session: p.data.unit_id,
    };
  }
  if (e.type === AGENT_EVENT.run_dispatched) {
    const p = AgentRunDispatchedPayload.safeParse(e.payload);
    if (!p.success) return null;
    return {
      item: p.data.item_id,
      project: p.data.project_id,
      at: occurred,
      source: 'dispatch',
      session: p.data.run_id,
    };
  }
  return null;
}

export const sessionActivityProjection: Projection<{ rows: unknown[] }> = {
  name: 'session_activity',
  version: 1,
  tables: ['core.session_activity'],

  async apply(tx: Tx, e: RecordEvent) {
    const a = activityOf(e);
    if (!a) return;
    // the newest activity wins; a late event about an earlier instant only counts the beat
    await tx.query(
      `INSERT INTO core.session_activity (item_id, project_id, last_at, source, session_id, beats, last_seq)
       VALUES ($1, $2, $3, $4, $5, 1, $6::bigint)
       ON CONFLICT (item_id) DO UPDATE SET
         beats = core.session_activity.beats + 1,
         last_seq = EXCLUDED.last_seq,
         source = CASE WHEN EXCLUDED.last_at >= core.session_activity.last_at
                       THEN EXCLUDED.source ELSE core.session_activity.source END,
         session_id = CASE WHEN EXCLUDED.last_at >= core.session_activity.last_at
                       THEN EXCLUDED.session_id ELSE core.session_activity.session_id END,
         last_at = GREATEST(core.session_activity.last_at, EXCLUDED.last_at)`,
      [a.item, a.project, a.at, a.source, a.session, String(e.global_seq)],
    );
  },

  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.session_activity');
  },

  async snapshot(db: Executor) {
    const q = await db.query(
      `SELECT item_id, project_id, last_at, source, session_id, beats, last_seq
         FROM core.session_activity ORDER BY item_id`,
    );
    return { rows: q.rows };
  },
};

/** Catches SessionActivity up; `false` when it cannot (the floor is then marked stale). */
export async function catchUpSessionActivity(pool: pg.Pool): Promise<boolean> {
  const r = await runProjection(pool, sessionActivityProjection);
  return r.ok;
}

export interface ActivityRow {
  readonly last_at: Date;
  readonly source: ActivitySource;
}

/** The newest activity of the given items. */
export async function readActivity(
  db: Executor,
  items: readonly string[],
): Promise<Map<string, ActivityRow>> {
  if (items.length === 0) return new Map();
  const q = await db.query<{ item_id: string; last_at: Date; source: ActivitySource }>(
    `SELECT item_id, last_at, source FROM core.session_activity WHERE item_id = ANY($1::uuid[])`,
    [items],
  );
  return new Map(q.rows.map((r) => [r.item_id, { last_at: r.last_at, source: r.source }]));
}

/**
 * An item's liveness at `now`: silence counts from the newer of its last activity and the moment it entered its
 * session (activity from before it entered does not count). Silent past the station's threshold is stuck.
 */
export function livenessOf(
  inSessionSince: Date | null,
  act: ActivityRow | undefined,
  stage: FloorStage | null,
  cfg: FloorLiveness,
  now: Date,
): FloorActivity {
  const since = inSessionSince ?? now;
  const counted = act && act.last_at.getTime() >= since.getTime() ? act : undefined;
  const from = counted ? counted.last_at : since;
  const silent_for_s = Math.max(0, Math.floor((now.getTime() - from.getTime()) / 1000));
  const stuck_after_s = stuckAfterS(cfg, stage);
  return {
    last_at: counted ? counted.last_at.toISOString() : null,
    source: counted ? counted.source : null,
    session_since: inSessionSince ? inSessionSince.toISOString() : null,
    silent_for_s,
    stuck_after_s,
    silent: silent_for_s > stuck_after_s,
  };
}

/** `factory.floor` in force, and where it came from. Unreadable uses the defaults and says so. */
export async function floorLiveness(db: Executor): Promise<FloorLiveness> {
  try {
    const r = await readFloorConfig(db);
    if (r.state === 'ok') {
      const isDefault = JSON.stringify(r.value) === JSON.stringify(DEFAULT_FLOOR_CONFIG);
      return { ...r.value, source: isDefault ? 'default' : 'config' };
    }
  } catch {
    // fall through
  }
  return { ...DEFAULT_FLOOR_CONFIG, by_stage: {}, source: 'unreadable' };
}

// ---------------------------------------------------------------- agent score chips

const worst = (scores: readonly AgentScore[]): AgentScore | null =>
  [...scores].sort(
    (a, b) =>
      (a.pass_rate ?? a.accept_rate ?? 2) - (b.pass_rate ?? b.accept_rate ?? 2) ||
      a.score_id.localeCompare(b.score_id),
  )[0] ?? null;

/**
 * The score chips of every station: each agent of the registry at the stations of its steps, with the worst of its
 * scores under its CURRENT prompt (`foldAgentScores`; a score of an older prompt says nothing about this one) and the
 * ScoreSignals behind it (`scoreSignals`). Low: `fail` or `flaky`, or a rate under `low_score`. No score: `unknown`.
 */
export async function floorScoreChips(pool: pg.Pool, lowScore: number): Promise<FloorScoreChip[]> {
  const runs = await loadAllEvalRuns(pool);
  const production: RunWithOutcome[] = [];
  for (const a of AgentIdValues) production.push(...(await listAgentRunsOf(pool, a)));
  const scores = foldAgentScores(runs, production);
  const signals = scoreSignals(runs, production);
  const out: FloorScoreChip[] = [];
  for (const def of AGENT_DEFINITIONS) {
    const stages = new Set<FloorStage>();
    for (const step of [...def.steps, ...def.specialist_steps]) {
      const st = floorStageOf(STEPS[step].stage);
      if (st) stages.add(st);
    }
    const mine = scores.filter(
      (s) => s.agent_id === def.agent_id && s.prompt_sha256 === def.prompt.sha256,
    );
    const w = worst(mine);
    const sig = w ? signals.filter((g) => g.score_id === w.score_id) : [];
    const rate = w ? (w.pass_rate ?? w.accept_rate) : null;
    const status = w ? w.status : 'unknown';
    const low =
      w !== null &&
      (status === 'fail' ||
        status === 'flaky' ||
        (rate !== null && rate < lowScore) ||
        (w.accept_rate !== null && w.accept_rate < lowScore));
    for (const stage of stages) {
      out.push({
        stage,
        agent_id: def.agent_id,
        name: def.name,
        prompt_sha256: def.prompt.sha256,
        score_id: w?.score_id ?? null,
        provider: w?.provider ?? null,
        model: w?.model ?? null,
        pass_rate: w?.pass_rate ?? null,
        accept_rate: w?.accept_rate ?? null,
        status,
        low,
        eval_signals: sig.filter((g) => g.source === 'eval').length,
        production_signals: sig.filter((g) => g.source === 'production').length,
      });
    }
  }
  return out.sort((a, b) => a.stage.localeCompare(b.stage) || a.agent_id.localeCompare(b.agent_id));
}

// ---------------------------------------------------------------- the kill switch's verdict (AR9)

/** What the floor asks about kills: core-worker's `/admission` verdict (core has no route to the kill switch). */
export interface KillVerdictPort {
  verdict(q: KillQuery): Promise<AgentAdmission>;
}

/** A `KillStatePort` read as a verdict (tests, and anything that holds the port itself). */
export const verdictOfKillState = (port: KillStatePort): KillVerdictPort => ({
  verdict: (q) => admitAgentWork(port, q),
});

/**
 * core-worker's `GET /admission` (read-only, on the internal network): 200 admitted, 423 with the verdict; anything
 * else, a timeout or a body that is not a verdict, is `unreachable` (AR9: shown as killed).
 */
export class HttpAdmissionVerdict implements KillVerdictPort {
  constructor(private readonly o: { baseUrl: string; timeoutMs?: number }) {}

  async verdict(q: KillQuery): Promise<AgentAdmission> {
    const qs = new URLSearchParams({
      project_id: q.project_id,
      ...(q.lane ? { lane: q.lane } : {}),
    });
    const unreachable = (message: string): AgentAdmission => ({
      admitted: false,
      why: 'unreachable',
      kill_ids: [],
      message,
    });
    try {
      const r = await fetch(`${this.o.baseUrl.replace(/\/+$/, '')}/admission?${qs.toString()}`, {
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 2_000),
      });
      const body = (await r.json().catch(() => null)) as Record<string, unknown> | null;
      if (r.status === 200 && body?.['admitted'] === true) return { admitted: true };
      if (r.status === 423 && body?.['admitted'] === false) {
        const why = body['why'] === 'killed' ? 'killed' : 'unreachable';
        const ids = Array.isArray(body['kill_ids'])
          ? body['kill_ids'].filter((x): x is string => typeof x === 'string')
          : [];
        const message = typeof body['message'] === 'string' ? body['message'] : why;
        return { admitted: false, why, kill_ids: ids, message };
      }
      return unreachable(`core-worker answered ${r.status}`);
    } catch (e) {
      return unreachable(
        `core-worker could not be asked: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
}

/** The floor's kill banner: no port configured, or any failure, is `unreachable`, shown as killed (AR9). */
export async function floorKillOf(
  port: KillVerdictPort | undefined,
  q: KillQuery,
): Promise<FloorKill> {
  if (!port) {
    return {
      state: 'unreachable',
      killed: true,
      kill_ids: [],
      message: 'no kill switch verdict is configured for the floor (CORE_ADMISSION_URL)',
    };
  }
  let a: AgentAdmission;
  try {
    a = await port.verdict(q);
  } catch (e) {
    a = {
      admitted: false,
      why: 'unreachable',
      kill_ids: [],
      message: e instanceof Error ? e.message : String(e),
    };
  }
  if (a.admitted) return { state: 'clear', killed: false, kill_ids: [], message: null };
  return { state: a.why, killed: true, kill_ids: [...a.kill_ids], message: a.message };
}
