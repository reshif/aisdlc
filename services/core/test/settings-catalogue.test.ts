import {
  CATALOGUE,
  catalogueFor,
  clearSettingsReleases,
  currentCatalogueRef,
} from '@aisdlc/catalogue';
import { configPublish, proposeRevision } from '@aisdlc/config';
import { WORK_EVENT, workStream } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { submitRequest } from '../src/index.js';
import { decideGate, pid, pr, setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';
import { loadReports, seedActivePrr } from './work-fixtures.js';

// Portal v2 (H1-H5, H18-H21): the catalogue from the factory's settings. A request made before a limit changes pins
// the code release N; after the publish, a new request pins N+1 (`<base>+settings.1`); each reads its own pin.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  setAdmins(s, 'factory', ['root', 'rita']);
  await loadReports();
});
afterAll(async () => {
  clearSettingsReleases();
  await s.stop();
});

const publish = async (doc: Record<string, unknown>) => {
  const p = await proposeRevision(s.config, { layer: 'factory', proposed_by: pr('root'), doc });
  if (!p.ok) throw new Error(p.error.message);
  expect((await decideGate(s, p.value.gate_instance_id, 'rita', 'approve')).ok).toBe(true);
  expect((await configPublish(s.config, { rev_hash: p.value.rev_hash })).ok).toBe(true);
};

const pinOf = async (requestId: string) => {
  const q = await s.record.pool.query<{
    body: { catalogue_ref: { version: string; hash: string } };
  }>(`SELECT body FROM record.record_event WHERE stream = $1 AND type = $2`, [
    workStream(requestId),
    WORK_EVENT.requested,
  ]);
  return q.rows[0]?.body.catalogue_ref;
};

describe('the catalogue from config, through a request', () => {
  it('changing the rework limit makes N+1 for new requests; the earlier one keeps N', async () => {
    const seeded = await seedActivePrr(s, { level: 'light' });
    const ask = (text: string) =>
      submitRequest(s.deps, {
        project_id: pid(seeded.project),
        repo: seeded.repo,
        lane: 'L3',
        requester: pr('alice'),
        channel: 'N1',
        text,
      });

    const before = await ask('Add pagination to the orders list.');
    if (!before.ok) throw new Error(before.error.message);
    expect(await pinOf(before.value.request_id)).toEqual(currentCatalogueRef());

    await publish({
      'catalogue.rework_budget': {
        ...CATALOGUE.rework_budget,
        total: { ...CATALOGUE.rework_budget.total, value: 8 },
      },
    });

    const after = await ask('Rename the orders table column.');
    if (!after.ok) throw new Error(after.error.message);
    const pinned = await pinOf(after.value.request_id);
    expect(pinned?.version).toBe(`${currentCatalogueRef().version}+settings.1`);

    const n = catalogueFor(currentCatalogueRef());
    const n1 = catalogueFor(pinned!);
    expect(n.ok && n.value.rework_budget.total.value).toBe(5);
    expect(n1.ok && n1.value.rework_budget.total.value).toBe(8);
  });
});
