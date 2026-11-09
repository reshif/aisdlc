import { primaryAgentFor, validateOutput } from '@aisdlc/agents';
import type { StepId } from '@aisdlc/contracts';
import { startTestGateway, type TestGateway } from '@aisdlc/gateway/testing';
import { FakeProvider, PLANNING_FIXTURES, planningFixtureReply } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listUnits } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { planningRig } from './planning.js';
import { loadReports, runItem } from './work-fixtures.js';

// The canned answers a LOCAL stack's fake provider gives the planning steps (`fixtures: "planning"`): every one
// is a valid output of its step's agent, and an L4 item runs S1 to the plan approval on them alone, through the
// real planning port and the real gateway.

let s: CoreStack;
let gw: TestGateway;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startTestGateway({
    database: s.record,
    adapters: { fake: new FakeProvider({ respond: planningFixtureReply }) },
  });
});
afterAll(async () => {
  await gw.stop();
  await s.stop();
});

describe('the planning fixtures of the local fake provider', () => {
  it('every step has the output its agent accepts', () => {
    for (const [step, out] of Object.entries(PLANNING_FIXTURES)) {
      const agent = primaryAgentFor(step as StepId);
      expect(agent, step).not.toBeNull();
      const v = validateOutput(agent?.agent_id ?? 'A3', out);
      expect(v.ok, `${step}: ${v.ok ? '' : JSON.stringify(v.error.errors)}`).toBe(true);
    }
  });

  it('an L4 item runs S1 to the plan approval on them alone, and its Units are planned', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'G3' || g === 'G3s' ? 'hold' : 'approve'),
      stop: (st) => st.gates.some((g) => g.gate === 'G3' && g.status === 'pending'),
      passes: 250,
    });
    expect(item?.state.waiting).toMatchObject({ kind: 'gates', gates: ['G3', 'G3s'] });
    expect((await listUnits(s.record.pool, rig.itemId)).map((u) => u.unit_key)).toEqual([
      'export-route',
      'export-ui',
    ]);
  });

  it('a call that is not a planning input gets no fixture', () => {
    expect(
      planningFixtureReply({
        model: 'm',
        max_tokens: 10,
        messages: [{ role: 'user', content: 'hi' }],
        metadata: {},
      }),
    ).toBeUndefined();
  });
});
