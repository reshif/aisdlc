import { laneEligibility as catalogueEligibility } from '@aisdlc/catalogue';
import {
  ITEM_EVENT,
  LevelValues,
  OPEN_INTAKE_CHANNELS,
  gatePolicy,
  type GateId,
  type Level,
  type RequestGateDeciders,
  type SubmitRequestReceipt,
  type EntryChannel,
  type InjectionReport,
  type Lane,
  type LaneEligibility,
  type PrincipalId,
  type ProjectId,
  type TaintedText,
} from '@aisdlc/contracts';
import type { EligibilityPort } from '@aisdlc/decisions';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import { injectionReportOf, taintMark } from '@aisdlc/work';
import { coreError, type CoreError } from './errors.js';
import { clockOf, maintenanceRefusal, type CoreDeps } from './journal.js';
import { ingestItem, readItem } from './work-items.js';
import { requestWork, type WorkState } from './work.js';

// Request intake (PLAN M9.1; FL REQ and S1 1.1, 1.2, 1.4). A person or a system asks for work on an
// entry channel; the factory normalises and taint-marks the text (1.1), scans for duplicates and
// conflicts (1.2), checks the repo's readiness for the lane (1.4: N8 hold, or L8 through the 1.4
// rule) and, if the request is not held, makes the work item. Everything is deterministic; the
// text is DATA from the first byte (FIX 15) and never reaches the interpreter.

export interface SubmitRequestInput {
  readonly project_id: ProjectId;
  readonly repo: string;
  /** The lane asked for or proposed (1.3 may change it; G0 binds it). */
  readonly lane: Lane;
  readonly requester: PrincipalId;
  /** N1 portal Ask and N3 API are open; the other channels are contract values (`OPEN_INTAKE_CHANNELS`). */
  readonly channel: EntryChannel;
  readonly text: string;
  /** A retry key: the same key is the same request, and the same item. */
  readonly request_id?: string;
}

export interface SubmitRequestResult {
  readonly request_id: string;
  readonly item_id: string | null;
  readonly state: WorkState;
  readonly verdict: LaneEligibility;
  readonly duplicate: boolean;
  readonly dedupe_links: readonly string[];
  /** B27: the scan of the text (`suspected` means it is fenced and the G0 card is flagged). */
  readonly injection: InjectionReport;
  /** 1.1: the text as kept, with its taint mark and provenance. */
  readonly request_text: TaintedText;
  readonly asked_lane: Lane;
}

export async function submitRequest(
  deps: CoreDeps,
  input: SubmitRequestInput,
): Promise<Result<SubmitRequestResult, CoreError>> {
  if (!OPEN_INTAKE_CHANNELS.includes(input.channel)) {
    return err(coreError('refused', `channel ${input.channel} is not open for requests yet`));
  }
  const marked = taintMark({
    raw: input.text,
    channel: input.channel,
    submitted_by: input.requester,
    received_at: new Date(Math.floor(clockOf(deps).nowMs())).toISOString(),
  });
  if (!marked.ok) return err(coreError('invalid_input', marked.error.message, marked.error));
  const text: TaintedText = marked.value;
  const r = await requestWork(deps, {
    project_id: input.project_id,
    repo: input.repo,
    lane: input.lane,
    requester: input.requester,
    channel: input.channel,
    ...(input.request_id ? { request_id: input.request_id } : {}),
    request_text: text,
    create_item: true,
  });
  if (!r.ok) return r;
  return ok({
    request_id: r.value.request_id,
    item_id: r.value.item_id ?? null,
    state: r.value.state,
    verdict: r.value.verdict,
    duplicate: r.value.duplicate,
    dedupe_links: r.value.dedupe_links ?? [],
    injection: injectionReportOf(text),
    request_text: text,
    asked_lane: input.lane,
  });
}

/** The gates a new item meets first, whose deciders the receipt names (FL: G0 and G1 on one card). */
const FIRST_GATES: readonly GateId[] = ['G0', 'G1'];

/** The lowest level whose catalogue row opens `lane` (the current catalogue: the one a new item pins). */
export const laneOpensAt = (lane: Lane): Level | null =>
  LevelValues.find((l) => catalogueEligibility(l, lane) === 'eligible') ?? null;

