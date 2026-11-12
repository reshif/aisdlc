import {
  HEALTH_SNAPSHOT_INTERVAL_MS,
  HealthSnapshot,
  healthViewOf,
  loopTileId,
  serviceTileId,
  type HealthState,
  type HealthView,
} from '@aisdlc/contracts';
import type { HealthReport, LoopSpec, LoopState } from '@aisdlc/loops';
import type { Executor } from '@aisdlc/record';
import type pg from 'pg';
import type { AlertTracker } from './alerts.js';

// HealthSnapshot and HealthTile (PLAN M19; DM §3.10): core collects how each service and each loop is doing into
// `core.health_snapshot`, the newest reading per tile, and serves the tiles. The collector is a loop of core-worker
// (`health_snapshot`, every 30 s): it reads its own supervisor's report (one tile per loop, and core-worker's own),
// then probes every configured service's `/healthz`. A loop host's `/healthz` that names its loops (gate-check,
// gate-relay, notifier) gives one tile per loop too.
//
// A reading is ephemeral, never a fact: nothing decides on it, it is not in the record, and the read applies the
// HealthSnapshot rule (older than two minutes reads `unknown`, never green; a service nobody read is `unknown`).
// A probe that gets no answer reads `down` (`unreachable`); a non-2xx answer reads `down` (`unhealthy`).

export const HEALTH_REPORTER = 'core-worker';
export const HEALTH_LOOP = 'health_snapshot';

/** A service the collector probes: its base URL and the path of its liveness answer (default `/healthz`). */
export interface HealthTarget {
  readonly url: string;
  readonly path?: string;
}

const LOOP_STATE: Record<LoopState, { state: HealthState; code: string }> = {
  ok: { state: 'ok', code: 'ok' },
  starting: { state: 'unknown', code: 'starting' },
  degraded: { state: 'degraded', code: 'degraded' },
  failing: { state: 'down', code: 'failing' },
  stalled: { state: 'down', code: 'stalled' },
};

const LoopStateOf = (s: unknown): LoopState | null =>
  typeof s === 'string' && s in LOOP_STATE ? (s as LoopState) : null;

const LOOP_NAME = /^[a-z][a-z0-9_]{0,63}$/;

/** The tiles a loop host's health report gives: one per loop, and the host's own. */
export function snapshotsOfReport(
  host: string,
  report: Pick<HealthReport, 'status' | 'loops' | 'alerts'>,
  at: Date,
  sli: number | null = null,
): HealthSnapshot[] {
  const out: HealthSnapshot[] = [];
  let degraded = false;
  for (const l of report.loops) {
    const st = LoopStateOf(l.state);
    if (st === null || !LOOP_NAME.test(l.name)) continue;
    const m = LOOP_STATE[st];
    if (m.state === 'degraded') degraded = true;
    out.push({
      tile_id: loopTileId(host, l.name),
      domain: 'loop',
      state: m.state,
      detail_code: m.code,
      sli_value: l.consecutive_failures,
      reporter: HEALTH_REPORTER,
      as_of: at.toISOString(),
    });
  }
  const own: HealthState =
    report.status !== 'ok' ? 'down' : degraded || report.alerts.length > 0 ? 'degraded' : 'ok';
  out.push({
    tile_id: serviceTileId(host),
    domain: 'service',
    state: own,
    detail_code:
      report.status !== 'ok'
        ? 'unhealthy'
        : report.alerts.length > 0
          ? 'alert'
          : own === 'ok'
            ? 'ok'
            : 'loop_degraded',
    sli_value: sli,
    reporter: HEALTH_REPORTER,
    as_of: at.toISOString(),
  });
  return out.filter((s) => HealthSnapshot.safeParse(s).success);
}

