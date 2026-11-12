import { deterministicId, hashCanonical } from '@aisdlc/kernel';
import { z } from 'zod';
import type { GithubPermissions } from './codehost.js';
import { RepoFullName } from './codehost.js';
import { GateInstanceId, GitSha, IsoDateTime, ProjectId, Sha256Hex, WorkItemId } from './ids.js';
import type { PrrGatingProfile } from './readiness.js';
import { ServiceEnv, ServiceName } from './service-env.js';

// gate-relay (PLAN M15.3; ADR-0003 §1 Integration plane "gate-relay: G5 release, deploy markers, RELHOLD"; FL S8b "gate-
// relay binds/consumes G5, records merged SHA -> evidence SHA", B16, B26/RELHOLD; DM `DeployMarker`). One vocabulary for
// the service, its narrow App on the code host (the port in `@aisdlc/ports`, the fake and the adapter), core's G5 card
// and S8b release port, and the per-project release setting.
//
// gate-relay writes ONE kind of thing on the code host: a deployment (GitHub's Deployments API) of a merged commit to
// the project's release target, through its OWN App (`deployments: write`, never the Push Broker's or gate-check's). It
// creates a deployment only for an approved G5 whose card binds the merged commit to the Evidence Pack's head, once per
// G5 instance; it never merges, approves or writes a deployment status (the deploy system does).

/**
 * What gate-relay's App asks for (its whole installation token): create and read deployments, and the metadata every
 * App has. Nothing else: no contents, no pull requests, no checks, no statuses, no environments administration.
 */
export const GATE_RELAY_APP_PERMISSIONS: GithubPermissions = {
  deployments: 'write',
  metadata: 'read',
};

// ---------------------------------------------------------------- the per-project release setting

/** The config key of a project's release choice (project layer, M1-gated like every revision). */
export const RELEASE_CONFIG_KEY = 'project.release';

/** A deploy target: a GitHub environment name (letters, digits and `._-`, as GitHub allows, at most 255). */
export const ReleaseEnvironment = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, 'environment: letters, digits, . _ -');
export type ReleaseEnvironment = z.infer<typeof ReleaseEnvironment>;

/**
 * PLAN §7a "G5 release": chosen per project (card 4 at onboarding; later an M1 config change): `off` (S8b has nothing to
 * do: the item's route has no G5 and goes on to S9) or a deploy target (G5 decides each release to that environment).
 * The config value is nullable: `null` is "not chosen", which keeps the gating profile's G5 and releases nothing
 * (unknown is not released).
 */
export const ReleaseSetting = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('off') }),
  z.strictObject({
    mode: z.literal('target'),
    environment: ReleaseEnvironment,
    /**
     * M17: the service released, one of card 3's ServiceEnvs (needed only when several declared services deploy to
     * the target environment). Absent: the one service that does.
     */
    service: ServiceName.optional(),
  }),
]);
export type ReleaseSetting = z.infer<typeof ReleaseSetting>;

/**
 * The gating profile an item pins when its project's release setting is known: `off` takes G5 out of every lane and says
 * the project does not deploy (so the T2 floor does not put G5 back); a target says it deploys (the T2 floor keeps G5 on).
 * `null` (not chosen) leaves the profile as the readiness record has it.
 */
export function applyReleaseSetting(
  profile: PrrGatingProfile,
  release: ReleaseSetting | null,
): PrrGatingProfile {
  if (release === null) return profile;
  if (release.mode === 'target') return { ...profile, project_deploys: true };
  const by_lane = profile.by_lane
    ? Object.fromEntries(
        Object.entries(profile.by_lane).map(([lane, row]) => [
          lane,
          { ...row, g5: 'off' as const },
        ]),
      )
    : undefined;
  return {
    ...profile,
    gates: { ...profile.gates, g5: 'off' },
    ...(by_lane ? { by_lane } : {}),
    project_deploys: false,
  };
}

// ---------------------------------------------------------------- the G5 binding (card facts)

/**
 * Why core could not bind a G5 card: the facts it opens the card with then say `unbound`, and gate-relay refuses to
 * release whatever the decision (an approval of an unbound card releases nothing).
 */
