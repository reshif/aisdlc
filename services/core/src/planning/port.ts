import { readSandboxCaps } from '@aisdlc/config';
import { DEFAULT_RUNNER_HOST } from '../admission/admit.js';
import {
  OFFERABLE_TOOLS,
  buildContext,
  inputSchemaFor,
  primaryAgentFor,
  quoteAsData,
  withAgentSettings,
  validateOutput,
  type ArtefactPiece,
  type OutputFieldError,
} from '@aisdlc/agents';
import { catalogueFor, type CatalogueData } from '@aisdlc/catalogue';
import {
  AGENT_EVENT,
  AgentRunFailedPayload,
  ProposalRecordedPayload,
  agentStream,
  DEFAULT_CONSTITUTION,
  GateArtefactRef,
  type AgentBinding,
  type AgentRunFailureCode,
  type ArtefactType,
  type Constitution,
  type ProposalReason,
  type StageOutcome,
  type StageRequest,
  type ReonboardTriggersConfig,
  type AgentsSettingsConfig,
  type PlanningSizeShareConfig,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import {
  StagePortError,
  type KnowledgeSearchPort,
  type PlanningPort,
  type RunKeyLender,
} from '@aisdlc/ports';
import { readOpened } from '@aisdlc/decisions';
import { limitValue, type ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { z } from 'zod';
import { affirmedInstructionsOf } from '../drift/affirmed.js';
import { inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { recordKnowledgeDefects } from '../knowledge-defects.js';
import { readItem } from '../work-items.js';
import { readWork } from '../work.js';
import { checkContractFiles, designFactsOf, evaluateConstitution } from './design.js';
import { laneForClassification, shallowerLane, type WorkClassification } from './lanes.js';
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
import { planUnits } from './units.js';
import { type GroundingPort } from './grounding.js';
import { callMessages, type ContentBlock, type ModelCallOptions } from './model-call.js';
import {
  PLANNING_ACTOR,
  ArtefactRefused,
  artefactOfCommand,
  latestArtefact,
  recordProposal,
  secretRules,
  storeArtefact,
  type LoadedArtefact,
} from './store.js';
import {
  STEP_SPECS,
  isPlanningStep,
  outcomeFor,
  ungrounded,
  wrongKind,
  type PlanningStep,
} from './steps.js';
import { validateOracles, validateSpecDelta } from './validate.js';

// AgentPlanningPort (PLAN M12.1, M12.2): the real PlanningPort for S2 and S3.
//
// WHERE IT LIVES. In services/core, not a new package: it needs core's record journal, its `artefact` table,
// the item streams and the agent streams, all of which are core's. The pure halves a later task reuses are
// separate modules beside it (render, validate, steps, lanes); the ports it needs (the key lender, the
// knowledge search) are in `@aisdlc/ports` with fakes. Steps outside S2 and S3 go to `fallback` (the fake until
// M12.3 and M12.4 build S4 and S5, and S1's agents).
//
// WHAT IT DOES for an agent-acted step, once per command (a redelivery finds its answer and calls nothing):
//   1. grounding: the merged head (`GroundingPort`), the factory policy, the request text as data;
//   2. the context: `buildContext` (precedence, provenance headers, fences, lint, budget), with the item's
//      accepted intent block at level 2 only when a person approved G0/G1 on the item, and the earlier
//      artefacts the step may read as level 6 data;
//   3. the call: the gateway's `/v1/messages` under the RUN'S virtual key, which the port borrows from a
//      `RunKeyLender` for the length of the call (it never holds the secret as a value), with the locked
//      prompt and the tools the key carries and the port can run (`KnowledgeSearch`, read-only, at the
//      merged commit only: the model supplies a query, never a repo or a commit);
//   4. the answer is parsed, checked against the OutputSchema (`validateOutput`), the step's expected kind,
//      the grounding rule (every cited commit is the merged head), the secret ruleset (a hit, or the
//      gateway's own redaction mark, refuses it) and, at 3.4, the oracle mapping. Invalid: the proposal is
//      recorded as rejected (a hash and field paths, never text), `agent.run_failed` `output_invalid` (or
//      `secret_in_output`) is recorded, and the call is made again with the field errors named, up to the
//      catalogue's B3 `auto_rounds` (3); then ET8 (a D1 handoff). Valid: the output is stored as an
//      Artefact (content-addressed, secret-scanned, one `artefact.stored` event with the hash) and a
//      Proposal links item, step, run and artefact hash.
//   3.3 is code: the schema and structural checks over the spec delta; a failure is B3 (the engine counts
//   3 automatic rounds, then ET8).

export interface AgentPlanningDeps extends CoreDeps {
  readonly gateway: ModelCallOptions;
  /** Where the run's key secret is borrowed from (the work driver's vault). */
  readonly keys: RunKeyLender;
  readonly grounding: GroundingPort;
  /** The `KnowledgeSearch` tool's backend; absent: the tool is not offered. */
  readonly search?: KnowledgeSearchPort;
  /** Every step this port does not own (1.2, 1.4, 1.6, the human steps and S6 on). */
  readonly fallback: PlanningPort;
  /** The locked prompt text of `name@version`. */
  readonly prompt: (ref: string) => string;
  /**
   * The factory constitution 4.5 checks a design against (config `factory.constitution`, M1-gated). Absent: the
   * built-in default. Returns `null` when the published value cannot be read: that is a violation (unknown
   * means unmet), never a pass.
   */
  readonly constitution?: () => Constitution | null;
  readonly maxOutputTokens?: number;
  /** Tool-use round trips inside one answer (default 6; the last call is made without tools). */
  readonly maxToolRounds?: number;
  /** `onboarding.reonboard_triggers` (M17): the knowledge-defect threshold; absent: the spec's 3 in 30 days. */
  readonly reonboardTriggers?: () => ReonboardTriggersConfig;
  /** Portal v2 (`agents.config`): the model and budget per agent; absent or unreadable: the contract's. */
  readonly agentSettings?: () => AgentsSettingsConfig | null;
  /** Portal v2 (`planning.size_share`, H15): the budget share per part size; `null`: unreadable (5.5 fails). */
  readonly sizeShare?: () => PlanningSizeShareConfig | null;
}

type Ctx = Parameters<typeof outcomeFor>[3];
type Refusal = { readonly reasons: ProposalReason[]; readonly code: AgentRunFailureCode };
const sanePath = (p: string): string => (/^[A-Za-z0-9_.[\]$]{1,120}$/.test(p) ? p : '?');
const reasonsOf = (errors: readonly OutputFieldError[]): ProposalReason[] =>
  errors.slice(0, 50).map((e) => ({ path: sanePath(e.path), code: e.code.slice(0, 64) }));

const portError = (message: string) => err(StagePortError({ message }));

/** Pulls the one JSON object out of a model answer: the whole text, or a single fenced block. */
function parseJson(text: string): unknown {
  const t = text.trim();
  for (const c of [t, /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(t)?.[1]]) {
    if (c === undefined) continue;
    try {
      return JSON.parse(c);
    } catch {
      /* next candidate */
    }
  }
  return undefined;
}

/**
 * The intent block a person accepted, for context level 2: the newest one, and only when an approved G0 or G1
 * of the item bound THAT block by hash. An intent block written after the approval (a B2 redraft) is not
 * accepted until a person approves it: it is the agent's own words until then.
 */
export async function acceptedIntentOf(
  pool: pg.Pool,
  itemId: string,
  s: Pick<ItemState, 'gates'>,
): Promise<{ text: string; gate_ref: string } | null> {
  const a = await latestArtefact(pool, itemId, 'intent_block');
  if (!a) return null;
  const approved = s.gates.filter(
    (g) =>
      (g.gate === 'G0' || g.gate === 'G1') && g.status === 'decided' && g.outcome === 'approve',
  );
  for (const g of [...approved].reverse()) {
    const o = await readOpened(pool, g.gate_instance_id);
    const facts = z
      .looseObject({ artefacts: z.array(GateArtefactRef).optional() })
      .safeParse(o?.payload.facts);
    const bound = facts.success ? (facts.data.artefacts ?? []) : [];
    if (bound.some((r) => r.type === 'intent_block' && r.sha256 === a.row.sha256)) {
      return { text: JSON.stringify(a.content), gate_ref: `gate:${g.gate_instance_id}` };
    }
  }
  return null;
}

export class AgentPlanningPort implements PlanningPort {
  readonly port = 'planning' as const;
  constructor(private readonly d: AgentPlanningDeps) {}

  async run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    if (!isPlanningStep(req.step)) return this.d.fallback.run(req);
    try {
      return await this.step(req, req.step);
    } catch (e) {
      // the name of the failure, never its message (a message could carry text of a request or an answer)
      return portError(
        `planning step ${req.step} failed: ${e instanceof Error ? e.name : 'error'}`,
      );
    }
  }

  private async step(
    req: StageRequest,
    step: PlanningStep,
  ): Promise<Result<StageOutcome, StagePortError>> {
    const d = this.d;
    const spec = STEP_SPECS[step];
    const item = await readItem(d.pool, req.item_id);
    if (!item) return portError('no such item');
    const s = item.state;
    const cat = catalogueFor(req.catalogue_ref);
    if (!cat.ok) return portError('the item is pinned to a catalogue this build does not have');

    const shallower = shallowerLane(cat.value, s.profile, s.tier, req.lane);
    // 1.3: the lane is the FACTORY's, derived from what the classifier said by the catalogue's rules. A re-lane
    // R2 that a person approved at E1 stands: the item comes back to 1.3 with the lane they chose.
    const chooseLane = (c: Record<string, unknown>) => {
      if (s.relanes.at(-1)?.edge === 'R2') return s.proposed_lane;
      return (
        laneForClassification(cat.value, s.profile, s.tier, c as unknown as WorkClassification) ??
        req.lane
      );
    };
    const ctx = { lane: req.lane, shallower, chooseLane } as const;

    // a redelivery: the command already stored its artefact, so it answers from it and does nothing else
    const prior = await artefactOfCommand(d.pool, req.item_id, req.command_key, spec.artefact);
    if (prior) {
      return ok(outcomeFor(step, prior.content as Record<string, unknown>, prior.row.sha256, ctx));
    }
    if (step === '3.3') return this.validate(req, s, ctx);
    if (step === '5.5') return this.envelope(req, s, cat.value, ctx);
    return this.agentStep(req, step, s, limitValue(cat.value, 'B3', 'auto_rounds') ?? 3, ctx);
  }

  // ------------------------------------------------------------ 3.3, deterministic

  private async validate(
    req: StageRequest,
    s: ItemState,
    ctx: Ctx,
  ): Promise<Result<StageOutcome, StagePortError>> {
    const delta = await latestArtefact(this.d.pool, req.item_id, 'spec_delta');
    if (!delta) return ok({ outcome: 'failed', code: 'missing_input' });
    const affected = await latestArtefact(this.d.pool, req.item_id, 'affected_requirements');
    const findings = validateSpecDelta(
      delta.content,
      (affected?.content as { requirements?: Array<{ requirement_id?: unknown }> } | undefined) ??
        null,
    );
    const content = {
      kind: 'validation',
      subject_sha256: delta.row.sha256,
      verdict: findings.length === 0 ? 'pass' : 'findings',
      findings: findings.map((f) => ({
        severity: f.severity,
        code: f.code,
        location: { path: f.path },
        message: f.message,
      })),
    };
    const stored = await storeArtefact(this.d, {
      item_id: req.item_id,
      project_id: s.project_id,
      type: 'validation_report',
      step: '3.3',
      command_key: req.command_key,
      run_id: null,
      content,
    });
    if (!stored.ok) return portError('the validation report could not be stored');
    return ok(outcomeFor('3.3', content, stored.value.sha256, ctx));
  }

  // ------------------------------------------------------------ agent steps

  private async agentStep(
    req: StageRequest,
    step: PlanningStep,
    s: ItemState,
    autoRounds: number,
    ctx: Ctx,
  ): Promise<Result<StageOutcome, StagePortError>> {
    const d = this.d;
    const spec = STEP_SPECS[step];
    const contractDef = primaryAgentFor(step);
    // Portal v2 (`agents.config`): the model and budget the factory set for the agent; the key was minted with them
    const table = d.agentSettings?.();
    const def =
      contractDef && table
        ? withAgentSettings(contractDef, table[contractDef.agent_id])
        : contractDef;
    const binding = req.agent;
    if (def === null || binding === undefined || binding.agent_id !== def.agent_id) {
      return ok({ outcome: 'failed', code: 'no_agent_binding' });
    }
    if (binding.vkey_id === null) return ok({ outcome: 'failed', code: 'no_key' });

    // ET8 already reached for this command (the answer was lost): do not call the model again
    const refused = await d.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM record.record_event
        WHERE stream = $1 AND type = 'proposal.recorded' AND body ->> 'command_key' = $2
          AND body ->> 'status' = 'rejected'`,
      [`planning:${req.item_id}`, req.command_key],
    );
    const already = Number(refused.rows[0]?.n ?? 0);
    if (already >= autoRounds) return ok(this.giveUp());

    const g = await d.grounding.ground(req.repo);
    if (!g.ok) return portError(`grounding: ${g.error.code}`);
    const grounding = g.value;

    // ---- inputs: the request as data, the earlier artefacts the step reads
    const pieces: ArtefactPiece[] = [];
    const refs: Array<{ type: ArtefactType; ref: string; sha256: string }> = [];
    if (spec.request) {
      const w = await readWork(d.pool, s.request_id);
      const text = w?.request.request_text?.text ?? null;
      if (text !== null) {
        const sha = sha256Hex(text);
        pieces.push({ type: 'request', sha256: sha, text });
        refs.push({ type: 'request', ref: `request:${s.request_id}`, sha256: sha });
      }
    }
    // 1.5: what the requester answered to earlier rounds of questions (their words, so DATA: B1 allows two rounds)
    if (step === '1.5') {
      for (const q of s.questions.filter((x) => x.state === 'answered' && x.answer !== null)) {
        const text = `Question (round ${q.round}): ${q.text}\nAnswer: ${q.answer?.text ?? ''}`;
        const sha = sha256Hex(text);
        pieces.push({ type: 'request', sha256: sha, text });
        refs.push({ type: 'request', ref: `question:${q.question_id}`, sha256: sha });
      }
    }
    const loaded = new Map<ArtefactType, LoadedArtefact>();
    for (const t of spec.inputs) {
      const a = await latestArtefact(d.pool, req.item_id, t);
      if (a) loaded.set(t, a);
    }
    // 3.2: feedback counts only when it judged the draft the agent is about to replace
    const draft = loaded.get('spec_delta');
    for (const t of ['validation_report', 'spec_review'] as const) {
      const a = loaded.get(t);
      if (a && step === '3.2' && (!draft || a.row.seq < draft.row.seq)) loaded.delete(t);
    }
    // 4.1: a constitution report counts only when it judged the design the agent is about to replace
    // (a redesign after B25 or B24); the first design, and a report of an older one, see none
    const design = await latestArtefact(d.pool, req.item_id, 'adr');
    const report = loaded.get('constitution_report');
    if (report && (!design || report.row.seq < design.row.seq))
      loaded.delete('constitution_report');
    for (const [t, a] of loaded) {
      pieces.push({ type: t, sha256: a.row.sha256, text: a.markdown });
      refs.push({ type: t, ref: `artefact:${t}:v${a.row.version}`, sha256: a.row.sha256 });
    }

    const input = { item_id: req.item_id, step, attempt: req.attempt, artefacts: refs };
    const shape = inputSchemaFor(def.agent_id).safeParse(input);
    if (!shape.success) return ok({ outcome: 'failed', code: 'input_not_allowed' });

    // level 3 (DEC-11(a), OB §4.1 item 6): the repo's affirmed instruction text as fenced Guidance, from the RECORD
    // (card 2's text or a later re-affirmation, hash-bound), never the repo's file (M16 part 3)
    let instructions: Awaited<ReturnType<typeof affirmedInstructionsOf>>;
    try {
      instructions = await affirmedInstructionsOf(d.pool, s.repo);
    } catch {
      return portError('the affirmed instruction text could not be read');
    }
    const built = buildContext({
      agent_id: def.agent_id,
      purpose: 'item',
      merged_sha: grounding.merged_sha,
      policy: [...grounding.policy, { text: spec.task }],
      intent: await acceptedIntentOf(d.pool, req.item_id, s),
      ...(instructions.length > 0 ? { instructions } : {}),
      ...(grounding.claims ? { claims: grounding.claims } : {}),
      ...(grounding.pack_docs ? { pack_docs: grounding.pack_docs } : {}),
      ...(grounding.repo_text ? { repo_text: grounding.repo_text } : {}),
      artefacts: pieces,
    });
    // M17: the repo defects the build logged are recorded, and may propose a re-onboarding (OB §8). Recorded first:
    // a defect that cannot be recorded stops the step, which the driver retries.
    if (built.defects.length > 0) {
      const kd = await recordKnowledgeDefects(d, {
        repo: s.repo,
        defects: built.defects,
        source: { kind: 'item_step', ref: `${req.item_id}:${step}` },
      });
      if (!kd.ok) return portError(`knowledge defects: ${kd.error.message}`);
    }

    let system: string;
    try {
      system = d.prompt(def.prompt.ref);
    } catch {
      return portError('the prompt cannot be read');
    }
    if (sha256Hex(system) !== def.prompt.sha256) {
      return ok({ outcome: 'failed', code: 'prompt_not_locked' });
    }

    const offered = def.contract.tools.flatMap((t) => {
      const tool = OFFERABLE_TOOLS[t];
      return tool && (t !== 'KnowledgeSearch' || d.search) ? [tool] : [];
    });

    // ---- the attempts (B3: `autoRounds` automatic ones, then ET8)
    let feedback: Refusal | null = null;
    for (let attempt = already + 1; attempt <= autoRounds; attempt += 1) {
      const user =
        `${built.text}\n` +
        (feedback
          ? `Your previous answer was refused by the factory's checks (fix every item and answer again): ${feedback.reasons
              .map((r) => `${r.path} ${r.code}`)
              .join('; ')}\n\n`
          : '\n') +
        `Input (data, as JSON):\n${JSON.stringify(input)}`;
      const answer = await this.converse(req, binding, {
        system,
        user,
        offered,
        merged_sha: grounding.merged_sha,
        max_tokens: Math.min(d.maxOutputTokens ?? 4096, def.contract.budget.max_tokens),
        data_class: def.contract.data_class_max,
        model: def.contract.models[0] ?? 'default',
      });
      if (!answer.ok) return answer;
      if (!('text' in answer.value)) return ok(answer.value.outcome);

      const text = answer.value.text;
      const proposalOf = (status: 'accepted' | 'rejected', reasons: ProposalReason[]) =>
        ProposalRecordedPayload.parse({
          proposal_id: `${binding.run_id}:${attempt}`,
          item_id: req.item_id,
          project_id: s.project_id,
          step,
          run_id: binding.run_id,
          command_key: req.command_key,
          agent_id: def.agent_id,
          attempt,
          kind: spec.proposal,
          status,
          // an accepted proposal names the artefact it became when the store writes it
          artefact_sha256: null,
          output_sha256: sha256Hex(text),
          reasons,
        });
      const verdict = await this.judge(step, def.agent_id, text, grounding.merged_sha, req);
      if (verdict.valid) {
        const out = verdict.output as Record<string, unknown>;
        // 1.5: the agent asks the requester instead of writing the intent. Nothing is stored (the questions are
        // entities of the item, B1 counts the rounds and parks the third); the proposal is recorded as accepted.
        if (step === '1.5' && out['kind'] === 'questions') {
          await recordProposal(d, proposalOf('accepted', []));
          return ok({
            outcome: 'questions',
            questions: out['questions'] as Array<{
              text: string;
              material: 'blocking' | 'non_blocking';
            }>,
          });
        }
        const content = await this.compose(step, out, req, loaded, grounding.merged_sha);
        const stored = await storeArtefact(d, {
          item_id: req.item_id,
          project_id: s.project_id,
          type: spec.artefact,
          step,
          command_key: req.command_key,
          run_id: binding.run_id,
          content,
          proposal: proposalOf('accepted', []),
        });
        if (stored.ok) return ok(outcomeFor(step, content, stored.value.sha256, ctx));
        if (!ArtefactRefused.is(stored.error)) return portError('the artefact could not be stored');
        feedback = { reasons: [{ path: '$', code: 'secret_in_output' }], code: 'secret_in_output' };
      } else {
        feedback = verdict.refusal;
      }
      // a refused answer: its hash and the field paths, never the text
      await recordProposal(d, proposalOf('rejected', feedback.reasons));
      await this.recordRunFailure(req, s, binding, feedback.code, attempt, feedback.reasons);
    }
    return ok(this.giveUp());
  }

  private giveUp(): StageOutcome {
    return { outcome: 'trigger', trigger: 'ET8', reason_code: 'output_invalid' };
  }

  // ------------------------------------------------------------ the model call and its tool loop

  private async converse(
    req: StageRequest,
    binding: AgentBinding,
    c: {
      system: string;
      user: string;
      offered: ReadonlyArray<(typeof OFFERABLE_TOOLS)[keyof typeof OFFERABLE_TOOLS] & object>;
      merged_sha: string;
      max_tokens: number;
      data_class: string;
      model: string;
    },
  ): Promise<Result<{ text: string } | { outcome: StageOutcome }, StagePortError>> {
    const d = this.d;
    const rounds = d.maxToolRounds ?? 6;
    // the secret is borrowed for these calls only; a process that restarted since the key was minted has none
    const done = await d.keys.lend(binding.run_id, async (secret) => {
      const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = [
        { role: 'user', content: c.user },
      ];
      for (let round = 0; round <= rounds; round += 1) {
        const last = round === rounds;
        const r = await callMessages(d.gateway, secret, c.data_class, {
          model: c.model,
          max_tokens: c.max_tokens,
          system: c.system,
          messages,
          ...(c.offered.length > 0 && !last
            ? {
                tools: c.offered.map((t) => ({
                  name: t.name,
                  description: t.description,
                  input_schema: t.input_schema,
                })),
              }
            : {}),
        });
        if (!r.ok) {
          if (r.error.kind === 'refused') {
            return ok<{ outcome: StageOutcome }>({
              outcome: { outcome: 'failed', code: 'gateway_refused' },
            });
          }
          return portError(`gateway: ${r.error.code}`);
        }
        const uses = r.value.blocks.filter(
          (b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use',
        );
        if (uses.length === 0) return ok<{ text: string }>({ text: r.value.text });
        messages.push({ role: 'assistant', content: r.value.blocks });
        messages.push({
          role: 'user',
          content: await Promise.all(uses.map((u) => this.runTool(req.repo, c.merged_sha, u))),
        });
      }
      return ok<{ text: string }>({ text: '' });
    });
    if (done === null) return portError('this process holds no key secret for the run');
    return done;
  }

  private async runTool(
    repo: string,
    sha: string,
    use: Extract<ContentBlock, { type: 'tool_use' }>,
  ): Promise<{ type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }> {
    const result = (content: string, is_error = false) => ({
      type: 'tool_result' as const,
      tool_use_id: use.id,
      content,
      ...(is_error ? { is_error: true } : {}),
    });
    if (use.name !== 'KnowledgeSearch' || !this.d.search) return result('tool not available', true);
    const q = use.input['query'];
    if (typeof q !== 'string' || q.trim().length < 2 || q.length > 200) {
      return result('the query must be 2 to 200 characters', true);
    }
    const prefix =
      typeof use.input['path_prefix'] === 'string'
        ? (use.input['path_prefix'] as string)
        : undefined;
    const limit =
      typeof use.input['limit'] === 'number' ? (use.input['limit'] as number) : undefined;
    // the repository and the commit are the factory's: whatever else the model put in its input is ignored
    const r = await this.d.search.search({
      repo,
      sha,
      query: q,
      ...(prefix !== undefined && prefix.length <= 200 ? { path_prefix: prefix } : {}),
      ...(limit !== undefined ? { limit: Math.max(1, Math.min(20, Math.trunc(limit))) } : {}),
    });
    if (!r.ok) return result(`knowledge search: ${r.error.code}`, true);
    const body =
      r.value.length === 0
        ? 'no results'
        : r.value
            .map((h) => `${h.path}:${h.line_from}-${h.line_to} blob ${h.blob_sha}\n${h.excerpt}`)
            .join('\n---\n');
    return result(quoteAsData({ tool: 'KnowledgeSearch', repo, commit_sha: sha }, body));
  }

  // ------------------------------------------------------------ judging an answer

  private async judge(
    step: PlanningStep,
    agentId: string,
    text: string,
    merged: string,
    req: StageRequest,
  ): Promise<{ valid: true; output: unknown } | { valid: false; refusal: Refusal }> {
    const spec = STEP_SPECS[step];
    const refuse = (code: AgentRunFailureCode, errors: readonly OutputFieldError[]) => ({
      valid: false as const,
      refusal: { code, reasons: reasonsOf(errors) },
    });
    // a secret: either the gateway had to redact the answer, or the shared ruleset hits it (a route without redaction)
    if (/\[REDACTED:[^\]]{1,64}\]/.test(text) || secretRules(text).length > 0) {
      return refuse('secret_in_output', [{ path: '$', code: 'secret_in_output', message: '' }]);
    }
    const parsed = parseJson(text);
    if (parsed === undefined)
      return refuse('output_invalid', [{ path: '$', code: 'not_json', message: '' }]);
    const v = validateOutput(agentId, parsed);
    if (!v.ok) return refuse('output_invalid', v.error.errors);
    const out = v.value as Record<string, unknown>;
    const wrong = wrongKind(spec, out);
    if (wrong.length > 0) return refuse('output_invalid', wrong);
    const loose = ungrounded(out, merged);
    if (loose.length > 0) return refuse('output_invalid', loose);
    if (step === '3.4') {
      const delta = await latestArtefact(this.d.pool, req.item_id, 'spec_delta');
      if (!delta)
        return refuse('output_invalid', [{ path: '$', code: 'missing_spec_delta', message: '' }]);
      const f = validateOracles(
        out,
        delta.content as { delta?: Array<{ requirement_id?: unknown; change?: unknown }> },
      );
      if (f.length > 0)
        return refuse(
          'output_invalid',
          f.map((x) => ({ path: x.path, code: x.code, message: '' })),
        );
    }
    const checked = await this.checkStep(step, out, req);
    if (checked.length > 0) {
      return refuse(
        'output_invalid',
        checked.map((x) => ({ path: x.path, code: x.code, message: '' })),
      );
    }
    return { valid: true, output: out };
  }

  /** The deterministic checks of the S4 and S5 steps over an answer that already passed its schema. */
  private async checkStep(
    step: PlanningStep,
    out: Record<string, unknown>,
    req: StageRequest,
  ): Promise<ReadonlyArray<{ path: string; code: string }>> {
    const pool = this.d.pool;
    const latest = async (t: ArtefactType) => (await latestArtefact(pool, req.item_id, t))?.content;
    switch (step) {
      case '4.2':
        // 4.2 (D+A): the agent proposes contract files, a deterministic checker parses them
        return checkContractFiles(out['contract_files'] as never);
      case '5.1':
        return validateUnitSplit(out);
      case '5.2':
        return validateSequence(out, await latest('unit_split'));
      case '5.3':
        return validateTasks(out, await latest('unit_split'));
      case '5.4':
        return validateVerification(out, await latest('unit_split'), await latest('oracle_specs'));
      case '5.6':
        return validateCapacity(out, await latest('unit_split'));
      default:
        return [];
    }
  }

  /**
   * What is stored for an accepted answer. Most steps store the answer as it is. 4.5 stores the constitution
   * REPORT: the factory's own rules run over the design, beside A5's review. The S5 steps store the answer
   * stamped with the commit the plan is made against (5.1: the merged head now; later steps: the one 5.1
   * stamped), so the plan's hashes bind it; 5.6 stores the capacity the factory will use of what was asked.
   */
  private async compose(
    step: PlanningStep,
    out: Record<string, unknown>,
    req: StageRequest,
    loaded: ReadonlyMap<ArtefactType, LoadedArtefact>,
    merged: string,
  ): Promise<Record<string, unknown>> {
    if (step === '4.5') {
      const c = this.d.constitution ? this.d.constitution() : DEFAULT_CONSTITUTION;
      const facts = designFactsOf({
        contracts: loaded.get('contracts')?.content,
        data_migration: loaded.get('data_migration')?.content,
        nfr_threat_ops: loaded.get('nfr_threat_ops')?.content,
      });
      const deterministic =
        c === null
          ? [
              {
                rule_id: 'CONSTITUTION',
                severity: 'high',
                location: { path: 'constitution' },
                message:
                  'the factory constitution could not be read: nothing is approved on a guess',
              },
            ]
          : evaluateConstitution(c, facts);
      const findings = Array.isArray(out['findings']) ? out['findings'] : [];
      return {
        kind: 'constitution_report',
        constitution_version: c?.version ?? null,
        constitution_sha256: c === null ? null : hashCanonical(c),
        deterministic,
        review: { verdict: out['verdict'], findings },
        verdict: deterministic.length > 0 || out['verdict'] === 'findings' ? 'violation' : 'pass',
      };
    }
    if (step.startsWith('5.')) {
      const split =
        step === '5.1' ? null : await latestArtefact(this.d.pool, req.item_id, 'unit_split');
      const stamp = (split?.content as { base_sha?: unknown } | undefined)?.base_sha;
      const base_sha = typeof stamp === 'string' ? stamp : merged;
      if (step === '5.6') {
        // M15.5: bounded by the published coding cap (the one H2 and the sandbox-controller follow)
        const cap = (await readSandboxCaps(this.d.pool, DEFAULT_RUNNER_HOST)).coding;
        return { ...boundCapacity(out, split?.content, cap), base_sha };
      }
      return { ...out, base_sha };
    }
    return out;
  }

  /**
   * 5.5, deterministic (D): the budget envelope from the catalogue's lane profile default and the sizes of the
   * Units, and the plan's Units entering the `unit` read model (state Planned, DAG order). Nothing here reads a
   * model: the same plan gives the same envelope.
   */
  private async envelope(
    req: StageRequest,
    s: ItemState,
    cat: CatalogueData,
    ctx: Ctx,
  ): Promise<Result<StageOutcome, StagePortError>> {
    const d = this.d;
    const [split, seq, tasks, ver] = await Promise.all(
      (['unit_split', 'unit_sequence', 'plan', 'verification_binding'] as const).map((t) =>
        latestArtefact(d.pool, req.item_id, t),
      ),
    );
    if (!split || !seq || !tasks || !ver) return ok({ outcome: 'failed', code: 'missing_input' });
    const coderDef = primaryAgentFor('6.4');
    const agents = d.agentSettings?.();
    const coder = coderDef
      ? agents
        ? withAgentSettings(coderDef, agents[coderDef.agent_id]).contract.budget
        : coderDef.contract.budget
      : undefined;
    if (!coder) return ok({ outcome: 'failed', code: 'no_budget_contract' });
    // Portal v2 (`planning.size_share`): unreadable is no envelope (unknown means unmet), never a default above it
    const sizeShare = d.sizeShare ? d.sizeShare() : undefined;
    if (sizeShare === null) return ok({ outcome: 'failed', code: 'settings_unreadable' });
    const stamp = (split.content as { base_sha?: unknown }).base_sha;
    if (typeof stamp !== 'string') return ok({ outcome: 'failed', code: 'plan_not_stamped' });
    const units = splitUnits(split.content);
    const { content, envelopes } = budgetEnvelope({
      lane: req.lane,
      lane_default_budget_cents: cat.lanes[req.lane].profile.default_envelope.budget_cents,
      coder_budget: coder,
      units: units.map((u) => ({ unit_key: u.unit_key, size: u.size })),
      base_sha: stamp,
      ...(sizeShare ? { size_share: sizeShare } : {}),
    });
    const planned = await planUnits(d, {
      item_id: req.item_id,
      project_id: s.project_id,
      repo: req.repo,
      plan_sha256: hashCanonical([
        split.row.sha256,
        seq.row.sha256,
        tasks.row.sha256,
        ver.row.sha256,
      ]),
      base_sha: stamp,
      units: plannedUnits(split.content, envelopes),
    });
    if (!planned.ok) return portError('the Units could not be recorded');
    const stored = await storeArtefact(d, {
      item_id: req.item_id,
      project_id: s.project_id,
      type: 'budget_envelope',
      step: '5.5',
      command_key: req.command_key,
      run_id: null,
      content,
    });
    if (!stored.ok) return portError('the budget envelope could not be stored');
    return ok(outcomeFor('5.5', content, stored.value.sha256, ctx));
  }

  private async recordRunFailure(
    req: StageRequest,
    s: ItemState,
    binding: AgentBinding,
    code: AgentRunFailureCode,
    attempt: number,
    reasons: readonly ProposalReason[],
  ): Promise<void> {
    const payload = AgentRunFailedPayload.parse({
      run_id: binding.run_id,
      item_id: req.item_id,
      project_id: s.project_id,
      command_key: req.command_key,
      step: req.step,
      attempt: req.attempt,
      lane: req.lane,
      binding,
      code,
      detail: reasons
        .slice(0, 6)
        .map((r) => `${r.path} ${r.code}`)
        .join('; ')
        .slice(0, 300),
    });
    await inCoreTx(this.d, async (j, tx) => {
      await lockKeys(tx, [`agent:${req.item_id}`]);
      const w = await j.emitAll(agentStream(req.item_id), [
        {
          type: AGENT_EVENT.run_failed,
          body: payload as unknown as Record<string, unknown>,
          actor: PLANNING_ACTOR,
          idempotency_key: `agent.failed:${req.command_key}:${code}:${attempt}`,
        },
      ]);
      return w.ok ? ok(undefined) : w;
    });
  }
}
