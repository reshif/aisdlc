import {
  ConfigReader,
  loadEffective,
  proposeRevision,
  readLineage,
  type ConfigDeps,
  type ConfigRegistry,
  type ProposeResult,
} from '@aisdlc/config';
import {
  CONFIG_EVENT,
  DEFAULT_GATING_PROFILE,
  DEFAULT_TWO_PERSON,
  EMPTY_ROLE_MAP,
  GatingProfile,
  KillDelegation,
  MAINTENANCE_FLAG_KEY,
  PROJECT_CONFIG_KEYS,
  ProjectSettings,
  ProjectSettingsDoc,
  RoleMap,
  S0Calendar,
  S0FailureModel,
  S0TimeBoxes,
  S0_CONFIG_KEYS,
  S0_DEFAULT_CALENDAR,
  S0_DEFAULT_FAILURE_MODEL,
  S0_DEFAULT_TIMEBOXES,
  TwoPerson,
  configStream,
  projectSettingsTierViolations,
  type PrincipalId,
  type ProjectId,
  type ProjectSettingsWire,
  type Tier,
} from '@aisdlc/contracts';
import type { Written } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  projectSettingsError,
  type ProjectSettingsError,
  type ProjectSettingsPort,
} from '@aisdlc/ports';
import { z } from 'zod';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { getProjectState } from './queries.js';

// A project's settings (role map, two-person, gating profile, kill delegations) are CONFIG
// REVISIONS of the project layer (PLAN M7.1): a change is proposed through `proposeRevision`, which
// opens an M1 gate, and becomes effective only when `config_publish` finds the decided approve.
// Core never writes them any other way. The effective settings are read back through the config
// reader (defaults, then the published factory layer, then the published project layer), so a
// revision that is only proposed is never in force.

/** Registers the keys core's context owns: a project's settings, and the S0 driver's tunables. */
export function registerCoreConfig(registry: ConfigRegistry): ConfigRegistry {
  return registry
    .setting({
      key: PROJECT_CONFIG_KEYS.role_map,
      schema: RoleMap,
      default: EMPTY_ROLE_MAP,
      overridable: true,
      description: 'who holds each of the ten slots of the project (OB §1B)',
    })
    .setting({
      key: PROJECT_CONFIG_KEYS.two_person,
      schema: TwoPerson,
      default: DEFAULT_TWO_PERSON,
      overridable: true,
      description: 'two-person rule for X1, X2, E2, M4 and kill release (DEC-28)',
    })
    .setting({
      key: PROJECT_CONFIG_KEYS.gating_profile,
      schema: GatingProfile,
      default: DEFAULT_GATING_PROFILE,
      overridable: true,
      description: 'which human gates the project has, above the safety floor (OB §1C)',
    })
    .setting({
      key: PROJECT_CONFIG_KEYS.kill_delegations,
      schema: z.array(KillDelegation),
      default: [],
      overridable: true,
      description: 'project kill delegations, until revoked (DEC-29)',
    })
    .setting({
      key: S0_CONFIG_KEYS.failure_model,
      schema: S0FailureModel,
      default: S0_DEFAULT_FAILURE_MODEL,
      description: 'S0 failure model: send-backs, PARK after silence, machine retries (DEC-9)',
    })
    .setting({
      key: S0_CONFIG_KEYS.timeboxes,
      schema: S0TimeBoxes,
      default: S0_DEFAULT_TIMEBOXES,
      description: 'S0 step time boxes (OB §6.2), with the reminder at 2 business days on 0.1',
    })
    .setting({
      key: S0_CONFIG_KEYS.t0_attestation,
      schema: z.boolean(),
      default: true,
      description: "DEC-4: a T0 tier needs the owner's positive attestation on card 1",
    })
    .setting({
      key: S0_CONFIG_KEYS.calendar,
      schema: S0Calendar,
      default: S0_DEFAULT_CALENDAR,
      description:
        'the business-day calendar of the S0 timers and of the work lifecycle (PARK, item age)',
    })
    .opsFlag({
      key: MAINTENANCE_FLAG_KEY,
      default: false,
      description:
        'maintenance mode MM-2 (FL): timers frozen, decisions disabled, drafts kept. An ops flag: factory layer only',
    });
}

