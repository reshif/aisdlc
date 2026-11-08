import { deterministicId, hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import { FLEET_REF, Scope, scopeKey } from '../values.js';
import { GateInstanceId, IsoDateTime, LedgerEntryId, ProjectId, Sha256Hex } from './ids.js';

// Configuration (DM §3.11).

/** `major.minor.patch` of the catalogue (`@aisdlc/catalogue`). */
export const CatalogueVersion = z
  .string()
  .regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'semver');
export type CatalogueVersion = z.infer<typeof CatalogueVersion>;

/**
 * The catalogue revision a request, item or S0 record started with (M1.6). `hash` is the sha256 of
 * the canonical JSON of the catalogue data; `version` alone is not enough, because two builds can
 * carry the same version string with different data.
 */
export const CatalogueRef = z.strictObject({
  version: CatalogueVersion,
  hash: Sha256Hex,
});
export type CatalogueRef = z.infer<typeof CatalogueRef>;

// ---------------------------------------------------------------- Layered configuration (M3.5)
//
// Configuration is a stack of layers. A layer is a FULL document (not a delta) at one scope:
// `factory` at the fleet scope, `project` at one project. A document is a flat map of dotted keys
// (`ops.kill.enabled`, `roles.map`) to values; the keys, and a Zod schema per key, are registered by
// the code that consumes them (`@aisdlc/config`), and a key nobody registered is refused. The DM
// layer names (catalogue, roles, routes, s0, assistant) are key namespaces inside the document,
// and ops flags are keys like any other.
//
// A revision is immutable. It becomes effective only by `config_publish`, which needs a decided
// `approve` of an M1 gate whose `subject_hash` is exactly the revision's `rev_hash`.

export const ConfigLayerKind = z.enum(['factory', 'project']);
export type ConfigLayerKind = z.infer<typeof ConfigLayerKind>;
export const ConfigLayerKindValues: readonly ConfigLayerKind[] = ConfigLayerKind.options;

/** A config key: dotted lowercase tokens. */
export const ConfigKey = z
  .string()
  .max(128)
  .regex(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/, 'dotted lowercase config key');
export type ConfigKey = z.infer<typeof ConfigKey>;

/** The full document of one layer: key -> value. */
export const ConfigDoc = z.record(ConfigKey, z.unknown());
export type ConfigDoc = z.infer<typeof ConfigDoc>;

/**
 * `proposed`: its M1 gate is pending (or the revision was just recorded). `current`: published and
 * the newest of its lineage. `superseded`: published, and a newer one is published. `rejected`: its
 * M1 gate ended without an approval (reject, request_changes, expire, withdraw, or a newer proposal
 * replaced it). `rolled_back` is kept from DM §3.11 for a later rollback task; nothing writes it yet.
 */
export const ConfigRevisionState = z.enum([
  'proposed',
  'current',
  'superseded',
  'rolled_back',
  'rejected',
]);
export type ConfigRevisionState = z.infer<typeof ConfigRevisionState>;
export const ConfigRevisionStateValues: readonly ConfigRevisionState[] =
  ConfigRevisionState.options;

/** The M1 gate of a factory-layer revision has no project; this reserved id stands in (PLAN M3.5). */
export const FACTORY_PROJECT_ID = ProjectId.parse('factory');

export const FACTORY_SCOPE: Scope = { kind: 'fleet', ref: FLEET_REF };

export interface ConfigLineage {
  readonly layer: ConfigLayerKind;
  readonly scope: Scope;
}

/** A layer is consistent with its scope: `factory` is the fleet, `project` is one project. */
export const scopeFitsLayer = (layer: ConfigLayerKind, scope: Scope): boolean =>
  layer === 'factory' ? scope.kind === 'fleet' : scope.kind === 'project';

/** The project whose `admin` slot decides the M1 gate of a lineage. */
export const configProjectOf = (l: ConfigLineage): string =>
  l.layer === 'factory' ? FACTORY_PROJECT_ID : l.scope.ref;

/** `factory:fleet:*`, `project:project:acme`. One lineage is one chain of revisions. */
export const configLineageKey = (l: ConfigLineage): string => `${l.layer}:${scopeKey(l.scope)}`;

/** The record stream of a lineage. */
export const configStream = (l: ConfigLineage): string => `config:${configLineageKey(l)}`;

