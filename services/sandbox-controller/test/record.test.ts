import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  registerSandboxConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import {
  PrincipalId,
  ProjectId,
  SANDBOX_CAPS_KEY,
  type RoleSlot,
  type SandboxGrantRef,
} from '@aisdlc/contracts';
import { createPool, migrate } from '@aisdlc/db';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import {
  FakeEligibility,
  FakeStepUp,
  decide,
  prepare,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import { manualClock } from '@aisdlc/kernel';
import { startTestKms } from '@aisdlc/kms-local/testing';
import { startTestNotary } from '@aisdlc/notary/testing';
import { FakeSandbox, HttpSandbox, freeCodingSlots, type SandboxSpec } from '@aisdlc/ports';
import { runProjection } from '@aisdlc/record';
import type { RunningService } from '@aisdlc/service-kit';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootSandboxController } from '../src/boot.js';
import { RecordGrants } from '../src/grants.js';

// M14.2 on a real Postgres with the WHOLE migrate plan applied: the controller boots as its own least-privilege role
// (`aisdlc_sandbox_controller`: the effective-config view and `core.admission_grant`, nothing else), reads the caps
// `sandbox.caps` that an M1 decision published (a reload takes the new caps; an unpublished revision is never in force),
// and checks every session's grant against the row core recorded.

const pr = (s: string): PrincipalId => PrincipalId.parse(s);
const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');
const roleUrl = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

let db: TestDatabase;
let deps: ConfigDeps;
let role: string;
let rolePool: pg.Pool;
let roleDbUrl: string;
const stoppers: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const kms = await startTestKms();
  stoppers.push(() => kms.stop());
  db = await createTestDatabase();
  stoppers.push(() => db.drop());
  const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')) as {
    databases: { record: Array<{ scope: string; dir: string }> };
  };
  for (const e of plan.databases.record)
    await migrate(db.pool, { scope: e.scope, dir: join(planDir, e.dir) });
  const clock = manualClock('2026-11-12T10:00:00.000Z');
  const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
  stoppers.push(() => notary.stop());
  const k = await kms.custodyFor('witness').publicKey('dev:notary');
  if (!k.ok) throw new Error(k.error.message);
  const elig = new FakeEligibility();
  const factory = ProjectId.parse('factory');
  elig.setPolicy(factory, { tier: 'T1' });
  for (const slot of [
    'admin',
    'requesters',
    'intent',
    'design',
    'g4',
    'g5',
    'x',
    'sec',
    'm4',
    'kill',
  ] as RoleSlot[]) {
    elig.setHolders(factory, slot, slot === 'admin' ? [pr('root')] : []);
  }
  deps = {
    pool: db.pool,
    ledger: { notary: notary.clientFor('core'), notaryKey: k.value },
    eligibility: elig,
    stepUp: new FakeStepUp(),
    clock,
    registry: registerSandboxConfig(new ConfigRegistry()),
  };
  role = `sbc_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await db.pool.query(
    `CREATE ROLE ${role} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_sandbox_controller`,
  );
  await db.pool.query(`GRANT CONNECT ON DATABASE "${db.name}" TO ${role}`);
  roleDbUrl = roleUrl(db.url, role, pw);
  rolePool = createPool(roleDbUrl, 2);
});

afterAll(async () => {
  await rolePool?.end();
  for (const s of stoppers.reverse()) await s().catch(() => undefined);
  const { default: pgmod } = await import('pg');
  const c = new pgmod.Pool({ connectionString: new URL('/postgres', db.url).toString(), max: 1 });
  await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await c.end();
});

/** Proposes `sandbox.caps`, decides its M1 gate (approve or not) and publishes an approved one; core's reader folds. */
async function publishCaps(value: unknown, approve = true): Promise<void> {
  const p = await proposeRevision(deps, {
    layer: 'factory',
    proposed_by: pr('dev'),
    doc: { [SANDBOX_CAPS_KEY]: value },
  });
  if (!p.ok) throw new Error(p.error.message);
  if (approve) {
    const prep = await prepare(deps, {
      gate_instance_id: p.value.gate_instance_id,
      principal: pr('root'),
    });
    if (!prep.ok) throw new Error(prep.error.message);
    const v = await recordEvidenceViewed(deps, {
      nonce: prep.value.nonce,
      evidence_hash: prep.value.evidence_hash,
    });
    if (!v.ok) throw new Error(v.error.message);
    const d = await decide(deps, { nonce: prep.value.nonce, decision: 'approve' });
    if (!d.ok) throw new Error(d.error.message);
    const pub = await configPublish(deps, { rev_hash: p.value.rev_hash });
    if (!pub.ok) throw new Error(pub.error.message);
  }
  // the controller's role may not fold the config read model: core does (here, the owner)
  const r = await runProjection(db.pool, configProjection);
  if (!r.ok) throw new Error('projection');
}

const GRANT: SandboxGrantRef = {
  grant_id: 'unit-rec@2',
  item_id: '01930000-0000-7000-8000-0000000000aa',
  unit_id: 'unit-rec',
  lease_epoch: 2,
};
async function recordGrant(g: SandboxGrantRef, status: 'active' | 'waiting' | 'released') {
  await db.pool.query(
    `INSERT INTO core.admission_grant (grant_id, item_id, unit_id, project_id, lease_epoch, slot, envelope, status, granted_at)
     VALUES ($1, $2, $3, 'acme', $4, '{}'::jsonb, '{}'::jsonb, $5, now())
     ON CONFLICT (grant_id) DO UPDATE SET status = EXCLUDED.status`,
    [g.grant_id, g.item_id, g.unit_id, g.lease_epoch, status],
  );
}

describe('the controller database role', () => {
  it('reads the effective-config view and core.admission_grant, and no other table or view', async () => {
    const tables = (
      await db.pool.query<{ s: string; t: string }>(
        `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
      )
    ).rows.map((r) => `${r.s}.${r.t}`);
    expect(tables).toContain('core.work_item');
    expect(tables).toContain('ledger.ledger_entry');
    const allowed = new Set(['config.genuine_publish', 'core.admission_grant']);
    const readable: string[] = [];
    for (const t of tables) {
      if (allowed.has(t)) continue;
      try {
        await rolePool.query(`SELECT 1 FROM ${t} LIMIT 1`);
        readable.push(t);
      } catch (e) {
        if ((e as { code?: string }).code !== '42501') readable.push(`${t}:${String(e)}`);
      }
    }
    expect(readable).toEqual([]);
    for (const t of allowed) await rolePool.query(`SELECT 1 FROM ${t} LIMIT 1`);
    // and it writes nothing
    await expect(
      rolePool.query(`UPDATE core.admission_grant SET status = 'active' WHERE false`),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('RecordGrants: active at the named item, Unit and epoch only', async () => {
    const g = new RecordGrants(rolePool);
    expect(await g.check(GRANT)).toEqual({ ok: true, value: 'not_active' });
    await recordGrant(GRANT, 'active');
    expect(await g.check(GRANT)).toEqual({ ok: true, value: 'active' });
    expect(await g.check({ ...GRANT, lease_epoch: 1 })).toEqual({ ok: true, value: 'not_active' });
    expect(await g.check({ ...GRANT, unit_id: 'unit-x' })).toEqual({
      ok: true,
      value: 'not_active',
    });
    await recordGrant(GRANT, 'waiting');
    expect(await g.check(GRANT)).toEqual({ ok: true, value: 'not_active' });
    const broken = createPool(roleUrl(db.url, role, 'wrong-password'), 1);
    expect((await new RecordGrants(broken).check(GRANT)).ok).toBe(false);
    await broken.end();
  });
});

