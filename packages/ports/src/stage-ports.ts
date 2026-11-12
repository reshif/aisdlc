import {
  StageOutcome,
  type Lane,
  type StagePortName,
  type StageRequest,
  type StepId,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// The stage ports (PLAN M9.2): how the lifecycle engine asks for the work of a stage. The engine
// never runs planning, coding, verification or release itself and never learns how they run; it
// hands a port a `StageRequest` (ids and hashes, never request text) and gets back a `StageOutcome`
// it turns into an event. Every request carries the command's idempotency key, and a port asked
// twice with the same key does the work once and answers the same: that is what lets the executor
// redeliver a command after a crash. The real ports are an agent runtime (M11-M12), the sandbox
// (M13), the Verifier (M14) and the release plane (M15); the deterministic fakes below stand in
// for all four until then.

export const StagePortError = taggedError('StagePortError');
export type StagePortError = TaggedError<'StagePortError', { message: string }>;

/** One stage family's port. `port` is a brand: the four are not interchangeable. */
export interface StagePort<N extends StagePortName> {
  readonly port: N;
  /** An error is "unknown whether it ran": the command is delivered again with the same key. */
  run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>>;
}

/** S1 agent steps and S2-S5: classify, clarify, ground, specify, design, plan. */
export type PlanningPort = StagePort<'planning'>;
/** S6: admission, provisioning, oracles, the task loop, the draft PR. */
export type CodingPort = StagePort<'coding'>;
/** S7: the deterministic checks and the Evidence Pack. */
export type VerifyPort = StagePort<'verify'>;
/** S8b and S9: release, close-out, learn. */
export type ReleasePort = StagePort<'release'>;

export interface StagePorts {
  readonly planning: PlanningPort;
  readonly coding: CodingPort;
  readonly verify: VerifyPort;
  readonly release: ReleasePort;
}

// ---------------------------------------------------------------- Fakes

const hash = (...parts: Array<string | number>): never => sha256Hex(parts.join('|')) as never;

/** What a port answers when nothing is scripted: the step completes; 1.3 classifies as asked; 6.0 grants a lease. */
export function defaultStageOutcome(req: StageRequest): StageOutcome {
  const output_hash = hash('stage-output', req.item_id, req.step, req.attempt);
  if (req.step === '1.3') return { outcome: 'classified', lane: req.lane as Lane, output_hash };
  if (req.step === '6.0') return { outcome: 'completed', output_hash, lease_epoch: 1 };
  return { outcome: 'completed', output_hash };
}

export type StageScript = (req: StageRequest) => StageOutcome | undefined;

/**
 * Deterministic stage port. A pure function of the request unless scripted; idempotent on the
 * command key (the second call with a key is answered from memory and is not a second effect);
 * `effects` is the list of keys whose work was done, `calls` every call. A scripted outcome is
 * validated against the contract, so a fake cannot say something a real port could not.
 */
export class FakeStagePort<N extends StagePortName> implements StagePort<N> {
  private readonly done = new Map<string, StageOutcome>();
  private readonly scripts: StageScript[] = [];
  private readonly failures = new Map<string, number>();
  private down = false;
  readonly calls: StageRequest[] = [];
  /** Command keys whose work was done, in order; a key appears once however often it was asked. */
  readonly effects: string[] = [];

  constructor(readonly port: N) {}

  /** Scripts outcomes: the first script that answers wins (later `script` calls are tried first). */
  script(fn: StageScript): this {
    this.scripts.unshift(fn);
    return this;
  }

  /** For `step`, answer these outcomes in order (one per attempt), then the default. */
  scriptStep(step: StepId, outcomes: readonly StageOutcome[]): this {
    return this.script((req) => (req.step === step ? outcomes[req.attempt - 1] : undefined));
  }

  /**
   * The work for `key` is done but the caller never hears (a crash after the effect): the next `n`
   * calls with the key throw after doing nothing more. The redelivery is then answered from memory.
   */
  loseResponse(key: string, n = 1): this {
    this.failures.set(key, n);
    return this;
  }

  /** The port is unreachable: every call is an error and nothing is done. */
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    this.calls.push(req);
    if (this.down) return err(StagePortError({ message: `${this.port} port unavailable` }));
    let out = this.done.get(req.command_key);
    if (!out) {
      const scripted = this.scripts.map((s) => s(req)).find((o) => o !== undefined);
      out = StageOutcome.parse(scripted ?? defaultStageOutcome(req));
      this.done.set(req.command_key, out);
      this.effects.push(req.command_key);
    }
    const lost = this.failures.get(req.command_key) ?? 0;
    if (lost > 0) {
      this.failures.set(req.command_key, lost - 1);
      return err(StagePortError({ message: 'response lost' }));
    }
    return ok(out);
  }
}

