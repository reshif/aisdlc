import {
  GATE_POLICIES,
  ROLE_CATALOGUE,
  roleHolds,
  scopeCovers,
  resourceScopes,
  type ActionId,
  type RoleDef,
  type Scope,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { ACTION_IDS, FLEET, RESOURCES, applicable, lane, proj, rig } from './helpers.js';

// A policy test per role: the role is bound at its natural scope, the principal holds nothing
// else, and EVERY catalogue action is asked on EVERY resource of the matrix. The expectation is
// written out per role below (not derived from the generator), so a change to what a role may do
// shows up here as a deliberate edit.

const VIEWS: ActionId[] = ['project.view', 'floor.read', 'item.view_floor', 'gate.view'];

/** Actions a role holds outright, and the gates it may decide (`decide`), by role. */
const EXPECTED: Record<
  string,
  { actions: ActionId[]; decides: (g: string) => boolean; cards?: boolean }
> = {
  'project.admin': {
    actions: [
      ...VIEWS,
      'work.request',
      // M12.5: the steps of the lifecycle that are not gates (Ready, answers to questions)
      'item.ready',
      // M15.3: RELHOLD's re-request
      'item.release',
      'project.settings.edit',
      'kill.request',
      'kill.release',
      'config.propose',
      'audit.read',
      'access.explain',
      // M9.6: the project admin controls and announces for the project
      'control.apply',
      'control.lift',
      'banner.publish',
    ],
    decides: (g) => GATE_POLICIES[g as keyof typeof GATE_POLICIES].slot === 'admin',
    cards: true,
  },
  'project.requester': {
    actions: [...VIEWS, 'work.request', 'item.ready'],
    decides: (g) => g === 'G6',
    cards: true,
  },
  'project.intent_approver': {
    actions: [...VIEWS, 'item.ready'],
    decides: (g) => ['G0', 'G1', 'G1f', 'G2'].includes(g),
    cards: true,
  },
  'project.design_approver': {
    // M12.5: the observed signals during G3d and the human-written plan are the design slot's
    actions: [...VIEWS, 'item.observe', 'item.plan', 'item.human_done'],
    decides: (g) => ['G3', 'G3d', 'G3s', 'G3o'].includes(g),
    cards: true,
  },
  'project.code_owner': { actions: VIEWS, decides: (g) => g === 'G4', cards: true },
  'project.release_approver': {
    // M15.3: RELHOLD's re-request is the release slot's
    actions: [...VIEWS, 'item.release'],
    decides: (g) => g === 'G5',
    cards: true,
  },
  'project.exception_approver': { actions: VIEWS, decides: (g) => /^(X|E)\d/.test(g), cards: true },
  'project.security_approver': {
    actions: VIEWS,
    decides: (g) => g === 'Q1' || g === 'SECT',
    cards: true,
  },
  'project.onboarding_signer': { actions: VIEWS, decides: (g) => g === 'M4', cards: true },
  'project.kill_holder': {
    actions: [...VIEWS, 'kill.request', 'kill.release'],
    decides: () => false,
  },
  'project.viewer': { actions: VIEWS, decides: () => false },
  'factory.admin': {
    actions: [
      ...VIEWS,
      'project.onboard',
      'project.settings.edit',
      'kill.request',
      'kill.release',
      'config.propose',
      'audit.read',
      'access.explain',
      'control.apply',
      'control.lift',
      'banner.publish',
    ],
    decides: () => false,
  },
  // Fleet-bound: onboarding anywhere, and V1 reads. It decides no gate and no card.
  'factory.onboarder': { actions: [...VIEWS, 'project.onboard'], decides: () => false },
  'factory.auditor': { actions: [...VIEWS, 'audit.read', 'access.explain'], decides: () => false },
};

const bindAt = (r: RoleDef): Scope => (r.scope_kinds.includes('fleet') ? FLEET : proj('p1'));

function expectAllowed(
  role: RoleDef,
  scope: Scope,
  action: ActionId,
  res: (typeof RESOURCES)[number],
): boolean {
  const e = EXPECTED[role.role_id];
  if (!e || !applicable(action, res.res)) return false;
  // Does the binding reach the resource? Independent of the generator: scope containment only.
  const reach = resourceScopes(res.res).some((s) => scopeCovers(scope, s));
  if (!reach) return false;
  if (action === 'gate.decide') return res.res.gate_id !== null && e.decides(res.res.gate_id);
  if (action === 'card.decide') return e.cards === true;
  return e.actions.includes(action);
}

describe('every role is allowed exactly its actions at its scope, denied elsewhere', () => {
  it('has an expectation for every role in the catalogue, and no more', () => {
    expect(Object.keys(EXPECTED).sort()).toEqual(ROLE_CATALOGUE.map((r) => r.role_id).sort());
  });

  for (const role of ROLE_CATALOGUE) {
    it(`${role.role_id}`, async () => {
      const { pdp, entities } = rig();
      const scope = bindAt(role);
      entities.addPrincipal('alice').bind('alice', role.role_id, scope);
      let allowed = 0;
      for (const res of RESOURCES) {
        for (const action of ACTION_IDS) {
          const d = await pdp.decide(
            { principal: 'alice', action, resource: res.res },
            { log: false },
          );
          const want = expectAllowed(role, scope, action, res);
          expect(
            d.decision,
            `${role.role_id} ${action} on ${res.name}: ${d.reasons.join(',')}`,
          ).toBe(want ? 'allow' : 'deny');
          if (want) allowed++;
          // The generated grant agrees with the independent expectation.
          if (applicable(action, res.res) && want)
            expect(roleHolds(role, action, res.res)).toBe(true);
        }
      }
      expect(allowed).toBeGreaterThan(0);
    });
  }

  it('a project role bound at p1 gets nothing on p2, and a lane-bound kill holder only on its lane', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('kim').bind('kim', 'project.kill_holder', lane('p1', 'L3'));
    const ask = async (res: (typeof RESOURCES)[number]['res'], action: ActionId = 'kill.request') =>
      (await pdp.decide({ principal: 'kim', action, resource: res }, { log: false })).decision;
    expect(await ask(RESOURCES.find((r) => r.name === 'lane p1/L3')!.res)).toBe('allow');
    expect(await ask(RESOURCES.find((r) => r.name === 'lane p1/L4')!.res)).toBe('deny');
    expect(await ask(RESOURCES.find((r) => r.name === 'project p1')!.res)).toBe('deny');
    expect(await ask(RESOURCES.find((r) => r.name === 'fleet')!.res)).toBe('deny');
    expect(await ask(RESOURCES.find((r) => r.name === 'item in L3')!.res, 'item.view_floor')).toBe(
      'allow',
    );
  });

  it('a role bound at a scope kind its definition does not allow grants nothing', async () => {
    const { pdp, entities } = rig();
    // project.admin may only be bound at a project; a lane binding of it is ignored.
    entities.addPrincipal('ann').bind('ann', 'project.admin', lane('p1', 'L3'));
    const r = RESOURCES.find((x) => x.name === 'lane p1/L3')!;
    expect(
      (await pdp.decide({ principal: 'ann', action: 'floor.read', resource: r.res })).decision,
    ).toBe('deny');
    // An unknown role is ignored the same way.
    entities.addPrincipal('bo').bind('bo', 'project.nonexistent', proj('p1'));
    const p = RESOURCES.find((x) => x.name === 'project p1')!;
    expect(
      (await pdp.decide({ principal: 'bo', action: 'project.view', resource: p.res })).decision,
    ).toBe('deny');
  });

  it('two roles add up: the union of what each holds', async () => {
    const { pdp, entities } = rig();
    entities
      .addPrincipal('dee')
      .bind('dee', 'project.intent_approver', proj('p1'))
      .bind('dee', 'project.release_approver', proj('p1'));
    const g = (id: 'G0' | 'G5' | 'G4') => RESOURCES.find((r) => r.name === `gate ${id} p1`)!.res;
    const can = async (id: 'G0' | 'G5' | 'G4') =>
      (
        await pdp.decide(
          { principal: 'dee', action: 'gate.decide', resource: g(id) },
          { log: false },
        )
      ).decision;
    expect(await can('G0')).toBe('allow');
    expect(await can('G5')).toBe('allow');
    expect(await can('G4')).toBe('deny');
  });
});
