import { canonicalJson, sha256Hex } from '@aisdlc/kernel';
import { z } from 'zod';
import { FLEET_REF, Lane, Scope, type Scope as ScopeType } from '../values.js';
import { IsoDateTime, JsonObject, PrincipalId, Sha256Hex } from './ids.js';

// Controls, the kill switch and banners (PLAN M9.6; DM §3.10 and §8 gap 8). ONE Scope type serves all of
// them: `Scope{kind, ref}` from `values.ts`. A control takes the scope kinds DM lists for it, a kill the
// four the plan names; neither invents a second shape.

// ---------------------------------------------------------------- Scopes of controls and kills

/** DM `Control.scope_kind`: fleet, team, project, lane, release, budget. */
export const CONTROL_SCOPE_KINDS = [
  'fleet',
  'team',
  'project',
  'lane',
  'release',
  'budget',
] as const;
/** The kill scopes of PLAN M9.6: fleet (factory admin only), project, lane, session. */
export const KILL_SCOPE_KINDS = ['fleet', 'project', 'lane', 'session'] as const;

const kindIn = (kinds: readonly string[]) => (s: ScopeType) => kinds.includes(s.kind);

export const ControlScope = Scope.refine(kindIn(CONTROL_SCOPE_KINDS), {
  message: `a control covers one of: ${CONTROL_SCOPE_KINDS.join(', ')}`,
});
export type ControlScope = z.infer<typeof ControlScope>;

/**
 * A kill covers the fleet, a project (`ref` the project id), a lane (`ref` `<project>/<lane>`, the
 * same ref the PDP's Lane resource uses) or one agent session (`ref` `<project>/<session id>`).
 */
export const KillScope = Scope.refine(kindIn(KILL_SCOPE_KINDS), {
  message: `a kill covers one of: ${KILL_SCOPE_KINDS.join(', ')}`,
}).refine((s) => s.kind === 'fleet' || s.kind === 'project' || /^[^/\s]+\/[^/\s]+$/.test(s.ref), {
  message: 'a lane or session scope ref is <project>/<lane or session id>',
});
export type KillScope = z.infer<typeof KillScope>;

/** The project a scope belongs to (`null` for the fleet and for kinds with no project). */
export function projectOfScope(s: ScopeType): string | null {
  switch (s.kind) {
    case 'project':
      return s.ref;
    case 'lane':
    case 'session':
      return s.ref.split('/')[0] ?? null;
    default:
      return null;
  }
}

/** What an enforcement point asks the kill switch about: one project, and optionally a lane or a session. */
export const KillQuery = z.strictObject({
  project_id: z.string().min(1),
  lane: Lane.optional(),
  session_id: z.string().min(1).optional(),
});
export type KillQuery = z.infer<typeof KillQuery>;

/** Does a kill (or control) of `scope` cover what `q` asks about? The fleet covers everything. */
export function scopeCoversQuery(scope: ScopeType, q: KillQuery): boolean {
  switch (scope.kind) {
    case 'fleet':
      return true;
    case 'project':
      return scope.ref === q.project_id;
    case 'lane':
      return q.lane !== undefined && scope.ref === `${q.project_id}/${q.lane}`;
    case 'session':
      return q.session_id !== undefined && scope.ref === `${q.project_id}/${q.session_id}`;
    default:
      return false;
  }
}

// ---------------------------------------------------------------- The kill switch (its own service)

export const KillState = z.enum(['active', 'release_pending', 'released']);
export type KillState = z.infer<typeof KillState>;

/** DM `KillSwitch`: one kill. `release_pending` still kills: only `released` stops it. */
export const KillRecord = z.strictObject({
  kill_id: z.uuid(),
  scope: KillScope,
  state: KillState,
  requested_by: PrincipalId,
  reason: z.string().min(1).max(500),
  requested_at: IsoDateTime,
  /** Approvals the release needs: 2 under the project's two-person setting (always on T2 and for the fleet), else 1. */
  release_required: z.number().int().min(1).max(2),
  /** DM `KillReleaseApproval`: the distinct people who approved the release so far. */
  release_approvals: z.array(PrincipalId),
  released_at: IsoDateTime.nullable(),
});
export type KillRecord = z.infer<typeof KillRecord>;

/** The answer enforcement points read. `killed` is true while any covering kill is not released. */
export const KillStatus = z.strictObject({
  killed: z.boolean(),
  kills: z.array(KillRecord),
  as_of: IsoDateTime,
});
export type KillStatus = z.infer<typeof KillStatus>;

export const KILL_EVENT = {
  requested: 'kill.requested',
  release_approved: 'kill.release_approved',
  released: 'kill.released',
  delegation_granted: 'kill.delegation_granted',
  delegation_revoked: 'kill.delegation_revoked',
  holders_synced: 'kill.holders_synced',
  /** A later, signed entry that attests a `kill.requested` entry written while the KMS was down. */
  signature_attested: 'kill.signature_attested',
} as const;

