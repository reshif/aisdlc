import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigReader,
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  registerGatewayConfig,
} from '@aisdlc/config';
import { INTEGRATION_CONFIG_KEYS, GATEWAY_CONFIG_KEYS } from '@aisdlc/contracts';
import { createPool, migrate, withTransaction } from '@aisdlc/db';
import { modelProviderRow } from '@aisdlc/integrations';
import { FakeKillState, FakeProvider } from '@aisdlc/ports';
import { appendEvents, runProjection, verifyChain } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { FAKE_MODEL, fakeRouting, hello, StaticConfig } from '../src/testing.js';
import { GatewayService } from '../src/service.js';
import { decideGate, pr, startM1Stack, type M1Stack } from './m1-stack.js';

// The gateway's database role (PLAN M10 follow-up). It used to connect as `aisdlc`, which reads the whole
// record database. Now it connects as `gateway`, a login role in the group role `aisdlc_gateway` that the
// gateway migration grants exactly what the gateway does, and the migrations of EVERY other context are
// applied here too (the whole `aisdlc-migrate` plan), so "cannot read the others" is checked against the
// real schemas, not a subset.

let s: M1Stack;
let role: string;
let gwPool: pg.Pool;

const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');
async function migrateWholePlan(pool: pg.Pool) {
  const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')) as {
    databases: { record: Array<{ scope: string; dir: string }> };
  };
  for (const e of plan.databases.record)
    await migrate(pool, { scope: e.scope, dir: join(planDir, e.dir) });
}
const roleUrl = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};
/** The SQLSTATE of a failing statement, or null if it ran. */
async function code(p: pg.Pool, sql: string, args: unknown[] = []): Promise<string | null> {
  try {
    await p.query(sql, args);
    return null;
  } catch (e) {
    return (e as { code?: string }).code ?? 'unknown';
  }
}

beforeAll(async () => {
  s = await startM1Stack();
  await migrateWholePlan(s.record.pool);
  role = `gw_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await s.record.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_gateway`);
  await s.record.pool.query(`GRANT CONNECT ON DATABASE "${s.record.name}" TO ${role}`);
  gwPool = createPool(roleUrl(s.record.url, role, pw), 4);
});
afterAll(async () => {
  await gwPool.end();
  const admin = s.record.pool;
  await s.stop();
  void admin;
  // the database is gone; the role is cluster-wide, so it is dropped here
  const { default: pgmod } = await import('pg');
  const c = new pgmod.Pool({
    connectionString: new URL('/postgres', s.record.url).toString(),
    max: 1,
  });
  await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await c.end();
});

const ALLOWED = new Set([
  'gateway.budget_group',
  'gateway.vkey',
  'gateway.reservation',
  'record.record_event',
  'record.global_counter',
  'config.genuine_publish',
  'integrations.integration_health',
]);

