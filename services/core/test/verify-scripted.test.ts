import { FakeStagePorts, scriptVerifyExceptions } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { decideReady, driveWork, ingestItem, readItem, submitRequest } from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  seedActivePrr,
} from './work-fixtures.js';

// M14.6: the scripted S7 the compose e2e runs (core-worker CORE_WORKER_FAKE_VERIFY=exceptions) on human-led L8 items,
// on the real record, ledger and Notary. The first item: Q1 (SECT confirmed sends it back to the developer), D5
// again, X2, E2, then G4. The second: E6 at 7.2, rejected, is the D2 handoff.
let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

async function newL8Item(project: string, repo: string, text: string) {
  const r = await submitRequest(s.deps, {
    project_id: pid(project),
    repo,
    lane: 'L8',
    requester: pr('alice'),
    channel: 'N1',
    text,
  });
  if (!r.ok) throw new Error(r.error.message);
  return r.value.item_id as string;
}

/** Drives one item: Ready by alice, D5 by bob each time the developer is asked, every gate decided by bob. */
async function drive(
  d: ReturnType<typeof driverOver>,
  itemId: string,
  how: (gate: string) => 'approve' | 'reject',
) {
  const decided: string[] = [];
  let d5 = 0;
  for (let i = 0; i < 120; i++) {
    await driveWork(d);
    const st = (await readItem(d.pool, itemId))?.state;
    if (!st || st.terminal !== null || st.underlying === 'Handoff') break;
    const w = st.waiting;
    if (w?.kind === 'stuck') throw new Error(`stuck: ${JSON.stringify(w)}`);
    if (w?.kind === 'human' && w.what === 'ready') {
      const x = await decideReady({ pool: d.pool, clock: s.clock }, itemId, pr('alice'));
      if (!x.ok) throw new Error(x.error.message);
      continue;
    }
    if (w?.kind === 'human' && w.what === 'human_led') {
      d5 += 1;
      const x = await ingestItem({ pool: d.pool, clock: s.clock }, itemId, {
        type: 'item.human_work_done',
        payload: { by: pr('bob') },
        actor: pr('bob'),
        idempotency_key: `human:${itemId}:${d5}`,
      });
      if (!x.ok) throw new Error(x.error.message);
      continue;
    }
    for (const g of st.gates.filter((x) => x.status === 'pending')) {
      const x = await decideGate(s, g.gate_instance_id, 'bob', how(g.gate));
      if (!x.ok) throw new Error(`decide ${g.gate}: ${JSON.stringify(x.error)}`);
      decided.push(`${g.station} ${g.gate} ${how(g.gate)}`);
    }
  }
  return { decided, d5, state: (await readItem(d.pool, itemId))?.state };
}

describe('the scripted S7 exceptions on L8 items (the compose e2e)', () => {
  it('item 1: Q1 -> SECT confirmed -> D5 again -> X2 -> E2 -> G4; item 2: E6 rejected is D2', async () => {
    const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
    approvers(s, seeded.project, ['bob']);
    const d = driverOver(s, { ports: scriptVerifyExceptions(new FakeStagePorts()) });

    const one = await newL8Item(seeded.project, seeded.repo, 'scripted verify one');
    const r1 = await drive(d, one, (g) => (g === 'SECT' ? 'reject' : 'approve'));
    const gates1 = r1.decided.map((x) => x.split(' ').slice(1).join(' '));
    expect(gates1).toEqual(
      expect.arrayContaining(['SECT reject', 'X2 approve', 'E2 approve', 'G4 approve']),
    );
    expect(gates1).not.toContain('E6 approve');
    expect(r1.d5).toBe(2);
    expect(r1.state?.quarantines?.[0]).toMatchObject({ trigger: 'ET10', resolved: 'confirmed' });
    expect(r1.decided.find((x) => x.includes(' X2 '))).toMatch(/^7\.4!X2/);
    expect(r1.decided.find((x) => x.includes(' E2 '))).toMatch(/^7\.5!E2/);

    const two = await newL8Item(seeded.project, seeded.repo, 'scripted verify two');
    const r2 = await drive(d, two, (g) => (g === 'E6' ? 'reject' : 'approve'));
    expect(r2.decided.find((x) => x.includes(' E6 '))).toMatch(/^7\.2!E6 E6 reject$/);
    expect(r2.state?.handoffs.at(-1)).toMatchObject({ code: 'D2', trigger: 'E6' });
  });
});
