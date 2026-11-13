import { z } from 'zod';
import { Level, Tier } from '../values.js';
import { OnboardingStatus } from '../states/onboarding.js';
import { S0RecordId } from './ids.js';

// "Why is this onboarding stuck, and whose move is it" (onboarding console, P0; docs/design/onboarding-console.md).
// A deterministic blocker graph over what the record, knowledge and the code host say now. Nothing here decides or
// changes anything: it only says what stands between the onboarding and its sign-off.

/** Who can make the next move. `agent` is the factory itself (a re-check, a re-run); the rest are people or GitHub. */
export const BlockerOwner = z.enum(['agent', 'you', 'security', 'signer', 'github']);
export type BlockerOwner = z.infer<typeof BlockerOwner>;

export const BlockerKind = z.enum([
  'step',
  'floor',
  'card',
  'finding',
  'control',
  'probe',
  'feasibility',
]);
export type BlockerKind = z.infer<typeof BlockerKind>;

export const Blocker = z.strictObject({
  /** Stable within one answer; `blocked_by` points at other blockers' ids. */
  id: z.string().min(1).max(80),
  kind: BlockerKind,
  owner: BlockerOwner,
  /** A reason code (`b1_blocked`, `m4_infeasible`, ...): what a test or a tool keys on. */
  code: z.string().min(1).max(80),
  title: z.string().min(1).max(160),
  why: z.string().min(1).max(400),
  next: z.string().min(1).max(300),
  blocked_by: z.array(z.string().min(1).max(80)).max(20),
});
export type Blocker = z.infer<typeof Blocker>;

/** Can the onboarding signer gate (M4) be decided by the people who would hold its slot? Pure arithmetic over a role map. */
export const SignoffFeasibility = z.strictObject({
  state: z.enum(['feasible', 'infeasible']),
  tier: Tier,
  slot: z.string(),
  /** Approvals the gate would freeze (1 or 2), when it can be planned at all. */
  required: z.number().int().min(0).max(2).nullable(),
  /** People who could approve (holders who are not barred). */
  eligible: z.number().int().min(0),
  reason: z.string().nullable(),
});
export type SignoffFeasibility = z.infer<typeof SignoffFeasibility>;

export const OnboardingBlockers = z.strictObject({
  s0_id: S0RecordId,
  status: OnboardingStatus,
  requested_level: Level,
  /** No blocker is left that is not a decision a person can take now: the sign-off can proceed. */
  ready: z.boolean(),
  blockers: z.array(Blocker).max(60),
  signoff: SignoffFeasibility.nullable(),
});
export type OnboardingBlockers = z.infer<typeof OnboardingBlockers>;
