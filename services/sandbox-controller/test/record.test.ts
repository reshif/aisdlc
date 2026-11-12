import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ConfigReader,
  ConfigRegistry,
  configProjection,
  configPublish,
  proposeRevision,
  registerSandboxConfig,
  type ConfigDeps,
} from '@aisdlc/config';
import {
  ONBOARDING_PROBE_UNIT,
  PROBE_GRANT_TTL_S,
  PrincipalId,
  ProjectId,
  SANDBOX_CAPS_KEY,
  ONBOARDING_LIGHT_TESTS_KEY,
  DEFAULT_LIGHT_TESTS,
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
import { listen, newApp, type RunningService } from '@aisdlc/service-kit';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootSandboxController } from '../src/boot.js';
import { ConfigCaps } from '../src/caps.js';
import { RecordGrants } from '../src/grants.js';

// M14.2 on a real Postgres with the WHOLE migrate plan applied: the controller boots as its own least-privilege role
// (`aisdlc_sandbox_controller`: the effective-config view, `core.admission_grant` and `core.probe_grant`, nothing else), reads the caps
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
/** The W image the booted controller's host runs, and the one `onboarding.light_tests` names (LF4). */
const W_IMAGE = `sha256:${'d'.repeat(64)}`;

async function publishCaps(
  value: unknown,
  approve = true,
  worker: string | null = W_IMAGE,
): Promise<void> {
  const p = await proposeRevision(deps, {
    layer: 'factory',
    proposed_by: pr('dev'),
    doc: {
      [SANDBOX_CAPS_KEY]: value,
      [ONBOARDING_LIGHT_TESTS_KEY]: { ...DEFAULT_LIGHT_TESTS, worker_image: worker },
    },
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
  it('reads the effective-config view, core.admission_grant and core.probe_grant, and no other table or view', async () => {
    const tables = (
      await db.pool.query<{ s: string; t: string }>(
        `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
      )
    ).rows.map((r) => `${r.s}.${r.t}`);
    expect(tables).toContain('core.work_item');
    expect(tables).toContain('ledger.ledger_entry');
    const allowed = new Set(['config.genuine_publish', 'core.admission_grant', 'core.probe_grant']);
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

  it('RecordGrants: a probe grant starts K-exec only, while granted and young, for its S0 record', async () => {
    const s0 = '01930000-0000-7000-8000-0000000000bb';
    const probe = {
      grant_id: `probe-${'a'.repeat(32)}`,
      item_id: s0,
      unit_id: ONBOARDING_PROBE_UNIT,
      lease_epoch: 1,
    };
    const g = new RecordGrants(rolePool);
    const put = (status: 'granted' | 'recorded', age_s: number) =>
      db.pool.query(
        `INSERT INTO core.onboarding_probe (probe_id, s0_id, project_id, repo, census_hash, baseline_sha, image,
                                            status, outcome, result, result_hash, granted_at, event_gseq)
         VALUES ($1, $2, 'acme', 'acme/app', $3, $4, NULL, $5, $6, $7, $8, now() - make_interval(secs => $9), 1)
         ON CONFLICT (probe_id) DO UPDATE SET status = EXCLUDED.status, outcome = EXCLUDED.outcome,
           result = EXCLUDED.result, result_hash = EXCLUDED.result_hash, granted_at = EXCLUDED.granted_at`,
        [
          probe.grant_id,
          s0,
          'c'.repeat(64),
          'd'.repeat(40),
          status,
          status === 'recorded' ? 'passed' : null,
          status === 'recorded' ? '{}' : null,
          status === 'recorded' ? 'e'.repeat(64) : null,
          age_s,
        ],
      );
    expect(await g.check(probe, 'K-exec')).toEqual({ ok: true, value: 'not_active' });
    await put('granted', 5);
    expect(await g.check(probe, 'K-exec')).toEqual({ ok: true, value: 'active' });
    // never another class, another record, or another epoch
    for (const cls of ['W', 'O', 'K', 'P', 'V'] as const) {
      expect(await g.check(probe, cls)).toEqual({ ok: true, value: 'not_active' });
    }
    expect(
      await g.check({ ...probe, item_id: '01930000-0000-7000-8000-0000000000cc' }, 'K-exec'),
    ).toEqual({ ok: true, value: 'not_active' });
    expect(await g.check({ ...probe, lease_epoch: 2 }, 'K-exec')).toEqual({
      ok: true,
      value: 'not_active',
    });
    // a lapsed grant, and a recorded probe, start nothing
    await put('granted', PROBE_GRANT_TTL_S + 60);
    expect(await g.check(probe, 'K-exec')).toEqual({ ok: true, value: 'not_active' });
    await put('recorded', 5);
    expect(await g.check(probe, 'K-exec')).toEqual({ ok: true, value: 'not_active' });
  });

  it('RecordGrants: active at the named item, Unit and epoch only', async () => {
    const g = new RecordGrants(rolePool);
    expect(await g.check(GRANT, 'W')).toEqual({ ok: true, value: 'not_active' });
    expect(await g.projectOf(GRANT.grant_id)).toBeNull();
    await recordGrant(GRANT, 'active');
    expect(await g.check(GRANT, 'W')).toEqual({ ok: true, value: 'active' });
    // M19: the heartbeat names the grant's project, read as this role
    expect(await g.projectOf(GRANT.grant_id)).toBe('acme');
    expect(await g.check({ ...GRANT, lease_epoch: 1 }, 'W')).toEqual({
      ok: true,
      value: 'not_active',
    });
    expect(await g.check({ ...GRANT, unit_id: 'unit-x' }, 'W')).toEqual({
      ok: true,
      value: 'not_active',
    });
    await recordGrant(GRANT, 'waiting');
    expect(await g.check(GRANT, 'W')).toEqual({ ok: true, value: 'not_active' });
    const broken = createPool(roleUrl(db.url, role, 'wrong-password'), 1);
    expect((await new RecordGrants(broken).check(GRANT, 'W')).ok).toBe(false);
    expect(await new RecordGrants(broken).projectOf(GRANT.grant_id)).toBeNull();
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
        SANDBOX_CONTROLLER_WORKER_IMAGE_ID: W_IMAGE,
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
    // not before the reload: the controller does not act on the publish notification (spec §4), and its periodic
    // reload is 10 minutes in this test
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

  it('M16 part 3: W starts only while onboarding.light_tests names the image this host runs (LF4); else image_unverified', async () => {
    await recordGrant(GRANT, 'active');
    await publishCaps({ total: 3, coding: 1 }, true, `sha256:${'e'.repeat(64)}`);
    await reload();
    const other = await client.run(w('rec-w-lf4-1'));
    expect(other).toMatchObject({ ok: false, error: { code: 'image_unverified' } });
    await publishCaps({ total: 3, coding: 1 }, true, null);
    await reload();
    const none = await client.run(w('rec-w-lf4-2'));
    expect(none).toMatchObject({ ok: false, error: { code: 'image_unverified' } });
    expect(fake.runs.map((x) => x.session_id)).not.toContain('rec-w-lf4-2');
    await publishCaps({ total: 3, coding: 1 });
    await reload();
    expect((await client.run(w('rec-w-lf4-3'))).ok).toBe(true);
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

describe('M19: the booted controller posts heartbeats to core with its activity token', () => {
  it('a session beats at start; the grant project is read from the record; the env is both or neither', async () => {
    const got: Array<{ auth: string | undefined; body: unknown }> = [];
    const core = newApp();
    core.post('/v1/sessions/heartbeat', async (req, reply) => {
      got.push({ auth: req.headers.authorization, body: req.body });
      return reply.code(201).send({ duplicate: false });
    });
    const coreUrl = await listen(core);
    const token = randomBytes(24).toString('hex');
    const env = {
      SANDBOX_CONTROLLER_DATABASE_URL: 'env:SBC_DB',
      SBC_DB: roleDbUrl,
      SANDBOX_CONTROLLER_CALLERS: JSON.stringify({
        'core-worker': { token_ref: 'env:SBC_TOKEN', scopes: ['run', 'read'] },
      }),
      SBC_TOKEN: token,
      SANDBOX_CONTROLLER_PORT: '0',
      SANDBOX_CONTROLLER_CORE_URL: coreUrl,
      SANDBOX_CONTROLLER_CORE_TOKEN_REF: 'env:SBC_CORE_TOKEN',
      SBC_CORE_TOKEN: 'tok-activity-0123456789',
    };
    await expect(
      bootSandboxController(
        { ...env, SANDBOX_CONTROLLER_CORE_TOKEN_REF: '' },
        { driver: new FakeSandbox() },
      ),
    ).rejects.toThrow(/together or not at all/);
    const svc = await bootSandboxController(env, { driver: new FakeSandbox() });
    try {
      await recordGrant(GRANT, 'active');
      const client = new HttpSandbox({ baseUrl: svc.url, token });
      const r = await client.run({
        session_id: 'rec-hb-0001',
        class: 'O',
        command: ['npm', 'test'],
        repo: [],
        grant: GRANT,
      });
      expect(r.ok).toBe(true);
      for (let i = 0; i < 50 && got.length === 0; i++) await new Promise((x) => setTimeout(x, 20));
      expect(got[0]?.auth).toBe('Bearer tok-activity-0123456789');
      expect(got[0]?.body).toMatchObject({
        item_id: GRANT.item_id,
        project_id: 'acme',
        session_id: 'rec-hb-0001',
        unit_id: 'unit-rec',
        sandbox_class: 'O',
      });
    } finally {
      await svc.close();
      await core.close();
    }
  });
});

describe('the reload path on its own (spec §4)', () => {
  // the controller's own reader options (boot.ts): no fold, no poll, no LISTEN
  const reader = () =>
    ConfigReader.create({
      pool: rolePool,
      registry: registerSandboxConfig(new ConfigRegistry()),
      catchUp: false,
      pollIntervalMs: 0,
      listen: false,
    });

  it('with the controller reader options nothing changes until reload() reads the config again', async () => {
    const r = await reader();
    await r.start();
    try {
      const caps = new ConfigCaps(r, 'runner-z');
      const before = caps.current().caps;
      await publishCaps({ total: 5, coding: 1 });
      // deterministic: nothing in this reader can see the publish yet
      expect(caps.current().caps).toEqual(before);
      await caps.reload();
      expect(caps.current()).toEqual({ caps: { total: 5, coding: 1 }, source: 'config' });
    } finally {
      await r.stop();
    }
  });
});
