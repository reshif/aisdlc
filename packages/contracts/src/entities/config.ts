import { z } from 'zod';
import { Scope } from '../values.js';
import { IsoDateTime, JsonObject, LedgerEntryId, Sha256Hex } from './ids.js';

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

/** DM §3.11 `ConfigRevision.state`. */
export const ConfigRevisionState = z.enum(['current', 'superseded', 'rolled_back']);
export type ConfigRevisionState = z.infer<typeof ConfigRevisionState>;
export const ConfigRevisionStateValues: readonly ConfigRevisionState[] =
  ConfigRevisionState.options;

/**
 * A published configuration revision (DM §3.11; written only through `config_publish`, an M1 gate
 * decision). `layer` names the kind of config (DM: catalogue, roles, routes, s0, assistant); `scope`
 * is the factory or a project. The hash recipe for `rev_hash` is not fixed by the specs.
 */
export const ConfigRevision = z
  .strictObject({
    rev_hash: Sha256Hex,
    layer: z.string().regex(/^[a-z][a-z0-9_.-]*$/, 'layer name'),
    scope: Scope,
    previous_rev_hash: Sha256Hex.nullable(),
    state: ConfigRevisionState,
    /** The `config_publish` ledger entry. `null` only while the publish is not yet ledgered. */
    ledger_entry_id: LedgerEntryId.nullable(),
    content: JsonObject,
    published_at: IsoDateTime,
  })
  .refine((r) => r.previous_rev_hash !== r.rev_hash, {
    message: 'a revision cannot be its own predecessor',
    path: ['previous_rev_hash'],
  });
export type ConfigRevision = z.infer<typeof ConfigRevision>;
