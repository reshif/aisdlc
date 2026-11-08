import { currentCatalogueRef } from '@aisdlc/catalogue';
import {
  WORK_EVENT,
  WorkAdmittedPayload,
  WorkFanOutPayload,
  WorkHeldPayload,
  WorkRequestedPayload,
  WorkRoutedL8Payload,
  repoKeyOf,
  workStream,
  type EntryChannel,
  type Lane,
  type LaneEligibility,
  type PrincipalId,
  type ProjectId,
  type ProjectReadinessRecord,
  type RecordEvent,
} from '@aisdlc/contracts';
import { deterministicId, err, newId, ok, type Result } from '@aisdlc/kernel';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import { coreError, type CoreError } from './errors.js';
import type { PrrVersion } from './fold.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps, type Journal } from './journal.js';
import { routeLane } from './lane-eligibility.js';
import { governingPrr } from './fold.js';
import { repoIdentity } from './prr-store.js';

// The work request intake, minimal (PLAN M7.6). The full request-to-item lifecycle is M9; what
// this owns is the part onboarding decides: where a request for a repo and a lane goes, the N8
// hold of a request for a repo with no active PRR, and the project-level fan-out an M4 causes.
// Everything is a record event on `work:<request_id>`. Nothing here starts an agent session, a
// unit or a work item: a request that is admitted waits for M9.

export type WorkState = 'requested' | 'held' | 'admitted' | 'routed_l8' | 'released' | 'l8_offered';

export interface WorkRequestState {
  readonly request: WorkRequestedPayload;
  readonly state: WorkState;
  readonly head_seq: number;
}

export function foldWork(events: readonly RecordEvent[]): WorkRequestState | null {
  let request: WorkRequestedPayload | null = null;
  let state: WorkState = 'requested';
  let head = 0;
  for (const e of events) {
    head = e.stream_seq;
    if (e.type === WORK_EVENT.requested) {
      request = WorkRequestedPayload.parse(e.payload);
      state = 'requested';
    } else if (e.type === WORK_EVENT.held) state = 'held';
    else if (e.type === WORK_EVENT.admitted) state = 'admitted';
    else if (e.type === WORK_EVENT.routed_l8) state = 'routed_l8';
    else if (e.type === WORK_EVENT.released) state = 'released';
    else if (e.type === WORK_EVENT.l8_offered) state = 'l8_offered';
  }
  return request ? { request, state, head_seq: head } : null;
}

export async function readWork(
  db: CoreDeps['pool'],
  requestId: string,
): Promise<WorkRequestState | null> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [workStream(requestId)],
  );
  return foldWork(q.rows.map(toRecordEvent));
}

export interface WorkRequestInput {
  readonly project_id: ProjectId;
  readonly repo: string;
  readonly lane: Lane;
  readonly requester: PrincipalId;
  /** Default `N1`; a request that the factory raises itself would say N6. */
  readonly channel?: EntryChannel;
  /** A retry key: the same key is the same request. */
  readonly request_id?: string;
}

export interface WorkRequestResult {
  readonly request_id: string;
  readonly state: WorkState;
  readonly verdict: LaneEligibility;
  /** True when `request_id` had been seen: nothing was written. */
  readonly duplicate: boolean;
}

/**
 * Takes a request for a lane on a repo. The repo's lock is held while the PRR is read, the same
 * lock an M4 takes to activate one, so a request is either held before the M4 (and the fan-out
 * sees it) or sees the active record. Eligible: `work.admitted`. No active PRR: `work.held` (N8).
 * Anything else: `work.routed_l8`, the 1.4 rule.
 */