/** Reads one service's liveness answer. Never throws. */
export async function probeService(
  name: string,
  t: HealthTarget,
  now: () => Date,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 3_000,
): Promise<HealthSnapshot[]> {
  const started = Date.now();
  const at = (): string => now().toISOString();
  const one = (state: HealthState, code: string, sli: number | null): HealthSnapshot[] => [
    {
      tile_id: serviceTileId(name),
      domain: 'service',
      state,
      detail_code: code,
      sli_value: sli,
      reporter: HEALTH_REPORTER,
      as_of: at(),
    },
  ];
  let res: Response;
  try {
    res = await fetchImpl(new URL(t.path ?? '/healthz', t.url), {
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return one('down', 'unreachable', null);
  }
  const ms = Date.now() - started;
  let body: unknown;
  try {
    const text = await res.text();
    body = text === '' ? null : JSON.parse(text);
  } catch {
    body = null;
  }
  // a loop host's answer names its loops: a tile per loop, and the host's own from the same report
  const b = body as { status?: unknown; loops?: unknown; alerts?: unknown } | null;
  if (b !== null && typeof b === 'object' && Array.isArray(b.loops)) {
    const loops = b.loops.filter(
      (l): l is HealthReport['loops'][number] =>
        typeof l === 'object' && l !== null && typeof (l as { name?: unknown }).name === 'string',
    );
    return snapshotsOfReport(
      name,
      {
        status: res.ok && b.status !== 'unhealthy' ? 'ok' : 'unhealthy',
        loops,
        alerts: Array.isArray(b.alerts) ? (b.alerts as HealthReport['alerts']) : [],
      },
      now(),
      ms,
    );
  }
  return res.ok ? one('ok', 'ok', ms) : one('down', 'unhealthy', ms);
}

/** Keeps the newest reading of each tile. */
export async function writeHealthSnapshots(
  db: Executor,
  snaps: readonly HealthSnapshot[],
): Promise<number> {
  let n = 0;
  for (const raw of snaps) {
    const s = HealthSnapshot.parse(raw);
    await db.query(
      `INSERT INTO core.health_snapshot (tile_id, domain, state, detail_code, sli_value, reporter, as_of)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (tile_id) DO UPDATE SET domain = EXCLUDED.domain, state = EXCLUDED.state,
         detail_code = EXCLUDED.detail_code, sli_value = EXCLUDED.sli_value, reporter = EXCLUDED.reporter,
         as_of = EXCLUDED.as_of
       WHERE core.health_snapshot.as_of <= EXCLUDED.as_of`,
      [s.tile_id, s.domain, s.state, s.detail_code, s.sli_value, s.reporter, s.as_of],
    );
    n += 1;
  }
  return n;
}

export async function readHealthSnapshots(db: Executor): Promise<HealthSnapshot[]> {
  const q = await db.query<{
    tile_id: string;
    domain: string;
    state: string;
    detail_code: string | null;
    sli_value: number | null;
    reporter: string;
    as_of: Date;
  }>(
    `SELECT tile_id, domain, state, detail_code, sli_value, reporter, as_of
       FROM core.health_snapshot ORDER BY tile_id`,
  );
  const out: HealthSnapshot[] = [];
  for (const r of q.rows) {
    const p = HealthSnapshot.safeParse({ ...r, as_of: r.as_of.toISOString() });
    if (p.success) out.push(p.data);
  }
  return out;
}

/** The tiles at `now` (the HealthSnapshot rule applied here, at read time). */
export async function readHealthView(db: Executor, now: Date): Promise<HealthView> {
  return healthViewOf(await readHealthSnapshots(db), now.getTime());
}

export interface HealthLoopDeps {
  readonly pool: pg.Pool;
  /** The loop host this runs in (its own report: `supervisor.health()`). */
  readonly own: () => HealthReport;
  readonly targets: Readonly<Record<string, HealthTarget>>;
  readonly now?: () => Date;
  readonly fetchImpl?: typeof fetch;
  /** RC-NOT-3: alerts to a person from the readings (absent: readings only). */
  readonly alerts?: AlertTracker;
  /** Whether this host runs the checkpointer, so an overdue checkpoint is its to page about (default false). */
  readonly checkpointAlerts?: boolean;
}

/** One collection: the host's own report and every target, written in one statement batch. */
export async function collectHealth(d: HealthLoopDeps): Promise<HealthSnapshot[]> {
  const now = d.now ?? (() => new Date());
  const own = snapshotsOfReport(HEALTH_REPORTER, d.own(), now());
  const probed = await Promise.all(
    Object.entries(d.targets).map(([name, t]) => probeService(name, t, now, d.fetchImpl)),
  );
  const all = [...own, ...probed.flat()];
  await writeHealthSnapshots(d.pool, all);
  await d.alerts?.evaluate(d.pool, all, now(), { checkpoint: d.checkpointAlerts === true });
  return all;
}

/** core-worker's `health_snapshot` loop. */
export function healthSnapshotLoop(
  d: HealthLoopDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? HEALTH_SNAPSHOT_INTERVAL_MS;
  return {
    name: HEALTH_LOOP,
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      const s = await collectHealth(d);
      return { ok: s.length, failed: 0 };
    },
  };
}
