import {
  CATALOGUE_SECTIONS,
  CATALOGUE,
  catalogueSectionSchema,
  catalogueSettingKey,
  currentCatalogue,
  overlayFrom,
  planSettingsRelease,
  registerSettingsRelease,
  type CatalogueData,
  type SettingsReleasePlan,
} from '@aisdlc/catalogue';
import {
  CATALOGUE_EVENT,
  CATALOGUE_RELEASE_STREAM,
  CatalogueReleasedPayload,
  FACTORY_SCOPE,
  configLineageKey,
  type CatalogueRef,
  type JsonObject,
} from '@aisdlc/contracts';
import { lockKey } from '@aisdlc/decisions';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import { inTransaction } from '@aisdlc/ledger';
import { appendEvents, runProjection, type Executor, type Tx } from '@aisdlc/record';
import type pg from 'pg';
import { configError, type ConfigError } from './errors.js';
import { configProjection, loadEffective } from './projection.js';
import type { ConfigRegistry } from './registry.js';

// The catalogue from config (portal v2, H1-H5, H18-H21). One FACTORY key per catalogue section (`catalogue.lanes`,
// `catalogue.back_edge_limits`, ...), each with the section of the newest code release as its default, M1-gated like
// every revision. A published revision that changes a section makes a NEW catalogue release
// (`<base>+settings.<n>`, `@aisdlc/catalogue` settings.ts): recorded once, with its full data, as a
// `catalogue.released` event in the same transaction as the `config.published` that made it. New items pin the
// release the published settings make; an item keeps its pin, and `catalogueFor` reads the release once the process
// has loaded it (`loadSettingsReleases`).

const SECTION_LABEL: Readonly<Record<(typeof CATALOGUE_SECTIONS)[number], string>> = {
  lanes:
    'Tracks: each track’s steps, approvals, entry point, default budget per part and hotfix follow-up (H1, H5, H18)',
  back_edge_limits:
    'Retry limits per sent-back reason (B1-B28), including the light-review spot-check (B19) and approval overdue after (B21) (H2, H19, H8)',
  rework_budget: 'Rework limit: sends back and working days before a person takes over (H3)',
  envelope_extension: 'Budget extension: how often and by how much (H4)',
  flow_limits: 'Hand back once (D4) and find an alternative (X3)',
  triggers: 'Escalation triggers (ET1-ET14) and their thresholds',
  gating: 'Gating defaults per approval group and track, and the T2 floor',
  eligibility: 'Which tracks each onboarding level allows (H21)',
  autonomy: 'Agent autonomy caps by tier, level, readiness and posture (H20)',
  criteria: 'Readiness criteria and floors',
};

/** Registers the ten catalogue keys (factory layer only). Idempotent. */
export function registerCatalogueConfig(registry: ConfigRegistry): ConfigRegistry {
  for (const s of CATALOGUE_SECTIONS) {
    const key = catalogueSettingKey(s);
    if (registry.get(key)) continue;
    registry.setting({
      key,
      schema: catalogueSectionSchema(s),
      default: structuredClone(CATALOGUE[s]),
      overridable: false,
      description: `${SECTION_LABEL[s]}. Catalogue data: a change makes a new catalogue version for NEW items; running items keep theirs. Factory layer only, M1-gated`,
    });
  }
  return registry;
}

/** Every settings release recorded, oldest first. */
export async function readSettingsReleases(db: Executor): Promise<CatalogueReleasedPayload[]> {
  const q = await db.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
    [CATALOGUE_RELEASE_STREAM, CATALOGUE_EVENT.released],
  );
  return q.rows.flatMap((r) => {
    const p = CatalogueReleasedPayload.safeParse(r.body);
    return p.success ? [p.data] : [];
  });
}

/**
 * Loads every recorded settings release into this process's catalogue history (checked: a release whose data does
 * not hash to its hash is not loaded, and is reported). Call at boot and whenever config changes.
 */
export async function loadSettingsReleases(
  db: Executor,
): Promise<{ loaded: CatalogueRef[]; refused: string[] }> {
  const loaded: CatalogueRef[] = [];
  const refused: string[] = [];
  for (const r of await readSettingsReleases(db)) {
    const done = registerSettingsRelease(r);
    if (done.ok) loaded.push(done.value);
    else refused.push(`${r.version}: ${done.error.reason}`);
  }
  return { loaded, refused };
}

