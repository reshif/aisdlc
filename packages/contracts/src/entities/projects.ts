import { z } from 'zod';
import { ProjectToggleGroup, type GateId } from '../flow.js';
import { Lane, Level, Scope, Tier } from '../values.js';
import { Classification } from './identity.js';
import { IsoDateTime, PrincipalId, ProjectId, RepoId, TeamId } from './ids.js';

// Projects (DM §3.2) and the per-project settings of OB §1B (role map, two-person) and §1C (gating
// profile). Onboarding records and cards are in onboarding.ts; the PRR and gaps in readiness.ts.

// ---------------------------------------------------------------- Repo

/** `none` is a repo with no S0 record yet (DM §3.2 `onboarding_level`). The rest is `Level`. */
export const OnboardingLevel = z.union([z.literal('none'), Level]);
export type OnboardingLevel = z.infer<typeof OnboardingLevel>;

/** OB §2.4 lists `visibility` without values; these are the three code-host visibilities. */
export const RepoVisibility = z.enum(['public', 'private', 'internal']);
export type RepoVisibility = z.infer<typeof RepoVisibility>;
export const RepoOwnerType = z.enum(['user', 'org']);
export type RepoOwnerType = z.infer<typeof RepoOwnerType>;

export const Repo = z.strictObject({
  repo_id: RepoId,
  /** `owner/name` (DM `repo_ref`). */
  repo_ref: z.string().regex(/^[^/\s]+\/[^/\s]+$/, 'owner/name'),
  project_id: ProjectId,
  host: z.string().min(1),
  owner: z.string().min(1),
  name: z.string().min(1),
  /** `null` until the code host has been read for this repo (unknown, never assumed). */
  visibility: RepoVisibility.nullable(),
  owner_type: RepoOwnerType.nullable(),
  plan: z.string().min(1).nullable(),
  default_branch: z.string().min(1).nullable(),
  stack: z.string().min(1).nullable(),
  /** The highest level an M4 signed for this repo; `none` until then (M7.5 sets it). */
  onboarding_level: OnboardingLevel,
});
export type Repo = z.infer<typeof Repo>;

// ---------------------------------------------------------------- Project

export const Project = z.strictObject({
  project_id: ProjectId,
  name: z.string().min(1),
  /** `null` is "unassigned" (DM ProjectMeta default). */
  team_id: TeamId.nullable(),
  classification: Classification,
  stack: z.string().min(1).nullable(),
  /** `null` is unknown; the gating floor treats unknown as "deploys". */
  deploys: z.boolean().nullable(),
  /** Signed at M4. `null` before any M4. */
  tier: Tier.nullable(),
  level: Level.nullable(),
  owner: PrincipalId.nullable(),
  /** `If-Match` version of the project document. */
  version: z.number().int().min(1),
  updated_at: IsoDateTime,
});
export type Project = z.infer<typeof Project>;

// ---------------------------------------------------------------- Role map (OB §1B, DM §3.2)

/** The ten slots of DM §3.2 `ProjectRoleMap`. */
export const RoleSlot = z.enum([
  'admin',
  'requesters',
  'intent',
  'design',
  'g4',
  'g5',
  'x',
  'sec',
  'm4',
  'kill',
]);
export type RoleSlot = z.infer<typeof RoleSlot>;
export const RoleSlotValues: readonly RoleSlot[] = RoleSlot.options;

/**
 * Who holds a slot: a list of principals, or (g4 only) the code owners on GitHub (OB §1B: "G4 = code
 * owners"). An empty list means nobody holds it, so nobody can decide.
 */
export const RoleSlotValue = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('principals'),
    principals: z
      .array(PrincipalId)
      .refine((a) => new Set(a).size === a.length, { message: 'duplicate principal' }),
  }),
  z.strictObject({ kind: z.literal('codeowners') }),
]);
export type RoleSlotValue = z.infer<typeof RoleSlotValue>;

export const RoleMap = z
  .record(RoleSlot, RoleSlotValue)
  .refine((m) => RoleSlotValues.every((s) => s === 'g4' || m[s].kind === 'principals'), {
    message: 'only the g4 slot may be `codeowners`',
  });
export type RoleMap = z.infer<typeof RoleMap>;

/** Delegation of the project kill (OB §1B, DEC-29): lasts until revoked. Never a fleet kill. */
export const KillDelegation = z
  .strictObject({
    delegate: PrincipalId,
    scope: Scope,
    granted_by: PrincipalId,
    granted_at: IsoDateTime,
    revoked_at: IsoDateTime.nullable(),
  })
  .refine((d) => d.scope.kind === 'project' || d.scope.kind === 'lane', {
    message: 'a project delegation covers a project or a lane; fleet kill is factory-admin only',
    path: ['scope'],
  })
  .refine((d) => d.revoked_at === null || Date.parse(d.revoked_at) >= Date.parse(d.granted_at), {
    message: 'revoked_at before granted_at',
    path: ['revoked_at'],
  });
export type KillDelegation = z.infer<typeof KillDelegation>;

