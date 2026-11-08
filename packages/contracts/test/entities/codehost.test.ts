import { describe, expect, it } from 'vitest';
import {
  B4Report,
  BranchRules,
  CODEHOST_FORBIDDEN_VERBS,
  CODEHOST_ROLE_PERMISSIONS,
  CODEOWNERS_PATHS,
  CodeHostRoleValues,
  CodeownersSyncReport,
  GITHUB_FORBIDDEN_PERMS,
  InstallationInfo,
  MembershipSource,
  RegisteredRepo,
  RepoFullName,
  SetCodeownerMembersRequest,
  codeHostRoleIsReadOnly,
  forbiddenPermissionsIn,
  isCodeownersGroup,
  roleMapGroupId,
} from '../../src/index.js';

describe('code host vocabulary', () => {
  it('the forbidden verbs are the eight of OB §5.5 / DM §4', () => {
    expect([...CODEHOST_FORBIDDEN_VERBS]).toEqual([
      'merge',
      'enqueue',
      'approve',
      'auto_merge',
      'force',
      'delete',
      'dismiss',
      'admin',
    ]);
  });

  it('forbidden permissions cover OB §6.5 "Never", and no role requests one', () => {
    for (const p of [
      'administration',
      'workflows',
      'secrets',
      'environments',
      'security_events',
      'statuses',
    ]) {
      expect(GITHUB_FORBIDDEN_PERMS).toContain(p);
      expect(forbiddenPermissionsIn({ [p]: 'read' })).toEqual([`${p}:read`]);
    }
    expect(forbiddenPermissionsIn({ actions: 'write' })).toEqual(['actions:write']);
    expect(forbiddenPermissionsIn({ actions: 'read', contents: 'read' })).toEqual([]);
    expect(forbiddenPermissionsIn({ contents: 'admin' })).toEqual(['contents:admin']);
    expect(forbiddenPermissionsIn({ contents: 'sideways' })).toEqual(['contents:sideways']);
    for (const role of CodeHostRoleValues) {
      expect(forbiddenPermissionsIn(CODEHOST_ROLE_PERMISSIONS[role]), role).toEqual([]);
    }
    expect(CodeHostRoleValues.filter(codeHostRoleIsReadOnly)).toEqual(['hub', 'posture']);
  });

  it('parses the shapes the port returns, strictly', () => {
    expect(RepoFullName.safeParse('acme/app').success).toBe(true);
    for (const bad of ['acme', 'a/b/c', '../x', 'a b/c', '']) {
      expect(RepoFullName.safeParse(bad).success, bad).toBe(false);
    }
    expect(
      InstallationInfo.safeParse({
        installation_id: 1,
        account_login: 'a',
        repository_selection: 'all',
        permissions: { contents: 'read' },
        suspended: false,
      }).success,
    ).toBe(true);
    expect(
      InstallationInfo.safeParse({
        installation_id: 1,
        account_login: 'a',
        repository_selection: 'some',
        permissions: {},
        suspended: false,
      }).success,
    ).toBe(false);
    expect(BranchRules.safeParse({ branch: 'main' }).success).toBe(false);
    expect(RegisteredRepo.safeParse({ project_id: 'p1', repo: 'acme/app' }).success).toBe(true);
    expect(CODEOWNERS_PATHS).toEqual(['.github/CODEOWNERS', 'CODEOWNERS', 'docs/CODEOWNERS']);
  });

  it('B4 and the sync report refuse unknown fields', () => {
    expect(B4Report.safeParse({ extra: 1 }).success).toBe(false);
    expect(CodeownersSyncReport.safeParse({}).success).toBe(false);
    expect(
      SetCodeownerMembersRequest.safeParse({ principals: [], source_ref: 'x', y: 1 }).success,
    ).toBe(false);
    expect(
      SetCodeownerMembersRequest.safeParse({ principals: ['a'], source_ref: 'x' }).success,
    ).toBe(true);
  });

  it('codeowners is a membership source, and only the g4 group of a project is a codeowners group', () => {
    expect(MembershipSource.options).toContain('codeowners');
    expect(isCodeownersGroup(roleMapGroupId('acme' as never, 'g4'))).toBe(true);
    expect(isCodeownersGroup('rm.acme.admin')).toBe(false);
    expect(isCodeownersGroup('rm..g4')).toBe(false);
    expect(isCodeownersGroup('g4')).toBe(false);
    expect(isCodeownersGroup('grp.acme.g4')).toBe(false);
  });
});