async function headSeq(tx: Executor, stream: string): Promise<number> {
  const q = await tx.query<{ seq: string }>(
    'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
    [stream],
  );
  return Number(q.rows[0]?.seq ?? 0);
}

/**
 * Inside a publish (or `ensureSettingsRelease`): the release the factory document `doc` makes, recorded if it is
 * new. The caller holds the factory lineage's lock, so releases are numbered one at a time. A document whose
 * sections do not read makes no release (the revision was validated when it was proposed; nothing to pin).
 */
export async function recordSettingsRelease(
  tx: Tx,
  doc: Readonly<Record<string, unknown>>,
  rev_hash: string,
  clock: Clock = systemClock,
): Promise<Result<SettingsReleasePlan, ConfigError>> {
  const overlay = overlayFrom(doc);
  if (!overlay.ok) return err(configError('invalid_value', overlay.error.reason));
  const existing = await readSettingsReleases(tx);
  const plan = planSettingsRelease({ overlay: overlay.value, existing, rev_hash });
  if (!plan.ok) return err(configError('invalid_value', plan.error.reason));
  if (plan.value.kind !== 'new') return ok(plan.value);
  const w = await appendEvents(
    tx,
    CATALOGUE_RELEASE_STREAM,
    await headSeq(tx, CATALOGUE_RELEASE_STREAM),
    [
      {
        type: CATALOGUE_EVENT.released,
        actor: 'system.config',
        idempotency_key: `catalogue.released:${plan.value.release.base.hash}:${plan.value.release.content_hash}`,
        body: plan.value.release as unknown as JsonObject,
      },
    ],
    { clock },
  );
  if (!w.ok) return err(configError('database', JSON.stringify(w.error)));
  return ok(plan.value);
}

/**
 * Makes sure the published factory settings have their release (a boot after a code release moved the base, or a
 * database that predates this feature). Takes the factory lineage's lock, as a publish does; record only.
 */
export async function ensureSettingsRelease(
  pool: pg.Pool,
  clock: Clock = systemClock,
): Promise<Result<SettingsReleasePlan | null, ConfigError>> {
  const lineage = { layer: 'factory', scope: FACTORY_SCOPE } as const;
  const caught = await runProjection(pool, configProjection);
  if (!caught.ok) return err(configError('database', JSON.stringify(caught.error)));
  return inTransaction(
    pool,
    async (tx) => {
      await lockKey(tx, `config:${configLineageKey(lineage)}`);
      const head = await loadEffective(tx, lineage);
      if (!head) return ok(null);
      return recordSettingsRelease(tx, head.doc as Record<string, unknown>, head.rev_hash, clock);
    },
    (e) => configError('database', e instanceof Error ? e.message : String(e)),
  );
}

export interface CataloguePin {
  readonly ref: CatalogueRef;
  readonly data: CatalogueData;
}

/**
 * The pin a NEW request, item or S0 record takes now: the release the published factory settings make (the code
 * release when they change nothing). Loads the recorded releases first; when the release is missing it is recorded
 * (`ensureSettingsRelease`) and loaded. `Err`: the settings do not read, or the release cannot be made: nothing new is
 * pinned (fail closed), the caller refuses the request.
 */
export async function pinCatalogue(
  pool: pg.Pool,
  clock: Clock = systemClock,
): Promise<Result<CataloguePin, ConfigError>> {
  const caught = await runProjection(pool, configProjection);
  if (!caught.ok) return err(configError('database', JSON.stringify(caught.error)));
  const head = await loadEffective(pool, { layer: 'factory', scope: FACTORY_SCOPE });
  const doc = (head?.doc ?? {}) as Record<string, unknown>;
  const tryNow = () => currentCatalogue(doc);
  let now = tryNow();
  if (!now.ok && now.error._tag === 'SettingsReleaseMissing') {
    await loadSettingsReleases(pool);
    now = tryNow();
    if (!now.ok && now.error._tag === 'SettingsReleaseMissing') {
      const made = await ensureSettingsRelease(pool, clock);
      if (!made.ok) return made;
      await loadSettingsReleases(pool);
      now = tryNow();
    }
  }
  if (!now.ok) {
    const reason =
      now.error._tag === 'SettingsReleaseMissing'
        ? `release ${now.error.version} is missing`
        : now.error.reason;
    return err(configError('invalid_value', `no catalogue to pin: ${reason}`));
  }
  return ok(now.value);
}
