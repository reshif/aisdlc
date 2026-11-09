import { configProjection, loadEffective } from '@aisdlc/config';
import {
  FACTORY_SCOPE,
  IntegrationHealthReport,
  type IntegrationEvent,
  type IntegrationHealthTiles,
  type IntegrationKind,
  type IntegrationRegistryView,
} from '@aisdlc/contracts';
import {
  buildTiles,
  listIntegrationEvents,
  readHealth,
  readRegistry,
  recordHealth,
} from '@aisdlc/integrations';
import { runProjection } from '@aisdlc/record';
import type pg from 'pg';

// The integration registry as core serves it (PLAN M10.4): the effective registry for the processes
// that hold adapters (the codehost reads its row here; the gateway reads the same config straight from
// the database), the health those processes report, and the tiles built from the two. Core owns no
// state of the registry: the rows are published config, the health is the last report of each reporter.

/** The effective registry now: the factory layer's published `integrations.*` keys (empty before the first publish). */
export async function effectiveRegistry(
  pool: pg.Pool,
  kind?: IntegrationKind,
): Promise<IntegrationRegistryView> {
  const caught = await runProjection(pool, configProjection);
  if (!caught.ok) throw new Error('config projection');
  const layer = await loadEffective(pool, { layer: 'factory', scope: FACTORY_SCOPE });
  const view = readRegistry({
    get: <T = unknown>(k: string) => layer?.doc[k] as T | undefined,
    revisions: { factory: layer?.rev_hash ?? null },
  });
  if (kind === undefined) return view;
  const ids = new Set(
    view.integrations.filter((i) => i.kind === kind).map((i) => i.integration_id),
  );
  return {
    ...view,
    integrations: view.integrations.filter((i) => ids.has(i.integration_id)),
    installs: view.installs.filter((n) => ids.has(n.integration_id)),
  };
}

export async function healthTiles(pool: pg.Pool, now: Date): Promise<IntegrationHealthTiles> {
  return buildTiles(await effectiveRegistry(pool), await readHealth(pool), now);
}

export async function integrationEvents(pool: pg.Pool, id?: string): Promise<IntegrationEvent[]> {
  return listIntegrationEvents(pool, id === undefined ? {} : { integration_id: id });
}

/**
 * Stores a reporter's health reports. Only integrations of the registry are accepted (a report about a
 * name nobody registered is dropped, so a reporter cannot invent tiles), stamped with core's clock.
 */
export async function acceptHealth(
  pool: pg.Pool,
  raw: unknown,
  now: Date,
): Promise<{ recorded: number; ignored: number } | { error: string }> {
  const parsed = IntegrationHealthReport.safeParse(raw);
  if (!parsed.success)
    return {
      error: 'a health report has {reporter, reports:[{integration_id, state, detail_code?}]}',
    };
  const known = new Set((await effectiveRegistry(pool)).integrations.map((i) => i.integration_id));
  const reports = parsed.data.reports.filter((r) => known.has(r.integration_id));
  await recordHealth(pool, { reporter: parsed.data.reporter, reports }, now);
  return { recorded: reports.length, ignored: parsed.data.reports.length - reports.length };
}
