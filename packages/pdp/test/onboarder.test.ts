import {
  ADMIN_OVERRIDE_POLICY_ID,
  GateIdValues,
  isAdminOverride,
  pdpResource,
  type ActionId,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { FLEET, RESOURCES, proj, rig, team } from './helpers.js';

// M9.0 (user decision): `factory.onboarder` holds `project.onboard` at fleet or team scope;
// `factory.admin` holds every action (owner decision 2026-11-13); what no role grant permits is the override.

const ask = async (
  r: ReturnType<typeof rig>,
  principal: string,
  action: ActionId,
  resource: Parameters<typeof r.pdp.decide>[0]['resource'],
) => (await r.pdp.decide({ principal, action, resource }, { log: false })).decision;

describe('factory.onboarder', () => {
  it('at fleet scope may onboard (fleet or any team) and nothing administrative', async () => {
    const r = rig();
    r.entities.addPrincipal('olga').bind('olga', 'factory.onboarder', FLEET);
    expect(await ask(r, 'olga', 'project.onboard', pdpResource.fleet())).toBe('allow');
    expect(await ask(r, 'olga', 'project.onboard', pdpResource.team('t1'))).toBe('allow');
    for (const a of [
      'project.settings.edit',
      'kill.request',
      'kill.release',
      'config.propose',
      'audit.read',
      'access.explain',
    ] as const) {
      expect(await ask(r, 'olga', a, pdpResource.fleet()), a).toBe('deny');
      expect(await ask(r, 'olga', a, pdpResource.project('p1')), a).toBe('deny');
    }
  });

  it('at team scope may onboard only into that team: not the fleet, not another team', async () => {
    const r = rig();
    r.entities.addPrincipal('tom').bind('tom', 'factory.onboarder', team('t1'));
    expect(await ask(r, 'tom', 'project.onboard', pdpResource.team('t1'))).toBe('allow');
    expect(await ask(r, 'tom', 'project.onboard', pdpResource.team('t2'))).toBe('deny');
    expect(await ask(r, 'tom', 'project.onboard', pdpResource.fleet())).toBe('deny');
    // Team-to-project containment is not assumed (fail closed): no project reads either.
    expect(await ask(r, 'tom', 'project.view', pdpResource.project('p1'))).toBe('deny');
  });

  it('decides no gate and no card, at any scope', async () => {
    const r = rig();
    r.entities
      .addPrincipal('olga')
      .bind('olga', 'factory.onboarder', FLEET)
      .addPrincipal('tom')
      .bind('tom', 'factory.onboarder', team('t1'));
    for (const who of ['olga', 'tom']) {
      for (const res of RESOURCES) {
        if (res.res.type === 'Gate') expect(await ask(r, who, 'gate.decide', res.res)).toBe('deny');
        if (res.res.type === 'Card') expect(await ask(r, who, 'card.decide', res.res)).toBe('deny');
      }
    }
  });

  it('a team onboarder bound at a project scope grants nothing (the role cannot be bound there)', async () => {
    const r = rig();
    r.entities.addPrincipal('pia').bind('pia', 'factory.onboarder', proj('p1'));
    expect(await ask(r, 'pia', 'project.onboard', pdpResource.fleet())).toBe('deny');
  });
});

describe('factory.admin holds every action; what the role map does not grant is the override', () => {
  it('holds onboard, settings, kill, config, audit, explain and floor', async () => {
    const r = rig();
    r.entities.addPrincipal('ada').bind('ada', 'factory.admin', FLEET);
    expect(await ask(r, 'ada', 'project.onboard', pdpResource.fleet())).toBe('allow');
    expect(await ask(r, 'ada', 'project.onboard', pdpResource.team('t1'))).toBe('allow');
    expect(await ask(r, 'ada', 'floor.read', pdpResource.fleet())).toBe('allow');
    for (const a of [
      'kill.request',
      'kill.release',
      'config.propose',
      'audit.read',
      'access.explain',
    ] as const) {
      expect(await ask(r, 'ada', a, pdpResource.fleet()), a).toBe('allow');
      expect(await ask(r, 'ada', a, pdpResource.project('p1')), a).toBe('allow');
    }
    expect(await ask(r, 'ada', 'project.settings.edit', pdpResource.project('p1'))).toBe('allow');
  });

  // Owner decision 2026-11-13 (docs/specs/deletion.md §8): nothing applies to the factory admin. It decides every
  // gate and card, and an allow that only the override permits says so (`isAdminOverride`), so callers record it.
  it('decides every gate and card through the override alone, and the allow says it is an override', async () => {
    const r = rig();
    r.entities.addPrincipal('ada').bind('ada', 'factory.admin', FLEET);
    for (const g of GateIdValues) {
      const d = await r.pdp.decide(
        {
          principal: 'ada',
          action: 'gate.decide',
          resource: pdpResource.gate('p1', `gi-${g}`, g, { item: 'i1' }),
        },
        { log: false },
      );
      expect(d.decision, g).toBe('allow');
      expect(d.reasons, g).toEqual([ADMIN_OVERRIDE_POLICY_ID]);
      expect(isAdminOverride(d), g).toBe(true);
    }
    const c = await r.pdp.decide(
      { principal: 'ada', action: 'card.decide', resource: pdpResource.card('p1', 'c1') },
      { log: false },
    );
    expect(isAdminOverride(c)).toBe(true);
    // An administrative action the role holds outright is not an override.
    const o = await r.pdp.decide(
      { principal: 'ada', action: 'project.onboard', resource: pdpResource.fleet() },
      { log: false },
    );
    expect(o.decision).toBe('allow');
    expect(isAdminOverride(o)).toBe(false);
  });

  it('a gate whose slot the role map gives it is a normal allow; one it does not hold is an override', async () => {
    const r = rig();
    r.entities
      .addPrincipal('ada')
      .bind('ada', 'factory.admin', FLEET)
      .bind('ada', 'project.intent_approver', proj('p1'));
    const g0 = pdpResource.gate('p1', 'gi-g0', 'G0', { item: 'i1' });
    const g5 = pdpResource.gate('p1', 'gi-g5', 'G5', { item: 'i1' });
    const d0 = await r.pdp.decide({ principal: 'ada', action: 'gate.decide', resource: g0 });
    const d5 = await r.pdp.decide({ principal: 'ada', action: 'gate.decide', resource: g5 });
    expect(d0.decision).toBe('allow');
    expect(isAdminOverride(d0)).toBe(false);
    expect(d5.decision).toBe('allow');
    expect(isAdminOverride(d5)).toBe(true);
    // The override is always logged as one (decide-class allows are logged anyway; the reason says why).
    expect(r.log.records.map((x) => x.logged_because)).toEqual(['action', 'override']);
  });

  it('a non-admin is unchanged: no override for a project admin outside its slot', async () => {
    const r = rig();
    r.entities.addPrincipal('pat').bind('pat', 'project.admin', proj('p1'));
    expect(
      await ask(r, 'pat', 'gate.decide', pdpResource.gate('p1', 'gi-g5', 'G5', { item: 'i1' })),
    ).toBe('deny');
    expect(await ask(r, 'pat', 'person.delete', pdpResource.fleet())).toBe('deny');
  });

  it('a suspended factory admin is denied (the disabled-principal forbid still applies)', async () => {
    const r = rig();
    r.entities.addPrincipal('ada', { status: 'disabled' }).bind('ada', 'factory.admin', FLEET);
    expect(await ask(r, 'ada', 'project.delete', pdpResource.project('p1'))).toBe('deny');
  });

  it('the fleet kill stays factory.admin only (an onboarder and a project kill holder cannot)', async () => {
    const r = rig();
    r.entities
      .addPrincipal('olga')
      .bind('olga', 'factory.onboarder', FLEET)
      .addPrincipal('kim')
      .bind('kim', 'project.kill_holder', proj('p1'));
    expect(await ask(r, 'olga', 'kill.request', pdpResource.fleet())).toBe('deny');
    expect(await ask(r, 'kim', 'kill.request', pdpResource.fleet())).toBe('deny');
    expect(await ask(r, 'kim', 'kill.request', pdpResource.project('p1'))).toBe('allow');
  });
});
