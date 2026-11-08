import { ITEM_EVENT, type GateId, type StageOutcome, type StepId } from '@aisdlc/contracts';
import { PROFILE_ALL_ON, Sim, type RunOptions } from './sim.js';

// Helpers for the back-edge, handoff and hold scenarios: scripts for the fake stages and a few
// shortcuts over the simulator. Nothing here knows a limit: every number a scenario relies on is read
// from the catalogue by the test that uses it.

export type Script = NonNullable<RunOptions['script']>;

export const rework = (
  edge: string,
  o: { variant?: 'a' | 'b'; loop?: string; observed?: number } = {},
): StageOutcome =>
  ({ outcome: 'rework', edge, reason_code: 'test', ...o }) as unknown as StageOutcome;

export const trigger = (t: string): StageOutcome =>
  ({ outcome: 'trigger', trigger: t, reason_code: 'test' }) as unknown as StageOutcome;

export const gateNeeded = (gate: string): StageOutcome =>
  ({ outcome: 'gate_needed', gate, reason_code: 'test' }) as unknown as StageOutcome;

/** `step` answers `outcomes[attempt - 1]` (`undefined`: the default), whatever else runs. */
export const forStep =
  (step: StepId, outcomes: ReadonlyArray<StageOutcome | undefined>): Script =>
  (s, attempt) =>
    s === step ? outcomes[attempt - 1] : undefined;

/** `step` answers `outcome` on every attempt up to and including `upTo`. */
export const repeat = (step: StepId, outcome: StageOutcome, upTo = 99): Script =>
  forStep(
    step,
    Array.from({ length: upTo }, () => outcome),
  );

/** The first script that answers. */
export const scripts =
  (...fns: Script[]): Script =>
  (s, a, c) => {
    for (const f of fns) {
      const r = f(s, a, c);
      if (r !== undefined) return r;
    }
    return undefined;
  };

/** Gates answered with `outcome` while the station has been opened at most `times` times. */
export const decideUntil =
  (
    gate: GateId,
    outcome: 'reject' | 'request_changes',
    times: number,
  ): NonNullable<RunOptions['decide']> =>
  (g, c) => {
    const attempt = c?.type === 'open_gates' ? c.attempt : 99;
    return g === gate && attempt <= times ? outcome : 'approve';
  };

export const newSim = (name: string, o: ConstructorParameters<typeof Sim>[1] = {}): Sim => {
  const s = new Sim(name, { profile: PROFILE_ALL_ON, ...o });
  s.submit();
  return s;
};

/** The open handoff of an item (or throws: a scenario that wanted one did not get it). */
export const openHandoff = (s: Sim) => {
  const h = s.state.handoffs.find((x) => x.status === 'open');
  if (!h) throw new Error(`no open handoff; waiting ${JSON.stringify(s.state.waiting)}`);
  return h;
};

export const choose = (
  s: Sim,
  choice: string,
  o: { extension_percent?: number; via?: 'E3' | 'E5'; cause?: string } = {},
) =>
  s.apply(ITEM_EVENT.handoff_chosen, {
    handoff_id: openHandoff(s).handoff_id,
    choice,
    by: 'alice',
    ...o,
  });

/** Every transition in a trail is one the phase table allows (holds and handoffs included). */
export const lastPhases = (s: Sim, n = 6): string => s.phases.slice(-n).join('>');