/**
 * The `subject_id` of the M1 gate of a lineage (the gate contract wants a UUID): stable per
 * lineage, so a new proposal for the same lineage supersedes the pending one, as for any subject.
 */
export const configSubjectId = (l: ConfigLineage): string =>
  deterministicId<'ConfigLineage'>(`aisdlc.config:${configLineageKey(l)}`);

/**
 * The recipe of `rev_hash`: sha256 of the RFC 8785 canonical JSON of
 * `{layer, scope: {kind, ref}, parent_rev_hash, doc}`. The parent hash chains the revisions of a
 * lineage, so one hash fixes the document and everything before it; the M1 decision binds that hash.
 */
export function configRevHash(i: {
  layer: ConfigLayerKind;
  scope: Scope;
  parent_rev_hash: string | null;
  doc: ConfigDoc;
}): string {
  return hashCanonical({
    layer: i.layer,
    scope: { kind: i.scope.kind, ref: i.scope.ref },
    parent_rev_hash: i.parent_rev_hash,
    doc: i.doc,
  });
}

export const CONFIG_EVENT = {
  proposed: 'config.proposed',
  published: 'config.published',
} as const;
export const ConfigEventType = z.enum([CONFIG_EVENT.proposed, CONFIG_EVENT.published]);
export type ConfigEventType = z.infer<typeof ConfigEventType>;

/** Postgres NOTIFY channel a publish signals on (consumers also poll). */
export const CONFIG_NOTIFY_CHANNEL = 'aisdlc_config';

/** Payload of `config.proposed`: the immutable revision. */
export const ConfigProposedPayload = z.strictObject({
  rev_hash: Sha256Hex,
  layer: ConfigLayerKind,
  scope: Scope,
  parent_rev_hash: Sha256Hex.nullable(),
  doc: ConfigDoc,
  proposed_by: z.string().min(1),
});
export type ConfigProposedPayload = z.infer<typeof ConfigProposedPayload>;

/** Payload of `config.published`: the revision record event that references the M1 decision. */
export const ConfigPublishedPayload = z.strictObject({
  rev_hash: Sha256Hex,
  layer: ConfigLayerKind,
  scope: Scope,
  parent_rev_hash: Sha256Hex.nullable(),
  gate_instance_id: GateInstanceId,
  /** The ledger entry that decided the M1 gate (the approval that reached the quorum). */
  ledger_entry_id: LedgerEntryId,
  published_by: z.string().min(1),
});
export type ConfigPublishedPayload = z.infer<typeof ConfigPublishedPayload>;

/**
 * A configuration revision (DM §3.11). `state` is derived (see `ConfigRevisionState`), the rest is
 * immutable. `rev_hash` follows `configRevHash`. `ledger_entry_id` and `published_at` are set only
 * once the M1 decision exists and `config_publish` has run.
 */
export const ConfigRevision = z
  .strictObject({
    rev_hash: Sha256Hex,
    layer: ConfigLayerKind,
    scope: Scope,
    previous_rev_hash: Sha256Hex.nullable(),
    state: ConfigRevisionState,
    /** The M1 gate instance that decides (or decided) this revision. */
    gate_instance_id: GateInstanceId.nullable(),
    /** The M1 decision entry on the ledger. */
    ledger_entry_id: LedgerEntryId.nullable(),
    content: ConfigDoc,
    proposed_by: z.string().min(1),
    proposed_at: IsoDateTime,
    published_at: IsoDateTime.nullable(),
  })
  .refine((r) => r.previous_rev_hash !== r.rev_hash, {
    message: 'a revision cannot be its own predecessor',
    path: ['previous_rev_hash'],
  })
  .refine((r) => scopeFitsLayer(r.layer, r.scope), {
    message: 'the factory layer is the fleet scope, the project layer a project scope',
    path: ['scope'],
  })
  .refine(
    (r) =>
      (r.state === 'current' || r.state === 'superseded') ===
      (r.ledger_entry_id !== null && r.published_at !== null),
    { message: 'a published revision has its M1 ledger entry and a published_at', path: ['state'] },
  )
  .refine(
    (r) =>
      r.rev_hash ===
      configRevHash({
        layer: r.layer,
        scope: r.scope,
        parent_rev_hash: r.previous_rev_hash,
        doc: r.content,
      }),
    { message: 'rev_hash does not match the document', path: ['rev_hash'] },
  );
export type ConfigRevision = z.infer<typeof ConfigRevision>;
