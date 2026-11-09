import {
  AGENT_EVENT,
  AgentRunDispatchedPayload,
  AgentRunFailedPayload,
  BACK_EDGES,
  ITEM_EVENT,
  ItemEventPayloads,
  STEPS,
  isAgentStep,
  type AgentJudgement,
  type AgentRunOutcome,
  type AgentRunResult,
  type AgentRunVerdict,
  type AgentRunView,
  type BackEdgeId,
  type GateId,
  type GateOutcome,
  type RecordEvent,
  type StageId,
  type StepId,
} from '@aisdlc/contracts';

// AgentRun and AgentRunOutcome as a pure fold (PLAN M11.2; DM §3.5, §5.2). Given everything the record
// holds about ONE item (its `item:` stream and its `agent:` stream) and the gateway's metered calls of
// the keys minted for it, the runs and what came of each. No clock, no I/O: core's read model calls this
// for an item whenever one of its streams grows, and a rebuild calls it again, so a rebuilt model equals
// the live one by construction.

/** What the gateway recorded of one call (`gateway.model_call`, no text), reduced to what a run sums. */
export interface CallFact {
  readonly call_id: string;
  readonly vkey_id: string;
  readonly tokens_in: number;
  readonly tokens_out: number;
  readonly cost_micro_usd: number;
  readonly provider_id: string | null;
  readonly model_id: string | null;
  /** `refused` calls cost nothing and are not counted as calls. */
  readonly outcome: string;
  readonly global_seq: number;
}

// ---------------------------------------------------------------- Which gates judge which runs

/**
 * The stages whose agent steps produce what a station gate decides on: G0 and G1 judge S1's output
 * (the intent block, the lane proposal), G2 the spec and oracle specs (S3), G3d the design (S4), G3 and
 * G3s the plan (S5), G4 the implementation and its review (S6, S7), G1f the shaped initiative (S2). The
 * gates raised mid-step (G3o, X1, X2, X3, E1, E2, E6) judge the run that raised them (below). G5 and G6
 * decide on a release and on acceptance, which no agent produces.
 */
export const GATE_JUDGES: Readonly<Partial<Record<GateId, readonly StageId[]>>> = {
  G0: ['S1'],
  G1: ['S1'],
  G1f: ['S2'],
  G2: ['S3'],
  G3d: ['S4'],
  G3: ['S5'],
  G3s: ['S5'],
  G4: ['S6', 'S7'],
};

/**
 * The back-edge the interpreter takes when a station gate refuses (`onRefused` in `@aisdlc/work`: FL B5,
 * B13, B22, B23, B24). It is derived here, not stored: the item stream does not record it as an event
 * of its own (it is the interpreter's move on `item.gate_decided`).
 */
export function refusalEdge(gate: GateId, outcome: GateOutcome): BackEdgeId | null {
  if (outcome !== 'reject' && outcome !== 'request_changes') return null;
  switch (gate) {
    case 'G0':
      return outcome === 'reject' ? 'B22' : null;
    case 'G2':
      return 'B23';
    case 'G3d':
      return 'B24';
    case 'G3':
    case 'G3s':
      return 'B5';
    case 'G4':
      return 'B13';
    default:
      return null;
  }
}

/** The steps a back-edge returns to that an agent acts at: the artefact that was reworked came from there. */
function reworkTargets(edge: BackEdgeId, variant: 'a' | 'b' | undefined): StepId[] {
  // B15a goes to 7.1 (deterministic: no agent), B15b back to the coder at 6.4
  if (edge === 'B15') return variant === 'a' ? [] : ['6.4'];
  return BACK_EDGES[edge].to.filter((t): t is StepId => t in STEPS && isAgentStep(t as StepId));
}

// ---------------------------------------------------------------- Fold

interface Draft {
  run: AgentRunView;
  /** global_seq of the dispatch (or of the failure that created the run). */
  born: number;
  /** global_seq of the result; `null` until one arrives. */
  answered: number | null;
  /** The gate this run raised (`stage_gate_needed`). */
  raised: GateId | null;
  judgements: AgentJudgement[];
}

