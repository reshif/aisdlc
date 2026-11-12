import type { SessionStore } from '@aisdlc/build';
import {
  DEFAULT_CONSTITUTION,
  VERIFY_STEPS,
  VerifyRunRequest,
  verifyResultHash,
  type Constitution,
  type StageOutcome,
  type StageRequest,
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
import { outcomeOf, unmetSteps, type VerifyClient } from '@aisdlc/verify';
import type pg from 'pg';
import { readItem } from '../work-items.js';
import { CoreVerifySubjects, gateApprovedAt } from './subject.js';

// AgentVerifyPort (PLAN M14.3): the real `VerifyPort` for S7 7.1 to 7.5. Each step is one call to the verify service
// (`services/verify`, the plan's `cvw`), which runs the step's check over the Unit head in its own kits and records the
// result; this port builds the request from core's own record (the Unit head and base, the locks, the approved oracles,
// the approvals, the constitution, the live grant) and turns the result into the step's outcome with the ONE pure
// function `outcomeOf`: ET10 is Q1 (7.2), a raised gate is X2 (7.4) or E2 (7.5), anything else completes the step
// with the result's hash. 7.6 assembles the Evidence Pack (M14.4); until then this port guards it: 7.6 goes on to the
// fallback only when every step 7.1 to 7.5 PASSED for this head and every gate a check raised was approved; otherwise
// the item stops (`failed`, `s7_unmet`). Unknown is unmet.
//
// The D+A steps (7.3, 7.5) carry the A5 binding the work driver minted, and its key is lent from the vault for the
// length of the one call (it reaches the verify service in the request body, as a session's key reaches the
// sandbox-controller, and is never recorded). DEC-18 and B1 are asked before any check: a repo off the owner
// allow-list never has its code run (`failed`, `exec_not_allowed`).

export interface AgentVerifyPortDeps {
  readonly pool: pg.Pool;
  readonly client: VerifyClient;
  readonly keys: RunKeyLender;
  /** 7.6 and everything else (until M14.4). */
  readonly fallback: VerifyPort;
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
      if (req.step === '7.6') return await this.guard76(req);
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
    return ok(outcomeOf(result));
  }

  /** 7.6 until M14.4: every step met for this head, or the item stops (fail closed, never a pass by default). */
  private async guard76(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    const subject = await this.subjects.subject(req);
    if (!subject.ok) return ok({ outcome: 'failed', code: subject.error });
    const results = await this.d.client.results(req.item_id, subject.value.head_sha);
    if (!results.ok) {
      if (results.error.code === 'unavailable') return portError(results.error.message);
      return ok({ outcome: 'failed', code: 'verify_refused' });
    }
    const item = await readItem(this.d.pool, req.item_id);
    if (!item) return ok({ outcome: 'failed', code: 'no_item' });
    const unmet = unmetSteps(results.value, (gate, step) => gateApprovedAt(item.state, gate, step));
    if (unmet.length > 0) return ok({ outcome: 'failed', code: 's7_unmet' });
    return this.d.fallback.run(req);
  }
}