/**
 * The `signature` of a kill written while key custody was unreachable: stopping is a tightening and must
 * never wait for a dependency, so it is recorded (hash-chained like every entry) unsigned and enforced at
 * once; a signed `kill.signature_attested` entry that names it follows when the KMS is back. Only a kill
 * may be pending: a delegation, a holder sync, a release approval or a release (they widen rights) are
 * refused instead.
 */
export const KILL_SIGNATURE_PENDING = 'pending_signature';
export type KillEventKind = (typeof KILL_EVENT)[keyof typeof KILL_EVENT];
export const KillEventKind = z.enum(
  Object.values(KILL_EVENT) as [KillEventKind, ...KillEventKind[]],
);

/** One entry of the kill switch's own signed, hash-chained journal (ES256 by its own key). */
export const KillEvent = z.strictObject({
  seq: z.number().int().min(1),
  kind: KillEventKind,
  /** The kill, delegation or project the event is about. */
  subject: z.string().min(1),
  actor: PrincipalId.nullable(),
  body: JsonObject,
  at: IsoDateTime,
  prev_hash: Sha256Hex.nullable(),
  entry_hash: Sha256Hex,
  signature: z.string().min(1),
  key_id: z.string().min(1),
});
export type KillEvent = z.infer<typeof KillEvent>;

/** DEC-29: kill authority granted by a project admin, until revoked. Never the fleet. */
export const KillDelegationGrant = z.strictObject({
  delegation_id: z.uuid(),
  delegate: PrincipalId,
  scope: KillScope.refine((s) => s.kind === 'project' || s.kind === 'lane', {
    message: 'a delegation covers a project or a lane; the fleet kill is factory admin only',
  }),
  granted_by: PrincipalId,
  granted_at: IsoDateTime,
  revoked_at: IsoDateTime.nullable(),
  revoked_by: PrincipalId.nullable(),
});
export type KillDelegationGrant = z.infer<typeof KillDelegationGrant>;

/**
 * What a person does at the kill switch (RC-SEC-3). Every such call carries a step-up proof (the bff's
 * `su1.` proof, `step-up.ts`) for exactly this act: the proof's `bound_hash` is `killActHash(act)` and
 * its principal is who acts. The kill switch takes the actor from the verified proof, never from the
 * caller's word, so one service token cannot act as two people. The fields are hashed exactly as the
 * request body carries them.
 */
export type KillAct =
  | { readonly action: 'kill.request'; readonly scope: unknown; readonly reason: string }
  | { readonly action: 'kill.release'; readonly kill_id: string }
  | { readonly action: 'kill.delegate'; readonly delegate: string; readonly scope: unknown }
  | { readonly action: 'kill.revoke'; readonly delegation_id: string };
/** Domain separation: a kill-act hash can never equal a gate's subject hash or another proof's binding. */
export const KILL_ACT_DOMAIN = 'aisdlc/kill-act/1';
export const killActHash = (act: KillAct): string =>
  // the scope is whatever JSON the body carried (`unknown` until the kill switch parses it)
  sha256Hex(canonicalJson({ domain: KILL_ACT_DOMAIN, ...act } as never));

/** The record event core makes of a kill-switch event it read (`kill.observed`, stream `kill:observed`). */
export const KILL_OBSERVED_EVENT = 'kill.observed';
export const KILL_OBSERVED_STREAM = 'kill:observed';
/** The ledger entry type core writes (through the Notary) for each one. */
export const KILL_LEDGER_ENTRY_TYPE = 'kill.event';
export const KillObservedPayload = z.strictObject({
  ks_seq: z.number().int().min(1),
  kind: KillEventKind,
  subject: z.string().min(1),
  actor: PrincipalId.nullable(),
  entry_hash: Sha256Hex,
  signature: z.string().min(1),
  key_id: z.string().min(1),
  at: IsoDateTime,
  body: JsonObject,
});
export type KillObservedPayload = z.infer<typeof KillObservedPayload>;

// ---------------------------------------------------------------- Controls (core)

export const ControlKind = z.enum(['hold', 'clamp', 'halt', 'maintenance']);
export type ControlKind = z.infer<typeof ControlKind>;
export const ControlKindValues: readonly ControlKind[] = ControlKind.options;

export const ControlOrigin = z.enum(['operator', 'security', 'kill', 'automation']);
export type ControlOrigin = z.infer<typeof ControlOrigin>;

export const ControlState = z.enum(['active', 'lifted', 'expired']);
export type ControlState = z.infer<typeof ControlState>;

/**
 * DM `Control`. `hold` stops new agent work in the scope (items there are HELD), `clamp` limits the
 * agent work in flight in it (`params.max_in_flight`), `halt` stops releases (S8, G5), `maintenance`
 * freezes timers and holds work like MM-2.
 */
export const OpsControl = z.strictObject({
  control_id: z.uuid(),
  kind: ControlKind,
  scope: ControlScope,
  origin_kind: ControlOrigin,
  state: ControlState,
  expires_at: IsoDateTime.nullable(),
  /** `clamp`: `{max_in_flight: n}`. */
  params: JsonObject,
  created_by_action: z.uuid(),
  created_at: IsoDateTime,
  lifted_at: IsoDateTime.nullable(),
});
export type OpsControl = z.infer<typeof OpsControl>;

