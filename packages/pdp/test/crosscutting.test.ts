import { PdpDecisionRecord, pdpResource } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { CROSS_CUTTING_POLICY_IDS, Pdp, buildBundle } from '../src/index.js';
import { FLEET, proj, rig } from './helpers.js';

const P1 = pdpResource.project('p1');
const G5 = pdpResource.gate('p1', 'g-1', 'G5');
const FLEET_RES = pdpResource.fleet();

describe('cross-cutting rules', () => {
  it('a disabled principal is denied everything, even if its bindings leak through', async () => {
    const { pdp, entities } = rig();
    entities.leakBindingsWhenInactive = true;
    entities
      .addPrincipal('gone', { status: 'disabled' })
      .bind('gone', 'project.admin', proj('p1'))
      .bind('gone', 'factory.admin', FLEET);
    for (const [action, resource] of [
      ['project.view', P1],
      ['project.settings.edit', P1],
      ['kill.request', FLEET_RES],
      ['config.propose', FLEET_RES],
    ] as const) {
      const d = await pdp.decide({ principal: 'gone', action, resource });
      expect(d.decision).toBe('deny');
      expect(d.reasons).toContain(CROSS_CUTTING_POLICY_IDS.disabled);
    }
    entities.setStatus('gone', 'deleted');
    expect(
      (await pdp.decide({ principal: 'gone', action: 'project.view', resource: P1 })).decision,
    ).toBe('deny');
    // The same bindings on an active principal do allow, so the denial above is the status.
    entities.addPrincipal('here').bind('here', 'project.admin', proj('p1'));
    expect(
      (await pdp.decide({ principal: 'here', action: 'project.view', resource: P1 })).decision,
    ).toBe('allow');
  });

  it('a service principal can never decide a gate or a card, whatever it is bound to', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('bot', { kind: 'service' });
    for (const role of ['project.release_approver', 'project.admin', 'factory.admin']) {
      entities.bind('bot', role, role.startsWith('factory') ? FLEET : proj('p1'));
    }
    const d = await pdp.decide({ principal: 'bot', action: 'gate.decide', resource: G5 });
    expect(d.decision).toBe('deny');
    expect(d.reasons).toEqual([CROSS_CUTTING_POLICY_IDS.service_decide]);
    const c = await pdp.decide({
      principal: 'bot',
      action: 'card.decide',
      resource: pdpResource.card('p1', 'c1'),
    });
    expect(c.decision).toBe('deny');
    // It can still do what a role gives it that is not a decision.
    expect(
      (await pdp.decide({ principal: 'bot', action: 'project.view', resource: P1 })).decision,
    ).toBe('allow');
    // The same role on a human decides.
    entities.addPrincipal('hana').bind('hana', 'project.release_approver', proj('p1'));
    expect(
      (await pdp.decide({ principal: 'hana', action: 'gate.decide', resource: G5 })).decision,
    ).toBe('allow');
  });

  it('the fleet kill is factory.admin only; a project kill is for the project kill slot and admin', async () => {
    const { pdp, entities } = rig();
    entities
      .addPrincipal('root')
      .bind('root', 'factory.admin', FLEET)
      .addPrincipal('pat')
      .bind('pat', 'project.admin', proj('p1'))
      .addPrincipal('kim')
      .bind('kim', 'project.kill_holder', proj('p1'))
      .addPrincipal('aud')
      .bind('aud', 'factory.auditor', FLEET);
    const ask = async (
      who: string,
      action: 'kill.request' | 'kill.release',
      resource = FLEET_RES,
    ) => (await pdp.decide({ principal: who, action, resource })).decision;
    expect(await ask('root', 'kill.request')).toBe('allow');
    expect(await ask('root', 'kill.release')).toBe('allow');
    for (const who of ['pat', 'kim', 'aud']) {
      expect(await ask(who, 'kill.request')).toBe('deny');
      expect(await ask(who, 'kill.release')).toBe('deny');
    }
    expect(await ask('pat', 'kill.request', P1)).toBe('allow');
    expect(await ask('kim', 'kill.request', P1)).toBe('allow');
    expect(await ask('aud', 'kill.request', P1)).toBe('deny');
    // Even a project role leaked to the fleet resource is stopped by the explicit forbid.
    entities.addPrincipal('mal').bind('mal', 'project.kill_holder', FLEET);
    const d = await pdp.decide({ principal: 'mal', action: 'kill.request', resource: FLEET_RES });
    expect(d.decision).toBe('deny');
  });
});