/**
 * The receipt of a request (P1-1, P2-17): what intake did, the lane it runs as and why, the lowest level that opens
 * the asked lane, and who decides G0 and G1 on the project now. Who decides is read from the role map; an error is
 * `null` holders with the reason (unknown, never "anyone"), and a held request (no item yet) names nobody.
 */
export async function requestReceipt(
  r: SubmitRequestResult,
  project: ProjectId,
  eligibility: EligibilityPort | undefined,
): Promise<SubmitRequestReceipt> {
  const deciders: RequestGateDeciders[] = [];
  if (r.item_id !== null) {
    for (const gate of FIRST_GATES) {
      const slot = gatePolicy(gate).slot;
      if (!eligibility) {
        deciders.push({ gate, slot, holders: null, reason: 'no identity is configured' });
        continue;
      }
      let h: Awaited<ReturnType<EligibilityPort['holders']>>;
      try {
        h = await eligibility.holders(project, slot);
      } catch (e) {
        deciders.push({
          gate,
          slot,
          holders: null,
          reason: `who holds ${slot} could not be read: ${e instanceof Error ? e.message : String(e)}`,
        });
        continue;
      }
      deciders.push(
        h.ok
          ? { gate, slot, holders: [...h.value].sort(), reason: null }
          : {
              gate,
              slot,
              holders: null,
              reason: `who holds ${slot} is unknown: ${h.error.message}`,
            },
      );
    }
  }
  return {
    request_id: r.request_id as never,
    item_id: r.item_id as never,
    state: r.state,
    verdict: r.verdict,
    duplicate: r.duplicate,
    dedupe_links: [...r.dedupe_links] as never,
    injection: r.injection,
    asked_lane: r.asked_lane,
    proposed_lane: r.verdict.route === 'l8' ? 'L8' : r.asked_lane,
    lane_opens_at: laneOpensAt(r.asked_lane),
    request_text: r.request_text,
    deciders,
  };
}

// ---------------------------------------------------------------- Human signals into an item

/**
 * 1.6, the Ready decision: a person says the request is ready for G0. Authorisation is the caller's
 * (the PDP in the route); here it is one signal with a key, so a repeat is a no-op.
 */
export async function decideReady(deps: CoreDeps, itemId: string, by: PrincipalId) {
  const mm = maintenanceRefusal(deps);
  if (mm) return err(mm);
  // One decision per visit of 1.6: a re-lane (R2) brings the item back to Ready, and that is a new
  // question for a person, not a repeat of the first answer.
  const st = (await readItem(deps.pool, itemId))?.state;
  const visit = st?.waiting?.kind === 'human' ? (st.attempts['h:1.6'] ?? 1) : 1;
  return ingestItem(deps, itemId, {
    type: ITEM_EVENT.ready_decided,
    payload: { by },
    actor: by,
    idempotency_key: visit === 1 ? `ready:${itemId}` : `ready:${itemId}:${visit}`,
  });
}

/**
 * The requester's answer to a question: tainted like any outside text (origin `answer`), so an
 * answer that tries to instruct the factory is flagged and fenced like the request itself.
 */
export async function answerQuestion(
  deps: CoreDeps,
  itemId: string,
  o: { question_id: string; text: string; by: PrincipalId; channel?: EntryChannel },
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  const item = await readItem(deps.pool, itemId);
  if (!item) return err(coreError('not_found', `no item ${itemId}`));
  const q = item.state.questions.find((x) => x.question_id === o.question_id);
  if (!q) return err(coreError('not_found', `no question ${o.question_id}`));
  const marked = taintMark({
    raw: o.text,
    channel: o.channel ?? 'N1',
    submitted_by: o.by,
    received_at: new Date(Math.floor(clockOf(deps).nowMs())).toISOString(),
    origin: 'answer',
  });
  if (!marked.ok) return err(coreError('invalid_input', marked.error.message, marked.error));
  const w = await ingestItem(deps, itemId, {
    type: ITEM_EVENT.question_answered,
    payload: { question_id: o.question_id, answer: marked.value, by: o.by },
    actor: o.by,
    idempotency_key: `answer:${o.question_id}`,
  });
  return w.ok ? ok({ duplicate: w.value.duplicate }) : w;
}

/** Ids derived for the work a request starts: stable, so a retried creation is the same creation. */
export const questionIdOf = (commandKey: string, index: number): string =>
  deterministicId<'WorkItem'>(`aisdlc.question:${commandKey}:${index}`);