export const ReleaseUnboundReason = z.enum([
  'no_merge_observed',
  'no_passing_pack',
  'no_pull_request',
  'pack_head_not_pr_head',
  'no_release_target',
  /** M17: the project declared ServiceEnvs at Full and the target is not exactly one of them. */
  'target_not_attested',
  /** M17 (FF2): an L5 release needs staging separation attested and a staging ServiceEnv of the service. */
  'staging_separation_not_attested',
]);
export type ReleaseUnboundReason = z.infer<typeof ReleaseUnboundReason>;

/**
 * What a G5 card decides (FL F11 "G5 links merged SHA"): the merged commit, the Evidence Pack whose head it must contain,
 * the PR that carried it, and the target. Bound into the gate's subject hash (`g5SubjectHash`), so an approval is an
 * approval of exactly this merged commit to exactly this environment.
 */
export const ReleaseBinding = z.discriminatedUnion('status', [
  z.strictObject({
    status: z.literal('bound'),
    item_id: WorkItemId,
    project_id: ProjectId,
    repo: RepoFullName,
    pr_number: z.number().int().min(1),
    unit_key: z.string().min(1).max(64),
    merged_sha: GitSha,
    pack_sha256: Sha256Hex,
    pack_head_sha: GitSha,
    /** The environment this G5 deploys to (the GitHub environment name). */
    environment: ReleaseEnvironment,
    /**
     * M17 (DM §3.2 ServiceEnv): the (service, environment) G5 binds to, one of the project's attested environments
     * (card 3's ledgered `service_envs`, bound into the readiness record at M4). Absent for a project that declared
     * none (below Full): its target is the release setting's environment, as before.
     */
    service_env: ServiceEnv.optional(),
    /**
     * M17: the project's release target when this G5 deploys elsewhere: an L5 change goes to its service's staging
     * environment first, and only once that release is healthy does a re-requested G5 bind production.
     */
    target_environment: ReleaseEnvironment.optional(),
  }),
  z.strictObject({
    status: z.literal('unbound'),
    item_id: WorkItemId,
    project_id: ProjectId,
    repo: RepoFullName,
    reason: ReleaseUnboundReason,
  }),
]);
export type ReleaseBinding = z.infer<typeof ReleaseBinding>;

type BoundRelease = Extract<ReleaseBinding, { status: 'bound' }>;

/** M17: a G5 that releases an L5 change to its service's staging environment before the target (production). */
export const isStagingFirst = (b: BoundRelease): boolean =>
  b.target_environment !== undefined && b.environment !== b.target_environment;

/**
 * Whether a bound G5 still deploys what the project's release setting says now (gate-relay checks it again before it
 * deploys): the same target environment (and service, when the setting names one), and either the target itself or,
 * for an L5 staging-first release, exactly the service's staging environment. Anything else is a changed target.
 */
export function releaseTargetHolds(b: BoundRelease, setting: ReleaseSetting | null): boolean {
  if (setting?.mode !== 'target') return false;
  const target = b.target_environment ?? b.environment;
  if (setting.environment !== target) return false;
  if (b.service_env && setting.service !== undefined && setting.service !== b.service_env.service)
    return false;
  if (!isStagingFirst(b)) {
    return b.service_env === undefined || b.service_env.environment === b.environment;
  }
  return b.service_env?.environment === 'staging' && b.environment === 'staging';
}

/** The facts key a G5 card carries its binding under, beside the engine's facts. */
export const G5_FACTS_KEY = 'release';
/** The facts key of the engine's own subject hash, which the G5 subject hash is built over. */
export const G5_ENGINE_HASH_KEY = 'engine_subject_hash';

/** G5's subject hash: the engine's subject hash and the binding, together. */
export const g5SubjectHash = (engineSubjectHash: string, binding: ReleaseBinding): string =>
  hashCanonical({ engine: engineSubjectHash, release: binding });

// ---------------------------------------------------------------- deployments (DeployMarker)

/** What gate-relay writes into a deployment's payload, so a deployment on the host says which G5 made it. */
export const DeploymentTag = z.strictObject({
  aisdlc: z.strictObject({
    item_id: WorkItemId,
    gate_instance_id: GateInstanceId,
    kind: z.enum(['release', 'rollback']),
    binding_sha256: Sha256Hex,
  }),
});
export type DeploymentTag = z.infer<typeof DeploymentTag>;

