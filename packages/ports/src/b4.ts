import {
  CODEHOST_ROLE_PERMISSIONS,
  CodeHostRoleValues,
  type B4Finding,
  type B4Report,
  type CodeHostRead,
  type CodeHostRole,
  type GithubPermissions,
  type InstallationInfo,
  type RequiredCheck,
} from '@aisdlc/contracts';

// The B4 security blockers computed from what the code host says (OB §5.2; PLAN M5.2, moved to ports in M7.3). A pure
// function: the installation's permissions, the permissions the role tokens carry, and the
// required checks of the default branch. `unknown` and `unreadable` inputs never give "clear".
//
//   B4a  the installation holds `administration` or `workflows`, or any minted token carries
//        `administration`, `workflows` or `statuses`.                       blocks M4 entirely
//   B4b  the installation holds `statuses` and a required check has no `integration_id`: a status
//        with a matching name could satisfy the gate.                       blocks M4 entirely
//   B4c  the installation holds `statuses` and every required check is pinned. Amber remediation
//        (DEC-7: remove `statuses:write` from the App).

export interface B4Input {
  readonly installation: CodeHostRead<InstallationInfo>;
  /** Required checks on the default branch of the repo being judged. */
  readonly required_checks: CodeHostRead<readonly RequiredCheck[]>;
  /**
   * What each role's token carries. Default: what the roles ask for (`CODEHOST_ROLE_PERMISSIONS`).
   * Pass the observed permissions of minted tokens as well; every entry is judged.
   */
  readonly token_permissions?: ReadonlyArray<{
    readonly role: CodeHostRole;
    readonly permissions: GithubPermissions;
  }>;
}

const TOKEN_BLOCKERS = ['administration', 'workflows', 'statuses'] as const;
const INSTALLATION_BLOCKERS = ['administration', 'workflows'] as const;

export const defaultTokenPermissions = (): NonNullable<B4Input['token_permissions']> =>
  CodeHostRoleValues.map((role) => ({ role, permissions: CODEHOST_ROLE_PERMISSIONS[role] }));

const finding = (
  id: B4Finding['id'],
  blocks: B4Finding['blocks'],
  status: B4Finding['status'],
  reasons: string[],
): B4Finding => ({
  id,
  blocks,
  status,
  reasons,
  active: status === 'blocked' || status === 'unknown' || status === 'amber',
});

export function b4Checks(input: B4Input): B4Report {
  const tokens = [...defaultTokenPermissions(), ...(input.token_permissions ?? [])];
  const reasonsA: string[] = [];
  for (const t of tokens) {
    for (const p of TOKEN_BLOCKERS) {
      if (p in t.permissions) reasonsA.push(`a ${t.role} token carries ${p}:${t.permissions[p]}`);
    }
  }
  const inst = input.installation;
  if (inst.state === 'ok') {
    for (const p of INSTALLATION_BLOCKERS) {
      const level = inst.value.permissions[p];
      if (level !== undefined) reasonsA.push(`the installation holds ${p}:${level}`);
    }
  }
  const dedupe = (xs: string[]): string[] => [...new Set(xs)];

  let b4a: B4Finding;
  if (reasonsA.length > 0) b4a = finding('B4a', 'm4', 'blocked', dedupe(reasonsA));
  else if (inst.state !== 'ok') {
    b4a = finding('B4a', 'm4', 'unknown', [`the installation is ${inst.state}: ${inst.reason}`]);
  } else b4a = finding('B4a', 'm4', 'clear', []);

  let b4b: B4Finding;
  let b4c: B4Finding;
  if (inst.state !== 'ok') {
    const why = [`the installation is ${inst.state}: ${inst.reason}`];
    b4b = finding('B4b', 'm4', 'unknown', why);
    b4c = finding('B4c', 'remediation', 'unknown', why);
  } else {
    const level = inst.value.permissions['statuses'];
    if (level === undefined) {
      b4b = finding('B4b', 'm4', 'clear', []);
      b4c = finding('B4c', 'remediation', 'clear', []);
    } else {
      const checks = input.required_checks;
      if (checks.state !== 'ok') {
        const why = [
          `the installation holds statuses:${level} and the required checks are ${checks.state}: ${checks.reason}`,
        ];
        b4b = finding('B4b', 'm4', 'unknown', why);
        b4c = finding('B4c', 'remediation', 'unknown', why);
      } else {
        const unpinned = checks.value.filter((c) => c.integration_id === null);
        if (unpinned.length > 0) {
          b4b = finding('B4b', 'm4', 'blocked', [
            `the installation holds statuses:${level} and required check(s) ${unpinned
              .map((c) => c.context)
              .sort()
              .join(', ')} have no integration_id`,
          ]);
          b4c = finding('B4c', 'remediation', 'clear', []);
        } else {
          b4b = finding('B4b', 'm4', 'clear', []);
          b4c = finding('B4c', 'remediation', 'amber', [
            `the installation holds statuses:${level}; every required check is pinned to an App (remove statuses, DEC-7)`,
          ]);
        }
      }
    }
  }
  return {
    b4a,
    b4b,
    b4c,
    blocks_m4: b4a.active || b4b.active,
    amber: b4c.status === 'amber',
  };
}