/** The four fakes together, with every effect across them. */
export class FakeStagePorts implements StagePorts {
  readonly planning = new FakeStagePort('planning');
  readonly coding = new FakeStagePort('coding');
  readonly verify = new FakeStagePort('verify');
  readonly release = new FakeStagePort('release');

  all(): Array<FakeStagePort<StagePortName>> {
    return [this.planning, this.coding, this.verify, this.release];
  }

  /** Every command key whose work was done, over all four ports. */
  effects(): string[] {
    return this.all().flatMap((p) => p.effects);
  }

  /** Every call over all four ports (a redelivery is a call, not an effect). */
  calls(): StageRequest[] {
    return this.all().flatMap((p) => p.calls);
  }

  /** Scripts the same function on every port (a step belongs to exactly one, so only that one answers). */
  script(fn: StageScript): this {
    for (const p of this.all()) p.script(fn);
    return this;
  }

  scriptStep(step: StepId, outcomes: readonly StageOutcome[]): this {
    for (const p of this.all()) p.scriptStep(step, outcomes);
    return this;
  }
}

/**
 * (M14.6) A scripted S7 for the compose e2e (core-worker `CORE_WORKER_FAKE_VERIFY=exceptions`): the S7 exception gates
 * on the fakes, so a person can decide each in the portal. Items are numbered in the order they first reach S7.
 * The first item: its first 7.2 hits ET10 (Q1, then SECT), its first 7.4 raises X2, its first 7.5 raises E2. The second
 * item: its first 7.2 raises E6. Only calls that did work are counted (a redelivery is answered from memory); every
 * other call is the default. X3 is not here: it is raised only at 6.4, which a human-led (L8) route never runs. In
 * memory, like the fakes: a restart starts the numbering again.
 */
export function scriptVerifyExceptions(ports: FakeStagePorts): FakeStagePorts {
  const order = new Map<string, number>();
  const seen = new Map<string, number>();
  ports.verify.script((req) => {
    if (!req.step.startsWith('7.')) return undefined;
    if (!order.has(req.item_id)) order.set(req.item_id, order.size + 1);
    const item = order.get(req.item_id);
    if (req.step !== '7.2' && req.step !== '7.4' && req.step !== '7.5') return undefined;
    const k = `${req.item_id}|${req.step}`;
    const n = (seen.get(k) ?? 0) + 1;
    seen.set(k, n);
    if (n !== 1) return undefined;
    const evidence = hash('scripted-verify', req.item_id, req.step);
    if (item === 1 && req.step === '7.2')
      return {
        outcome: 'trigger',
        trigger: 'ET10',
        reason_code: 'locked_test_edit',
        output_hash: evidence,
      };
    if (item === 1 && req.step === '7.4')
      return { outcome: 'gate_needed', gate: 'X2', reason_code: 'protected_path' };
    if (item === 1 && req.step === '7.5')
      return {
        outcome: 'gate_needed',
        gate: 'E2',
        reason_code: 'constitution_violation',
        output_hash: evidence,
      };
    if (item === 2 && req.step === '7.2')
      return { outcome: 'gate_needed', gate: 'E6', reason_code: 'locked_test_must_change' };
    return undefined;
  });
  return ports;
}
