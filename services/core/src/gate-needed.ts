import {
  GateNeededDetail,
  ITEM_EVENT,
  ItemEventPayloads,
  type GateId,
  type StepId,
} from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';
import { readItemEvents } from './work-items.js';

// P1-8: what a stage reported with the X1 or the G3o it raised (`stage_gate_needed.detail`: the irreversible operation,
// the oracle deviations). The work driver binds it into the gate's facts and subject hash when it opens the gate; the
// portal's gate context reads it back from those facts. Only these two gates carry one.

const DETAILED: readonly GateId[] = ['X1', 'G3o'];

/**
 * The detail of the stage report that raised the gate about to open, or `null`: only for one X1 or G3o at the station
 * the facts name (`<step>!<gate>`), from the item's newest `stage_gate_needed` for that gate at that step. A G3o chained
 * after an approved E6 was raised by no stage report: `null`.
 */
export async function gateNeededFor(
  db: Executor,
  itemId: string,
  gates: readonly GateId[],
  facts: unknown,
): Promise<GateNeededDetail | null> {
  const gate = gates[0];
  if (gates.length !== 1 || gate === undefined || !DETAILED.includes(gate)) return null;
  const station = (facts as { station?: unknown } | null)?.station;
  if (typeof station !== 'string') return null;
  const m = /^(\d+\.\d+[a-z]?)!(\w+)$/.exec(station);
  if (!m || m[2] !== gate) return null;
  const step = m[1] as StepId;
  const schema = ItemEventPayloads[ITEM_EVENT.stage_gate_needed];
  const raised = (await readItemEvents(db, itemId))
    .filter((e) => e.type === ITEM_EVENT.stage_gate_needed)
    .map((e) => schema.safeParse(e.payload))
    .flatMap((p) => (p.success ? [p.data] : []))
    .filter((p) => p.gate === gate && p.step === step)
    .at(-1);
  const d = GateNeededDetail.safeParse(raised?.detail);
  if (!d.success) return null;
  // the detail must be the gate's own kind (X1: the operation; G3o: the deviations)
  const kind = gate === 'X1' ? 'irreversible_operation' : 'oracle_deviation';
  return d.data.kind === kind ? d.data : null;
}

/** The newest `stage_gate_needed` of a gate at a step (its reason code), for the portal. */
export async function stageGateNeededOf(
  db: Executor,
  itemId: string,
  gate: GateId,
  step: StepId,
): Promise<{ reason_code: string; detail: GateNeededDetail | null } | null> {
  const schema = ItemEventPayloads[ITEM_EVENT.stage_gate_needed];
  const p = (await readItemEvents(db, itemId))
    .filter((e) => e.type === ITEM_EVENT.stage_gate_needed)
    .map((e) => schema.safeParse(e.payload))
    .flatMap((x) => (x.success ? [x.data] : []))
    .filter((x) => x.gate === gate && x.step === step)
    .at(-1);
  return p ? { reason_code: p.reason_code, detail: p.detail ?? null } : null;
}
