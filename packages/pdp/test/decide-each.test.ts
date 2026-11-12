import { ACTION_IDS, pdpResource, type PdpResource } from '@aisdlc/contracts';
import type { PdpEntityPort } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import { MemoryDecisionLog, Pdp, StaticBundleSource, buildBundle } from '../src/index.js';
import { RESOURCES, lane, proj, rig } from './helpers.js';

// M19 (the load test's floor hot spot): `decideEach` answers exactly what `decide(..., { log: false })` answers one by
// one, asks the entity source's batch view (one per call) when it has one, never logs, and fails closed per resource.

const strip = (d: { decision: string; reasons: readonly string[] }) => ({
  decision: d.decision,
  reasons: [...d.reasons].sort(),
});

describe('Pdp.decideEach', () => {
  it('gives the same answer as decide for every action and resource of the matrix', async () => {
    const { pdp, entities } = rig();
    entities
      .addPrincipal('ann')
      .bind('ann', 'project.contributor', proj('p1'))
      .bind('ann', 'project.viewer', lane('p1', 'L3'));
    const all: PdpResource[] = RESOURCES.map((r) => r.res);
    for (const action of ACTION_IDS) {
      const each = await pdp.decideEach('ann', action, all);
      expect(each).toHaveLength(all.length);
      for (const [i, res] of all.entries()) {
        const one = await pdp.decide({ principal: 'ann', action, resource: res }, { log: false });
        expect(strip(each[i] as never), `${action} on ${RESOURCES[i]?.name}`).toEqual(strip(one));
      }
    }
  });

  it('asks one batch view of the entity source per call, for every resource', async () => {
    const { entities } = rig();
    entities.addPrincipal('ann').bind('ann', 'project.viewer', proj('p1'));
    let views = 0;
    let asked = 0;
    const port: PdpEntityPort = {
      principalFacts: () => {
        throw new Error('the batch view is asked, not the source');
      },
      batch: () => {
        views += 1;
        return {
          principalFacts: (p, s, at) => {
            asked += 1;
            return entities.principalFacts(p, s, at);
          },
        };
      },
    };
    const pdp = new Pdp({ source: new StaticBundleSource(buildBundle()), entities: port });
    const items = Array.from({ length: 30 }, (_, i) => pdpResource.item('p1', `i${i}`, 'L4'));
    const out = await pdp.decideEach('ann', 'item.view_floor', items);
    expect(out.every((d) => d.decision === 'allow')).toBe(true);
    expect([views, asked]).toEqual([1, 30]);
  });

  it('logs nothing, and fails closed per resource (unknown action, bad resource, a source that throws)', async () => {
    const { pdp, entities, log } = rig();
    entities.addPrincipal('ann').bind('ann', 'project.viewer', proj('p1'));
    const r = pdpResource.item('p1', 'i1', 'L4');
    expect((await pdp.decideEach('ann', 'nope.never', [r]))[0]?.decision).toBe('deny');
    const mixed = await pdp.decideEach('ann', 'item.view_floor', [
      r,
      { type: 'Bogus' } as never,
      pdpResource.project('p1'),
    ]);
    expect(mixed.map((d) => d.decision)).toEqual(['allow', 'deny', 'deny']);
    expect(mixed[1]?.reasons).toContain('invalid_resource');
    expect(log.records).toHaveLength(0);
    const broken = new Pdp({
      source: new StaticBundleSource(buildBundle()),
      entities: {
        principalFacts: async () => {
          throw new Error('identity went away');
        },
      },
      log: new MemoryDecisionLog(),
    });
    const d = await broken.decideEach('ann', 'item.view_floor', [r, r]);
    expect(d.map((x) => x.decision)).toEqual(['deny', 'deny']);
  });
});