/** A deployment's state as GitHub's statuses spell it; the newest status wins, none is `pending`. */
export const DeploymentState = z.enum([
  'pending',
  'queued',
  'in_progress',
  'success',
  'failure',
  'error',
  'inactive',
]);
export type DeploymentState = z.infer<typeof DeploymentState>;

/** How a deployment's newest status reads: `healthy` on success, `unhealthy` on failure or error, else `pending`. */
export const healthOf = (state: DeploymentState | null): 'pending' | 'healthy' | 'unhealthy' =>
  state === 'success'
    ? 'healthy'
    : state === 'failure' || state === 'error'
      ? 'unhealthy'
      : 'pending';

/** Why gate-relay refused to release an approved G5 (recorded; core's S8b then holds the release: RELHOLD). */
export const ReleaseRefusal = z.enum([
  /** The card was opened unbound (see `ReleaseUnboundReason`). */
  'unbound',
  /** The gate's subject hash is not the hash of its binding: the card is not what was decided. */
  'subject_mismatch',
  /** The opened gate wants no step-up: a G5 is always decided with one (GATE_POLICIES). */
  'no_step_up',
  /** The project's release setting is off, not chosen, unreadable, or names another environment now. */
  'target_changed',
  /** gate-check never recorded a gated merge of the pack's head as exactly the merged commit. */
  'merged_content_mismatch',
  /** The pack does not verify offline, is not passing, or is not for the bound head and item. */
  'pack_invalid',
  /** The code host refused the deployment (a permission, a rule, a conflict). */
  'host_refused',
]);
export type ReleaseRefusal = z.infer<typeof ReleaseRefusal>;

/** The DeployMarker (DM §3.6): one deployment gate-relay created, a release or a rollback. */
export const DeployMarker = z.strictObject({
  marker_id: z.uuid(),
  kind: z.enum(['release', 'rollback']),
  item_id: WorkItemId,
  project_id: ProjectId,
  /** DM `service`: the repo. */
  repo: RepoFullName,
  environment: ReleaseEnvironment,
  /** DM `digest`: the merged commit deployed. */
  merged_sha: GitSha,
  /** The Evidence Pack the merged commit contains (a rollback carries the pack of the release it goes back to). */
  pack_sha256: Sha256Hex,
  gate_instance_id: GateInstanceId,
  binding_sha256: Sha256Hex,
  deployment_id: z.number().int().min(1),
  /** A rollback: the marker of the unhealthy release it replaces. */
  rollback_of: z.uuid().nullable(),
  created_at: IsoDateTime,
});
export type DeployMarker = z.infer<typeof DeployMarker>;

/** One marker per G5 instance and kind (a second consume of the same G5 is the same marker). */
export const deployMarkerId = (gateInstanceId: string, kind: DeployMarker['kind']): string =>
  deterministicId<'DeployMarker'>(`aisdlc.deploy:${gateInstanceId}:${kind}`);

// ---------------------------------------------------------------- record

export const GATERELAY_STREAM_PREFIX = 'gaterelay:';
/** One stream per item: `gaterelay:<item id>`. */
export const gateRelayStream = (itemId: string): string => `${GATERELAY_STREAM_PREFIX}${itemId}`;

export const GATERELAY_EVENT = {
  /** Record-first: an approved G5 is being released (written before the host is asked). */
  release_intended: 'gaterelay.release_intended',
  /** The deployment exists on the host: the DeployMarker. */
  deployment_created: 'gaterelay.deployment_created',
  /** An approved G5 that will not be released, and why. */
  release_refused: 'gaterelay.release_refused',
  /** The deployment's newest status is success. */
  deploy_healthy: 'gaterelay.deploy_healthy',
  /** The deployment's newest status is failure or error (B16: rollback, a NEW linked item). */
  deploy_unhealthy: 'gaterelay.deploy_unhealthy',
} as const;
export type GateRelayEventType = (typeof GATERELAY_EVENT)[keyof typeof GATERELAY_EVENT];

export const ReleaseIntendedPayload = z.strictObject({
  item_id: WorkItemId,
  gate_instance_id: GateInstanceId,
  binding_sha256: Sha256Hex,
  marker_id: z.uuid(),
  kind: z.enum(['release', 'rollback']),
  repo: RepoFullName,
  environment: ReleaseEnvironment,
  merged_sha: GitSha,
});
export type ReleaseIntendedPayload = z.infer<typeof ReleaseIntendedPayload>;

