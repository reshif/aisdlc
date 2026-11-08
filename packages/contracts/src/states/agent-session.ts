import { z } from 'zod';
import { defineMachine, type TransitionTable } from './machine.js';

/**
 * AgentSession state (DM §6.4): `starting -> running -> {idle, waiting_tool, interrupted} ->
 * ended | stopped | tainted`.
 *
 * Choices: the spec gives the shape, not every edge. `idle`, `waiting_tool` and `interrupted` can
 * return to `running` (a session cycles; the Unit diagram shows them as a loop on Building). `ended`
 * is a normal finish from `running` or a waiting state. `stopped` (kill, budget, operator) and
 * `tainted` (policy, Q1) can happen in any live state including `starting`, since a stop or a taint
 * must never be refused. The three outcomes are terminal.
 */
export const AgentSessionState = z.enum([
  'starting',
  'running',
  'idle',
  'waiting_tool',
  'interrupted',
  'ended',
  'stopped',
  'tainted',
]);
export type AgentSessionState = z.infer<typeof AgentSessionState>;
export const AgentSessionStateValues: readonly AgentSessionState[] = AgentSessionState.options;

export const AGENT_SESSION_TRANSITIONS: TransitionTable<AgentSessionState> = {
  starting: ['running', 'stopped', 'tainted'],
  running: ['idle', 'waiting_tool', 'interrupted', 'ended', 'stopped', 'tainted'],
  idle: ['running', 'ended', 'stopped', 'tainted'],
  waiting_tool: ['running', 'ended', 'stopped', 'tainted'],
  interrupted: ['running', 'ended', 'stopped', 'tainted'],
  ended: [],
  stopped: [],
  tainted: [],
};

export const AgentSessionMachine = defineMachine('AgentSession', AGENT_SESSION_TRANSITIONS);
export const canTransitionAgentSession = AgentSessionMachine.canTransition;
export const assertTransitionAgentSession = AgentSessionMachine.assertTransition;
