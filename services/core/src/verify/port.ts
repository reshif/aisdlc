import type { SessionStore } from '@aisdlc/build';
import {
  DEFAULT_CONSTITUTION,
  VERIFY_STEPS,
  VerifyRunRequest,
  verifyResultHash,
  type Constitution,
  type S7Disposition,
  type StageOutcome,
  type StageRequest,
  type VerifyCheckResult,
  type VerifyStep,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  StagePortError,
  checkSessionAllowed,
  type RunKeyLender,
  type SessionGuardDeps,
  type VerifyPort,
} from '@aisdlc/ports';
import { B9_LOOP, decide76, decideStep, type EdgeRoom, type VerifyClient } from '@aisdlc/verify';
import { catalogueOfItem, effectiveLimit, type ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { readItem } from '../work-items.js';
import { outcomeOfRecorded, evidenceByCommand, type CoreEvidence } from './evidence.js';
import { CoreVerifySubjects, gateApprovedAt, type SubjectFields } from './subject.js';

// AgentVerifyPort (PLAN M14.3): the real `VerifyPort` for S7 7.1 to 7.5. Each step is one call to the verify service
// (`services/verify`, the plan's `cvw`), which runs the step's check over the Unit head in its own kits and records the
// result; this port builds the request from core's own record (the Unit head and base, the locks, the approved oracles,
// the approvals, the constitution, the live grant) and turns the result into the step's outcome with the ONE pure
// function `decideStep`: ET10 is Q1 (7.2), a raised gate is X2 (7.4), E2 (7.5) or E6 (7.2, B12), a spec found
// ambiguous at 7.3 is B10, anything else completes the step with the result's hash. 7.6 (M14.4) decides over the
// results of exactly the head (`decide76`): every step met signs the passing Evidence Pack; otherwise B9 (6.4 again) or
// B11 (5.1 again) while the pinned catalogue leaves the edge a round, else D2; a hard-fail class or a check with no
// verdict is D2 at once. Every 7.6 outcome, and a D2 at 7.2 or 7.3 (B12, B10 out of rounds), records a signed pack
// (`CoreEvidence`): a D2 carries it and the S6 Handoff Pack. Unknown is unmet, and nothing passes unsigned.
//
// The D+A steps (7.3, 7.5) carry the A5 binding the work driver minted, and its key is lent from the vault for the
// length of the one call (it reaches the verify service in the request body, as a session's key reaches the
// sandbox-controller, and is never recorded). DEC-18 and B1 are asked before any check: a repo off the owner
// allow-list never has its code run (`failed`, `exec_not_allowed`).

export interface AgentVerifyPortDeps {
  readonly pool: pg.Pool;
  readonly client: VerifyClient;
  readonly keys: RunKeyLender;
  /** Steps that are not S7's checks (the stage port of a step the verify port does not know). */
  readonly fallback: VerifyPort;
  /** 7.6: the pack assembly, signing and storage (M14.4). */
  readonly evidence: CoreEvidence;
  /** The factory constitution in force (`constitutionFrom`); `null` is unreadable config: 7.5 fails closed. */
  readonly constitution: () => Constitution | null;
  /** DEC-18 and B1, as in front of every S6 session. Absent: not checked here (a test of something else). */
  readonly guard?: SessionGuardDeps;
  /** S6's session store: the locks the coding session holds (after E6 and G3o they moved). */
  readonly store?: SessionStore;
}

const isVerifyStep = (s: string): s is VerifyStep =>
  (VERIFY_STEPS as readonly string[]).includes(s);

const portError = (message: string) =>
  err(StagePortError({ message: `verify: ${message}`.slice(0, 300) }));

export class AgentVerifyPort implements VerifyPort {
  readonly port = 'verify' as const;
  private readonly subjects: CoreVerifySubjects;

  constructor(private readonly d: AgentVerifyPortDeps) {
    this.subjects = new CoreVerifySubjects({
      pool: d.pool,
      ...(d.store ? { store: d.store } : {}),
    });
  }

  async run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    try {
      if (req.step === '7.6') return await this.assemble(req);
      if (!isVerifyStep(req.step)) return await this.d.fallback.run(req);
      return await this.check(req, req.step);
    } catch (e) {
      // unknown whether it ran: the command is delivered again with the same key (the service answers it once)
      return portError(`${req.step}: ${(e as Error).message}`);
    }
  }

  private async check(
    req: StageRequest,
    step: VerifyStep,
  ): Promise<Result<StageOutcome, StagePortError>> {
    if (this.d.guard) {
      const g = await checkSessionAllowed(this.d.guard, req.repo, 'O');
      if (!g.ok) {
        if (g.error.code === 'exec_not_allowed')
          return ok({ outcome: 'failed', code: 'exec_not_allowed' });
        if (g.error.code === 'b1_blocked')
          return ok({ outcome: 'failed', code: 'b1_secret_finding_open' });
        return portError(`the session guard: ${g.error.message}`);
      }
    }
    const subject = await this.subjects.subject(req);
    if (!subject.ok) return ok({ outcome: 'failed', code: subject.error });
    const constitution = this.d.constitution();
    if (constitution === null && step === '7.5')
      return ok({ outcome: 'failed', code: 'constitution_unreadable' });

    const body = (review: VerifyRunRequest['review']): VerifyRunRequest =>
      VerifyRunRequest.parse({
        command_key: req.command_key,
        item_id: req.item_id,
        project_id: req.project_id,
        step,
        attempt: req.attempt,
        repo: req.repo,
        lane: req.lane,
        approved_gates: req.approved_gates,
        constitution: constitution ?? DEFAULT_CONSTITUTION,
        ...subject.value,
        review,
      });

    const agent = req.agent;
    const call = async (review: VerifyRunRequest['review']) => this.d.client.run(body(review));
    let answer: Awaited<ReturnType<typeof call>>;
    if (agent && (step === '7.3' || step === '7.5')) {
      const artefacts = await this.subjects.reviewArtefacts(req.item_id, step);
      const lent = await this.d.keys.lend(agent.run_id, (secret) =>
        call({ agent, gateway_key: secret, artefacts }),
      );
      if (lent === null) {
        return portError(
          'no run key held for this command: it is delivered again and a new key is minted',
        );
      }
      answer = lent;
    } else {
      answer = await call(null);
    }
    if (!answer.ok) {
      if (answer.error.code === 'unavailable') return portError(answer.error.message);
      return ok({ outcome: 'failed', code: 'verify_refused' });
    }
    const { result, result_sha256 } = answer.value;
    // the service's word is checked: the result hashes to its address and is about exactly this command's subject
    if (
      verifyResultHash(result) !== result_sha256 ||
      result.item_id !== req.item_id ||
      result.step !== step ||
      result.head_sha !== subject.value.head_sha
    ) {
      return portError('the verify service answered a result for another subject');
    }
    const item = await readItem(this.d.pool, req.item_id);
    if (!item) return ok({ outcome: 'failed', code: 'no_item' });
    const decided = decideStep(result, edgeRoom(item.state));
    if (decided.kind === 'outcome') return ok(decided.outcome);
    // B12 or B10 with no round left: D2, with the evidence so far (this step's result is the last of it)
    if (step !== '7.2' && step !== '7.3') return portError(`a handoff decided at ${step}`);
    return this.withEvidence(req, subject.value, item.state, {
      kind: 'handoff',
      trigger: decided.trigger,
      step,
      reason_code: decided.reason_code,
    });
  }

  /** 7.6: the results of exactly the head decide; the pack is built, signed, stored and recorded for every outcome. */
  private async assemble(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    const have = await evidenceByCommand(this.d.pool, req.command_key);
    if (have) return ok(outcomeOfRecorded(have));
    const subject = await this.subjects.subject(req);
    if (!subject.ok) return ok({ outcome: 'failed', code: subject.error });
    const item = await readItem(this.d.pool, req.item_id);
    if (!item) return ok({ outcome: 'failed', code: 'no_item' });
    const results = await this.resultsFor(req.item_id, subject.value.head_sha);
    if (!results.ok) return results;
    const s = item.state;
    const d = decide76(results.value, (gate, step) => gateApprovedAt(s, gate, step), edgeRoom(s));
    // a step with no result for this head: nothing to sign and nothing to repair; the item stops for a person
    if (d.kind === 'incomplete') return ok({ outcome: 'failed', code: 's7_incomplete' });
    return this.withEvidence(req, subject.value, s, d.disposition, results.value);
  }

  private async resultsFor(
    itemId: string,
    head: string,
  ): Promise<Result<VerifyCheckResult[], StagePortError>> {
    const results = await this.d.client.results(itemId, head);
    if (!results.ok) {
      if (results.error.code === 'unavailable') return portError(results.error.message);
      return err(
        StagePortError({ message: 'verify: the verify service refused the results read' }),
      );
    }
    // exactly the head: a result for another commit is never evidence for this one
    return ok(results.value.filter((r) => r.head_sha === head && r.item_id === itemId));
  }

  private async withEvidence(
    req: StageRequest,
    subject: SubjectFields,
    s: ItemState,
    disposition: S7Disposition,
    known?: VerifyCheckResult[],
  ): Promise<Result<StageOutcome, StagePortError>> {
    let results = known;
    if (results === undefined) {
      const r = await this.resultsFor(req.item_id, subject.head_sha);
      if (!r.ok) return r;
      results = r.value;
    }
    const p = await this.d.evidence.produce({
      command_key: req.command_key,
      item: s,
      subject,
      results,
      approved: (gate, step) => gateApprovedAt(s, gate, step),
      disposition,
    });
    // not signed, not stored or not recorded: the command is delivered again (never a pass, never a handoff unseen)
    if (!p.ok) return portError(`7.6 evidence: ${p.error}`);
    return ok(outcomeOfRecorded(p.value));
  }
}

/**
 * Whether an S7 edge may loop once more under the item's PINNED catalogue (the reader is `@aisdlc/work`'s `limits.ts`;
 * no number here): its counted rounds plus this one within the limit. B9 counts against `et3_rounds` (ET3's threshold:
 * the flow gives the S7 loops no number of their own), B10 to B12 against their first limit (`times`). An edge with no
 * number is bounded by the item's rework budget only, which the engine applies.
 */
export function edgeRoom(s: ItemState): EdgeRoom {
  const cat = catalogueOfItem(s);
  return (edge) => {
    const lim = cat.back_edge_limits[edge];
    if (lim.kind !== 'limited') return true;
    const l = edge === 'B9' ? lim.limits.find((x) => x.key === B9_LOOP) : lim.limits[0];
    if (l === undefined) return true;
    const v = effectiveLimit(cat, l);
    if (v === null) return true;
    return (s.rework.by_loop[`${edge}:${l.key}`] ?? 0) + 1 <= v;
  };
}
