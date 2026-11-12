import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { configProjection, loadEffective } from '@aisdlc/config';
import { FACTORY_SCOPE, PROJECT_CONFIG_KEYS, SANDBOX_CAPS_KEY, repoIdOf } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { governingPrr } from '../src/fold.js';
import { driveWork, submitRequest } from '../src/index.js';
import golden from '../src/load/census-golden.json' with { type: 'json' };
import { loadCensus } from '../src/load/fixture.js';
import { LOAD_GATING, loadRepoOf, loadRoleMap, seedLoad } from '../src/load/seed.js';
import { readPrrState } from '../src/prr-store.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { approvers, driverOver, runItem } from './work-fixtures.js';

// PLAN M19, the load test's seed (`aisdlc-load seed`): projects with an active PRR and published settings, the first
// decisions real ledger entries; idempotent; and an item runs to its end in a seeded project under the real engine
// (the deterministic stage ports, the gates decided by the approver and G6 by the requester).

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(() => s?.stop());

const people = { requester: pr('alice'), approver: pr('bob') };

describe('the load seed', () => {
  it('its census is the golden census `a` of the knowledge service, unchanged', () => {
    const file = JSON.parse(
      readFileSync(
        join(import.meta.dirname, '..', '..', 'knowledge', 'test', 'golden', 'census-a-clean.json'),
        'utf8',
      ),
    );
    expect(golden).toEqual(file);
    expect(loadCensus('load-org/p1').repo.full_name).toBe('load-org/p1');
  });

  it('makes projects with an active PRR, published settings and the coding cap; a second run changes nothing', async () => {
    const d = { pool: s.record.pool, clock: s.clock, config: s.config };
    const projects = ['load-a', 'load-b'];
    expect(await seedLoad(d, { projects, people, codingCap: 3 })).toEqual(projects);
    for (const p of projects) {
      const g = governingPrr(await readPrrState(s.record.pool, p, repoIdOf(loadRepoOf(p))));
      expect(g?.prr.level.signed).toBe('full');
      expect(g?.prr.tier.value).toBe('T1');
      await runProjection(s.record.pool, configProjection);
      const eff = await loadEffective(s.record.pool, {
        layer: 'project',
        scope: { kind: 'project', ref: p },
      });
      expect(eff?.doc[PROJECT_CONFIG_KEYS.role_map]).toEqual(loadRoleMap(people));
    }
    const f = await loadEffective(s.record.pool, {
      layer: 'factory',
      scope: FACTORY_SCOPE,
    });
    expect(f?.doc[SANDBOX_CAPS_KEY]).toEqual({ total: 4, coding: 3 });
    const before = await s.record.pool.query('SELECT count(*)::int AS n FROM record.record_event');
    expect(await seedLoad(d, { projects, people, codingCap: 3 })).toEqual([]);
    const after = await s.record.pool.query('SELECT count(*)::int AS n FROM record.record_event');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('an item in a seeded project runs to its end under the engine', async () => {
    approvers(s, 'load-a', ['bob']);
    const d = driverOver(s);
    const r = await submitRequest(s.deps, {
      project_id: 'load-a' as never,
      repo: loadRepoOf('load-a') as never,
      lane: 'L4',
      requester: pr('alice'),
      channel: 'N1',
      text: 'Load item 1: add a CSV export.',
    });
    if (!r.ok) throw new Error(r.error.message);
    const item = await runItem(s, d, r.value.item_id as string, { approver: 'bob', passes: 120 });
    expect(item?.state.terminal).toBe('Done');
    expect(LOAD_GATING.gates.g5).toBe('off');
  });
});

describe('M19: the work driver dispatches for a bounded time per pass', () => {
  it('a pass past its budget dispatches one round only; the next pass goes on', async () => {
    approvers(s, 'load-b', ['bob']);
    for (let i = 0; i < 3; i++) {
      const r = await submitRequest(s.deps, {
        project_id: 'load-b' as never,
        repo: loadRepoOf('load-b') as never,
        lane: 'L4',
        requester: pr('alice'),
        channel: 'N1',
        text: `Budget item ${i}: add a CSV export.`,
      });
      if (!r.ok) throw new Error(r.error.message);
    }
    const d = { ...driverOver(s), batch: 2 };
    // one claim of two commands, then the budget is spent
    expect((await driveWork(d, { dispatchBudgetMs: 0 })).dispatched).toBe(2);
    expect((await driveWork(d, { dispatchBudgetMs: 0 })).dispatched).toBe(2);
    expect((await driveWork(d)).dispatched).toBeGreaterThan(2);
  });
});
