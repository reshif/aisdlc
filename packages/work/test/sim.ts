import { CATALOGUE, currentCatalogueRef } from '@aisdlc/catalogue';
import {
  DEFAULT_GATING_PROFILE,
  ITEM_EVENT,
  LaneValues,
  type GateId,
  type ItemCommand,
  type ItemCreatedPayload,
  type ItemEvent,
  type ItemEventType,
  type Lane,
  type PrrGatingProfile,
  type StageOutcome,
  type StepId,
  type Tier,
} from '@aisdlc/contracts';
import { deterministicId, sha256Hex } from '@aisdlc/kernel';
import { type FakeStagePorts } from '@aisdlc/ports';
import { interpret, type ItemState } from '../src/index.js';

// A pure simulator of the execution side: it feeds events to `interpret` and answers the commands the
// way the deterministic fakes do. The real executor (core) does the same through the record.

export const uuid = (n: string): string => deterministicId<'WorkItem'>(`work-test:${n}`);

export const PROFILE_ALL_ON: PrrGatingProfile = {
  ...DEFAULT_GATING_PROFILE,
  project_deploys: true,
};
export const PROFILE_ALL_OFF: PrrGatingProfile = {
  gates: { g0g1: 'off', g2: 'off', g3d: 'off', g3_g3s: 'off', g5: 'off', g6: 'off' },
  schedule: 'auto',
  tier_floor_applied: true,
  project_deploys: false,
};

export function createdPayload(
  name: string,
  o: {
    lane?: Lane;
    profile?: PrrGatingProfile;
    tier?: Tier;
    injection?: boolean;
  } = {},
): ItemCreatedPayload {
  return {
    item_id: uuid(name) as never,
    project_id: 'acme' as never,
    request_id: uuid(`${name}:req`) as never,
    repo: 'acme/app' as never,
    requester: 'alice' as never,
    channel: 'N1',
    catalogue_ref: currentCatalogueRef(),
    gating_profile: o.profile ?? PROFILE_ALL_ON,
    tier: o.tier ?? 'T1',
    prr: { version: 1, record_hash: sha256Hex('prr') as never },
    proposed_lane: o.lane ?? 'L4',
    intake: {
      text_sha256: sha256Hex(`text:${name}`) as never,
      injection: o.injection
        ? {
            suspected: true,
            rules: ['L-DIRECTIVE'],
            lines: [1],
            text_sha256: sha256Hex('fenced') as never,
          }
        : null,
      dedupe_links: [],
      conflict_candidates: [],
      route: 'normal',
      eligibility_reason: 'eligible',
    },
    origin: null,
  };
}

export interface Step {
  readonly event: ItemEvent;
  readonly commands: ItemCommand[];
  readonly state: ItemState;
}

export class Sim {
  state: ItemState;
  seq = 1;
  readonly steps: Step[] = [];
  /** Commands executed, by key: a command is only ever executed once. */
  readonly executed: ItemCommand[] = [];
  /** Phases the item went through, in order (consecutive duplicates removed). */
  readonly phases: string[] = [];

  constructor(
    readonly name: string,
    o: Parameters<typeof createdPayload>[1] = {},
    readonly cat = CATALOGUE,
  ) {
    const p = createdPayload(name, o);
    const r = interpret(null, ev(ITEM_EVENT.created, p, 1), cat, p.gating_profile);
    this.state = r.state;
    this.record(r.state);
  }

  private record(s: ItemState): void {
    // The hops of the event (a bridge passes through phases), then the phase it ended in (a hold hides them).
    for (const p of [...s.trail, s.phase]) if (this.phases.at(-1) !== p) this.phases.push(p);
  }

  apply<T extends ItemEventType>(type: T, payload: unknown): Step {
    this.seq += 1;
    const event = ev(type, payload, this.seq);
    const r = interpret(this.state, event, this.cat, this.state.profile);
    this.state = r.state;
    this.record(r.state);
    const step = { event, commands: r.commands, state: r.state };
    this.steps.push(step);
    return step;
  }

  submit(): Step {
    return this.apply(ITEM_EVENT.submitted, {});
  }

  /** The gates opened so far, by command key. */
  readonly gateLog: Array<{ gates: GateId[]; key: string }> = [];

