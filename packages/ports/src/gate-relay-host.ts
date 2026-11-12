import type { CODEHOST_FORBIDDEN_VERBS } from '@aisdlc/contracts';
import {
  DeploymentTag,
  ReleaseEnvironment,
  type CodeHostRead,
  type DeploymentState,
  type GitSha,
  type RepoFullName,
} from '@aisdlc/contracts';

// GateRelayHostPort (PLAN M15.3; ADR-0003 §1 "gate-relay: its own narrow App (`deployments:write`)"; RV §2 "Code-host
// credential custody": gate-relay holds a different, narrower App than the codehost and gate-check). What gate-relay may
// do on the code host, through ITS App and nothing else: list the deployments of a commit in an environment, create a
// deployment of a merged commit, and read a deployment's statuses (which the deploy system writes). It cannot push,
// merge, approve, write a check run or a status, or change an environment: those verbs are not methods here (the
// forbidden-verb check below); the Push Broker's `CodeHostPort` and gate-check's `GateCheckHostPort` have no deployment
// method, and neither App's installation holds `deployments: write`, so no credential can do another's job.
//
// Every read is `CodeHostRead` (ok, unknown, unreadable): only `ok` is an answer gate-relay acts on.

/** A deployment as gate-relay reads it. `tag` is the payload gate-relay wrote, or `null` (somebody else's deployment). */
export interface DeploymentRead {
  readonly id: number;
  readonly sha: GitSha;
  readonly environment: string;
  readonly tag: DeploymentTag | null;
  readonly created_at: string;
}

export interface DeploymentStatusRead {
  readonly id: number;
  readonly state: DeploymentState;
  readonly created_at: string;
}

export interface DeploymentCreate {
  readonly repo: RepoFullName;
  /** The merged commit (never a branch name: the deployment is of exactly this content). */
  readonly sha: GitSha;
  readonly environment: string;
  readonly description: string;
  readonly tag: DeploymentTag;
}

export interface GateRelayHostPort {
  /** The App this credential belongs to. */
  readonly app_id: number;
  /** The deployments of `sha` to `environment`, newest first. */
  list_deployments(req: {
    readonly repo: RepoFullName;
    readonly sha: GitSha;
    readonly environment: string;
  }): Promise<CodeHostRead<DeploymentRead[]>>;
  /** gate-relay's one write: a deployment of the merged commit (auto-merge off, the ref is the sha). */
  create_deployment(req: DeploymentCreate): Promise<CodeHostRead<DeploymentRead>>;
  /** A deployment's statuses, newest first (written by the deploy system, never by gate-relay). */
  deployment_statuses(req: {
    readonly repo: RepoFullName;
    readonly deployment_id: number;
  }): Promise<CodeHostRead<DeploymentStatusRead[]>>;
}

export const GATE_RELAY_HOST_METHODS = [
  'list_deployments',
  'create_deployment',
  'deployment_statuses',
] as const satisfies ReadonlyArray<keyof GateRelayHostPort>;

// No method name may contain a forbidden verb (the same compile-time check as `CodeHostPort`'s).
type ForbiddenGateRelayMethods = Extract<
  keyof GateRelayHostPort,
  `${string}${(typeof CODEHOST_FORBIDDEN_VERBS)[number]}${string}`
>;
const noForbiddenGateRelayMethods: [ForbiddenGateRelayMethods] extends [never] ? true : never =
  true;
void noForbiddenGateRelayMethods;

/** Why a deployment is not one gate-relay may create (checked by the fake and the adapter before any request). */
export function badDeploymentCreate(req: DeploymentCreate): string | null {
  if (!/^[0-9a-f]{40}$/.test(req.sha)) return 'sha is not a 40-hex commit';
  if (!ReleaseEnvironment.safeParse(req.environment).success) return 'bad environment name';
  if (req.description.length === 0 || req.description.length > 140)
    return 'the description is empty or too long';
  if (!DeploymentTag.safeParse(req.tag).success) return 'the tag is not a deployment tag';
  return null;
}

/** The tag of a deployment payload read from the host, or `null` (not gate-relay's, or not parseable). */
export function tagOf(payload: unknown): DeploymentTag | null {
  const p = DeploymentTag.safeParse(payload);
  return p.success ? p.data : null;
}
