import { z } from 'zod';
import {
  CODEHOST_ROLE_PERMISSIONS,
  forbiddenPermissionsIn,
  type GithubPermissionLevel,
  type GithubPermissions,
} from './codehost.js';
import { GATE_CHECK_APP_PERMISSIONS, GATE_CHECK_NAME } from './gate-check.js';
import { IsoDateTime } from './ids.js';
import { GATE_RELAY_APP_PERMISSIONS } from './gate-relay.js';
import { TRACKER_APP_PERMISSIONS } from './issue-twin.js';

// The GitHub Apps of a deployment, as the owner sets them up (the wizard `platform/compose/setup-github-apps`,
// docs/getting-started.md §4) and the portal shows them. The default layout is TWO Apps:
//
//   factory      reads (Census, the bundle route) and pushes (the Push Broker's `agent/*` branch and Draft PR), and,
//                when the owner opts in, files tracker issues and writes gate-relay's deployments. One installation
//                grant, the union of those jobs; every service still mints tokens per role with an explicit subset.
//   gate-check   always its own App (separation of duties): the identity that pushes agent code must never be able to
//                write the check run `aisdlc/gate` that lets a person merge it.
//
// The permission sets are derived from the per-job constants, never re-listed.

const LEVELS: readonly GithubPermissionLevel[] = ['read', 'write', 'admin'];

export const GithubAppKind = z.enum(['factory', 'gate-check']);
export type GithubAppKind = z.infer<typeof GithubAppKind>;

/** A job one of the Apps does: the codehost's roles, the Push Broker, the tracker, gate-relay, gate-check. */
export const GithubAppJob = z.enum(['read', 'push', 'tracker', 'gate-relay', 'gate-check']);
export type GithubAppJob = z.infer<typeof GithubAppJob>;

/** What each job needs from its installation. */
export const GITHUB_APP_JOB_PERMISSIONS: Readonly<Record<GithubAppJob, GithubPermissions>> = {
  read: unionPermissions(CODEHOST_ROLE_PERMISSIONS.hub, CODEHOST_ROLE_PERMISSIONS.posture),
  push: CODEHOST_ROLE_PERMISSIONS.docs,
  tracker: unionPermissions(CODEHOST_ROLE_PERMISSIONS.tracker, TRACKER_APP_PERMISSIONS),
  'gate-relay': GATE_RELAY_APP_PERMISSIONS,
  'gate-check': GATE_CHECK_APP_PERMISSIONS,
};

/** The optional jobs the factory App may take on (the owner opts in to each). */
export interface FactoryAppOptions {
  readonly tracker?: boolean;
  readonly gateRelay?: boolean;
}

/** The jobs an App does in the two-App layout. */
export function jobsOfApp(kind: GithubAppKind, o: FactoryAppOptions = {}): GithubAppJob[] {
  if (kind === 'gate-check') return ['gate-check'];
  return [
    'read',
    'push',
    ...(o.tracker === true ? (['tracker'] as const) : []),
    ...(o.gateRelay === true ? (['gate-relay'] as const) : []),
  ];
}