  /** Answers one outstanding command the way the fakes do. `script` overrides a step's outcome. */
  answer(c: ItemCommand, o: RunOptions): void {
    this.executed.push(c);
    switch (c.type) {
      case 'run_stage': {
        const out = o.script?.(c.step, c.attempt, c) ?? defaultOutcome(c.step, c.key, c.lane);
        this.stage(c, out);
        return;
      }
      case 'check_eligibility':
        this.apply(ITEM_EVENT.eligibility_checked, {
          command_key: c.key,
          lane: c.lane,
          route: o.eligibility ?? 'normal',
          eligible: (o.eligibility ?? 'normal') === 'normal',
          reason: 'eligible',
          prr_version: 1,
        });
        return;
      case 'open_gates': {
        this.gateLog.push({ gates: c.gates, key: c.key });
        const gates = c.gates.map((g) => ({ gate: g, gate_instance_id: uuid(`${c.key}:${g}`) }));
        this.apply(ITEM_EVENT.gates_opened, {
          command_key: c.key,
          gates,
          card_ids: [uuid(`card:${c.key}`)],
          subject_hash: c.subject_hash,
        });
        for (const g of gates) {
          const outcome = o.decide?.(g.gate, c) ?? 'approve';
          if (outcome === 'pending') continue;
          this.apply(ITEM_EVENT.gate_decided, {
            gate_instance_id: g.gate_instance_id,
            gate: g.gate,
            outcome,
            ledger_entry_id: uuid(`entry:${g.gate_instance_id}`),
          });
        }
        return;
      }
      case 'withdraw_gates':
        this.apply(ITEM_EVENT.command_done, { command_key: c.key });
        return;
      case 'spawn_item':
        this.apply(ITEM_EVENT.spawned, {
          command_key: c.key,
          link: {
            item_id: uuid(`spawn:${c.key}`),
            origin_item_id: this.state.item_id,
            origin_seq: c.origin_seq,
            index: c.index,
            edge: c.edge,
            kind: c.kind,
            lane: c.lane,
            status: 'open',
          },
        });
    }
  }

  stage(c: Extract<ItemCommand, { type: 'run_stage' }>, out: StageOutcome): void {
    switch (out.outcome) {
      case 'completed':
        this.apply(ITEM_EVENT.stage_completed, {
          command_key: c.key,
          step: c.step,
          output_hash: out.output_hash,
          ...(out.lease_epoch ? { lease_epoch: out.lease_epoch } : {}),
        });
        return;
      case 'classified':
        this.apply(ITEM_EVENT.stage_completed, {
          command_key: c.key,
          step: c.step,
          output_hash: out.output_hash,
          lane: out.lane,
        });
        return;
      case 'questions':
        this.apply(ITEM_EVENT.questions_raised, {
          command_key: c.key,
          step: c.step,
          round: 1,
          questions: out.questions.map((q, i) => ({
            question_id: uuid(`q:${c.key}:${i}`),
            text: q.text,
            material: q.material,
          })),
        });
        return;
      case 'gate_needed':
        this.apply(ITEM_EVENT.stage_gate_needed, {
          command_key: c.key,
          step: c.step,
          gate: out.gate,
          reason_code: out.reason_code,
        });
        return;
      case 'failed':
        this.apply(ITEM_EVENT.stage_failed, { command_key: c.key, step: c.step, code: out.code });
    }
  }

  /** The stations the item passed, as route keys, in order (1.1 and 1.2 were done at intake). */
  readonly visited: string[] = ['s:1.1', 's:1.2'];

  /** One action (a command answered, a gate decided, a human step done) through the fake stage ports; `false`: nothing to do. */
  async stepP(ports: FakeStagePorts, o: RunOptions = {}): Promise<boolean> {
    const next = this.state.outstanding.find((c) => !this.executed.some((e) => e.key === c.key));
    if (next) {
      if (next.type === 'run_stage') {
        this.executed.push(next);
        this.visited.push(`s:${next.step}`);
        const r = await ports[next.port].run({
          command_key: next.key,
          item_id: this.state.item_id as never,
          project_id: this.state.project_id as never,
          repo: this.state.repo as never,
          lane: next.lane,
          step: next.step,
          attempt: next.attempt,
          approved_gates: next.approved_gates,
          catalogue_ref: this.state.catalogue_ref,
        });
        if (!r.ok) throw new Error(r.error.message);
        this.stage(next, r.value);
      } else {
        if (next.type === 'check_eligibility') this.visited.push('s:1.4');
        if (next.type === 'open_gates')
          this.visited.push(String((next.facts as { station: string }).station));
        this.answer(next, o);
      }
      return true;
    }
    if (this.state.terminal !== null) return false;
    if (this.decidePending(o)) return true;
    return this.human(o);
  }

