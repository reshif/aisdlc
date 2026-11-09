import {
  ITEM_EVENT,
  type AbandonCause,
  type BackEdgeId,
  type HandoffChoice,
  type PrincipalId,
  type SpawnEdge,
  type SpawnKind,
  type StepId,
  type Lane,
} from '@aisdlc/contracts';
import { readGateState } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { ItemState } from '@aisdlc/work';
import { coreError, type CoreError } from './errors.js';
import { maintenanceRefusal, type CoreDeps } from './journal.js';
import { ingestItem, readItem } from './work-items.js';

// The signals people and monitors send into an item (PLAN M9.3, M9.4): each is an event on the item's
// stream with an idempotency key, so the same signal twice is one. The interpreter decides whether it
// applies; this layer only checks what must be read from the ledger or the stream before recording it.

type Out = Result<{ state: ItemState; duplicate: boolean }, CoreError>;

/**
 * The owner of record's E4 choice. Taken only when E4 itself is decided (approve) IN THE LEDGER, by the
 * principal who chose: a choice with no decided E4, or from someone who did not decide it, is refused.
 */
export async function chooseHandoff(
  deps: CoreDeps,
  itemId: string,
  input: {
    handoff_id: string;
    choice: HandoffChoice;
    by: PrincipalId;
    extension_percent?: number;
    via?: 'E3' | 'E5';
    cause?: AbandonCause;
  },
): Promise<Out> {
  const mm = maintenanceRefusal(deps);
  if (mm) return err(mm);
  const item = await readItem(deps.pool, itemId);
  if (!item) return err(coreError('not_found', `no item ${itemId}`));
  const h = item.state.handoffs.find((x) => x.handoff_id === input.handoff_id);
  if (!h || h.status !== 'open') return err(coreError('conflict', 'no such open handoff'));
  if (h.e4_gate_instance_id === null) {
    return err(coreError('conflict', 'E4 is not open yet for this handoff'));
  }
  const gs = await readGateState(deps.pool, h.e4_gate_instance_id);
  if (!gs || gs.status !== 'decided' || gs.outcome !== 'approve') {
    return err(coreError('refused', 'E4 is not decided: the owner of record decides it first'));
  }
  if (!gs.approvers.includes(input.by)) {
    return err(coreError('forbidden', 'only the owner of record who decided E4 chooses'));
  }
  const { handoff_id, choice, by, extension_percent, via, cause } = input;
  const w = await ingestItem(deps, itemId, {
    type: ITEM_EVENT.handoff_chosen,
    payload: {
      handoff_id,
      choice,
      by,
      ...(extension_percent !== undefined ? { extension_percent } : {}),
      ...(via ? { via } : {}),
      ...(cause ? { cause } : {}),
    },
    actor: by,
    idempotency_key: `handoff:chosen:${handoff_id}`,
  });
  if (!w.ok) return w;
  return ok({ state: w.value.state, duplicate: w.value.duplicate });
}

const signal = async (
  deps: CoreDeps,
  itemId: string,
  type: (typeof ITEM_EVENT)[keyof typeof ITEM_EVENT],
  payload: object,
  actor: string,
  key: string,
  /** A decision of a person: refused while MM-2 is on. Observations (an amendment, a spawn) are not. */
  decision = false,
): Promise<Out> => {
  if (decision) {
    const mm = maintenanceRefusal(deps);
    if (mm) return err(mm);
  }
  const w = await ingestItem(deps, itemId, { type, payload, actor, idempotency_key: key });
  return w.ok ? ok({ state: w.value.state, duplicate: w.value.duplicate }) : w;
};

/** D4: the developer who took over hands the item back (once; `plan_changed` sends it through G3). */
export const handBack = (
  deps: CoreDeps,
  itemId: string,
  by: PrincipalId,
  plan_changed: boolean,
  key: string,
): Promise<Out> =>
  signal(deps, itemId, ITEM_EVENT.hand_back, { by, plan_changed }, by, `hand_back:${key}`, true);

