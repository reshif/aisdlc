import {
  aggregateHealth,
  effectiveHealthState,
  type IntegrationHealth,
  type IntegrationHealthReport,
  type IntegrationHealthState,
  type IntegrationHealthTile,
  type IntegrationHealthTiles,
  type IntegrationReporter,
  type IntegrationRegistryView,
  DEFAULT_OPS_HEALTH,
  SETTINGS_KEYS,
  settingInForce,
} from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';

// IntegrationHealth (PLAN M10.4): the last report of each reporter about each integration. The reporters
// are the processes that hold adapters (`codehost` through core's API, `gateway` straight to the
// table). A tile is built from the registry (what exists) and the reports (how it is doing); a report
// older than two minutes reads `unknown`, never green, and an integration nobody reported on is
// `unknown` too.

interface Row {
  integration_id: string;
  reporter: IntegrationReporter;
  state: IntegrationHealthState;
  detail_code: string | null;
  as_of: Date;
}

/** Stores a reporter's reports, stamped with the RECEIVER's clock (`now`). One row per (integration, reporter). */
export async function recordHealth(
  db: Executor,
  report: IntegrationHealthReport,
  now: Date,
): Promise<number> {
  for (const r of report.reports) {
    await db.query(
      `INSERT INTO integrations.integration_health (integration_id, reporter, state, detail_code, as_of)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (integration_id, reporter)
       DO UPDATE SET state = EXCLUDED.state, detail_code = EXCLUDED.detail_code, as_of = EXCLUDED.as_of`,
      [r.integration_id, report.reporter, r.state, r.detail_code ?? null, now.toISOString()],
    );
  }
  return report.reports.length;
}

export async function readHealth(db: Executor): Promise<IntegrationHealth[]> {
  const q = await db.query<Row>(
    `SELECT integration_id, reporter, state, detail_code, as_of
       FROM integrations.integration_health ORDER BY integration_id, reporter`,
  );
  return q.rows.map((r) => ({
    integration_id: r.integration_id,
    reporter: r.reporter,
    state: r.state,
    detail_code: r.detail_code,
    as_of: r.as_of.toISOString(),
  }));
}

/**
 * The tiles of the integrations panel: one per integration of the registry (whatever its status), the
 * shared health shape for a code host and a model provider alike.
 */
export function buildTiles(
  view: IntegrationRegistryView,
  health: readonly IntegrationHealth[],
  now: Date,
): IntegrationHealthTiles {
  const nowMs = now.getTime();
  const tiles = view.integrations.map((i): IntegrationHealthTile => {
    const mine = health.filter((h) => h.integration_id === i.integration_id);
    const reporters = mine.map((h) => ({
      reporter: h.reporter,
      state: effectiveHealthState(h, nowMs),
      reported_state: h.state,
      detail_code: h.detail_code,
      as_of: h.as_of,
    }));
    const state = aggregateHealth(mine, nowMs);
    const newest =
      mine
        .map((h) => h.as_of)
        .sort()
        .at(-1) ?? null;
    const stale =
      newest !== null &&
      nowMs - Date.parse(newest) >
        settingInForce(SETTINGS_KEYS.ops_health, DEFAULT_OPS_HEALTH).stale_after_ms;
    const worst = reporters.find((r) => r.state === state && state !== 'ok') ?? reporters[0];
    return {
      integration_id: i.integration_id,
      kind: i.kind,
      adapter: i.adapter,
      display_name: i.display_name,
      status: i.status,
      state,
      detail_code: mine.length === 0 ? 'no_report' : stale ? 'stale' : (worst?.detail_code ?? null),
      as_of: newest,
      stale,
      reporters,
      installs: view.installs.filter((n) => n.integration_id === i.integration_id && n.enabled)
        .length,
    };
  });
  return { as_of: now.toISOString(), registry_revision: view.revision, tiles };
}
