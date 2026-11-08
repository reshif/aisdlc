import { z } from 'zod';
import { EntryChannel, Lane, StageId, Tier } from '../values.js';
import { WorkItemPhase } from '../states/work-item.js';
import { CatalogueRef } from './config.js';
import { IsoDateTime, PrincipalId, ProjectId, WorkItemId, WorkRequestId } from './ids.js';

// Work (DM §3.3). M1.4 does not list WorkItem or the request: these are the minimal shapes that
// carry the catalogue pin (M1.6). Everything else DM §3.3 gives them (risk class, projection
// document, last_global_seq, ...) is added by the milestone that owns it.

/** An inbound request (`work_item_request`), pinned to the catalogue revision current when it arrived. */
export const WorkRequest = z.strictObject({
  request_id: WorkRequestId,
  project_id: ProjectId,
  channel: EntryChannel,
  requester: PrincipalId,
  received_at: IsoDateTime,
  /** "N1-N8 · pins catalogue revision" (FL entry node). */
  catalogue_ref: CatalogueRef,
});
export type WorkRequest = z.infer<typeof WorkRequest>;

/**
 * A work item. `lane` is `null` until G0 binds the lane profile (FIX 7). `catalogue_ref` is copied
 * from the request and never changes: a later catalogue leaves in-flight items on their pin.
 */
export const WorkItem = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  request_id: WorkRequestId,
  phase: WorkItemPhase,
  lane: Lane.nullable(),
  stage: StageId.nullable(),
  owner_of_record: PrincipalId.nullable(),
  tier: Tier.nullable(),
  catalogue_ref: CatalogueRef,
});
export type WorkItem = z.infer<typeof WorkItem>;
