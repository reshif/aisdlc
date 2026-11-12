import { z } from 'zod';
import { ConfigRevisionState } from './config.js';
import { GateInstanceId, IsoDateTime, LedgerEntryId, PrincipalId, Sha256Hex } from './ids.js';
import { CardDeciders } from './portal.js';
import { GateStatus } from '../states/gate-instance.js';
import { Tier } from '../values.js';
import { PROJECT_CONFIG_KEYS } from './core-events.js';
import { RELEASE_CONFIG_KEY } from './gate-relay.js';
import { PROJECT_DEFAULT_ENVELOPE_KEY, PROJECT_WIP_LIMIT_KEY } from './learn.js';

// The configuration console (portal-coverage §6, the config pattern every config screen uses): one
// registered key of the FACTORY layer, read from its lineage (`@aisdlc/config`), and a proposal of a
// new value, which is an ordinary config revision with its M1 gate. Nothing here publishes: a value
// changes only when the M1 gate is decided approve and the revision is published.
//
//   core  GET  /v1/config/keys                     ConfigKeySummary[]   (scope read)
//         GET  /v1/config/keys/:key                ConfigKeyView        (scope read)
//         POST /v1/config/keys/:key/proposals      ConfigProposeRequest -> ConfigProposeResult
//                                                  (scope portal; PDP config.propose on the fleet)
//   bff   the same under /api/config/... (reads: audit.read or config.propose on the fleet)

export const ConfigKeyKind = z.enum(['setting', 'ops_flag']);
export type ConfigKeyKind = z.infer<typeof ConfigKeyKind>;

/** A registered key: what it is and the JSON Schema of its value (generated from its Zod schema). */
export const ConfigKeySummary = z.strictObject({
  key: z.string().min(1),
  kind: ConfigKeyKind,
  description: z.string().min(1),
  /** May a project layer set it; the console proposes on the factory layer only. */
  overridable: z.boolean(),
  /** JSON Schema 2020-12 of the value, as `z.toJSONSchema` writes it. */
  json_schema: z.record(z.string(), z.unknown()),
});
export type ConfigKeySummary = z.infer<typeof ConfigKeySummary>;

/** One revision of the factory lineage as it bears on this key. */
export const ConfigKeyRevision = z.strictObject({
  rev_hash: Sha256Hex,
  parent_rev_hash: Sha256Hex.nullable(),
  state: ConfigRevisionState,
  gate_instance_id: GateInstanceId.nullable(),
  /** The M1 decision that published it (published revisions only). */
  ledger_entry_id: LedgerEntryId.nullable(),
  proposed_by: z.string().min(1),
  proposed_at: IsoDateTime,
  published_at: IsoDateTime.nullable(),
  /** The key's value in this revision; `null` with `set: false` when the revision leaves it out. */
  value: z.unknown(),
  set: z.boolean(),
  /** The revision changes this key against its parent (or the default, for the first one). */
  changes_key: z.boolean(),
});
export type ConfigKeyRevision = z.infer<typeof ConfigKeyRevision>;

export const ConfigPending = z.strictObject({
  revision: ConfigKeyRevision,
  gate_status: GateStatus.nullable(),
  /** Who decides the M1 gate (the factory's admin slot); empty holders: nobody can yet. */
  deciders: CardDeciders,
});
export type ConfigPending = z.infer<typeof ConfigPending>;

export const ConfigKeyView = z.strictObject({
  key: ConfigKeySummary,
  default: z.unknown(),
  effective: z.strictObject({
    value: z.unknown(),
    /**
     * `default`: no published revision sets the key. `revision`: the published revision of the layer shown sets it.
     * `factory` (a project-layer view only): the project sets nothing, so the factory layer's published value holds.
     */
    source: z.enum(['default', 'revision', 'factory']),
    rev_hash: Sha256Hex.nullable(),
    gate_instance_id: GateInstanceId.nullable(),
    ledger_entry_id: LedgerEntryId.nullable(),
    published_at: IsoDateTime.nullable(),
  }),
  /** The head of the lineage a proposal must name as its parent. */
  head_rev_hash: Sha256Hex.nullable(),
  pending: z.array(ConfigPending),
  /** Every revision of the lineage, newest first. */
  history: z.array(ConfigKeyRevision),
});
export type ConfigKeyView = z.infer<typeof ConfigKeyView>;

export const ConfigProposeRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  value: z.unknown(),
  /** The head the draft was made against; another head is refused (409 stale_parent). */
  parent_rev_hash: Sha256Hex.nullable(),
});
export type ConfigProposeRequest = z.infer<typeof ConfigProposeRequest>;

export const ConfigProposeResult = z.strictObject({
  rev_hash: Sha256Hex,
  parent_rev_hash: Sha256Hex.nullable(),
  gate_instance_id: GateInstanceId,
  /** Pending M1 gates of the lineage this proposal replaced. */
  superseded: z.array(z.string()),
});
export type ConfigProposeResult = z.infer<typeof ConfigProposeResult>;

// ---------------------------------------------------------------- the project layer (P1-5)
//
//   core  GET  /v1/projects/:id/config/keys          ConfigKeySummary[]     (scope read)
//         GET  /v1/projects/:id/config/keys/:key     ProjectConfigKeyView   (scope read)
//         PUT  /v1/projects/:id/settings             the proposal (the field below, `parent_rev_hash`; PDP
//                                                    project.settings.edit), an M1 at the project's admin slot
//   bff   GET  /api/projects/:id/config/keys[/:key]  (PDP project.view; `may_propose`: project.settings.edit)
//         POST /api/projects/:id/config/keys/:key/proposals  ConfigProposeRequest without on_behalf_of

/**
 * The keys of a project's own layer, and the field of `PUT /v1/projects/:id/settings` each is proposed through.
 * The one list: a screen or route names a project key only through it.
 */
export const PROJECT_LAYER_KEYS = {
  [PROJECT_CONFIG_KEYS.gating_profile]: 'gating_profile',
  [PROJECT_CONFIG_KEYS.role_map]: 'role_map',
  [PROJECT_CONFIG_KEYS.two_person]: 'two_person',
  [RELEASE_CONFIG_KEY]: 'release',
  [PROJECT_WIP_LIMIT_KEY]: 'wip_limit',
  [PROJECT_DEFAULT_ENVELOPE_KEY]: 'default_envelope',
  [PROJECT_CONFIG_KEYS.kill_delegations]: 'kill_delegations',
} as const;
export type ProjectLayerKey = keyof typeof PROJECT_LAYER_KEYS;
export const ProjectLayerKeyValues = Object.keys(PROJECT_LAYER_KEYS) as ProjectLayerKey[];
export const ProjectLayerKey = z.enum(
  ProjectLayerKeyValues as [ProjectLayerKey, ...ProjectLayerKey[]],
);

/**
 * One key of a project's layer: the value in force for the project (project, else factory, else default), the
 * project lineage's head, pending proposals with who decides their M1 (the project's admin slot), the history, and
 * the tier and deploys the floors are checked against (`projectSettingsTierViolations`, as the server does).
 */
export const ProjectConfigKeyView = ConfigKeyView.extend({
  project_id: z.string().min(1),
  /** The signed tier, else the attested floor; `null`: none yet (no floor to check). */
  tier: Tier.nullable(),
  deploys: z.boolean().nullable(),
});
export type ProjectConfigKeyView = z.infer<typeof ProjectConfigKeyView>;
