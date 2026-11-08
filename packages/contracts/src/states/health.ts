import { z } from 'zod';
import { defineMachine, type TransitionTable } from './machine.js';

/**
 * HealthState: ok degraded down unknown. The specs give no edges; health is a reading, so any
 * reading may follow any other. `unknown` is also what a snapshot older than 2 minutes reads as
 * (PLAN §1.7), so it is reachable from and to every state. A "transition" to the same state is
 * not a change and is refused. There are no terminals.
 */
export const HealthState = z.enum(['ok', 'degraded', 'down', 'unknown']);
export type HealthState = z.infer<typeof HealthState>;
export const HealthStateValues: readonly HealthState[] = HealthState.options;

export const HEALTH_TRANSITIONS: TransitionTable<HealthState> = {
  ok: ['degraded', 'down', 'unknown'],
  degraded: ['ok', 'down', 'unknown'],
  down: ['ok', 'degraded', 'unknown'],
  unknown: ['ok', 'degraded', 'down'],
};

export const HealthMachine = defineMachine('Health', HEALTH_TRANSITIONS);
export const canTransitionHealth = HealthMachine.canTransition;
export const assertTransitionHealth = HealthMachine.assertTransition;