describe('fail closed', () => {
  const ask = (pdp: Pdp, action = 'project.view', resource = P1) =>
    pdp.decide({ principal: 'alice', action, resource });

  it('no bundle loaded: deny, with no version to stamp', async () => {
    const { pdp, entities, source } = rig();
    entities.addPrincipal('alice').bind('alice', 'project.admin', proj('p1'));
    expect((await ask(pdp)).decision).toBe('allow');
    source.set(null);
    expect(await ask(pdp)).toMatchObject({
      decision: 'deny',
      reasons: ['no_bundle'],
      bundle_version: null,
      bundle_hash: null,
    });
    source.set(undefined);
    expect((await ask(pdp)).reasons).toEqual(['no_bundle']);
  });

  it('a tampered bundle (hash mismatch) denies, and says which hash it declared', async () => {
    const { pdp, entities, source } = rig();
    entities.addPrincipal('alice').bind('alice', 'project.viewer', proj('p1'));
    const good = buildBundle();
    // Someone adds a permit for everyone without updating the hash.
    const tampered = {
      ...good,
      policies: {
        ...good.policies,
        evil: 'permit (principal, action == Action::"kill.request", resource);',
      },
    };
    source.set(tampered);
    const d = await ask(pdp, 'kill.request', FLEET_RES);
    expect(d).toMatchObject({
      decision: 'deny',
      reasons: ['bundle_hash_mismatch'],
      bundle_hash: good.bundle_hash,
    });
    expect((await ask(pdp)).decision).toBe('deny'); // everything is denied, not just the tampered action
    source.set({ ...good, bundle_version: 'pdp-9.9.9' });
    expect((await ask(pdp)).reasons).toEqual(['bundle_hash_mismatch']);
  });

  it('a malformed bundle, a bundle that fails Cedar validation, and a bundle with a bad schema deny', async () => {
    const { pdp, entities, source } = rig();
    entities.addPrincipal('alice').bind('alice', 'project.admin', proj('p1'));
    source.set({ schema: 'x' });
    expect((await ask(pdp)).reasons).toEqual(['bundle_malformed']);
    // Consistent hash, but a policy the schema rejects.
    const good = buildBundle();
    const base = {
      ...good,
      policies: {
        ...good.policies,
        bad: 'permit (principal, action, resource) when { principal.nope == 1 };',
      },
    };
    const { policyBundleHash } = await import('@aisdlc/contracts');
    source.set({ ...base, bundle_hash: policyBundleHash(base) });
    expect((await ask(pdp)).reasons).toEqual(['bundle_invalid']);
    const brokenSchema = { ...good, schema: 'entity (' };
    source.set({ ...brokenSchema, bundle_hash: policyBundleHash(brokenSchema) });
    expect((await ask(pdp)).reasons).toEqual(['bundle_invalid']);
  });

  it('an entity source that fails, or does not know the principal, denies', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('alice').bind('alice', 'project.admin', proj('p1'));
    expect(
      (await pdp.decide({ principal: 'nobody', action: 'project.view', resource: P1 })).reasons,
    ).toEqual(['unknown_principal']);
    entities.fail();
    expect((await ask(pdp)).reasons).toEqual(['entity_source_error']);
    entities.heal();
    expect((await ask(pdp)).decision).toBe('allow');
  });

  it('an evaluator that throws denies', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('alice').bind('alice', 'project.admin', proj('p1'));
    const boom = new Pdp({
      source: {
        current: () => {
          throw new Error('source exploded');
        },
      },
      entities,
    });
    const d = await boom.decide({ principal: 'alice', action: 'project.view', resource: P1 });
    expect(d.decision).toBe('deny');
    expect(d.reasons[0]).toMatch(/^evaluator_error:source exploded/);
    void pdp;
  });

  it('an unknown action, an invalid resource or an action that does not apply to the resource type deny', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('alice').bind('alice', 'factory.admin', FLEET);
    expect((await ask(pdp, 'project.delete')).reasons).toEqual(['unknown_action']);
    expect(
      (
        await pdp.decide({
          principal: 'alice',
          action: 'project.view',
          resource: { type: 'Project' } as never,
        })
      ).reasons,
    ).toEqual(['invalid_resource']);
    expect((await ask(pdp, 'gate.decide', P1)).reasons).toEqual(['action_not_applicable']);
    expect((await ask(pdp, 'project.onboard', P1)).reasons).toEqual(['action_not_applicable']);
  });

  it('every decision carries the bundle version and hash it was made under', async () => {
    const { pdp, entities } = rig();
    entities.addPrincipal('alice').bind('alice', 'project.admin', proj('p1'));
    const b = buildBundle();
    for (const action of ['project.view', 'kill.request'] as const) {
      const d = await pdp.decide({
        principal: 'alice',
        action,
        resource: action === 'kill.request' ? FLEET_RES : P1,
      });
      expect(d.bundle_version).toBe(b.bundle_version);
      expect(d.bundle_hash).toBe(b.bundle_hash);
      expect(d.reasons.length).toBeGreaterThan(0);
    }
  });
});

