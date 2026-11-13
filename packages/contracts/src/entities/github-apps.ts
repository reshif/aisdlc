import { z } from 'zod';
import {
  CODEHOST_ROLE_PERMISSIONS,
  forbiddenPermissionsIn,
  type GithubPermissionLevel,
  type GithubPermissions,
} from './codehost.js';
import { GATE_CHECK_APP_PERMISSIONS } from './gate-check.js';
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