describe('the booted controller: caps from M1-gated config, grants from the record', () => {
  let svc: RunningService;
  let client: HttpSandbox;
  let fake: FakeSandbox;
  const token = randomBytes(24).toString('hex');
  const KEY = `aisk_${'0123456789abcdef'.repeat(2)}`;
  const w = (id: string): SandboxSpec => ({
    session_id: id,
    class: 'W',
    command: ['node', 'run.js'],
    repo: [],
    gateway_key: KEY,
    grant: GRANT,
  });
  const slots = async () => {
    const r = await client.slots();
    if (!r.ok) throw new Error(r.error.message);
    return r.value;
  };
  const reload = () =>
    fetch(new URL('/v1/admin/reload', svc.url), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });

  beforeAll(async () => {
    fake = new FakeSandbox();
    svc = await bootSandboxController(
      {
        SANDBOX_CONTROLLER_DATABASE_URL: 'env:SBC_DB',
        SBC_DB: roleDbUrl,
        SANDBOX_CONTROLLER_CALLERS: JSON.stringify({
          'core-worker': { token_ref: 'env:SBC_TOKEN', scopes: ['run', 'read', 'admin'] },
        }),
        SBC_TOKEN: token,
        SANDBOX_CONTROLLER_HOST_ID: 'runner-a',
        SANDBOX_CONTROLLER_PORT: '0',
        SANDBOX_CONTROLLER_CAPS_RELOAD_MS: '600000',
      },
      { driver: fake },
    );
    client = new HttpSandbox({ baseUrl: svc.url, token });
  });
  afterAll(async () => {
    await svc?.close();
  });

  it('starts with the defaults; an M1-approved revision takes effect on reload, a host row wins; an undecided one never', async () => {
    expect(await slots()).toMatchObject({
      host_id: 'runner-a',
      caps: { total: 4, coding: 1 },
      caps_source: 'default',
    });
    await publishCaps({ total: 6, coding: 0 });
    // not before the reload
    expect((await slots()).caps).toEqual({ total: 4, coding: 1 });
    expect((await reload()).status).toBe(200);
    const s = await slots();
    expect(s).toMatchObject({ caps: { total: 6, coding: 0 }, caps_source: 'config' });
    expect(freeCodingSlots(s)).toBe(0);
    // coding 0: no W starts, even with an active grant
    await recordGrant(GRANT, 'active');
    expect(await client.run(w('rec-w-0001'))).toMatchObject({ ok: false, error: { code: 'busy' } });
    // this host's own row
    await publishCaps({ total: 6, coding: 0, hosts: { 'runner-a': { total: 3, coding: 1 } } });
    await reload();
    expect((await slots()).caps).toEqual({ total: 3, coding: 1 });
    const ran = await client.run(w('rec-w-0002'));
    expect(ran.ok).toBe(true);
    // a revision nobody approved is never in force
    await publishCaps({ total: 1, coding: 1 }, false);
    await reload();
    expect((await slots()).caps).toEqual({ total: 3, coding: 1 });
  });

  it('a session whose grant is not active in the record is refused; the slot H2 reads is never taken', async () => {
    await recordGrant(GRANT, 'released');
    const r = await client.run(w('rec-w-0003'));
    expect(r).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(fake.runs.map((x) => x.session_id)).not.toContain('rec-w-0003');
    expect((await slots()).used_total).toBe(0);
  });

  it('a document the schema refuses (coding above the total) is refused before an approver sees it', async () => {
    // registry validation refuses coding > total before an approver sees it
    const p = await proposeRevision(deps, {
      layer: 'factory',
      proposed_by: pr('dev'),
      doc: { [SANDBOX_CAPS_KEY]: { total: 2, coding: 5 } },
    });
    expect(p.ok).toBe(false);
  });
});