export const OpsVerb = z.enum([
  'control.hold',
  'control.clamp',
  'control.halt',
  'control.maintenance',
  'control.lift',
  'banner.publish',
]);
export type OpsVerb = z.infer<typeof OpsVerb>;

/** DM `OpsAction.action_class`: O-T (tracked), O-N (notify), O-L (local). Controls are O-T. */
export const OpsActionClass = z.enum(['O-T', 'O-N', 'O-L']);
/** DM `OpsAction.tier`: L (local) or R (release-bearing). */
export const OpsTier = z.enum(['L', 'R']);
export const OpsLedgerState = z.enum(['none', 'pending', 'ledgered']);
export type OpsLedgerState = z.infer<typeof OpsLedgerState>;

/** DM `OpsAction`: executed first, ledgered after (backfilled when the Notary was down). */
/**
 * DM `StepUpUse` (PLAN M19): a step-up proof consumed by an operator's action. Recorded with the action (record
 * first, FD-D8: executed, then ledgered) and carried into its ledger entry, so a step-up used while the Notary was
 * down is ledgered by the backfill with the action it authorised. The proof itself is never kept, only its hash.
 */
export const StepUpUse = z.strictObject({
  principal: PrincipalId,
  /** What the proof was bound to: the action's preview (its blast radius hash). */
  bound_hash: Sha256Hex,
  proof_sha256: Sha256Hex,
  used_for: z.strictObject({ kind: z.literal('ops_action'), id: z.uuid() }),
  used_at: IsoDateTime,
});
export type StepUpUse = z.infer<typeof StepUpUse>;

export const OpsAction = z.strictObject({
  action_id: z.uuid(),
  verb: OpsVerb,
  action_class: OpsActionClass,
  tier: OpsTier,
  actor: PrincipalId,
  scope: ControlScope,
  ledger_state: OpsLedgerState,
  ledger_entry_id: z.uuid().nullable(),
  backfilled: z.boolean(),
  created_at: IsoDateTime,
  /** M19: the step-up this action consumed, if it was given one (absent on actions recorded before M19). */
  step_up: StepUpUse.nullable().optional(),
});
export type OpsAction = z.infer<typeof OpsAction>;

/** What an action would touch, counted from the record when the preview is made. */
export const BlastRadius = z.strictObject({
  scope: ControlScope,
  projects: z.array(z.string()),
  lanes: z.array(z.string()),
  /** Active work items the scope covers. */
  items: z.number().int().min(0),
  /** Of them, with an agent session or lease open. */
  items_in_flight: z.number().int().min(0),
  /** Controls already active on an overlapping scope. */
  overlapping_controls: z.number().int().min(0),
});
export type BlastRadius = z.infer<typeof BlastRadius>;

/** DM `OpsPreview`: show what it would affect before applying; the nonce binds the apply to this preview. */
export const OpsPreview = z.strictObject({
  preview_id: z.uuid(),
  verb: OpsVerb,
  actor: PrincipalId,
  blast_radius: BlastRadius,
  blast_radius_hash: Sha256Hex,
  nonce: z.string().min(16),
  expires_at: IsoDateTime,
  consumed_at: IsoDateTime.nullable(),
});
export type OpsPreview = z.infer<typeof OpsPreview>;

export const BannerTarget = z.enum(['banner', 'channel', 'statuspage']);
export type BannerTarget = z.infer<typeof BannerTarget>;
export const BannerSeverity = z.enum(['info', 'warning', 'critical']);
export type BannerSeverity = z.infer<typeof BannerSeverity>;
/** DM `Banner`: published by an OpsAction, gone at `expires_at`. */
export const Banner = z.strictObject({
  banner_id: z.uuid(),
  target: BannerTarget,
  severity: BannerSeverity,
  /** The OpsAction that published it. */
  source: z.uuid(),
  scope: ControlScope,
  text: z.string().min(1).max(500),
  expires_at: IsoDateTime,
  published_at: IsoDateTime,
  withdrawn_at: IsoDateTime.nullable(),
});
export type Banner = z.infer<typeof Banner>;

// Record events of the control plane.
export const CONTROL_EVENT = {
  previewed: 'ops.previewed',
  preview_consumed: 'ops.preview_consumed',
  action: 'ops.action',
  ledgered: 'ops.ledgered',
  control_applied: 'control.applied',
  control_lifted: 'control.lifted',
  control_expired: 'control.expired',
  banner_published: 'banner.published',
  banner_withdrawn: 'banner.withdrawn',
} as const;
export const controlStream = (id: string): string => `control:${id}`;
export const opsActionStream = (id: string): string => `ops_action:${id}`;
export const opsPreviewStream = (id: string): string => `ops_preview:${id}`;
export const bannerStream = (id: string): string => `banner:${id}`;
export const isFleetScope = (s: ScopeType): boolean => s.kind === 'fleet' && s.ref === FLEET_REF;
