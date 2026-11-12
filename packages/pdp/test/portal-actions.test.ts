import {
  ROLE_CATALOGUE,
  actionDef,
  pdpResource,
  policyBundleHash,
  type ActionId,
  type PdpResource,
  type RoleDef,
  type Scope,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { buildBundle, bundleWithoutPolicies, verifyBundle } from '../src/index.js';
import { FLEET, proj, rig } from './helpers.js';

// PLAN §7a (2026-11-12): the six portal actions the design proposed (portal-coverage §5 item 6). One table per action,
// written out by hand: which role, bound at its natural scope, is allowed it on the fleet, on its own project and on
// another project. The full role x action matrix is roles.test.ts; this file says what the six mean.

const NEW_ACTIONS = [
  'identity.admin',
  'access.manage',
  'ops.read',
  'session.stop',
  'quality.read',
  'assistant.use',
] as const satisfies readonly ActionId[];

type Where = 'fleet' | 'own' | 'other';
/** Where each role is allowed the action; a role not listed is allowed it nowhere. */
const ALLOWED: Record<(typeof NEW_ACTIONS)[number], Partial<Record<string, readonly Where[]>>> = {
  'identity.admin': { 'factory.admin': ['fleet'] },
  'access.manage': {
    'factory.admin': ['fleet', 'own', 'other'],
    'project.admin': ['own'],
  },
  'ops.read': {
    'factory.admin': ['fleet', 'own', 'other'],
    'factory.auditor': ['fleet', 'own', 'other'],
    'project.admin': ['own'],
    'project.security_approver': ['own'],
  },
  'session.stop': {
    'factory.admin': ['fleet', 'own', 'other'],
    'project.admin': ['own'],
    'project.security_approver': ['own'],
    'project.kill_holder': ['own'],
  },
  'quality.read': {
    'factory.admin': ['fleet', 'own', 'other'],
    'factory.auditor': ['fleet', 'own', 'other'],
    'project.admin': ['own'],
  },
  // a V1 read: every role that sees a project may ask about it; the fleet roles also on the fleet
  'assistant.use': Object.fromEntries(
    ROLE_CATALOGUE.map((r) => [
      r.role_id,
      r.scope_kinds.includes('fleet') ? ['fleet', 'own', 'other'] : ['own'],
    ]),
  ),
};

const RESOURCE: Record<Where, PdpResource> = {
  fleet: pdpResource.fleet(),
  own: pdpResource.project('p1'),
  other: pdpResource.project('p2'),
};
const bindAt = (r: RoleDef): Scope => (r.scope_kinds.includes('fleet') ? FLEET : proj('p1'));

describe('bundleWithoutPolicies (the route tests withhold one grant with it)', () => {
  it('withholds exactly the policies named, rehashed and still valid, and refuses an unknown id', async () => {
    const full = buildBundle();
    const b = bundleWithoutPolicies(full, ['role/factory.auditor/ops.read']);
    expect(Object.keys(b.policies)).toHaveLength(Object.keys(full.policies).length - 1);
    expect(b.bundle_hash).toBe(policyBundleHash(b));
    expect(b.bundle_hash).not.toBe(full.bundle_hash);
    expect(verifyBundle(b).ok).toBe(true);
    const { pdp, entities, source } = rig();
    source.set(b);
    entities.addPrincipal('aud').bind('aud', 'factory.auditor', FLEET);
    const ask = (action: ActionId) =>
      pdp.decide({ principal: 'aud', action, resource: pdpResource.fleet() }, { log: false });
    expect((await ask('ops.read')).decision).toBe('deny');
    expect((await ask('audit.read')).decision).toBe('allow');
    expect((await ask('quality.read')).decision).toBe('allow');
    expect(() => bundleWithoutPolicies(full, ['role/nobody/ops.read'])).toThrow(/no such policy/);
  });
});

describe('the six portal actions (PLAN §7a, 2026-11-12)', () => {
  it('are in the catalogue with fail-closed shapes: config and kill allows are logged, reads are not', () => {
    expect(actionDef('identity.admin')).toMatchObject({ class: 'config', log_allow: true });
    expect(actionDef('identity.admin').resource_types).toEqual(['Fleet']);
    expect(actionDef('access.manage')).toMatchObject({ class: 'config', log_allow: true });
    expect(actionDef('session.stop')).toMatchObject({ class: 'kill', log_allow: true });
    for (const a of ['ops.read', 'quality.read', 'assistant.use'] as const) {
      expect(actionDef(a)).toMatchObject({ class: 'read', log_allow: false });
    }
  });

  for (const action of NEW_ACTIONS) {
    describe(action, () => {
      for (const role of ROLE_CATALOGUE) {
        const want = ALLOWED[action][role.role_id] ?? [];
        it(`${role.role_id}: allowed ${want.length === 0 ? 'nowhere' : want.join(', ')}`, async () => {
          const { pdp, entities } = rig();
          entities.addPrincipal('pat').bind('pat', role.role_id, bindAt(role));
          for (const where of ['fleet', 'own', 'other'] as const) {
            const res = RESOURCE[where];
            const d = await pdp.decide({ principal: 'pat', action, resource: res }, { log: false });
            expect(
              d.decision,
              `${role.role_id} ${action} on ${where}: ${d.reasons.join(',')}`,
            ).toBe(want.includes(where) ? 'allow' : 'deny');
          }
        });
      }
    });
  }

  it('a principal with no binding, a disabled one and an unknown one are denied every one of them', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('nobody');
    entities.addPrincipal('gone', { status: 'disabled' }).bind('gone', 'factory.admin', FLEET);
    for (const action of NEW_ACTIONS) {
      for (const principal of ['nobody', 'gone', 'stranger']) {
        const d = await pdp.decide(
          { principal, action, resource: pdpResource.fleet() },
          { log: false },
        );
        expect(d.decision, `${principal} ${action}`).toBe('deny');
      }
    }
  });

  it('session.stop on the fleet is the factory admin only, whatever a project role holds (DEC-29)', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('kim').bind('kim', 'project.kill_holder', proj('p1'));
    const d = await pdp.decide(
      { principal: 'kim', action: 'session.stop', resource: pdpResource.fleet() },
      { log: false },
    );
    expect(d.decision).toBe('deny');
  });

  it('every allow of identity.admin, access.manage and session.stop is logged; a read is not', async () => {
    const { pdp, entities, log } = rig();
    entities.addPrincipal('root').bind('root', 'factory.admin', FLEET);
    for (const action of NEW_ACTIONS) {
      await pdp.decide({ principal: 'root', action, resource: pdpResource.fleet() });
    }
    expect(log.records.map((r) => r.action).sort()).toEqual(
      ['access.manage', 'identity.admin', 'session.stop'].sort(),
    );
  });
});
