import { validateOutput } from '@aisdlc/agents';
import { catalogueFor } from '@aisdlc/catalogue';
import type { PrincipalId } from '@aisdlc/contracts';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import { coreError, type CoreError } from '../errors.js';
import type { CoreDeps } from '../journal.js';
import { completeHumanWork } from '../work-signals.js';
import { readItem } from '../work-items.js';
import type { GroundingPort } from './grounding.js';
import {
  boundCapacity,
  budgetEnvelope,
  plannedUnits,
  splitUnits,
  validateCapacity,
  validateSequence,
  validateTasks,
  validateUnitSplit,
  validateVerification,
} from './plan.js';
import { primaryAgentFor } from '@aisdlc/agents';
import { latestArtefact, storeArtefact } from './store.js';
import { planUnits } from './units.js';

// B5, "a human writes the plan" (PLAN M12.4; FL B5: 2 rejections, then a human writes the plan).
//
// MODEL. The catalogue's own exit for B5 is `human_writes_plan`, and the engine models it as the item waiting
// for a person (`waiting: human/plan`) until they say they are done; G3 then decides what they wrote. This is
// that person's side: they give the four parts of a plan in the SAME shapes the planner answers in, and the
// factory runs the SAME checks over them (the schema, the DAG, the sequence, the tasks, the oracle binding),
// stamps the base commit, stores each part as the artefact of its step, computes the budget envelope and the
// Units, and only then tells the engine they are done, with the hashes. G3 therefore binds what the human
// wrote exactly as it binds what an agent wrote, and the person who wrote it does not approve it (G3 is the
// design slot's, and a requester never decides their own request).
//
// WHY NOT E4's "takeover" / L8. Takeover hands the whole item to a developer for S2 to S6 (the lane becomes
// L8, the spec, the oracle specs and the design are thrown over the wall with it). B5's trouble is the plan
// only: the spec and the design were approved and stay approved, so only S5 is written by hand and every gate
// still decides it. The catalogue pins `human_writes_plan` as B5's exit; takeover remains available to the
// owner at E4 for the item as a whole.

export interface HumanPlan {
  readonly split: unknown;
  readonly sequence: unknown;
  readonly tasks: unknown;
  readonly verification: unknown;
  /** Optional: the plan's capacity input; absent, one Unit at a time and no review estimates. */
  readonly capacity?: unknown;
}

export interface HumanPlanDeps extends CoreDeps {
  readonly grounding: GroundingPort;
}

type Out = Record<string, unknown>;

/** The checks of one part: its schema (the planner's, strict) and then the deterministic ones. */
function refusal(
  parts: Array<[string, ReadonlyArray<{ path: string; code: string }>]>,
): string | null {
  const bad = parts.flatMap(([name, f]) => f.map((x) => `${name}: ${x.path} ${x.code}`));
  return bad.length === 0 ? null : bad.slice(0, 20).join('; ');
}

export async function submitHumanPlan(
  d: HumanPlanDeps,
  itemId: string,
  by: PrincipalId,
  plan: HumanPlan,
  key: string,
): Promise<
  Result<{ outputs: Record<string, string>; base_sha: string; units: number }, CoreError>
