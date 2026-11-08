import {
  ITEM_EVENT,
  OPEN_INTAKE_CHANNELS,
  type EntryChannel,
  type InjectionReport,
  type Lane,
  type LaneEligibility,
  type PrincipalId,
  type ProjectId,
  type TaintedText,
} from '@aisdlc/contracts';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import { injectionReportOf, taintMark } from '@aisdlc/work';
import { coreError, type CoreError } from './errors.js';
import { clockOf, type CoreDeps } from './journal.js';
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
  });
}

// ---------------------------------------------------------------- Human signals into an item

/**
 * 1.6, the Ready decision: a person says the request is ready for G0. Authorisation is the caller's
 * (the PDP in the route); here it is one signal with a key, so a repeat is a no-op.
 */
export function decideReady(deps: CoreDeps, itemId: string, by: PrincipalId) {
  return ingestItem(deps, itemId, {
    type: ITEM_EVENT.ready_decided,
    payload: { by },
    actor: by,
    idempotency_key: `ready:${itemId}`,
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
