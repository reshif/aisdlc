import { z } from 'zod';
import { ConfigRevisionState } from './config.js';
import { GateInstanceId, IsoDateTime, LedgerEntryId, PrincipalId, Sha256Hex } from './ids.js';
import { CardDeciders } from './portal.js';
import { GateStatus } from '../states/gate-instance.js';

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
    /** `default`: no published revision sets the key. */
    source: z.enum(['default', 'revision']),
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