const VERDICT_OF = (j: AgentJudgement): AgentRunVerdict => {
  switch (j.kind) {
    case 'gate':
      return j.outcome === 'approve'
        ? 'accepted'
        : j.outcome === 'reject'
          ? 'rejected'
          : 'sent_back';
    case 'back_edge':
      return 'reworked';
    case 'trigger':
      return 'handed_off';
  }
};

/** Whether a gate outcome judges (a decision), or only ends an instance without one (never judges). */
const decides = (o: GateOutcome): boolean =>
  o === 'approve' || o === 'reject' || o === 'request_changes';

const emptyOutcome = (run_id: string): AgentRunOutcome => ({
  run_id,
  verdict: 'pending',
  judgements: [],
  back_edges: [],
  triggers: [],
});

/**
 * Folds one item's runs. `events` are the item's `item:` and `agent:` events in any order (they are
 * sorted by `global_seq`); `calls` are the gateway calls of the item's keys. Runs come back in the order
 * they were dispatched.
 */
export function foldAgentRuns(
  events: readonly RecordEvent[],
  calls: readonly CallFact[] = [],
): AgentRunView[] {
  const ordered = [...events].sort((a, b) => a.global_seq - b.global_seq);
  const drafts = new Map<string, Draft>(); // by command_key
  const opened = new Map<string, number>(); // gate_instance_id -> global_seq of gates_opened

  const latestRun = (pred: (d: Draft) => boolean, before: number): Draft | undefined =>
    [...drafts.values()]
      .filter((d) => d.born < before && pred(d))
      .sort((a, b) => b.born - a.born)[0];

  const judge = (d: Draft, j: AgentJudgement) => d.judgements.push(j);

  for (const e of ordered) {
    switch (e.type) {
      case AGENT_EVENT.run_dispatched: {
        const p = AgentRunDispatchedPayload.parse(e.payload);
        const prior = drafts.get(p.command_key);
        const d: Draft = prior ?? {
          born: e.global_seq,
          answered: null,
          raised: null,
          judgements: [],
          run: {
            run_id: p.run_id,
            item_id: p.item_id,
            project_id: p.project_id,
            unit_id: p.unit_id,
            step: p.step,
            attempt: p.attempt,
            lane: p.lane,
            agent_id: p.binding.agent_id,
            contract_version: p.binding.contract_version,
            prompt_ref: p.binding.prompt_ref,
            prompt_sha256: p.binding.prompt_sha256,
            provider: null,
            model: null,
            vkey_id: p.binding.vkey_id,
            calls: 0,
            tokens_in: 0,
            tokens_out: 0,
            cost_micro_usd: 0,
            state: 'dispatched',
            result: null,
            failure_code: null,
            started_at: e.occurred_at,
            ended_at: null,
            outcome: emptyOutcome(p.run_id),
          },
        };
        if (prior) {
          // a failure came first (a refused key) and the run was dispatched after: the key is now known
          // and the run is under way again (a stage answer that came first still wins)
          d.run = {
            ...d.run,
            vkey_id: p.binding.vkey_id,
            unit_id: p.unit_id,
            started_at: e.occurred_at,
            ...(d.answered === null
              ? { state: 'dispatched' as const, failure_code: null, ended_at: null }
              : {}),
          };
        }
        drafts.set(p.command_key, d);
        break;
      }
      case AGENT_EVENT.run_failed: {
        const p = AgentRunFailedPayload.parse(e.payload);
        let d = drafts.get(p.command_key);
        if (!d) {
          d = {
            born: e.global_seq,
            answered: null,
            raised: null,
            judgements: [],
            run: {
              run_id: p.run_id,
              item_id: p.item_id,
              project_id: p.project_id,
              unit_id: null,
              step: p.step,
              attempt: p.attempt,
              lane: p.lane,
              agent_id: p.binding.agent_id,
              contract_version: p.binding.contract_version,
              prompt_ref: p.binding.prompt_ref,
              prompt_sha256: p.binding.prompt_sha256,
              provider: null,
              model: null,
              vkey_id: p.binding.vkey_id,
              calls: 0,
              tokens_in: 0,
              tokens_out: 0,
              cost_micro_usd: 0,
              state: 'dispatched',
              result: null,
              failure_code: null,
              started_at: e.occurred_at,
              ended_at: null,
              outcome: emptyOutcome(p.run_id),
            },
          };
          drafts.set(p.command_key, d);
        }
        // a stage answer that already came wins; the failure is then only history
        if (d.answered === null) {
          d.run = { ...d.run, state: 'failed', failure_code: p.code, ended_at: e.occurred_at };
        }
        break;
      }
      default:
        break;
    }
    if (!e.stream_id.startsWith('item:')) continue;

    const answer = (key: string | undefined, result: AgentRunResult, code?: string) => {
      const d = key === undefined ? undefined : drafts.get(key);
      if (!d || d.answered !== null) return d;
      d.answered = e.global_seq;
      d.run = {
        ...d.run,
        state: result === 'failed' ? 'failed' : 'finished',
        result,
        failure_code: result === 'failed' ? (code ?? null) : null,
        ended_at: e.occurred_at,
      };
      return d;
    };

    switch (e.type) {
      case ITEM_EVENT.stage_completed: {
        const p = ItemEventPayloads[ITEM_EVENT.stage_completed].parse(e.payload);
        answer(p.command_key, p.lane === undefined ? 'completed' : 'classified');
        break;
      }
      case ITEM_EVENT.stage_failed: {
        const p = ItemEventPayloads[ITEM_EVENT.stage_failed].parse(e.payload);
        answer(p.command_key, 'failed', p.code);
        break;
      }
      case ITEM_EVENT.questions_raised: {
        const p = ItemEventPayloads[ITEM_EVENT.questions_raised].parse(e.payload);
        answer(p.command_key, 'questions');
        break;
      }
      case ITEM_EVENT.stage_held: {
        const p = ItemEventPayloads[ITEM_EVENT.stage_held].parse(e.payload);
        answer(p.command_key, 'held');
        break;
      }
      case ITEM_EVENT.stage_gate_needed: {
        const p = ItemEventPayloads[ITEM_EVENT.stage_gate_needed].parse(e.payload);
        const d = answer(p.command_key, 'gate_needed');
        if (d) d.raised = p.gate;
        break;
      }
      case ITEM_EVENT.relane_requested: {
        const p = ItemEventPayloads[ITEM_EVENT.relane_requested].parse(e.payload);
        answer(p.command_key, 'relane');
        break;
      }
      case ITEM_EVENT.rework_requested: {
        const p = ItemEventPayloads[ITEM_EVENT.rework_requested].parse(e.payload);
        answer(p.command_key, 'rework');
        // the artefact that is being reworked came from the step the edge returns to
        for (const step of reworkTargets(p.edge, p.variant)) {
          const target = latestRun((d) => d.run.step === step && d.answered !== null, e.global_seq);
          if (target) judge(target, { kind: 'back_edge', edge: p.edge, seq: e.stream_seq });
        }
        break;
      }
      case ITEM_EVENT.trigger_fired: {
        const p = ItemEventPayloads[ITEM_EVENT.trigger_fired].parse(e.payload);
        // the run that raised it, else the latest run at the step, else the latest in the step's stage
        const own = p.command_key === undefined ? undefined : drafts.get(p.command_key);
        if (own) answer(p.command_key, 'trigger');
        const stage = STEPS[p.step].stage;
        const target =
          own ??
          latestRun((d) => d.run.step === p.step, e.global_seq) ??
          latestRun((d) => STEPS[d.run.step].stage === stage, e.global_seq);
        if (target) judge(target, { kind: 'trigger', trigger: p.trigger, seq: e.stream_seq });
        break;
      }
      case ITEM_EVENT.gates_opened: {
        const p = ItemEventPayloads[ITEM_EVENT.gates_opened].parse(e.payload);
        for (const g of p.gates) opened.set(g.gate_instance_id, e.global_seq);
        break;
      }
      case ITEM_EVENT.gate_decided: {
        const p = ItemEventPayloads[ITEM_EVENT.gate_decided].parse(e.payload);
        // expiry, closing and supersession end an instance without deciding: they judge nothing
        if (!decides(p.outcome)) break;
        const at = opened.get(p.gate_instance_id) ?? e.global_seq;
        const judgement: AgentJudgement = {
          kind: 'gate',
          gate: p.gate,
          gate_instance_id: p.gate_instance_id,
          outcome: p.outcome,
          ledger_entry_id: p.ledger_entry_id,
          edge: refusalEdge(p.gate, p.outcome),
          seq: e.stream_seq,
        };
        const stages = GATE_JUDGES[p.gate];
        if (stages !== undefined) {
          // the latest answered run of each agent step of those stages, before the gate was opened
          const bySteps = new Map<StepId, Draft>();
          for (const d of drafts.values()) {
            if (!stages.includes(STEPS[d.run.step].stage)) continue;
            if (d.answered === null || d.answered >= at) continue;
            if (d.run.result !== 'completed' && d.run.result !== 'classified') continue;
            const cur = bySteps.get(d.run.step);
            if (!cur || cur.born < d.born) bySteps.set(d.run.step, d);
          }
          for (const d of bySteps.values()) judge(d, judgement);
        } else {
          // a gate a stage raised judges the run that raised it
          const raiser = latestRun((d) => d.raised === p.gate, at);
          if (raiser) judge(raiser, judgement);
        }
        break;
      }
      default:
        break;
    }
  }

  // metering: the gateway's calls of each run's key
  const byKey = new Map<string, CallFact[]>();
  for (const c of calls) byKey.set(c.vkey_id, [...(byKey.get(c.vkey_id) ?? []), c]);

  const out: AgentRunView[] = [];
  for (const d of [...drafts.values()].sort((a, b) => a.born - b.born)) {
    const run = { ...d.run };
    const mine = (run.vkey_id === null ? [] : (byKey.get(run.vkey_id) ?? []))
      // a key is minted for one command; a Unit's key outlives it, so count only calls it made after dispatch
      .filter((c) => c.global_seq >= d.born)
      .sort((a, b) => a.global_seq - b.global_seq);
    const metered = mine.filter((c) => c.outcome !== 'refused');
    run.calls = metered.length;
    run.tokens_in = mine.reduce((n, c) => n + c.tokens_in, 0);
    run.tokens_out = mine.reduce((n, c) => n + c.tokens_out, 0);
    run.cost_micro_usd = mine.reduce((n, c) => n + c.cost_micro_usd, 0);
    const last = [...metered].reverse().find((c) => c.provider_id !== null || c.model_id !== null);
    run.provider = last?.provider_id ?? null;
    run.model = last?.model_id ?? null;

    const judgements = d.judgements;
    const back_edges: BackEdgeId[] = [];
    const triggers: AgentRunOutcome['triggers'] = [];
    for (const j of judgements) {
      const edge = j.kind === 'back_edge' ? j.edge : j.kind === 'gate' ? j.edge : null;
      if (edge !== null && !back_edges.includes(edge)) back_edges.push(edge);
      if (j.kind === 'trigger' && !triggers.includes(j.trigger)) triggers.push(j.trigger);
    }
    const lastJudgement = judgements.at(-1);
    run.outcome = {
      run_id: run.run_id,
      verdict: lastJudgement ? VERDICT_OF(lastJudgement) : 'pending',
      judgements,
      back_edges,
      triggers,
    };
    out.push(run);
  }
  return out;
}
