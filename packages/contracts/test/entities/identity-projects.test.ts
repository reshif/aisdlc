import { describe, expect, it } from 'vitest';
import {
  Binding,
  Group,
  KillDelegation,
  Membership,
  Principal,
  Project,
  ProjectSettings,
  Qualification,
  Repo,
  RoleMap,
  SodRule,
  Team,
  effectiveSwitch,
  gatingFloorViolations,
  projectSettingsTierViolations,
  type GatingProfile,
} from '../../src/index.js';
import { T0, T1, U1, U2, gatingProfile, projectSettings, roleMap } from './fixtures.js';

const principal = {
  principal_id: 'alice',
  kind: 'human',
  status: 'active',
  entra_oid: '018f3c1e-7b2a-7c3d-8e4f-0123456789ab',
  upn: 'alice@acme.test',
  logins: ['alice-gh'],
  machine_actions: [],
  breakglass: false,
  display_handle: 'alice',
  display_name: 'Alice',
  role_label: null,
  status_changed_at: T0,
};

describe('identity', () => {
  it('round-trips Principal and rejects bad ones', () => {
    expect(Principal.parse(principal)).toEqual(principal);
    expect(Principal.safeParse({ ...principal, status: 'gone' }).success).toBe(false);
    expect(Principal.safeParse({ ...principal, machine_actions: ['x'] }).success).toBe(false);
    expect(Principal.safeParse({ ...principal, extra: 1 }).success).toBe(false);
    const svc = { ...principal, kind: 'service', entra_oid: null, machine_actions: ['gate.read'] };
    expect(Principal.safeParse(svc).success).toBe(true);
    expect(Principal.safeParse({ ...svc, entra_oid: 'x' }).success).toBe(false);
  });

  it('round-trips Group and Membership', () => {
    const g = { group_id: 'g-1', display: 'Owners', pim_managed: false, protected: true };
    expect(Group.parse(g)).toEqual(g);
    expect(Group.safeParse({ ...g, protected: 'yes' }).success).toBe(false);
    const m = {
      group_id: 'g-1',
      principal_id: 'alice',
      active_from: T0,
      active_until: null,
      via: 'direct',
      source: 'sync',
    };
    expect(Membership.parse(m)).toEqual(m);
    expect(Membership.safeParse({ ...m, via: 'magic' }).success).toBe(false);
    expect(Membership.safeParse({ ...m, active_until: T0 }).success).toBe(false);
    expect(Membership.safeParse({ ...m, active_until: T1 }).success).toBe(true);
  });

  it('round-trips Binding with the one Scope type', () => {
    const b = {
      binding_id: U1,
      group_id: 'g-1',
      role_id: 'approver',
      scope: { kind: 'project', ref: 'acme-web' },
      constraints: {},
      expiry: null,
      m_gate_ref: U2,
      config_rev: null,
    };
    expect(Binding.parse(b)).toEqual(b);
    expect(Binding.safeParse({ ...b, scope: { kind: 'planet', ref: 'x' } }).success).toBe(false);
    expect(Binding.safeParse({ ...b, scope: { kind: 'fleet', ref: 'x' } }).success).toBe(false);
    expect(Binding.safeParse({ ...b, binding_id: 'not-a-uuid' }).success).toBe(false);
    expect(Binding.safeParse({ ...b, binding_id: U1.toUpperCase() }).success).toBe(false);
  });

  it('round-trips Qualification, SodRule, Team', () => {
    const q = {
      principal_id: 'alice',
      qual_type: 'sec-training',
      valid_from: T0,
      valid_until: T1,
      source: 'lms_import',
      evidence_ref: null,
    };
    expect(Qualification.parse(q)).toEqual(q);
    expect(Qualification.safeParse({ ...q, valid_until: T0 }).success).toBe(false);
    const r = { rule_id: 'sod-1', kind: 'toxic_pair', role_a: 'requester', role_b: 'approver' };
    expect(SodRule.parse(r)).toEqual(r);
    expect(SodRule.safeParse({ ...r, role_b: 'requester' }).success).toBe(false);
    expect(SodRule.safeParse({ ...r, kind: 'other' }).success).toBe(false);
    const t = {
      team_id: 'platform',
      name: 'Platform',
      classification: 'internal',
      idp_group: null,
    };
    expect(Team.parse(t)).toEqual(t);
    expect(Team.parse({ ...t, idp_group: 'g-platform' })).toEqual({
      ...t,
      idp_group: 'g-platform',
    });
    expect(
      Team.safeParse({ team_id: t.team_id, name: t.name, classification: 'internal' }).success,
    ).toBe(false);
    expect(Team.safeParse({ ...t, classification: 'secret' }).success).toBe(false);
  });
});