/** D5: the developer completed the human-led work. */
export const completeHumanWork = (
  deps: CoreDeps,
  itemId: string,
  by: PrincipalId,
  key: string,
  /** B5 (M12.4): the plan artefacts the human stored, by step, and the commit they planned against. */
  plan?: { outputs: Record<string, string>; base_sha: string },
): Promise<Out> =>
  signal(
    deps,
    itemId,
    ITEM_EVENT.human_work_done,
    { by, ...(plan ? { outputs: plan.outputs, base_sha: plan.base_sha } : {}) },
    by,
    `human_done:${key}`,
    true,
  );

/** BLOCKED's exit: the platform owner says the environment is fixed. */
export const envFixed = (
  deps: CoreDeps,
  itemId: string,
  by: PrincipalId,
  key: string,
): Promise<Out> => signal(deps, itemId, ITEM_EVENT.env_fixed, { by }, by, `env_fixed:${key}`, true);

/** RELHOLD's exit: re-request the release (G5 again). */
export const reRequestRelease = (
  deps: CoreDeps,
  itemId: string,
  by: PrincipalId,
  key: string,
): Promise<Out> =>
  signal(deps, itemId, ITEM_EVENT.release_re_requested, { by }, by, `rerequest:${key}`, true);

/** An observed back-edge: B4 (the design reviewer), B14 (the unsure approver), B15 (the merge), B20 (the requester amends). */
export const requestRework = (
  deps: CoreDeps,
  itemId: string,
  r: {
    edge: BackEdgeId;
    step: StepId | null;
    reason_code: string;
    by: PrincipalId;
    variant?: 'a' | 'b';
    key: string;
  },
): Promise<Out> =>
  signal(
    deps,
    itemId,
    ITEM_EVENT.rework_requested,
    {
      edge: r.edge,
      step: r.step,
      reason_code: r.reason_code,
      by: r.by,
      ...(r.variant ? { variant: r.variant } : {}),
    },
    r.by,
    `rework:${r.edge}:${r.key}`,
  );

/** A NEW linked item: B16 (deploy unhealthy), B17 (escape), B18, B19 (audit miss), B26 (needs change). */
export const requestSpawn = (
  deps: CoreDeps,
  itemId: string,
  r: { edge: SpawnEdge; kind: SpawnKind; lane: Lane; index?: number; key: string; by: string },
): Promise<Out> =>
  signal(
    deps,
    itemId,
    ITEM_EVENT.spawn_requested,
    { edge: r.edge, kind: r.kind, lane: r.lane, index: r.index ?? 0 },
    r.by,
    `spawn:${r.edge}:${r.key}`,
  );

/** What an assumption's owner decides: accept it, or override it (with who did). */
export const decideAssumption = (
  deps: CoreDeps,
  itemId: string,
  assumption_id: string,
  state: 'accepted' | 'overridden',
  by: PrincipalId,
): Promise<Out> =>
  signal(
    deps,
    itemId,
    ITEM_EVENT.assumption_decided,
    { assumption_id, state, by },
    by,
    `assumption:${assumption_id}:${state}`,
  );

/**
 * R2 observed at the design review (4.6, while G3d is open): the reviewer finds the work smaller than its lane.
 * E1 decides it; the item goes back to 1.3 and G0 only if E1 is approved, and stays at G3d if it is denied.
 */
export const observeRelane = (
  deps: CoreDeps,
  itemId: string,
  r: { to_lane: Lane; reason_code: string; by: PrincipalId; key: string },
): Promise<Out> =>
  signal(
    deps,
    itemId,
    ITEM_EVENT.relane_requested,
    {
      edge: 'R2',
      trigger: 'smaller_than_lane',
      to_lane: r.to_lane,
      step: '4.6',
      reason_code: r.reason_code,
      by: r.by,
    },
    r.by,
    `relane:R2:${r.key}`,
  );