  /** Runs like `run`, but the stage commands go to the fake stage ports. `until` stops early. */
  async runP(
    ports: FakeStagePorts,
    o: RunOptions = {},
    until?: (s: ItemState) => boolean,
  ): Promise<this> {
    for (let i = 0; i < 500; i++) {
      if (until?.(this.state)) return this;
      if (!(await this.stepP(ports, o))) return this;
    }
    throw new Error('simulation did not settle');
  }

  /** Decides a gate instance that was left pending, if the options now allow it. */
  decidePending(o: RunOptions): boolean {
    for (const g of this.state.gates) {
      if (g.status !== 'pending') continue;
      const outcome = o.decide?.(g.gate, undefined as never) ?? 'approve';
      if (outcome === 'pending') continue;
      this.apply(ITEM_EVENT.gate_decided, {
        gate_instance_id: g.gate_instance_id,
        gate: g.gate,
        outcome,
        ledger_entry_id: uuid(`entry:${g.gate_instance_id}`),
      });
      return true;
    }
    return false;
  }

  /** Human steps the simulator completes when it is told to. */
  human(o: RunOptions): boolean {
    const w = this.state.waiting;
    if (w?.kind !== 'human') return false;
    if (o.stopAtHuman?.includes(w.what)) return false;
    this.visited.push(
      { ready: 'h:1.6', schedule: 'h:5.7', merge: 'h:8.2', human_led: 'human_led' }[w.what],
    );
    switch (w.what) {
      case 'ready':
        this.apply(ITEM_EVENT.ready_decided, { by: 'alice' });
        return true;
      case 'schedule':
        this.apply(ITEM_EVENT.scheduled, { by: 'alice' });
        return true;
      case 'merge':
        this.apply(ITEM_EVENT.merge_observed, { merged_sha: 'abcdef1234' });
        return true;
      case 'human_led':
        this.apply(ITEM_EVENT.human_work_done, { by: 'alice' });
        return true;
    }
  }

  /** Runs until the item is finished, stuck, or waiting for something the options hold back. */
  run(o: RunOptions = {}): this {
    for (let i = 0; i < 500; i++) {
      const next = this.state.outstanding.find((c) => !this.executed.some((e) => e.key === c.key));
      if (next) {
        this.answer(next, o);
        continue;
      }
      if (this.state.terminal !== null) return this;
      if (this.decidePending(o)) continue;
      if (this.human(o)) continue;
      return this;
    }
    throw new Error('simulation did not settle');
  }

  stepsOnly(): StepId[] {
    return this.executed.flatMap((c) => (c.type === 'run_stage' ? [c.step] : []));
  }
}

export interface RunOptions {
  /** Overrides a step's outcome. */
  script?: (step: StepId, attempt: number, c: ItemCommand) => StageOutcome | undefined;
  decide?: (
    gate: GateId,
    c: ItemCommand,
  ) => 'approve' | 'reject' | 'request_changes' | 'expired' | 'pending';
  eligibility?: 'normal' | 'n8_hold' | 'l8';
  stopAtHuman?: Array<'ready' | 'schedule' | 'merge' | 'human_led'>;
}

export const hash = (s: string): string => sha256Hex(s);

export function defaultOutcome(step: StepId, key: string, lane: Lane): StageOutcome {
  const output_hash = hash(`out:${key}`) as never;
  if (step === '1.3') return { outcome: 'classified', lane, output_hash };
  if (step === '6.0') return { outcome: 'completed', output_hash, lease_epoch: 1 };
  return { outcome: 'completed', output_hash };
}

export function ev(type: string, payload: unknown, seq: number): ItemEvent {
  return {
    type,
    payload,
    seq,
    at: new Date(Date.UTC(2026, 10, 9, 8, 0, seq)).toISOString(),
  } as ItemEvent;
}

export const ALL_LANES = LaneValues;

// Submit and run to the end with the defaults.
Sim.prototype.run_ = function (this: Sim): Sim {
  this.submit();
  return this.run();
};