/**
 * MM-2 from the config reader: on when the flag is true, and also when it holds anything but a boolean
 * (a published value that no longer fits its schema is read as "on": unknown means unmet, so decisions
 * stay disabled and timers frozen until someone fixes the flag; a flag the registry does not know is off). One flag, read by every timer and
 * every decide path: the decision kernel (`DecisionDeps.maintenance`), the S0 driver, the work driver.
 */
export function maintenanceFrom(reader: ConfigReader): () => boolean {
  return () => {
    const c = reader.current();
    // A published value that no longer fits its schema fell back to the default (off): read it as on.
    if (c.rejected.includes(MAINTENANCE_FLAG_KEY)) return true;
    const v = c.get(MAINTENANCE_FLAG_KEY);
    return v === undefined ? false : v !== false;
  };
}

const lineageOf = (project: string) =>
  ({ layer: 'project', scope: { kind: 'project', ref: project } }) as const;

const KEYS = Object.values(PROJECT_CONFIG_KEYS);

/**
 * The settings in force for a project and its tier, or why there are none. A project with no
 * published project-layer revision has no settings (`unknown_project`): identity binds nothing and
 * the decision kernel refuses, which is the fail-closed answer. A published value that no longer
 * fits its schema is refused, never replaced by a default.
 */
export async function loadProjectSettings(
  pool: pg.Pool,
  registry: ConfigRegistry,
  project: ProjectId,
): Promise<Result<ProjectSettingsWire, ProjectSettingsError>> {
  try {
    const state = await getProjectState(pool, project);
    if (!state) return err(projectSettingsError('unknown_project', `unknown project ${project}`));
    const reader = await ConfigReader.create({ pool, registry, project });
    const cur = reader.current();
    if (cur.revisions.project === null) {
      return err(
        projectSettingsError('unknown_project', `no settings are published for ${project}`),
      );
    }
    if (cur.rejected.some((k) => KEYS.includes(k as never))) {
      return err(
        projectSettingsError('unavailable', 'a published setting no longer fits its schema'),
      );
    }
    const lineage = await readLineage(pool, lineageOf(project));
    const published = await pool.query<{ occurred_at: Date }>(
      `SELECT occurred_at FROM record.record_event
        WHERE stream = $1 AND type = $2 AND body ->> 'rev_hash' = $3 ORDER BY seq DESC LIMIT 1`,
      [configStream(lineageOf(project)), CONFIG_EVENT.published, cur.revisions.project],
    );
    const settings = ProjectSettings.safeParse({
      project_id: project,
      role_map: cur.values[PROJECT_CONFIG_KEYS.role_map],
      two_person: cur.values[PROJECT_CONFIG_KEYS.two_person],
      gating_profile: cur.values[PROJECT_CONFIG_KEYS.gating_profile],
      kill_delegations: cur.values[PROJECT_CONFIG_KEYS.kill_delegations],
      version: Math.max(1, lineage.published.length),
      updated_at: published.rows[0]?.occurred_at.toISOString() ?? state.project.updated_at,
    });
    if (!settings.success) {
      return err(projectSettingsError('unavailable', 'the published settings are not valid'));
    }
    return ok({ settings: settings.data, tier: state.project.tier });
  } catch (e) {
    return err(
      projectSettingsError(
        'unavailable',
        `settings: ${e instanceof Error ? e.message : String(e)}`,
      ),
    );
  }
}

