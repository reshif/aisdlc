import { err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import { defineMachine, InvalidTransition, type TransitionTable } from './machine.js';

/** ReadinessRecord (PRR) status (DM §6.3 last paragraph, OB §2.4). */
export const ReadinessStatus = z.enum([
  'proposed',
  'active',
  'stale',
  'suspended',
  'expired',
  'superseded',
]);
export type ReadinessStatus = z.infer<typeof ReadinessStatus>;
export const ReadinessStatusValues: readonly ReadinessStatus[] = ReadinessStatus.options;

/**
 * DM: `proposed -> active` (only an M4 decision) `-> stale | suspended | expired | superseded`.
 * Choices: no edge leads back to `active`; a level change or a re-affirmation raises a NEW version
 * that goes `proposed -> active` through its own M4 decision (`projects_prr_version_once`), and the
 * old one is `superseded`. Between the live states only tightening edges exist, so a stale record
 * can still be suspended or expired (otherwise a loosened protect-main would be unrecordable on it).
 * `stale -> superseded` and `suspended -> superseded` let the new version replace them.
 */
export const READINESS_TRANSITIONS: TransitionTable<ReadinessStatus> = {
  proposed: ['active'],
  active: ['stale', 'suspended', 'expired', 'superseded'],
  stale: ['suspended', 'expired', 'superseded'],
  suspended: ['expired', 'superseded'],
  expired: [],
  superseded: [],
};

export const ReadinessMachine = defineMachine('ReadinessRecord', READINESS_TRANSITIONS);
export const canTransitionReadiness = ReadinessMachine.canTransition;
export const assertTransitionReadiness = ReadinessMachine.assertTransition;

/** Who causes a change: an M4 decision (a human, ledgered) or a mechanical check. */
export const ReadinessActor = z.enum(['m4_decision', 'mechanical']);
export type ReadinessActor = z.infer<typeof ReadinessActor>;
export const ReadinessActorValues: readonly ReadinessActor[] = ReadinessActor.options;

/**
 * Mechanical checks (poll, nightly staleness, rules poll, expiry sweep) may only tighten: they can
 * move `active` or `stale` towards stale, suspended or expired, never activate and never supersede
 * (superseding is the effect of a newer record's M4 decision). An M4 decision may take any edge.
 */
const MECHANICAL_TARGETS: readonly ReadinessStatus[] = ['stale', 'suspended', 'expired'];

export function canTransitionReadinessBy(
  actor: ReadinessActor,
  from: ReadinessStatus,
  to: ReadinessStatus,
): boolean {
  if (!canTransitionReadiness(from, to)) return false;
  if (to === 'active') return actor === 'm4_decision';
  return actor === 'm4_decision' || MECHANICAL_TARGETS.includes(to);
}

export function assertTransitionReadinessBy(
  actor: ReadinessActor,
  from: ReadinessStatus,
  to: ReadinessStatus,
): Result<ReadinessStatus, InvalidTransition> {
  return canTransitionReadinessBy(actor, from, to)
    ? ok(to)
    : err(InvalidTransition({ machine: `ReadinessRecord/${actor}`, from, to }));
}
