import { z } from 'zod';
import { IsoDateTime } from './ids.js';
import { HealthState } from '../states/health.js';
import { INTEGRATION_HEALTH_STALE_MS, effectiveHealthState } from './integrations.js';

// HealthTile and HealthSnapshot (DM §3.10; PLAN M19): how each service of the factory, and each of core-worker's
// loops, is doing, as one shared shape. A snapshot is a READING, not a fact: core-worker's `health_snapshot` loop
// takes one every 30 s (its own supervisor's loops, and every configured service's `/healthz`) and keeps only the
// newest per tile in `core.health_snapshot`. It is ephemeral by design (a reading lost is taken again in 30 s) and
// never in the record, the ledger or a decision. The read applies the `HealthSnapshot` rule: a reading older than two
// minutes is `unknown`, never green, and a tile nobody has read is `unknown` too.

/** What a tile is about: a deployable service (its `/healthz`), or one loop of a loop host. */
export const HealthDomain = z.enum(['service', 'loop']);
export type HealthDomain = z.infer<typeof HealthDomain>;

/** `service.<name>` or `loop.<host>.<loop>`. */
export const HealthTileId = z.string().regex(/^(service|loop)\.[a-z][a-z0-9_.-]{0,95}$/);
export type HealthTileId = z.infer<typeof HealthTileId>;

/** A code, never text from the thing probed (`ok`, `unreachable`, `unhealthy`, `starting`, `failing`, ...). */
export const HealthDetailCode = z.string().regex(/^[a-z][a-z0-9_]{0,47}$/);

/** The services a factory runs, each a tile whether or not anything has read it (unknown until something has). */
export const FACTORY_SERVICES = [
  'bff',
  'core',
  'core-worker',
  'identity',
  'knowledge',
  'codehost',
  'notary',
  'witness',
  'killswitch',
  'kms-local',
  'gateway',
  'sandbox-controller',
  'verify',
  'gate-check',
  'gate-relay',
  'notifier',
  'audit',
  'object-store',
] as const;
export const FactoryService = z.enum(FACTORY_SERVICES);
export type FactoryService = z.infer<typeof FactoryService>;

export const serviceTileId = (s: string): string => `service.${s}`;
export const loopTileId = (host: string, loop: string): string => `loop.${host}.${loop}`;

/** The newest reading of one tile (one row of `core.health_snapshot`). `as_of` is the reader's clock. */
export const HealthSnapshot = z.strictObject({
  tile_id: HealthTileId,
  domain: HealthDomain,
  state: HealthState,
  detail_code: HealthDetailCode.nullable(),
  /** The tile's SLI when it has one (a probe's latency in ms); `null` otherwise. */
  sli_value: z.number().finite().nullable(),
  /** Who took the reading (`core-worker`). */
  reporter: z.string().regex(/^[a-z][a-z0-9-]{0,47}$/),
  as_of: IsoDateTime,
});
export type HealthSnapshot = z.infer<typeof HealthSnapshot>;

/** The rule every reader applies: older than this, a snapshot reads `unknown`. */
export const HEALTH_SNAPSHOT_STALE_MS = INTEGRATION_HEALTH_STALE_MS;
/** How often core-worker takes the readings. */
export const HEALTH_SNAPSHOT_INTERVAL_MS = 30_000;

/** One tile as the portal shows it. */
export const HealthTile = z.strictObject({
  tile_id: HealthTileId,
  domain: HealthDomain,
  /** The service, or `<host> / <loop>`. */
  label: z.string().min(1).max(160),
  /** The state a person may be shown: the reading while fresh, else `unknown`. */
  state: HealthState,
  /** The reading's code; `stale` once it is too old, `no_report` when nothing has read the tile. */
  detail_code: z.string().nullable(),
  sli_value: z.number().finite().nullable(),
  as_of: IsoDateTime.nullable(),
  stale: z.boolean(),
});
export type HealthTile = z.infer<typeof HealthTile>;

export const HealthCounts = z.strictObject({
  ok: z.number().int().min(0),
  degraded: z.number().int().min(0),
  down: z.number().int().min(0),
  unknown: z.number().int().min(0),
});
export type HealthCounts = z.infer<typeof HealthCounts>;

/** `GET /v1/health` (core) and `GET /api/health` (bff). */
export const HealthView = z.strictObject({
  as_of: IsoDateTime,
  /** The worst tile: `ok` only when every tile is fresh and ok. */
  overall: HealthState,
  counts: HealthCounts,
  tiles: z.array(HealthTile),
});
export type HealthView = z.infer<typeof HealthView>;

