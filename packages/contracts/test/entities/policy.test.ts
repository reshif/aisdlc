import { describe, expect, it } from 'vitest';
import {
  ACTION_CATALOGUE,
  ACTION_IDS,
  ActionDef,
  GATE_DECIDING_SLOTS,
  GATE_POLICIES,
  LOGGED_ALLOW_ACTIONS,
  PdpResource,
  ROLE_CATALOGUE,
  STEP_UP_TTL_SECONDS,
  StepUpClaims,
  actionDef,
  pdpResource,
  policyBundleHash,
  resourceParents,
  resourceScopes,
  roleGrants,
  roleHolds,
  scopeCovers,
  type RoleDef,
} from '../../src/index.js';

const role = (id: string): RoleDef => ROLE_CATALOGUE.find((r) => r.role_id === id) as RoleDef;

describe('action catalogue', () => {
  it('has well-formed entries keyed by their own id', () => {
    for (const id of ACTION_IDS) {
      expect(ActionDef.safeParse(ACTION_CATALOGUE[id]).success).toBe(true);
      expect(ACTION_CATALOGUE[id].action_id).toBe(id);
    }
    expect(ACTION_IDS).toEqual(
      expect.arrayContaining(['project.onboard', 'item.view_floor', 'floor.read', 'kill.release']),
    );
  });

  it('logs the allow of every decide, kill and config action, and of the onboarding request', () => {
    for (const id of ACTION_IDS) {
      const d = actionDef(id);
      if (['decide', 'kill', 'config'].includes(d.class))
        expect(LOGGED_ALLOW_ACTIONS).toContain(id);
    }
    expect(LOGGED_ALLOW_ACTIONS).toContain('project.onboard');
    expect(LOGGED_ALLOW_ACTIONS).not.toContain('project.view');
  });

  it('every action is granted to at least one role, and no role holds nothing', () => {
    for (const id of ACTION_IDS) {
      expect(ROLE_CATALOGUE.some((r) => roleGrants(r).some((g) => g.action === id))).toBe(true);
    }
    for (const r of ROLE_CATALOGUE) expect(roleGrants(r).length).toBeGreaterThan(0);
  });

  it('gate-deciding slots come from the gate policies, not a second list', () => {
    expect([...GATE_DECIDING_SLOTS].sort()).toEqual(
      [...new Set(Object.values(GATE_POLICIES).map((p) => p.slot))].sort(),
    );
    expect(GATE_DECIDING_SLOTS).not.toContain('kill');
  });

  it('gate.decide is held for the role slot of the gate policy, and for no other gate', () => {
    expect(
      roleHolds(role('project.release_approver'), 'gate.decide', pdpResource.gate('p', 'g', 'G5')),
    ).toBe(true);
    expect(
      roleHolds(role('project.release_approver'), 'gate.decide', pdpResource.gate('p', 'g', 'G4')),
    ).toBe(false);
    expect(roleHolds(role('factory.admin'), 'gate.decide', pdpResource.gate('p', 'g', 'G5'))).toBe(
      false,
    );
    // an action asked of a resource type it does not apply to is held by nobody
    expect(roleHolds(role('project.admin'), 'gate.decide', pdpResource.project('p'))).toBe(false);
  });
});

describe('resources and scopes', () => {
  it('validates the shape: a gate has a gate id, a fleet has its fixed id, a lane has a project', () => {
    expect(PdpResource.safeParse(pdpResource.fleet()).success).toBe(true);
    expect(PdpResource.safeParse({ ...pdpResource.fleet(), id: 'x' }).success).toBe(false);
    expect(
      PdpResource.safeParse({ ...pdpResource.gate('p', 'g', 'G0'), gate_id: null }).success,
    ).toBe(false);
    expect(PdpResource.safeParse({ ...pdpResource.project('p'), gate_id: 'G0' }).success).toBe(
      false,
    );
    expect(PdpResource.safeParse({ ...pdpResource.lane('p', 'L1'), project: null }).success).toBe(
      false,
    );
  });

  it('lists the scopes a resource lives in, innermost first, ending at the fleet', () => {
    expect(resourceScopes(pdpResource.fleet())).toEqual([{ kind: 'fleet', ref: '*' }]);
    expect(
      resourceScopes(pdpResource.item('p1', 'i1', 'L3')).map((s) => `${s.kind}:${s.ref}`),
    ).toEqual(['item:p1/i1', 'lane:p1/L3', 'project:p1', 'fleet:*']);
    expect(resourceParents(pdpResource.gate('p1', 'g', 'G0', { item: 'i1', lane: 'L3' }))).toEqual([
      { type: 'Item', id: 'p1/i1' },
      { type: 'Project', id: 'p1' },
    ]);
  });

  it('a project binding covers the lane of an item in it; a lane binding does not cover the project', () => {
    const chain = resourceScopes(pdpResource.item('p1', 'i1', 'L3'));
    expect(chain.some((s) => scopeCovers({ kind: 'project', ref: 'p1' }, s))).toBe(true);
    expect(chain.some((s) => scopeCovers({ kind: 'lane', ref: 'p1/L3' }, s))).toBe(true);
    expect(chain.some((s) => scopeCovers({ kind: 'lane', ref: 'p1/L4' }, s))).toBe(false);
    expect(
      resourceScopes(pdpResource.project('p1')).some((s) =>
        scopeCovers({ kind: 'lane', ref: 'p1/L3' }, s),
      ),
    ).toBe(false);
  });
});

describe('bundle hash and step-up claims', () => {
  it('hashes the content that matters and nothing else', () => {
    const base = { schema: 's', policies: { a: 'x' }, bundle_version: '1' };
    expect(policyBundleHash(base)).toBe(policyBundleHash({ ...base, policies: { a: 'x' } }));
    expect(policyBundleHash(base)).not.toBe(policyBundleHash({ ...base, bundle_version: '2' }));
    expect(policyBundleHash(base)).not.toBe(policyBundleHash({ ...base, policies: { a: 'y' } }));
  });

  it('step-up claims are strict, and a proof lives five minutes', () => {
    expect(STEP_UP_TTL_SECONDS).toBe(300);
    const c = {
      v: 1,
      proof_id: '01a1ba14-bf57-70d8-86e9-0962de54b667',
      principal: 'alice',
      bound_hash: 'a'.repeat(64),
      method: 'reauth',
      auth_time: '2026-11-09T10:00:00.000Z',
      issued_at: '2026-11-09T10:00:00.000Z',
      expires_at: '2026-11-09T10:05:00.000Z',
    };
    expect(StepUpClaims.safeParse(c).success).toBe(true);
    expect(StepUpClaims.safeParse({ ...c, method: 'sms' }).success).toBe(false);
    expect(StepUpClaims.safeParse({ ...c, extra: 1 }).success).toBe(false);
    expect(StepUpClaims.safeParse({ ...c, bound_hash: 'abc' }).success).toBe(false);
  });
});