describe('projects', () => {
  const project = {
    project_id: 'acme-web',
    name: 'Acme Web',
    team_id: null,
    classification: 'internal',
    stack: 'node',
    deploys: true,
    tier: null,
    level: null,
    owner: 'alice',
    version: 1,
    updated_at: T0,
  };
  it('round-trips Project', () => {
    expect(Project.parse(project)).toEqual(project);
    expect(Project.safeParse({ ...project, tier: 'T9' }).success).toBe(false);
    expect(Project.safeParse({ ...project, project_id: 'Has:Colon' }).success).toBe(false);
    expect(Project.safeParse({ ...project, version: 0 }).success).toBe(false);
  });

  it('round-trips Repo', () => {
    const repo = {
      repo_id: 'r1',
      repo_ref: 'acme/web',
      project_id: 'acme-web',
      host: 'github.com',
      owner: 'acme',
      name: 'web',
      visibility: 'private',
      owner_type: 'org',
      plan: null,
      default_branch: 'main',
      stack: null,
      onboarding_level: 'none',
    };
    expect(Repo.parse(repo)).toEqual(repo);
    expect(Repo.safeParse({ ...repo, onboarding_level: 'light' }).success).toBe(true);
    expect(Repo.safeParse({ ...repo, onboarding_level: 'gold' }).success).toBe(false);
    // Not yet read from the code host: unknown, never assumed.
    expect(
      Repo.safeParse({ ...repo, visibility: null, owner_type: null, default_branch: null }).success,
    ).toBe(true);
    expect(Repo.safeParse({ ...repo, repo_ref: 'no-slash' }).success).toBe(false);
    expect(Repo.safeParse({ ...repo, repo_id: 'a:b' }).success).toBe(false);
  });

  it('role map has exactly the ten slots, codeowners only for g4', () => {
    expect(RoleMap.parse(roleMap())).toEqual(roleMap());
    const nine = Object.fromEntries(Object.entries(roleMap()).filter(([k]) => k !== 'kill'));
    expect(RoleMap.safeParse(nine).success).toBe(false);
    expect(RoleMap.safeParse({ ...roleMap(), g6: roleMap().g5 }).success).toBe(false);
    expect(RoleMap.safeParse({ ...roleMap(), m4: { kind: 'codeowners' } }).success).toBe(false);
    expect(
      RoleMap.safeParse({ ...roleMap(), admin: { kind: 'principals', principals: ['a', 'a'] } })
        .success,
    ).toBe(false);
  });

  it('round-trips ProjectSettings', () => {
    const s = projectSettings();
    expect(ProjectSettings.parse(s)).toEqual(s);
    expect(
      ProjectSettings.safeParse({
        ...s,
        kill_delegations: [{ ...s.kill_delegations[0], scope: { kind: 'fleet', ref: '*' } }],
      }).success,
    ).toBe(false);
    expect(
      ProjectSettings.safeParse({
        ...s,
        two_person: { enabled: false, default: 'on_if_2plus', locked_on: true },
      }).success,
    ).toBe(false);
    expect(
      ProjectSettings.safeParse({
        ...s,
        gating_profile: { ...s.gating_profile, gates: { g0g1: 'on' } },
      }).success,
    ).toBe(false);
    expect(
      ProjectSettings.safeParse({
        ...s,
        gating_profile: { ...s.gating_profile, schedule: 'whenever' },
      }).success,
    ).toBe(false);
  });

  it('kill delegation cannot be fleet-wide or revoked before it was granted', () => {
    const d = {
      delegate: 'bob',
      scope: { kind: 'project', ref: 'acme-web' },
      granted_by: 'alice',
      granted_at: T1,
      revoked_at: null,
    };
    expect(KillDelegation.safeParse(d).success).toBe(true);
    expect(KillDelegation.safeParse({ ...d, revoked_at: T0 }).success).toBe(false);
    expect(KillDelegation.safeParse({ ...d, scope: { kind: 'fleet', ref: '*' } }).success).toBe(
      false,
    );
  });

  it('T2 gating floor: G2, G3d, G3/G3s for L4-L6 and G5 where it deploys', () => {
    const base = { ...gatingProfile() } as GatingProfile;
    const withOff = (g: keyof GatingProfile['gates'], lane?: 'L4'): GatingProfile =>
      lane === undefined
        ? { ...base, gates: { ...base.gates, [g]: 'off' } }
        : { ...base, by_lane: { [lane]: { [g]: 'off' } } };
    const t2 = { tier: 'T2', deploys: true } as const;
    expect(gatingFloorViolations(base, t2)).toEqual([]);
    for (const g of ['g2', 'g3d', 'g3_g3s', 'g5'] as const) {
      expect(gatingFloorViolations(withOff(g), t2).length).toBeGreaterThan(0);
    }
    expect(gatingFloorViolations(withOff('g2', 'L4'), t2).length).toBeGreaterThan(0);
    // G0+G1 and G6 are not on the floor; T0 and T1 may turn anything off.
    expect(gatingFloorViolations(withOff('g6'), t2)).toEqual([]);
    expect(gatingFloorViolations(withOff('g0g1'), t2)).toEqual([]);
    expect(gatingFloorViolations(withOff('g2'), { tier: 'T1', deploys: true })).toEqual([]);
    expect(gatingFloorViolations(withOff('g2'), { tier: 'T0', deploys: true })).toEqual([]);
    // G5 may be off where the project does not deploy, never where it is unknown.
    expect(gatingFloorViolations(withOff('g5'), { tier: 'T2', deploys: false })).toEqual([]);
    expect(
      gatingFloorViolations(withOff('g5'), { tier: 'T2', deploys: null }).length,
    ).toBeGreaterThan(0);
    // A lane override wins over the project-wide switch.
    const lane: GatingProfile = {
      ...base,
      gates: { ...base.gates, g2: 'off' },
      by_lane: { L4: { g2: 'on' }, L5: { g2: 'on' }, L6: { g2: 'on' } },
    };
    expect(effectiveSwitch(lane, 'g2', 'L4')).toBe('on');
    expect(effectiveSwitch(lane, 'g2', 'L1')).toBe('off');
    expect(gatingFloorViolations(lane, t2)).toEqual([]);
  });

  it('settings: T2 locks two-person on', () => {
    const s = projectSettings();
    expect(projectSettingsTierViolations(s, { tier: 'T1', deploys: true })).toEqual([]);
    expect(projectSettingsTierViolations(s, { tier: 'T2', deploys: true })).toContain(
      'T2 locks two-person on',
    );
  });
});