export async function requestWork(
  deps: CoreDeps,
  input: WorkRequestInput,
): Promise<Result<WorkRequestResult, CoreError>> {
  const requestId = input.request_id
    ? deterministicId<'WorkRequest'>(`aisdlc.work:${input.request_id}`)
    : newId<'WorkRequest'>();
  const key = repoKeyOf(input.repo);
  return inCoreTx<WorkRequestResult>(deps, async (j, tx) => {
    await lockKeys(tx, [`repo:${key}`, `work:${requestId}`]);
    // A repo core has not registered yet has no PRR, so a request for it is held (N8) like any other;
    // the repo's onboarding registers it and its M4 then finds the hold.
    const id = await repoIdentity(tx, input.repo);
    if (id && id.project_id !== input.project_id) {
      return err(
        coreError('conflict', `repository ${id.repo_ref} belongs to project ${id.project_id}`),
      );
    }
    const prr = id ? governingPrr(await j.prr(id.project_id, id.repo_id)) : null;
    const repoRef = id?.repo_ref ?? input.repo;
    const verdict = routeLane(repoRef, input.lane, prr, clockOf(deps).now());
    const seen = foldWork(await j.events(workStream(requestId)));
    if (seen) {
      if (seen.request.lane !== input.lane || repoKeyOf(seen.request.repo) !== key) {
        return err(coreError('conflict', 'request_id was used for a different request'));
      }
      return ok({ request_id: requestId, state: seen.state, verdict, duplicate: true });
    }
    const stream = workStream(requestId);
    const actor = input.requester;
    const w = await j.emit(
      stream,
      WORK_EVENT.requested,
      WorkRequestedPayload.parse({
        request_id: requestId,
        project_id: input.project_id,
        repo: repoRef,
        lane: input.lane,
        channel: input.channel ?? 'N1',
        requester: input.requester,
        catalogue_ref: currentCatalogueRef(),
      }),
      actor,
    );
    if (!w.ok) return w;
    let state: WorkState;
    if (verdict.route === 'n8_hold') {
      // N8: the held card offers "Onboard" or "Continue as L8 human-led".
      const h = await j.emit(
        stream,
        WORK_EVENT.held,
        WorkHeldPayload.parse({
          request_id: requestId,
          channel: 'N8',
          reason: 'no_active_prr',
          offers: ['onboard', 'continue_as_l8'],
        }),
        actor,
      );
      if (!h.ok) return h;
      state = 'held';
    } else if (verdict.route === 'l8') {
      const r = await j.emit(
        stream,
        WORK_EVENT.routed_l8,
        WorkRoutedL8Payload.parse({
          request_id: requestId,
          requested_lane: input.lane,
          reason: verdict.reason,
          prr_version: verdict.prr?.version ?? null,
        }),
        actor,
      );
      if (!r.ok) return r;
      state = 'routed_l8';
    } else {
      const a = await j.emit(
        stream,
        WORK_EVENT.admitted,
        WorkAdmittedPayload.parse({
          request_id: requestId,
          lane: input.lane,
          prr_version: verdict.prr?.version ?? 1,
          record_hash: verdict.prr?.record_hash,
        }),
        actor,
      );
      if (!a.ok) return a;
      state = 'admitted';
    }
    return ok({ request_id: requestId, state, verdict, duplicate: false });
  });
}

// ---------------------------------------------------------------- the M4 fan-out

export interface FanOutReport {
  /** Held requests released into their lane. */
  readonly released: readonly string[];
  /** Held requests whose lane the new PRR does not open: L8 is offered, nothing else starts. */
  readonly l8_offered: readonly string[];
}

/** The held requests of a repo, oldest first (`work.held` and no later outcome). */
async function heldRequests(
  j: Journal,
  repo: string,
): Promise<Array<{ id: string; request: WorkRequestedPayload }>> {
  const q = await j.tx.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = $1 AND lower(body ->> 'repo') = $2 ORDER BY global_seq`,
    [WORK_EVENT.requested, repoKeyOf(repo)],
  );
  const out: Array<{ id: string; request: WorkRequestedPayload }> = [];
  for (const { stream } of q.rows) {
    const w = foldWork(await j.events(stream));
    if (w?.state === 'held') out.push({ id: w.request.request_id, request: w.request });
  }
  return out;
}

/**
 * The project-level fan-out of an M4 (PLAN M7.6; OB row 0.5): every N8 hold of the repo is looked
 * at against the record that was just made active. A request whose lane that record opens is
 * released; every other one is offered L8 human-led and stays out of the lane. Writes record
 * events only, in the M4's own transaction, and starts nothing. The caller holds the project and
 * repo locks.
 */
export async function fanOutHeld(
  j: Journal,
  tx: Parameters<typeof lockKeys>[0],
  o: {
    repo: string;
    prr: ProjectReadinessRecord;
    version: PrrVersion;
    s0_id: string;
    now: Date;
    actor: string;
  },
): Promise<Result<FanOutReport, CoreError>> {
  const held = await heldRequests(j, o.repo);
  await lockKeys(
    tx,
    held.map((h) => `work:${h.id}`),
  );
  const released: string[] = [];
  const offered: string[] = [];
  for (const h of held) {
    // Re-fold under the lock: the request may have moved since the listing.
    const cur = foldWork(await j.events(workStream(h.id)));
    if (cur?.state !== 'held') continue;
    const verdict = routeLane(o.repo, h.request.lane, o.version, o.now);
    const ok_ = verdict.route === 'normal' && verdict.eligible;
    const w = await j.emit(
      workStream(h.id),
      ok_ ? WORK_EVENT.released : WORK_EVENT.l8_offered,
      WorkFanOutPayload.parse({
        request_id: h.id,
        requested_lane: h.request.lane,
        prr_version: o.prr.version,
        record_hash: o.prr.record_hash,
        s0_id: o.s0_id,
        reason: verdict.reason,
      }),
      o.actor,
    );
    if (!w.ok) return w;
    (ok_ ? released : offered).push(h.id);
  }
  return ok({ released, l8_offered: offered });
}
