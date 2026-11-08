import { z } from 'zod';
import { defineMachine, type TransitionTable } from './machine.js';

/**
 * OnboardingRecord status (DM §6.3, gap 9). Includes `starter` and `withdrawn`, which the old model
 * comment omitted.
 *
 * Choices: code lists `rejected` in END_STATES, but the diagram draws `rejected -> running` (restore
 * request) and `rejected -> withdrawn`; the drawn edges win, so `rejected` is not terminal here.
 * `starter -> withdrawn` is not drawn, but WITHDRAWABLE = open states (app running card starter) +
 * blocked parked rejected, so it is allowed.
 */
export const OnboardingStatus = z.enum([
  'app',
  'running',
  'card',
  'blocked',
  'starter',
  'parked',
  'done',
  'rejected',
  'superseded',
  'withdrawn',
]);
export type OnboardingStatus = z.infer<typeof OnboardingStatus>;
export const OnboardingStatusValues: readonly OnboardingStatus[] = OnboardingStatus.options;

export const ONBOARDING_TRANSITIONS: TransitionTable<OnboardingStatus> = {
  app: ['running', 'withdrawn'],
  running: ['card', 'blocked', 'starter', 'parked', 'done', 'withdrawn', 'superseded'],
  card: ['running', 'rejected', 'withdrawn'],
  blocked: ['running', 'withdrawn'],
  starter: ['running', 'withdrawn'],
  parked: ['running', 'withdrawn'],
  rejected: ['running', 'withdrawn'],
  done: [],
  superseded: [],
  withdrawn: [],
};

export const OnboardingMachine = defineMachine('OnboardingRecord', ONBOARDING_TRANSITIONS);
export const canTransitionOnboarding = OnboardingMachine.canTransition;
export const assertTransitionOnboarding = OnboardingMachine.assertTransition;
