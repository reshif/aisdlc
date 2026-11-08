import { pdpResource, type ActionId, type PdpResource } from '@aisdlc/contracts';
import { FakePdpEntities } from '@aisdlc/ports';
import { Pdp, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  IdentityPdpEntities,
  addMember,
  createBinding,
  createGroup,
  reconcileProject,
  setPrincipalStatus,
} from '../src/index.js';
import {
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

// The PDP against real identity (PLAN M4.3): the identity-backed `PdpEntityPort` answers the same
// questions as `FakePdpEntities`, so the policy tests that ran on the fake mean the same here.

let s: IdentityStack;
let pdp: Pdp;
const FLEET = { kind: 'fleet', ref: '*' } as const;

beforeAll(async () => {
  s = await startIdentityStack();
  await seedPrincipals(s.deps, ['alice', 'bob', 'carol', 'dave', 'root', 'ghost']);
  s.settings.set(
    settingsOf('acme', { admin: ['alice'], intent: ['bob'], kill: ['carol'], g5: ['dave'] }),
    'T1',
  );
  const r = await reconcileProject(
    { ...s.deps, settings: s.settings },
    { project_id: pid('acme') },
  );
  if (!r.ok) throw new Error(r.error.message);
  const g = await createGroup(
    s.deps,
    {
      group_id: 'grp-factory-admins',
      display: 'Factory admins',
      pim_managed: false,
      protected: false,
    },
    'system.test',
  );
  if (!g.ok) throw new Error(g.error.message);
  await addMember(
    s.deps,
    { group_id: 'grp-factory-admins' as never, principal_id: pr('root') },
    'system.test',
  );
  const b = await createBinding(
    s.deps,
    { group_id: 'grp-factory-admins', role_id: 'factory.admin', scope: FLEET },
    'system.test',
  );
  if (!b.ok) throw new Error(b.error.message);
  pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    clock: s.clock,
  });
});
afterAll(async () => {
  await s.stop();
});

const ACME = pdpResource.project('acme');
const can = async (who: string, action: ActionId, resource: PdpResource) =>
  (await pdp.decide({ principal: who, action, resource }, { log: false })).decision;

describe('the PDP over the identity read model', () => {
  it('role-map holders decide their gates, and only theirs', async () => {
    const g = (id: 'G0' | 'G5' | 'G4') => pdpResource.gate('acme', `gate-${id}`, id);
    expect(await can('bob', 'gate.decide', g('G0'))).toBe('allow');
    expect(await can('bob', 'gate.decide', g('G5'))).toBe('deny');
    expect(await can('dave', 'gate.decide', g('G5'))).toBe('allow');
    expect(await can('alice', 'gate.decide', g('G0'))).toBe('deny');
    expect(await can('carol', 'kill.request', ACME)).toBe('allow');
    expect(await can('carol', 'gate.decide', g('G0'))).toBe('deny');
    expect(await can('alice', 'project.settings.edit', ACME)).toBe('allow');
    expect(await can('bob', 'project.settings.edit', ACME)).toBe('deny');
  });

  it('a project role does not reach another project, and a fleet role reaches all', async () => {
    expect(await can('alice', 'project.view', pdpResource.project('other'))).toBe('deny');
    expect(await can('root', 'project.view', pdpResource.project('other'))).toBe('allow');
    expect(await can('root', 'kill.request', pdpResource.fleet())).toBe('allow');
    expect(await can('alice', 'kill.request', pdpResource.fleet())).toBe('deny');
  });

  it('an unknown principal is denied; so is one identity has never heard of', async () => {
    const d = await pdp.decide(
      { principal: 'nobody', action: 'project.view', resource: ACME },
      { log: false },
    );
    expect(d.reasons).toEqual(['unknown_principal']);
  });

  it('answers like the fake on the same facts', async () => {
    const fake = new FakePdpEntities();
    for (const [who, role, scope] of [
      ['alice', 'project.admin', { kind: 'project', ref: 'acme' }],
      ['bob', 'project.intent_approver', { kind: 'project', ref: 'acme' }],
      ['carol', 'project.kill_holder', { kind: 'project', ref: 'acme' }],
      ['dave', 'project.release_approver', { kind: 'project', ref: 'acme' }],
      ['root', 'factory.admin', FLEET],
    ] as const) {
      fake.addPrincipal(who).bind(who, role, scope);
    }
    const viaFake = new Pdp({
      source: new StaticBundleSource(buildBundle()),
      entities: fake,
      clock: s.clock,
    });
    const resources = [
      ACME,
      pdpResource.fleet(),
      pdpResource.gate('acme', 'g1', 'G0'),
      pdpResource.gate('acme', 'g2', 'G5'),
      pdpResource.lane('acme', 'L1'),
    ];
    const actions: ActionId[] = [
      'project.view',
      'gate.decide',
      'kill.request',
      'config.propose',
      'audit.read',
    ];
    for (const who of ['alice', 'bob', 'carol', 'dave', 'root']) {
      for (const resource of resources) {
        for (const action of actions) {
          const a = await pdp.decide({ principal: who, action, resource }, { log: false });
          const b = await viaFake.decide({ principal: who, action, resource }, { log: false });
          expect([who, action, resource.type, a.decision]).toEqual([
            who,
            action,
            resource.type,
            b.decision,
          ]);
        }
      }
    }
  });

  it('disabling a principal takes effect on the next decision', async () => {
    expect(await can('dave', 'gate.decide', pdpResource.gate('acme', 'g9', 'G5'))).toBe('allow');
    const r = await setPrincipalStatus(
      s.deps,
      'dave',
      'disabled',
      'left the company',
      'system.test',
    );
    expect(r.ok).toBe(true);
    const d = await pdp.decide(
      { principal: 'dave', action: 'project.view', resource: ACME },
      { log: false },
    );
    expect(d.decision).toBe('deny');
    expect(await can('dave', 'gate.decide', pdpResource.gate('acme', 'g9', 'G5'))).toBe('deny');
  });

  it('a role map change takes effect on the next decision', async () => {
    expect(await can('bob', 'gate.decide', pdpResource.gate('acme', 'gx', 'G1'))).toBe('allow');
    s.settings.set(
      settingsOf('acme', { admin: ['alice'], intent: ['alice'], kill: ['carol'], g5: [] }),
      'T1',
    );
    const r = await reconcileProject(
      { ...s.deps, settings: s.settings },
      { project_id: pid('acme') },
    );
    expect(r.ok).toBe(true);
    expect(await can('bob', 'gate.decide', pdpResource.gate('acme', 'gx', 'G1'))).toBe('deny');
    expect(await can('alice', 'gate.decide', pdpResource.gate('acme', 'gx', 'G1'))).toBe('allow');
  });
});