/**
 * The real `ProjectSettingsPort` (PLAN M7.1) over core's own read models and the effective config.
 * Core's processes use this; identity and the decision kernel's eligibility, which run elsewhere,
 * reach the same answer over HTTP (`HttpProjectSettings`, core's `GET /v1/projects/:id/settings`).
 * The fakes stay for tests.
 */
export class DbProjectSettings implements ProjectSettingsPort {
  constructor(private readonly o: { readonly pool: pg.Pool; readonly registry: ConfigRegistry }) {}

  get(project: ProjectId) {
    return loadProjectSettings(this.o.pool, this.o.registry, project);
  }
}

export interface SettingsChange {
  readonly role_map?: RoleMap | undefined;
  readonly two_person?: TwoPerson | undefined;
  readonly gating_profile?: GatingProfile | undefined;
  readonly kill_delegations?: KillDelegation[] | undefined;
}

const mapConfigError = (e: { code: string; message: string }): CoreError =>
  coreError(
    e.code === 'database'
      ? 'database'
      : e.code === 'decision'
        ? 'refused'
        : e.code === 'unchanged' || e.code === 'stale_parent'
          ? 'conflict'
          : 'invalid_input',
    e.message,
  );

/**
 * Proposes new settings for a project as a project-layer config revision (which opens its M1 gate).
 * Parts not given keep their effective value; the document written is the full one. Refuses a
 * document that breaks a rule the config schema cannot see: a T2 project (the signed tier, or a
 * raise-only T2 floor attested at the request) locks two-person on and keeps the gating floor.
 */
export async function proposeProjectSettings(
  deps: ConfigDeps,
  input: { project: ProjectId; change: SettingsChange; proposed_by: PrincipalId },
): Promise<Result<Written<ProposeResult>, CoreError>> {
  const state = await getProjectState(deps.pool, input.project);
  if (!state) return err(coreError('not_found', `unknown project ${input.project}`));
  const current = await loadEffective(deps.pool, lineageOf(input.project));
  const base = (current?.doc ?? {}) as Record<string, unknown>;
  const doc = {
    [PROJECT_CONFIG_KEYS.role_map]:
      input.change.role_map ?? base[PROJECT_CONFIG_KEYS.role_map] ?? EMPTY_ROLE_MAP,
    [PROJECT_CONFIG_KEYS.two_person]:
      input.change.two_person ?? base[PROJECT_CONFIG_KEYS.two_person] ?? DEFAULT_TWO_PERSON,
    [PROJECT_CONFIG_KEYS.gating_profile]:
      input.change.gating_profile ??
      base[PROJECT_CONFIG_KEYS.gating_profile] ??
      DEFAULT_GATING_PROFILE,
    [PROJECT_CONFIG_KEYS.kill_delegations]:
      input.change.kill_delegations ?? base[PROJECT_CONFIG_KEYS.kill_delegations] ?? [],
  };
  const parsed = ProjectSettingsDoc.safeParse(doc);
  if (!parsed.success) return err(coreError('invalid_input', parsed.error.message));
  const tier: Tier | null = state.project.tier ?? state.attestations.tier_floor ?? null;
  if (tier !== null) {
    const problems = projectSettingsTierViolations(
      {
        project_id: input.project,
        role_map: parsed.data[PROJECT_CONFIG_KEYS.role_map],
        two_person: parsed.data[PROJECT_CONFIG_KEYS.two_person],
        gating_profile: parsed.data[PROJECT_CONFIG_KEYS.gating_profile],
        kill_delegations: parsed.data[PROJECT_CONFIG_KEYS.kill_delegations],
        version: 1,
        updated_at: state.project.updated_at,
      },
      { tier, deploys: state.project.deploys },
    );
    if (problems.length > 0) return err(coreError('refused', problems.join('; ')));
  }
  const r = await proposeRevision(deps, {
    layer: 'project',
    scope: { kind: 'project', ref: input.project },
    doc,
    proposed_by: input.proposed_by,
  });
  return r.ok ? ok(r.value) : err(mapConfigError(r.error));
}
