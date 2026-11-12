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
 * Choices: one edge leads back to `active`, `suspended -> active`, and only a person's one-click
 * restore takes it (DEC-21(b), OB §8: the re-check passes, then a confirm plus bypass re-attestation,
 * ledgered); a level change raises a NEW version that goes `proposed -> active` through its own M4
 * decision (`projects_prr_version_once`), and the old one is `superseded`. An expired record is
 * never restored: it is re-signed as a new version. Between the live states only tightening edges exist, so a stale record
 * can still be suspended or expired (otherwise a loosened protect-main would be unrecordable on it).
 * `stale -> superseded` and `suspended -> superseded` let the new version replace them.
 */
export const READINESS_TRANSITIONS: TransitionTable<ReadinessStatus> = {
  proposed: ['active'],
  active: ['stale', 'suspended', 'expired', 'superseded'],
  stale: ['suspended', 'expired', 'superseded'],
  suspended: ['active', 'expired', 'superseded'],
  expired: [],
  superseded: [],
};

export const ReadinessMachine = defineMachine('ReadinessRecord', READINESS_TRANSITIONS);
export const canTransitionReadiness = ReadinessMachine.canTransition;
export const assertTransitionReadiness = ReadinessMachine.assertTransition;

/**
 * Who causes a change: an M4 decision (a human, ledgered), a mechanical check, or a person's
 * one-click restore of a suspended record (DEC-21(b), ledgered with the bypass re-attestation).
 */
export const ReadinessActor = z.enum(['m4_decision', 'mechanical', 'restore']);
export type ReadinessActor = z.infer<typeof ReadinessActor>;
export const ReadinessActorValues: readonly ReadinessActor[] = ReadinessActor.options;

/**
 * Mechanical checks (poll, nightly staleness, rules poll, expiry sweep) may only tighten: they can
 * move `active` or `stale` towards stale, suspended or expired, never activate and never supersede
 * (superseding is the effect of a newer record's M4 decision). An M4 decision may take any other
 * edge; `suspended -> active` is the restore's alone.
 */
const MECHANICAL_TARGETS: readonly ReadinessStatus[] = ['stale', 'suspended', 'expired'];

export function canTransitionReadinessBy(
  actor: ReadinessActor,
  from: ReadinessStatus,
  to: ReadinessStatus,
): boolean {
  if (!canTransitionReadiness(from, to)) return false;
  // a restore lifts a suspension and does nothing else; nothing else lifts one
  if (actor === 'restore') return from === 'suspended' && to === 'active';
  if (to === 'active') return actor === 'm4_decision' && from === 'proposed';
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