> {
  const item = await readItem(d.pool, itemId);
  if (!item) return err(coreError('not_found', `no item ${itemId}`));
  const s = item.state;
  if (s.waiting?.kind !== 'human' || s.waiting.what !== 'plan') {
    return err(coreError('conflict', 'no plan is waiting for a person to write it'));
  }
  const checkSchema = (o: unknown) => {
    const v = validateOutput('A3', o);
    return v.ok ? [] : v.error.errors.map((e) => ({ path: e.path, code: e.code }));
  };
  const split = { ...(plan.split as Out) };
  const sequence = { ...(plan.sequence as Out) };
  const tasks = { ...(plan.tasks as Out) };
  const verification = { ...(plan.verification as Out) };
  const capacityIn = plan.capacity ?? {
    kind: 'plan_capacity',
    max_parallel_units: 1,
    review_minutes: [],
    rationale: 'written by hand',
    assumptions: [],
  };
  const shape = refusal([
    ['split', checkSchema({ kind: 'plan_split', assumptions: [], ...split })],
    ['sequence', checkSchema({ kind: 'plan_sequence', assumptions: [], ...sequence })],
    ['tasks', checkSchema({ kind: 'plan_tasks', assumptions: [], ...tasks })],
    ['verification', checkSchema({ kind: 'plan_verification', assumptions: [], ...verification })],
    ['capacity', checkSchema({ assumptions: [], ...(capacityIn as Out) })],
  ]);
  if (shape) return err(coreError('invalid_input', shape));
  const oracles = (await latestArtefact(d.pool, itemId, 'oracle_specs'))?.content;
  const findings = refusal([
    ['split', validateUnitSplit(split)],
    ['sequence', validateSequence(sequence, split)],
    ['tasks', validateTasks(tasks, split)],
    ['verification', validateVerification(verification, split, oracles)],
    ['capacity', validateCapacity(capacityIn, split)],
  ]);
  if (findings) return err(coreError('invalid_input', findings));

  const g = await d.grounding.ground(s.repo);
  if (!g.ok) return err(coreError('unavailable', 'the merged commit could not be read'));
  const base_sha = g.value.merged_sha;
  const cat = catalogueFor(s.catalogue_ref);
  if (!cat.ok)
    return err(coreError('refused', 'the item is pinned to a catalogue this build lacks'));
  const coder = primaryAgentFor('6.4')?.contract.budget;
  if (!coder) return err(coreError('unavailable', 'no coding budget contract'));

  const store = async (
    type: Parameters<typeof storeArtefact>[1]['type'],
    step: Parameters<typeof storeArtefact>[1]['step'],
    content: Out,
  ) => {
    const r = await storeArtefact(d, {
      item_id: itemId,
      project_id: s.project_id,
      type,
      step,
      command_key: `human-plan:${key}:${step}`,
      run_id: null,
      content,
    });
    if (!r.ok) throw new Error(`the ${type} could not be stored`);
    return r.value.sha256;
  };
  try {
    const outputs: Record<string, string> = {};
    outputs['5.1'] = await store('unit_split', '5.1', {
      ...split,
      kind: 'plan_split',
      assumptions: split['assumptions'] ?? [],
      base_sha,
    });
    outputs['5.2'] = await store('unit_sequence', '5.2', {
      ...sequence,
      kind: 'plan_sequence',
      assumptions: sequence['assumptions'] ?? [],
      base_sha,
    });
    outputs['5.3'] = await store('plan', '5.3', {
      ...tasks,
      kind: 'plan_tasks',
      assumptions: tasks['assumptions'] ?? [],
      base_sha,
    });
    outputs['5.4'] = await store('verification_binding', '5.4', {
      ...verification,
      kind: 'plan_verification',
      assumptions: verification['assumptions'] ?? [],
      base_sha,
    });
    const lane = s.lane ?? s.proposed_lane;
    const { content, envelopes } = budgetEnvelope({
      lane,
      lane_default_budget_cents: cat.value.lanes[lane].profile.default_envelope.budget_cents,
      coder_budget: coder,
      units: splitUnits(split).map((u) => ({ unit_key: u.unit_key, size: u.size })),
      base_sha,
    });
    const planned = await planUnits(d, {
      item_id: itemId,
      project_id: s.project_id,
      repo: s.repo,
      plan_sha256: hashCanonical([outputs['5.1'], outputs['5.2'], outputs['5.3'], outputs['5.4']]),
      base_sha,
      units: plannedUnits(split, envelopes),
    });
    if (!planned.ok) throw new Error('the Units could not be recorded');
    outputs['5.5'] = await store('budget_envelope', '5.5', content);
    outputs['5.6'] = await store('capacity_input', '5.6', {
      ...boundCapacity(capacityIn as Out, split),
      base_sha,
    });
    const done = await completeHumanWork(d, itemId, by, key, { outputs, base_sha });
    if (!done.ok) return done;
    return ok({ outputs, base_sha, units: splitUnits(split).length });
  } catch (e) {
    return err(
      coreError('unavailable', e instanceof Error ? e.message : 'the plan could not be stored'),
    );
  }
}