describe('the gateway database role', () => {
  it('cannot read any table or view of any other context (identity, core, knowledge, security_findings, ledger, decisions, ...)', async () => {
    const tables = (
      await s.record.pool.query<{ s: string; t: string }>(
        `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
      )
    ).rows.map((r) => `${r.s}.${r.t}`);
    // the whole plan is here: the contexts this must be proven against
    for (const must of [
      'identity.principal',
      'core.work_item',
      'security_findings.finding',
      'knowledge.census',
      'ledger.ledger_entry',
      'decisions.gate_instance',
      'config.config_revision',
      'config.config_published',
      'record.outbox',
      'record.projection_checkpoint',
    ]) {
      expect(tables, `${must} should exist in the migrated database`).toContain(must);
    }
    const denied: string[] = [];
    const leaked: string[] = [];
    for (const t of tables) {
      if (ALLOWED.has(t)) continue;
      const c = await code(gwPool, `SELECT 1 FROM ${t} LIMIT 1`);
      if (c === '42501') denied.push(t);
      else leaked.push(`${t}:${c ?? 'readable'}`);
    }
    expect(leaked).toEqual([]);
    expect(denied.length).toBeGreaterThan(20);
    // what it does need, it can read
    for (const t of ALLOWED) expect(await code(gwPool, `SELECT 1 FROM ${t} LIMIT 1`), t).toBeNull();
  });

  it('cannot write what it does not own: no UPDATE, DELETE or TRUNCATE of the record, no DELETE of its own rows, no DDL', async () => {
    // seed one event of ANOTHER context as the owner, and one of its own
    await withTransaction(s.record.pool, async (tx) => {
      await appendEvents(tx, 'identity:probe', 0, [
        { type: 'identity.probe', body: {}, actor: 'test' },
      ]);
    });
    expect(await code(gwPool, `UPDATE record.record_event SET actor = 'x'`)).toBe('42501');
    expect(await code(gwPool, `DELETE FROM record.record_event`)).toBe('42501');
    expect(await code(gwPool, `TRUNCATE record.record_event`)).toBe('42501');
    expect(await code(gwPool, `DELETE FROM record.global_counter`)).toBe('42501');
    expect(await code(gwPool, `DELETE FROM gateway.vkey`)).toBe('42501');
    expect(await code(gwPool, `DELETE FROM gateway.reservation`)).toBe('42501');
    expect(await code(gwPool, `CREATE TABLE gateway.evil (x int)`)).toBe('42501');
    expect(await code(gwPool, `CREATE SCHEMA evil`)).toBe('42501');
    expect(await code(gwPool, `ALTER TABLE gateway.vkey ADD COLUMN x int`)).toBe('42501');
    expect(await code(gwPool, `CREATE TABLE public.evil (x int)`)).toBe('42501');
    // the view is read-only for everyone (a join): never an UPDATE, whatever the grant says
    expect(['42501', '55000']).toContain(
      await code(gwPool, `UPDATE config.genuine_publish SET doc = '{}'`),
    );
  });

  it("sees and appends only its own streams of the record (row-level security): another context's events are invisible and cannot be forged", async () => {
    const seen = await gwPool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream = 'identity:probe'`,
    );
    expect(seen.rows[0].n).toBe(0);
    const owner = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream = 'identity:probe'`,
    );
    expect(owner.rows[0].n).toBe(1);
    // a forged event on another context's stream is refused by the policy, not by luck
    const forged = await code(
      gwPool,
      `INSERT INTO record.record_event (stream, seq, global_seq, event_id, type, body, actor, occurred_at, prev_hash, hash)
       VALUES ('identity:forged', 1, 999999, gen_random_uuid(), 'identity.forged', '{}', 'gateway', date_trunc('milliseconds', now()), repeat('0', 64), repeat('1', 64))`,
    );
    expect(forged).toBe('42501');
  });

  it('does its whole job as that role: budgets, keys, a metered call and the sweep, with a verifiable record', async () => {
    const config = new StaticConfig(fakeRouting());
    const service = new GatewayService({
      pool: gwPool,
      config,
      adapters: new Map([['fake', new FakeProvider()]]),
      kill: new FakeKillState(() => s.clock.now()),
      environment: 'local',
      maxProviderCalls: 100,
      clock: s.clock,
    });
    const g = await service.createBudgetGroup({
      group_id: 'lp-g',
      max_tokens: 10_000,
      max_cost_micro_usd: 1_000_000,
    });
    expect(g.ok).toBe(true);
    const minted = await service.mintVKey(
      {
        scope: { kind: 'unit', ref: 'u-lp' },
        project_id: 'testbed',
        data_class_max: 'D2',
        models: [FAKE_MODEL.model_id],
        tools: [],
        budget_group: 'lp-g',
        expires_at: new Date(s.clock.nowMs() + 3_600_000).toISOString(),
      },
      'core',
    );
    expect(minted.ok).toBe(true);
    if (!minted.ok) return;
    const r = await service.complete(minted.value.key, hello());
    expect(r.ok).toBe(true);
    expect(await service.sweepReservations()).toMatchObject({ abandoned: 0 });
    // the events it wrote are a valid hash chain, read by the owner
    expect(
      await verifyChain(s.record.pool, `gateway:vkey:${minted.value.vkey.vkey_id}`),
    ).toMatchObject({ valid: true });
    const used = await service.budgetGroup('lp-g');
    expect(used?.used_tokens).toBeGreaterThan(0);
  });

  it('reads the published config (through the view, never the ledger) and reports its health; it does not fold the config projection', async () => {
    const reg = registerGatewayConfig(new ConfigRegistry());
    void reg;
    const p = await proposeRevision(s.deps, {
      layer: 'factory',
      proposed_by: pr('dev'),
      doc: {
        [INTEGRATION_CONFIG_KEYS.registry]: [modelProviderRow('fake', 'fake')],
        [GATEWAY_CONFIG_KEYS.models]: [FAKE_MODEL],
        [GATEWAY_CONFIG_KEYS.routes]: [
          { environment: 'local', data_class: 'D2', model_id: FAKE_MODEL.model_id },
        ],
      },
    });
    if (!p.ok) throw new Error(p.error.message);
    expect((await decideGate(s, p.value.gate_instance_id, 'root', 'approve')).ok).toBe(true);
    expect((await configPublish(s.deps, { rev_hash: p.value.rev_hash })).ok).toBe(true);
    // the role may not fold the read model, so a reader that asks it to is refused ...
    const writer = await ConfigReader.create({
      pool: gwPool,
      registry: registerGatewayConfig(new ConfigRegistry()),
    }).catch((e: unknown) => e);
    expect(writer).toBeInstanceOf(Error);
    // ... and one that does not (catchUp: false) reads what the owner's reader folded
    await runProjection(s.record.pool, configProjection);
    const reader = await ConfigReader.create({
      pool: gwPool,
      registry: registerGatewayConfig(new ConfigRegistry()),
      catchUp: false,
    });
    expect(reader.current().revisions.factory).toBe(p.value.rev_hash);
    expect((reader.current().get(INTEGRATION_CONFIG_KEYS.registry) as unknown[]).length).toBe(1);
    const { recordHealth } = await import('@aisdlc/integrations');
    expect(
      await recordHealth(
        gwPool,
        {
          reporter: 'gateway',
          reports: [{ integration_id: 'fake', state: 'ok', detail_code: 'ok' }],
        },
        new Date(),
      ),
    ).toBe(1);
  });
});
