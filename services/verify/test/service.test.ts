import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { agentDefinition } from '@aisdlc/agents';
import {
  SYNTH_BASE_SHA,
  SYNTH_REPO,
  sha256,
  specHashOf,
  synthOracleEntry,
  synthRepo,
} from '@aisdlc/build';
import {
  DEFAULT_CONSTITUTION,
  VERIFY_EVENT,
  VerifyRunRequest,
  verifyResultHash,
  verifyStream,
  type VerifyStep,
} from '@aisdlc/contracts';
import { createPool, migrate, withTransaction } from '@aisdlc/db';
import { appendEvents } from '@aisdlc/record';
import { createTestDatabase, dbUrlRef, type TestDatabase } from '@aisdlc/db/testing';
import { FakeSandbox, type RepoFile } from '@aisdlc/ports';
import type { RunningService } from '@aisdlc/service-kit';
import { FakeRepoFiles, FakeReviewer, HttpVerify } from '@aisdlc/verify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bootVerify, rebuildCheckResults, resultsOf } from '../src/index.js';

// M14.3 on a real Postgres with the WHOLE migrate plan applied: the verify service boots as its own least-privilege
// role (`aisdlc_verify`: its table and its `verify:` record streams), records each result as a record event and the
// read model in one transaction, answers a command key once, never records the gateway key, and the read model is
// rebuildable from the record alone.

const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');
const roleUrl = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};
const ITEM = '01930000-0000-7000-8000-0000000000c1';
const HEAD = 'b'.repeat(40);
const KEY = `aisk_${'0123456789abcdef'.repeat(3)}`;
const FIXED = 'exports.add = (a, b) => a + b;\nexports.mul = (a, b) => a * b;\n';

let db: TestDatabase;
let role: string;
let rolePool: pg.Pool;
let svc: RunningService;
let client: HttpVerify;
let readOnly: HttpVerify;
const sandbox = new FakeSandbox((spec) => {
  const calc = Buffer.from(
    spec.repo.find((f) => f.path === 'src/calc.js')?.content ?? '',
  ).toString();
  return calc.includes('a + b') ? { exit_code: 0 } : { exit_code: 1, stdout: 'not ok 1 - add\n' };
});
const files = new FakeRepoFiles();
const reviewer = new FakeReviewer();