describe('the decision log', () => {
  it('logs every deny, every allow of a decide, kill or config action, and not a plain read', async () => {
    const { pdp, entities, log } = rig();
    entities
      .addPrincipal('pat')
      .bind('pat', 'project.admin', proj('p1'))
      .bind('pat', 'project.release_approver', proj('p1'));
    await pdp.decide({ principal: 'pat', action: 'project.view', resource: P1 }); // allow, read: not logged
    await pdp.decide({
      principal: 'pat',
      action: 'gate.decide',
      resource: G5,
      justification: 'looks right',
    }); // allow, decide
    await pdp.decide({ principal: 'pat', action: 'kill.request', resource: P1 }); // allow, kill
    await pdp.decide({ principal: 'pat', action: 'config.propose', resource: P1 }); // allow, config
    await pdp.decide({ principal: 'pat', action: 'kill.request', resource: FLEET_RES }); // deny
    await pdp.decide({
      principal: 'pat',
      action: 'audit.read',
      resource: pdpResource.project('p2'),
    }); // deny
    expect(log.records.map((r) => `${r.action}:${r.decision}:${r.logged_because}`)).toEqual([
      'gate.decide:allow:action',
      'kill.request:allow:action',
      'config.propose:allow:action',
      'kill.request:deny:deny',
      'audit.read:deny:deny',
    ]);
    expect(log.records[0]).toMatchObject({ justification: 'looks right', principal: 'pat' });
    for (const r of log.records) expect(PdpDecisionRecord.safeParse(r).success).toBe(true);
  });

  it('samples the other allows deterministically, and never logs a probe', async () => {
    const all = rig({ sampleRate: 1 });
    all.entities.addPrincipal('pat').bind('pat', 'project.admin', proj('p1'));
    await all.pdp.decide({ principal: 'pat', action: 'project.view', resource: P1 });
    expect(all.log.records.map((r) => r.logged_because)).toEqual(['sampled']);
    await all.pdp.decide(
      { principal: 'pat', action: 'project.view', resource: P1 },
      { log: false },
    );
    expect(all.log.records).toHaveLength(1);
    expect(await all.pdp.allowedActions('pat', P1)).toContain('project.settings.edit');
    expect(all.log.records).toHaveLength(1);
    const none = rig({ sampleRate: 0 });
    none.entities.addPrincipal('pat').bind('pat', 'project.admin', proj('p1'));
    await none.pdp.decide({ principal: 'pat', action: 'project.view', resource: P1 });
    expect(none.log.records).toHaveLength(0);
  });

  it('an allow that must be logged but cannot be is a deny; a deny that cannot be logged is still a deny', async () => {
    const { pdp, entities, log } = rig();
    entities.addPrincipal('pat').bind('pat', 'project.admin', proj('p1'));
    log.failing = true;
    const d = await pdp.decide({ principal: 'pat', action: 'kill.request', resource: P1 });
    expect(d).toMatchObject({ decision: 'deny', reasons: ['decision_log_failed'] });
    expect(
      (await pdp.decide({ principal: 'pat', action: 'project.view', resource: P1 })).decision,
    ).toBe('allow');
    expect(
      (
        await pdp.decide({
          principal: 'pat',
          action: 'audit.read',
          resource: pdpResource.project('p2'),
        })
      ).decision,
    ).toBe('deny');
  });
});