/** The union of permission sets: each permission at the highest level any set asks. */
export function unionPermissions(...sets: readonly GithubPermissions[]): GithubPermissions {
  const out: Record<string, GithubPermissionLevel> = {};
  for (const set of sets) {
    for (const [name, level] of Object.entries(set)) {
      const have = out[name];
      if (have === undefined || LEVELS.indexOf(level) > LEVELS.indexOf(have)) out[name] = level;
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

/** What an App of `kind` asks GitHub for (its manifest's `default_permissions`, what its installation must hold). */
export function githubAppPermissions(
  kind: GithubAppKind,
  o: FactoryAppOptions = {},
): GithubPermissions {
  return unionPermissions(...jobsOfApp(kind, o).map((j) => GITHUB_APP_JOB_PERMISSIONS[j]));
}

/** How a granted set compares with the required one (sorted `name:level` strings). `ok` only when exactly equal. */
export interface PermissionComparison {
  readonly ok: boolean;
  /** Required and not granted, or granted at a lower level. */
  readonly missing: readonly string[];
  /** Granted and not required, or granted at a higher level. */
  readonly extra: readonly string[];
  /** Granted and never allowed (`forbiddenPermissionsIn`: administration, workflows, statuses, any admin, ...). */
  readonly forbidden: readonly string[];
}

export function comparePermissions(
  granted: Readonly<Record<string, string>>,
  required: GithubPermissions,
): PermissionComparison {
  const missing: string[] = [];
  const extra: string[] = [];
  for (const [name, level] of Object.entries(required)) {
    const g = granted[name];
    if (g === undefined || LEVELS.indexOf(g as GithubPermissionLevel) < LEVELS.indexOf(level)) {
      missing.push(`${name}:${level}`);
    }
  }
  for (const [name, level] of Object.entries(granted)) {
    const r = required[name];
    const li = LEVELS.indexOf(level as GithubPermissionLevel);
    if (r === undefined || li < 0 || li > LEVELS.indexOf(r)) extra.push(`${name}:${level}`);
  }
  const forbidden = forbiddenPermissionsIn(granted);
  return {
    ok: missing.length === 0 && extra.length === 0 && forbidden.length === 0,
    missing: missing.sort(),
    extra: extra.sort(),
    forbidden,
  };
}

// ---------------------------------------------------------------- what the services holding the keys report

/** An installation as GitHub showed it to the App (JWT), or why it could not be read. Unknown is never "ok". */
export const GithubInstallationRead = z.discriminatedUnion('state', [
  z.strictObject({
    state: z.literal('ok'),
    account_login: z.string().min(1),
    repository_selection: z.enum(['all', 'selected']),
    permissions: z.record(z.string().min(1), z.string().min(1)),
    suspended: z.boolean(),
  }),
  z.strictObject({ state: z.enum(['unknown', 'unreadable']), reason: z.string().min(1) }),
]);
export type GithubInstallationRead = z.infer<typeof GithubInstallationRead>;

/**
 * One job's App as the service that holds its key reports it (`GET /v1/app` of the codehost, the Push Broker and
 * gate-check). Never the key nor anything derived from it: only whether it loaded.
 */
export const GithubAppJobReport = z.strictObject({
  job: GithubAppJob,
  app_id: z
    .string()
    .regex(/^[1-9][0-9]*$/)
    .nullable(),
  installation_id: z.number().int().min(1).nullable(),
  /** The bot the job writes as (`<slug>[bot]`), when the service knows it. */
  login: z.string().nullable(),
  key_loaded: z.boolean(),
  /** The last 2xx/3xx GitHub gave this job's credential, or `null`: none since the service started. */
  last_ok_at: IsoDateTime.nullable(),
  installation: GithubInstallationRead,
});
export type GithubAppJobReport = z.infer<typeof GithubAppJobReport>;

export const GithubAppReport = z.strictObject({ reports: z.array(GithubAppJobReport) });
export type GithubAppReport = z.infer<typeof GithubAppReport>;

/** A reporter core or the bff asked, and whether it answered. */
export const GithubAppSource = z.enum(['codehost', 'push-broker', 'gate-check']);
export type GithubAppSource = z.infer<typeof GithubAppSource>;
export const GithubAppSourceState = z.strictObject({
  source: GithubAppSource,
  state: z.enum(['ok', 'unreachable', 'not_configured']),
});
export type GithubAppSourceState = z.infer<typeof GithubAppSourceState>;

/** A registered repo's default-branch required checks, as the codehost read them (`posture`). */
export const GithubBranchChecks = z.strictObject({
  repo: z.string().min(1),
  branch: z.string().min(1).nullable(),
  /** `null`: not read (unknown). */
  required_checks: z
    .array(z.strictObject({ context: z.string(), integration_id: z.number().int().nullable() }))
    .nullable(),
});
export type GithubBranchChecks = z.infer<typeof GithubBranchChecks>;

/** core `GET /v1/integrations/github-apps`: the codehost's and the Push Broker's reports, the branch rules. */
export const CoreGithubAppsView = z.strictObject({
  sources: z.array(GithubAppSourceState),
  reports: z.array(GithubAppJobReport),
  branches: z.array(GithubBranchChecks),
});
export type CoreGithubAppsView = z.infer<typeof CoreGithubAppsView>;

/** Whether a branch requires `aisdlc/gate` from gate-check's App. Unknown when either side cannot be read. */
export const GateRequirement = z.enum(['required', 'other_source', 'not_required', 'unknown']);
export type GateRequirement = z.infer<typeof GateRequirement>;

export function gateRequirementOf(
  checks: GithubBranchChecks['required_checks'],
  gateCheckAppId: string | null,
): GateRequirement {
  if (checks === null) return 'unknown';
  const named = checks.filter((c) => c.context === GATE_CHECK_NAME);
  if (named.length === 0) return 'not_required';
  if (gateCheckAppId === null) return 'unknown';
  // pinned to gate-check's App: a status of the same name from anyone else does not count
  return named.some((c) => c.integration_id !== null && String(c.integration_id) === gateCheckAppId)
    ? 'required'
    : 'other_source';
}

/** One App (one id) of the deployment: the jobs it does and how its grant compares with what they need. */
export const GithubAppRow = z.strictObject({
  kind: GithubAppKind,
  app_id: z.string().nullable(),
  installation_id: z.number().int().nullable(),
  login: z.string().nullable(),
  jobs: z.array(GithubAppJob),
  required: z.record(z.string(), z.string()),
  installation: GithubInstallationRead,
  /** `null`: the installation could not be read, so nothing is known about the grant. */
  comparison: z
    .strictObject({
      ok: z.boolean(),
      missing: z.array(z.string()),
      extra: z.array(z.string()),
      forbidden: z.array(z.string()),
    })
    .nullable(),
  key_loaded: z.boolean(),
  last_ok_at: IsoDateTime.nullable(),
  /** gate-check shares this App with a job that pushes: separation of duties is broken. */
  shares_with_pusher: z.boolean(),
});
export type GithubAppRow = z.infer<typeof GithubAppRow>;

/** bff `GET /api/integrations/github-apps`: the portal's read-only GitHub Apps panel. */
export const GithubAppsView = z.strictObject({
  sources: z.array(GithubAppSourceState),
  apps: z.array(GithubAppRow),
  gate_rule: z.array(
    z.strictObject({ repo: z.string(), branch: z.string().nullable(), state: GateRequirement }),
  ),
  /** What to run to create or replace the Apps (the portal never handles a key). */
  setup_command: z.string(),
});
export type GithubAppsView = z.infer<typeof GithubAppsView>;

export const GITHUB_APPS_SETUP_COMMAND = 'cd platform/compose && ./setup-github-apps';

const compared = (granted: Readonly<Record<string, string>>, required: GithubPermissions) => {
  const c = comparePermissions(granted, required);
  return { ok: c.ok, missing: [...c.missing], extra: [...c.extra], forbidden: [...c.forbidden] };
};

/** The panel's view from the reports: one row per App id, the jobs sharing it, their union compared with the grant. */
export function githubAppsView(o: {
  sources: readonly GithubAppSourceState[];
  reports: readonly GithubAppJobReport[];
  branches: readonly GithubBranchChecks[];
}): GithubAppsView {
  const groups = new Map<string, GithubAppJobReport[]>();
  for (const r of o.reports) {
    const key = r.app_id ?? `none:${r.job}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const apps: GithubAppRow[] = [...groups.values()].map((rs) => {
    const jobs = [...new Set(rs.map((r) => r.job))].sort(
      (a, b) => GithubAppJob.options.indexOf(a) - GithubAppJob.options.indexOf(b),
    );
    const required = unionPermissions(...jobs.map((j) => GITHUB_APP_JOB_PERMISSIONS[j]));
    const first = rs[0] as GithubAppJobReport;
    // every job of one App sees the same installation: the first that could be read
    const installation =
      rs.find((r) => r.installation.state === 'ok')?.installation ?? first.installation;
    const last = rs
      .map((r) => r.last_ok_at)
      .filter((x): x is string => x !== null)
      .sort()
      .at(-1);
    return {
      kind: jobs.includes('gate-check') ? 'gate-check' : 'factory',
      app_id: first.app_id,
      installation_id: rs.find((r) => r.installation_id !== null)?.installation_id ?? null,
      login: rs.find((r) => r.login !== null)?.login ?? null,
      jobs,
      required,
      installation,
      comparison: installation.state === 'ok' ? compared(installation.permissions, required) : null,
      key_loaded: rs.every((r) => r.key_loaded),
      last_ok_at: last ?? null,
      shares_with_pusher: jobs.includes('gate-check') && jobs.includes('push'),
    };
  });
  apps.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'factory' ? -1 : 1));
  const gate = o.reports.find((r) => r.job === 'gate-check');
  return {
    sources: [...o.sources],
    apps,
    gate_rule: o.branches.map((b) => ({
      repo: b.repo,
      branch: b.branch,
      state: gateRequirementOf(b.required_checks, gate?.app_id ?? null),
    })),
    setup_command: GITHUB_APPS_SETUP_COMMAND,
  };
}
