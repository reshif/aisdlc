import { DegradedView } from '@aisdlc/contracts';
import { FakeKillState } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createCoreApp,
  pendingOpsActions,
  readDegraded,
  writeHealthSnapshots,
  type CoreScope,
} from '../src/index.js';
import { verdictOfKillState } from '../src/floor-live.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// M19, the degraded states (portal coverage §4) on a real Postgres: the kill switch unreachable reads killed for
// every project asked about, the Notary's tile and the operator actions waiting for the backfill, and the read models
// the work screens are served from, each caught up or marked stale.

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const kills = new FakeKillState(() => new Date('2026-11-12T12:00:00.000Z'));
const T = { portal: 'portal-at-core-degraded'.padEnd(32, 'x') };

beforeAll(async () => {
  s = await startCoreStack();
  const callers: Record<string, readonly CoreScope[]> = { portal: ['portal'] };
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(T),
    callers,
    registry: s.registry,
    clock: s.clock,
    config: s.config,
    kill: verdictOfKillState(kills),
  });
  url = await listen(app);
});
afterAll(async () => {
  await app.close();
  await s.stop();
});

const get = async (q: string) => {
  const r = await fetch(new URL(`/v1/degraded${q}`, url), {
    headers: { authorization: `Bearer ${T.portal}` },
  });
  return { status: r.status, body: r.status === 200 ? DegradedView.parse(await r.json()) : null };
};

describe('GET /v1/degraded', () => {
  it('a kill on a project reads killed; the kill switch unreachable reads killed for every project', async () => {
    const id = kills.kill({ kind: 'project', ref: 'deg-a' } as never);
    let v = (await get('?projects=deg-a,deg-b')).body;
    expect(v?.kills).toEqual([
      expect.objectContaining({
        project_id: 'deg-a',
        state: 'killed',
        killed: true,
        kill_ids: [id],
      }),
      expect.objectContaining({ project_id: 'deg-b', state: 'clear', killed: false }),
    ]);
    kills.breakIt();
    v = (await get('?projects=deg-a,deg-b')).body;
    expect(v?.kills.map((k) => [k.project_id, k.state, k.killed])).toEqual([
      ['deg-a', 'unreachable', true],
      ['deg-b', 'unreachable', true],
    ]);
    kills.breakIt(false);
    kills.release(id);
  });

  it('without a kill verdict configured every project reads killed (unreachable)', async () => {
    const v = await readDegraded({ pool: s.record.pool, now: () => s.clock.now() }, ['deg-c']);
    expect(v.kills[0]).toMatchObject({ state: 'unreachable', killed: true });
  });

  it('the Notary is unknown until read, then its reading; operator actions waiting are counted', async () => {
    let v = (await get('')).body;
    expect(v?.notary).toMatchObject({ state: 'unknown', detail_code: 'no_report' });
    expect(v?.kills).toEqual([]);
    await writeHealthSnapshots(s.record.pool, [
      {
        tile_id: 'service.notary',
        domain: 'service',
        state: 'down',
        detail_code: 'unreachable',
        sli_value: null,
        reporter: 'core-worker',
        as_of: s.clock.now().toISOString(),
      },
    ]);
    v = (await get('')).body;
    expect(v?.notary).toMatchObject({ state: 'down', detail_code: 'unreachable' });
    expect(v?.notary.pending_ops_actions).toBe(await pendingOpsActions(s.record.pool));
  });

  it('the work read models are caught up and say so', async () => {
    const v = (await get('')).body;
    expect(v?.read_models.map((m) => m.name)).toEqual(['work_item', 'floor', 'session_activity']);
    for (const m of v?.read_models ?? []) {
      expect(m).toMatchObject({ stale: false, reason: null });
      expect(m.as_of_seq).toBeLessThanOrEqual(m.head_seq);
    }
  });

  it('a read model whose checkpoint is from another version is stale (it needs a rebuild)', async () => {
    await s.record.pool.query(
      `UPDATE record.projection_checkpoint SET version = version + 1000 WHERE name = 'floor'`,
    );
    const v = (await get('')).body;
    const floor = v?.read_models.find((m) => m.name === 'floor');
    await s.record.pool.query(
      `UPDATE record.projection_checkpoint SET version = version - 1000 WHERE name = 'floor'`,
    );
    expect(floor).toMatchObject({ stale: true });
    expect(floor?.reason).toMatch(/rebuild/);
  });

  it('more than 50 projects is refused', async () => {
    const many = Array.from({ length: 51 }, (_, i) => `p-${i}`).join(',');
    expect((await get(`?projects=${many}`)).status).toBe(400);
  });
});