beforeAll(async () => {
  db = await createTestDatabase();
  const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')) as {
    databases: { record: Array<{ scope: string; dir: string }> };
  };
  for (const e of plan.databases.record)
    await migrate(db.pool, { scope: e.scope, dir: join(planDir, e.dir) });
  role = `vfy_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await db.pool.query(`CREATE ROLE ${role} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_verify`);
  await db.pool.query(`GRANT CONNECT ON DATABASE "${db.name}" TO ${role}`);
  const url = roleUrl(db.url, role, pw);
  rolePool = createPool(url, 2);
  const s = synthRepo();
  const head: RepoFile[] = [
    ...s.files.filter((f) => f.path !== 'src/calc.js'),
    { path: 'src/calc.js', content: FIXED },
    { path: s.oracle.path, content: s.oracle.content },
  ];
  files.set(SYNTH_REPO, SYNTH_BASE_SHA, s.files).set(SYNTH_REPO, HEAD, head);
  const tok = randomBytes(24).toString('hex');
  const rtok = randomBytes(24).toString('hex');
  svc = await bootVerify(
    {
      ...dbUrlRef('VERIFY_DATABASE_URL', url),
      VERIFY_CALLERS: JSON.stringify({
        'core-worker': { token_ref: 'env:TOK', scopes: ['run', 'read'] },
        reader: { token_ref: 'env:RTOK', scopes: ['read'] },
      }),
      TOK: tok,
      RTOK: rtok,
      VERIFY_PORT: '0',
    },
    { sandbox, files, reviewer },
  );
  client = new HttpVerify({ baseUrl: svc.url, token: tok });
  readOnly = new HttpVerify({ baseUrl: svc.url, token: rtok });
});

afterAll(async () => {
  await svc?.close();
  await rolePool?.end();
  await db?.drop();
  const { default: pgmod } = await import('pg');
  const c = new pgmod.Pool({ connectionString: new URL('/postgres', db.url).toString(), max: 1 });
  await c.query(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined);
  await c.end();
});

const def = agentDefinition('A5');
const req = (step: VerifyStep, key = `cmd/${step}/${randomBytes(4).toString('hex')}`) =>
  VerifyRunRequest.parse({
    command_key: key,
    item_id: ITEM,
    project_id: 'acme',
    unit_key: 'main',
    step,
    attempt: 1,
    repo: SYNTH_REPO,
    lane: 'L3',
    base_sha: SYNTH_BASE_SHA,
    head_sha: HEAD,
    locks: { 'test/oracle-add.test.js': sha256(synthRepo().oracle.content) },
    oracles: [
      { oracle_id: 'O1', requirement_id: 'REQ-1', spec_sha256: specHashOf(synthOracleEntry) },
    ],
    repro: false,
    approved_gates: [],
    x2_covered: false,
    x3_approved: false,
    approved_hosts: [],
    constitution: DEFAULT_CONSTITUTION,
    grant: null,
    review:
      step === '7.3' || step === '7.5'
        ? {
            agent: {
              run_id: 'run-1',
              agent_id: 'A5',
              contract_version: def.contract.contract_version,
              prompt_ref: def.prompt.ref,
              prompt_sha256: def.prompt.sha256,
              vkey_id: 'vk-1',
              tools: [...def.contract.tools],
              data_class_max: def.contract.data_class_max,
            },
            gateway_key: KEY,
            artefacts: [],
          }
        : null,
  });

describe('the verify database role', () => {
  it('reads and writes its own table and its own record streams, and no other table', async () => {
    const tables = (
      await db.pool.query<{ s: string; t: string }>(
        `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
      )
    ).rows.map((r) => `${r.s}.${r.t}`);
    expect(tables).toContain('core.work_item');
    const allowed = new Set([
      'verify.check_result',
      'record.record_event',
      'record.global_counter',
    ]);
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
    // a stream of another context cannot be written (row-level security), its own can
    const append = (stream: string) =>
      withTransaction(rolePool, (tx) =>
        appendEvents(tx, stream, 0, [
          { type: 'x.y', body: {}, actor: 'system.verify', idempotency_key: stream },
        ]),
      );
    await expect(append('item:other')).rejects.toMatchObject({ code: '42501' });
    expect((await append(`verify:${ITEM}-probe`)).ok).toBe(true);
    await expect(
      rolePool.query(`UPDATE verify.check_result SET verdict = 'passed'`),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(rolePool.query(`DELETE FROM verify.check_result`)).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('POST /v1/checks', () => {
  it('records the result as a verify.check_recorded event and the read model, once per command key', async () => {
    const r = await client.run(req('7.1', 'cmd/once'));
    if (!r.ok) throw new Error(r.error.message);
    expect(r.value.duplicate).toBe(false);
    expect(r.value.result.verdict).toBe('passed');
    expect(r.value.result_sha256).toBe(verifyResultHash(r.value.result));
    const runs = sandbox.runs.length;
    const again = await client.run(req('7.1', 'cmd/once'));
    expect(again.ok && again.value).toMatchObject({
      duplicate: true,
      result_sha256: r.value.result_sha256,
    });
    expect(sandbox.runs.length).toBe(runs); // nothing ran again
    const ev = await db.pool.query<{ type: string; body: { result_sha256: string } }>(
      'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [verifyStream(ITEM)],
    );
    expect(
      ev.rows.filter((e) => e.body.result_sha256 === r.value.result_sha256).map((e) => e.type),
    ).toEqual([VERIFY_EVENT.check_recorded]);
  });

  it('never records or answers the gateway key a reviewer call was given', async () => {
    const r = await client.run(req('7.3'));
    if (!r.ok) throw new Error(r.error.message);
    expect(reviewer.calls.at(-1)?.key_seen).toBe(true);
    expect(JSON.stringify(r.value)).not.toContain('aisk_');
    const leaked = await db.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE body::text LIKE '%aisk_%'`,
    );
    expect(leaked.rows[0]).toEqual({ n: 0 });
    const rm = await db.pool.query(
      `SELECT count(*)::int AS n FROM verify.check_result WHERE result::text LIKE '%aisk_%'`,
    );
    expect(rm.rows[0]).toEqual({ n: 0 });
  });

  it('a sandbox that cannot be reached is 503 and nothing is recorded; a bad body is 400 with paths only', async () => {
    sandbox.breakIt();
    try {
      const r = await client.run(req('7.1', 'cmd/down'));
      expect(r.ok ? 'ok' : r.error).toMatchObject({ code: 'unavailable', status: 503 });
      const n = await db.pool.query(
        `SELECT count(*)::int AS n FROM verify.check_result WHERE command_key = 'cmd/down'`,
      );
      expect(n.rows[0]).toEqual({ n: 0 });
    } finally {
      sandbox.breakIt(false);
    }
    const res = await fetch(new URL('/v1/checks', svc.url), {
      method: 'POST',
      headers: {
        authorization: `Bearer ${(client as unknown as { o: { token: string } }).o.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...req('7.3'),
        review: { ...req('7.3').review, gateway_key: 'not-a-key' },
      }),
    });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('not-a-key');
  });

  it('needs a token and the right scope', async () => {
    const res = await fetch(new URL('/v1/checks', svc.url), { method: 'POST', body: '{}' });
    expect(res.status).toBe(401);
    const r = await readOnly.run(req('7.1'));
    expect(r.ok ? 'ok' : r.error).toMatchObject({ code: 'refused', status: 403 });
  });
});

describe('GET /v1/results and the read model', () => {
  it('answers the results of a head in record order, by hash, and rebuilds from the record alone', async () => {
    const r4 = await client.run(req('7.4'));
    if (!r4.ok) throw new Error(r4.error.message);
    const list = await readOnly.results(ITEM, HEAD);
    if (!list.ok) throw new Error(list.error.message);
    expect(list.value.map((r) => r.step)).toContain('7.4');
    const one = await fetch(new URL(`/v1/results/${r4.value.result_sha256}`, svc.url), {
      headers: {
        authorization: `Bearer ${(readOnly as unknown as { o: { token: string } }).o.token}`,
      },
    });
    expect(((await one.json()) as { result_sha256: string }).result_sha256).toBe(
      r4.value.result_sha256,
    );

    const before = await resultsOf(db.pool, ITEM, HEAD);
    expect(await rebuildCheckResults(db.pool)).toBe(before.length);
    expect(await resultsOf(db.pool, ITEM, HEAD)).toEqual(before);
  });
});
