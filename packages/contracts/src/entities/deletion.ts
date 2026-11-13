import { z } from 'zod';
import { IsoDateTime, PrincipalId, Sha256Hex } from './ids.js';

// Deletion (owner decision 2026-11-13: "delete means delete"; docs/specs/deletion.md). Deleting an object removes
// its record events, read models and stored content; the ledger keeps each of its entries' hash, link and signature
// (redacted in place) so the chain still verifies. `deletion.performed` is the one fact a deletion leaves: who, what
// kind, the sha256 of each deleted id, counts. Never a name, never content.

/** The objects that can be deleted, as the routes name them (`DELETE /v1/<route>/:id`). */
export const DeletionKind = z.enum(['project', 'repo', 'item', 'person', 'team', 'binding']);
export type DeletionKind = z.infer<typeof DeletionKind>;
export const DeletionKindValues: readonly DeletionKind[] = DeletionKind.options;

/** The route segment of each kind. */
export const DELETION_ROUTES: Readonly<Record<DeletionKind, string>> = {
  project: 'projects',
  repo: 'repos',
  item: 'items',
  person: 'people',
  team: 'teams',
  binding: 'bindings',
};

/** The PDP action of each kind's delete. */
export const DELETION_ACTIONS = {
  project: 'project.delete',
  repo: 'repo.delete',
  item: 'item.delete',
  person: 'person.delete',
  team: 'team.delete',
  binding: 'binding.delete',
} as const satisfies Record<DeletionKind, string>;

/** `DELETE /v1/<kind>/:id`: the reason and the object's id typed back. */
export const DeletionRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  reason: z
    .string()
    .transform((s) => s.trim())
    .pipe(z.string().min(1, 'a deletion needs a reason').max(2000)),
  /** The id of the object, typed again by the person (the screen's "type the name"). */
  confirm: z.string().min(1),
});
export type DeletionRequest = z.infer<typeof DeletionRequest>;

export const DeletionPreviewRequest = z.strictObject({
  on_behalf_of: PrincipalId,
  kind: DeletionKind,
  id: z.string().min(1),
});
export type DeletionPreviewRequest = z.infer<typeof DeletionPreviewRequest>;

/** How much of each kind of thing a deletion removes (or would remove). */
export const DeletionCounts = z.strictObject({
  /** Record events removed with their stream. */
  record_events_removed: z.number().int().min(0),
  /** Record events of the object in streams of something else, redacted in place. */
  record_events_redacted: z.number().int().min(0),
  /** Ledger entries redacted to their hash. */
  ledger_entries_redacted: z.number().int().min(0),
  /** Read-model rows removed, all tables together. */
  read_model_rows: z.number().int().min(0),
  /** Objects purged from the object store. */
  objects: z.number().int().min(0),
});
export type DeletionCounts = z.infer<typeof DeletionCounts>;

/** What blocks a deletion, shown first. */
export const DeletionBlocker = z.strictObject({
  kind: z.enum(['legal_hold', 'not_found']),
  message: z.string().min(1),
});
export type DeletionBlocker = z.infer<typeof DeletionBlocker>;

export const DeletionPreview = z.strictObject({
  kind: DeletionKind,
  id: z.string().min(1),
  counts: DeletionCounts,
  /** The read models with rows to remove (table names only). */
  tables: z.array(z.string().min(1)),
  blockers: z.array(DeletionBlocker),
});
export type DeletionPreview = z.infer<typeof DeletionPreview>;

export const DELETION_EVENT = { performed: 'deletion.performed' } as const;
/** The ledger entry type of a deletion. */
export const DELETION_ENTRY_TYPE = 'deletion.performed' as const;
/** The entry type a redacted ledger entry and record event carry. */
export const REDACTED_TYPE = 'redacted' as const;
export const deletionStream = (deletionId: string): string => `deletion:${deletionId}`;

/** The object-store keys a deletion purges (on the record event only: the ledger entry has counts). */
export const DeletionObjectKey = z.strictObject({
  bucket: z.string().min(1),
  sha256: Sha256Hex,
});
export type DeletionObjectKey = z.infer<typeof DeletionObjectKey>;

/** The body of the `deletion.performed` ledger entry: no name, no content. */
export const DeletionPerformedBody = z.strictObject({
  deletion_id: z.uuid(),
  kind: DeletionKind,
  /** sha256 of the root id, and of every id the deletion found to be the object's (sorted). */
  root_hash: Sha256Hex,
  id_hashes: z.array(Sha256Hex),
  counts: DeletionCounts,
  /** The ledger entries this deletion redacted: `verify-ledger --allow-redacted` accounts for each by this list. */
  redacted_ledger_seqs: z.array(z.number().int().min(1)),
  /** sha256 of the reason (the reason itself is the requester's words, kept on the record event). */
  reason_hash: Sha256Hex,
  actor: PrincipalId,
  /** True when the PDP allowed it only through the factory admin's override. */
  override: z.boolean(),
  at: IsoDateTime,
});
export type DeletionPerformedBody = z.infer<typeof DeletionPerformedBody>;

/** The body of the `deletion.performed` record event: the ledger body, the reason and the keys to purge. */
export const DeletionPerformedEvent = z.strictObject({
  ...DeletionPerformedBody.shape,
  reason: z.string().min(1).max(2000),
  objects: z.array(DeletionObjectKey),
});
export type DeletionPerformedEvent = z.infer<typeof DeletionPerformedEvent>;

export const DeletionResult = z.strictObject({
  deletion_id: z.uuid(),
  kind: DeletionKind,
  counts: DeletionCounts,
  /** False when some objects could not be purged yet (the purge loop retries them). */
  objects_purged: z.boolean(),
  ledger_entry_id: z.uuid(),
});
export type DeletionResult = z.infer<typeof DeletionResult>;