export const ReleaseRefusedPayload = z.strictObject({
  item_id: WorkItemId,
  project_id: ProjectId,
  gate_instance_id: GateInstanceId,
  reason: ReleaseRefusal,
  /** A short code of what was seen (never repo text). */
  detail: z.string().max(200),
  refused_at: IsoDateTime,
});
export type ReleaseRefusedPayload = z.infer<typeof ReleaseRefusedPayload>;

export const DeployHealthPayload = z.strictObject({
  item_id: WorkItemId,
  marker_id: z.uuid(),
  deployment_id: z.number().int().min(1),
  state: DeploymentState,
  observed_at: IsoDateTime,
  /** `deploy_unhealthy` only: the rollback marker made for it, or `null` when there was nothing to roll back to. */
  rollback_marker_id: z.uuid().nullable().optional(),
});
export type DeployHealthPayload = z.infer<typeof DeployHealthPayload>;

/** What the S8b release step reads of one item's release, folded from its `gaterelay:` stream. */
export type ReleaseStatus =
  | { readonly state: 'none' }
  | { readonly state: 'intended'; readonly marker_id: string }
  | { readonly state: 'refused'; readonly reason: ReleaseRefusal }
  | { readonly state: 'deployed'; readonly marker: DeployMarker }
  | { readonly state: 'healthy'; readonly marker: DeployMarker }
  | {
      readonly state: 'unhealthy';
      readonly marker: DeployMarker;
      readonly rollback_marker_id: string | null;
    };

/** Folds an item's `gaterelay:` events into the status of the release made for one G5 instance. */
export function foldReleaseStatus(
  events: ReadonlyArray<{ readonly type: string; readonly body: unknown }>,
  gateInstanceId: string,
): ReleaseStatus {
  let st: ReleaseStatus = { state: 'none' };
  let release: DeployMarker | null = null;
  for (const e of events) {
    if (e.type === GATERELAY_EVENT.release_intended) {
      const p = ReleaseIntendedPayload.safeParse(e.body);
      if (p.success && p.data.gate_instance_id === gateInstanceId && p.data.kind === 'release')
        if (st.state === 'none') st = { state: 'intended', marker_id: p.data.marker_id };
    } else if (e.type === GATERELAY_EVENT.release_refused) {
      const p = ReleaseRefusedPayload.safeParse(e.body);
      if (p.success && p.data.gate_instance_id === gateInstanceId && release === null)
        st = { state: 'refused', reason: p.data.reason };
    } else if (e.type === GATERELAY_EVENT.deployment_created) {
      const p = DeployMarker.safeParse(e.body);
      if (p.success && p.data.gate_instance_id === gateInstanceId && p.data.kind === 'release') {
        release = p.data;
        st = { state: 'deployed', marker: p.data };
      }
    } else if (
      e.type === GATERELAY_EVENT.deploy_healthy ||
      e.type === GATERELAY_EVENT.deploy_unhealthy
    ) {
      const p = DeployHealthPayload.safeParse(e.body);
      if (!p.success || release === null || p.data.marker_id !== release.marker_id) continue;
      // the first verdict on a release is final: an unhealthy release was rolled back, a later success does not undo it
      if (st.state !== 'deployed') continue;
      st =
        e.type === GATERELAY_EVENT.deploy_healthy
          ? { state: 'healthy', marker: release }
          : {
              state: 'unhealthy',
              marker: release,
              rollback_marker_id: p.data.rollback_marker_id ?? null,
            };
    }
  }
  return st;
}

/** The hash a marker and the S8b output bind (the canonical marker). */
export const deployMarkerHash = (m: DeployMarker): string => hashCanonical(m);

/**
 * The S8b release step's failure code prefix for "merged, not deployed": the engine holds the release (RELHOLD) instead
 * of stopping, and a re-request opens G5 again on a new instance. `not_released:<why>` (why: the refusal, `rolled_back`,
 * `no_target`, `no_g5`).
 */
export const NOT_RELEASED_CODE_PREFIX = 'not_released:';