const RANK: Record<HealthState, number> = { ok: 0, unknown: 1, degraded: 2, down: 3 };

/** The worst of some states; `unknown` for none (nothing read is not healthy). */
export function worstHealth(states: readonly HealthState[]): HealthState {
  if (states.length === 0) return 'unknown';
  return states.reduce((w, s) => (RANK[s] > RANK[w] ? s : w), 'ok' as HealthState);
}

/**
 * The tiles from the snapshots at `nowMs`: every factory service (unknown with `no_report` when nothing read it), and
 * every loop that was read. Pure: the same rule on the server and in tests.
 */
export function healthViewOf(snapshots: readonly HealthSnapshot[], nowMs: number): HealthView {
  const byId = new Map(snapshots.map((s) => [s.tile_id, s]));
  const tile = (id: string, domain: HealthDomain, label: string): HealthTile => {
    const s = byId.get(id);
    if (!s) {
      return {
        tile_id: id,
        domain,
        label,
        state: 'unknown',
        detail_code: 'no_report',
        sli_value: null,
        as_of: null,
        stale: false,
      };
    }
    const state = effectiveHealthState(s, nowMs);
    const stale = state === 'unknown' && s.state !== 'unknown';
    return {
      tile_id: id,
      domain,
      label,
      state,
      detail_code: stale ? 'stale' : s.detail_code,
      sli_value: stale ? null : s.sli_value,
      as_of: s.as_of,
      stale,
    };
  };
  const services = FACTORY_SERVICES.map((s) => tile(serviceTileId(s), 'service', s));
  const known = new Set<string>(services.map((t) => t.tile_id));
  const others = snapshots
    .filter((s) => !known.has(s.tile_id))
    .sort((a, b) => a.tile_id.localeCompare(b.tile_id))
    .map((s) => {
      const parts = s.tile_id.split('.');
      const label =
        s.domain === 'loop' && parts.length >= 3
          ? `${parts[1]} / ${parts.slice(2).join('.')}`
          : parts.slice(1).join('.');
      return tile(s.tile_id, s.domain, label);
    });
  const tiles = [...services, ...others];
  const counts: HealthCounts = { ok: 0, degraded: 0, down: 0, unknown: 0 };
  for (const t of tiles) counts[t.state] += 1;
  return {
    as_of: new Date(nowMs).toISOString(),
    overall: worstHealth(tiles.map((t) => t.state)),
    counts,
    tiles,
  };
}

// ---------------------------------------------------------------- degraded states (portal coverage §4)

/** One read model's freshness at read time: caught up with the record, or behind (and why). */
export const ReadModelFreshness = z.strictObject({
  name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  as_of_seq: z.number().int().min(0),
  head_seq: z.number().int().min(0),
  /** It could not catch up (it needs a rebuild, or the catch-up failed): the screens it feeds say so. */
  stale: z.boolean(),
  reason: z.string().nullable(),
});
export type ReadModelFreshness = z.infer<typeof ReadModelFreshness>;

/** The kill switch's verdict on one project, as a banner reads it (unreachable is killed, AR9). */
export const ProjectKillVerdict = z.strictObject({
  project_id: z.string().min(1),
  state: z.enum(['clear', 'killed', 'unreachable']),
  killed: z.boolean(),
  kill_ids: z.array(z.string().min(1)),
  message: z.string().nullable(),
});
export type ProjectKillVerdict = z.infer<typeof ProjectKillVerdict>;

/**
 * `GET /v1/degraded` (core) and `GET /api/degraded` (bff): what a screen must say before it shows anything else. The
 * kill switch's verdict per project (unreachable reads killed, AR9), the Notary (down: decisions fail closed, operator
 * actions wait for the backfill), and the read models that are behind.
 */
export const DegradedView = z.strictObject({
  as_of: IsoDateTime,
  kills: z.array(ProjectKillVerdict),
  notary: z.strictObject({
    /** The Notary's tile (the HealthSnapshot rule applied): `unknown` when nothing read it recently. */
    state: HealthState,
    detail_code: z.string().nullable(),
    as_of: IsoDateTime.nullable(),
    /** Operator actions executed and not yet ledgered (they are backfilled once the Notary answers). */
    pending_ops_actions: z.number().int().min(0),
  }),
  read_models: z.array(ReadModelFreshness),
});
export type DegradedView = z.infer<typeof DegradedView>;