/** Gates and actions a project's two-person setting covers (DEC-28). */
export const TWO_PERSON_GATES = ['X1', 'X2', 'E2', 'M4'] as const satisfies readonly GateId[];
export const TWO_PERSON_KILL_RELEASE = 'kill_release';

/** DEC-28: default on when 2+ people hold the role; `locked_on` is true for T2 (cannot be turned off). */
export const TwoPerson = z
  .strictObject({
    enabled: z.boolean(),
    default: z.literal('on_if_2plus'),
    locked_on: z.boolean(),
  })
  .refine((t) => !t.locked_on || t.enabled, {
    message: 'two-person is locked on, so it cannot be disabled',
    path: ['enabled'],
  });
export type TwoPerson = z.infer<typeof TwoPerson>;

// ---------------------------------------------------------------- Gating profile (OB §1C)

export const GateSwitch = z.enum(['on', 'off']);
export type GateSwitch = z.infer<typeof GateSwitch>;

export const ScheduleMode = z.enum(['auto', 'human']);
export type ScheduleMode = z.infer<typeof ScheduleMode>;
export const ScheduleModeValues: readonly ScheduleMode[] = ScheduleMode.options;

/** One switch per toggle group (g0g1 g2 g3d g3_g3s g5 g6). Keys are `ProjectToggleGroup`, not re-listed. */
export const GroupSwitches = z.record(ProjectToggleGroup, GateSwitch);
export type GroupSwitches = z.infer<typeof GroupSwitches>;

/**
 * OB §1C and §2.4 `gating_profile`. `by_lane` overrides the project-wide switch for a lane (G2, G3d
 * and G3 default on for L4-L6 and off for L1-L3). Off means absent, never auto-approved.
 */
export const GatingProfile = z.strictObject({
  gates: GroupSwitches,
  schedule: ScheduleMode,
  tier_floor_applied: z.boolean(),
  by_lane: z.partialRecord(Lane, z.partialRecord(ProjectToggleGroup, GateSwitch)).optional(),
});
export type GatingProfile = z.infer<typeof GatingProfile>;

/**
 * The T2 floor (OB §1C): a T2 project cannot turn off G2, G3d or G3 (with G3s) for L4-L6, or G5
 * where it deploys. T0 and T1 may. Defined here because the PRR refinement needs it and contracts
 * cannot import the catalogue; the catalogue re-exports this constant.
 */
export const T2_GATING_FLOOR = {
  lanes: ['L4', 'L5', 'L6'] as const satisfies readonly Lane[],
  groups: ['g2', 'g3d', 'g3_g3s'] as const satisfies readonly ProjectToggleGroup[],
  deployGroup: 'g5' as const satisfies ProjectToggleGroup,
};

/** The switch in force for a group, on a lane when one is given (the lane override wins). */
export function effectiveSwitch(
  profile: GatingProfile,
  group: ProjectToggleGroup,
  lane?: Lane,
): GateSwitch {
  if (lane !== undefined) {
    const override = profile.by_lane?.[lane]?.[group];
    if (override !== undefined) return override;
  }
  return profile.gates[group];
}

/**
 * Violations of the T2 floor, as readable strings (empty = ok). Only T2 has a floor. `deploys: null`
 * (unknown) counts as deploying: unknown means unmet.
 */
export function gatingFloorViolations(
  profile: GatingProfile,
  ctx: { readonly tier: Tier; readonly deploys: boolean | null },
): string[] {
  if (ctx.tier !== 'T2') return [];
  const out: string[] = [];
  for (const lane of T2_GATING_FLOOR.lanes) {
    for (const group of T2_GATING_FLOOR.groups) {
      if (effectiveSwitch(profile, group, lane) === 'off') {
        out.push(`T2 cannot turn off ${group} for ${lane}`);
      }
    }
  }
  if (ctx.deploys !== false) {
    const g = T2_GATING_FLOOR.deployGroup;
    const off =
      profile.gates[g] === 'off' ||
      Object.values(profile.by_lane ?? {}).some((o) => o[g] === 'off');
    if (off) out.push(`T2 cannot turn off ${g} where the project deploys`);
  }
  return out;
}

// ---------------------------------------------------------------- ProjectSettings

export const ProjectSettings = z.strictObject({
  project_id: ProjectId,
  role_map: RoleMap,
  two_person: TwoPerson,
  gating_profile: GatingProfile,
  kill_delegations: z.array(KillDelegation),
  version: z.number().int().min(1),
  updated_at: IsoDateTime,
});
export type ProjectSettings = z.infer<typeof ProjectSettings>;

/**
 * The tier-dependent rules a settings document cannot check alone (the tier lives on the project):
 * T2 locks two-person on and keeps the gating floor. Empty = ok.
 */
export function projectSettingsTierViolations(
  settings: ProjectSettings,
  ctx: { readonly tier: Tier; readonly deploys: boolean | null },
): string[] {
  const out = gatingFloorViolations(settings.gating_profile, ctx);
  if (ctx.tier === 'T2' && !(settings.two_person.locked_on && settings.two_person.enabled)) {
    out.push('T2 locks two-person on');
  }
  return out;
}
