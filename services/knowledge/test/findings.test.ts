import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashCanonical } from '@aisdlc/kernel';
import { makeCanary } from '@aisdlc/secrets-rules';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { verifyAll } from '@aisdlc/record';
import {
  FileBundleSource,
  FixtureRepo,
  scratchDir,
  startKnowledgeStack,
  type KnowledgeStack,
} from '../src/testing.js';
import { knowledgeJobs } from '../src/store.js';

// M6.2: the human-only finding states, the Security-only store, and the HTTP API's scopes.

const scratch = scratchDir();
const canary = makeCanary('findings-test');
let s: KnowledgeStack;
let findingId = '';
const reason = `rotated the key in the console; ticket 4711, old value was ${canary}`;

beforeAll(async () => {
  const r = new FixtureRepo(scratch.dir, 'f');
  r.write('a.txt', 'a\n').commit('1');
  r.write('secret.txt', `K=${canary}\n`).commit('2');
  const b = r.bundle(join(scratch.dir, 'f.bundle'));
  s = await startKnowledgeStack({ source: new FileBundleSource(b.file, b.manifest) });
  s.principals
    .add({ principal_id: 'alice', kind: 'human', status: 'active' })
    .add({ principal_id: 'svc-bff', kind: 'service', status: 'active' })
    .add({ principal_id: 'bob', kind: 'human', status: 'disabled' });
  const start = await s.call(s.tokens.census, 'POST', '/v1/jobs/census-intake', {
    repo: 'acme/app',
  });
  expect(start.status).toBe(202);
  const id = (start.json as { job_id: string }).job_id;
  await s.runner.idle();
  const job = (await s.call(s.tokens.census, 'GET', `/v1/jobs/${id}`)).json as { state: string };
  expect(job.state).toBe('done');
  findingId = (
    (await s.call(s.tokens.security, 'GET', '/v1/security/findings')).json as {
      findings: Array<{ finding_id: string }>;
    }
  ).findings[0]?.finding_id as string;
});
afterAll(async () => {
  await s?.stop();
  scratch.dispose();
});

const setState = (token: string | null, body: unknown, id = findingId) =>
  s.call(token, 'POST', `/v1/security/findings/${id}/state`, body);

describe('scopes', () => {
  it('start and status need census; findings and states need security; nothing without a token', async () => {
    expect((await s.call(null, 'GET', '/v1/security/findings')).status).toBe(401);
    expect((await s.call(s.tokens.none, 'GET', '/v1/security/findings')).status).toBe(403);
    // A census caller reads counts and can read no finding, not even one id it knows.
    expect((await s.call(s.tokens.census, 'GET', '/v1/security/findings')).status).toBe(403);
    expect(
      (await s.call(s.tokens.census, 'GET', `/v1/security/findings/${findingId}`)).status,
    ).toBe(403);
    expect(
      (await setState(s.tokens.census, { state: 'rotated', principal_id: 'alice', reason: 'x' }))
        .status,
    ).toBe(403);
    // A security caller starts no job.
    expect(
      (await s.call(s.tokens.security, 'POST', '/v1/jobs/census-intake', { repo: 'acme/app' }))
        .status,
    ).toBe(403);
    expect(
      (await s.call(s.tokens.security, 'GET', '/v1/repos/acme/app/security-summary')).status,
    ).toBe(403);
    expect((await s.call(s.tokens.both, 'GET', '/v1/security/findings')).status).toBe(200);
  });

  it('validates input', async () => {
    expect(
      (await s.call(s.tokens.census, 'POST', '/v1/jobs/census-intake', { repo: 'not a repo' }))
        .status,
    ).toBe(400);
    expect(
      (
        await s.call(s.tokens.census, 'POST', '/v1/jobs/census-intake', {
          repo: 'acme/app',
          extra: 1,
        })
      ).status,
    ).toBe(400);
    expect((await s.call(s.tokens.census, 'GET', '/v1/jobs/nope')).status).toBe(400);
    expect(
      (await s.call(s.tokens.census, 'GET', '/v1/jobs/01a1ba7f-5e9c-7048-b519-93e50b1776a9'))
        .status,
    ).toBe(404);
    expect(
      (await s.call(s.tokens.security, 'GET', '/v1/security/findings?state=bogus')).status,
    ).toBe(400);
    expect((await s.call(s.tokens.security, 'GET', '/v1/security/findings/nope')).status).toBe(400);
    expect(
      (
        await s.call(
          s.tokens.security,
          'GET',
          '/v1/security/findings/01a1ba7f-5e9c-7048-b519-93e50b1776a9',
        )
      ).status,
    ).toBe(404);
  });
});

describe('the state of a finding is set only by a human principal', () => {
  it('refuses a service principal, an unknown principal, a disabled one, and an identity service that cannot answer', async () => {
    const body = (principal_id: string) => ({ state: 'rotated', principal_id, reason: 'done' });
    const svc = await setState(s.tokens.security, body('svc-bff'));
    expect(svc.status).toBe(403);
    expect(svc.json).toMatchObject({ error: { code: 'principal_refused' } });
    expect((await setState(s.tokens.security, body('ghost'))).status).toBe(403);
    expect((await setState(s.tokens.security, body('bob'))).status).toBe(403);
    // A caller's own name is not a principal.
    expect((await setState(s.tokens.security, body('security'))).status).toBe(403);
    // The body has no principal at all: refused as invalid, never defaulted to the caller.
    expect((await setState(s.tokens.security, { state: 'rotated', reason: 'x' })).status).toBe(400);
    // Nothing changed.
    const f = (await s.call(s.tokens.security, 'GET', `/v1/security/findings/${findingId}`))
      .json as { state: string };
    expect(f.state).toBe('open');
    const events = await s.db.pool.query(
      `SELECT 1 FROM record.record_event WHERE type = 'finding.state_changed'`,
    );
    expect(events.rowCount).toBe(0);
  });

  it('fails closed when identity does not answer', async () => {
    const down = await startKnowledgeStack({ source: s.source });
    try {
      down.principals.breakIt();
      const r = await down.call(
        down.tokens.security,
        'POST',
        `/v1/security/findings/${findingId}/state`,
        {
          state: 'rotated',
          principal_id: 'alice',
          reason: 'x',
        },
      );
      expect(r.status).toBe(503);
    } finally {
      await down.stop();
    }
  });

  it('refuses edges outside open -> rotated | false_positive | accepted_test_fixture', async () => {
    expect(
      (await setState(s.tokens.security, { state: 'open', principal_id: 'alice', reason: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await setState(s.tokens.security, { state: 'fixed', principal_id: 'alice', reason: 'x' }))
        .status,
    ).toBe(400);
    expect(
      (await setState(s.tokens.security, { state: 'rotated', principal_id: 'alice', reason: '' }))
        .status,
    ).toBe(400);
    expect(
      (
        await setState(
          s.tokens.security,
          { state: 'rotated', principal_id: 'alice', reason: 'x' },
          '01a1ba7f-5e9c-7048-b519-93e50b1776a9',
        )
      ).status,
    ).toBe(404);
  });

  it('a human rotates it: one record event with who, from, to and the hash of the reason, never the reason', async () => {
    const before = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
      .json as { b1_blocked: boolean };
    expect(before.b1_blocked).toBe(true);
    const r = await setState(s.tokens.security, {
      state: 'rotated',
      principal_id: 'alice',
      reason,
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      finding_id: findingId,
      state: 'rotated',
      state_changed_by: 'alice',
      state_reason: reason,
    });
    const ev = await s.db.pool.query<{
      body: Record<string, unknown>;
      actor: string;
      type: string;
    }>(`SELECT type, body, actor FROM record.record_event WHERE stream = $1 ORDER BY seq`, [
      `finding:${findingId}`,
    ]);
    expect(ev.rows.map((e) => e.type)).toEqual(['finding.detected', 'finding.state_changed']);
    const changed = ev.rows[1];
    expect(changed?.actor).toBe('alice');
    expect(changed?.body).toEqual({
      finding_id: findingId,
      repo: 'acme/app',
      from: 'open',
      to: 'rotated',
      principal_id: 'alice',
      reason_sha256: hashCanonical(reason),
    });
    expect(JSON.stringify(ev.rows)).not.toContain(canary);
    expect(JSON.stringify(ev.rows)).not.toContain('ticket 4711');
    // The detection event names no value, fingerprint, path or line either.
    expect(Object.keys(ev.rows[0]?.body ?? {}).sort()).toEqual([
      'finding_id',
      'job_id',
      'repo',
      'rule_id',
    ]);

    const after = (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary'))
      .json as {
      b1_blocked: boolean;
      finding_counts: Record<string, number>;
    };
    expect(after.b1_blocked).toBe(false);
    expect(after.finding_counts).toEqual({
      open: 0,
      rotated: 1,
      false_positive: 0,
      accepted_test_fixture: 0,
    });
  });

  it('is final: a rotated finding cannot be re-decided, even by a human', async () => {
    const r = await setState(s.tokens.security, {
      state: 'false_positive',
      principal_id: 'alice',
      reason: 'changed my mind',
    });
    expect(r.status).toBe(409);
    const again = await setState(s.tokens.security, {
      state: 'rotated',
      principal_id: 'alice',
      reason: 'again',
    });
    expect(again.status).toBe(409);
  });

  it('survives a rescan: the same secret is the same finding, still rotated, and B1 stays unblocked', async () => {
    const job = await s.runJob();
    expect(job.result?.finding_counts).toEqual({
      open: 0,
      rotated: 1,
      false_positive: 0,
      accepted_test_fixture: 0,
    });
    expect(job.result?.security_summary.history_scan).toMatchObject({
      open: 0,
      rotated: 1,
      false_positive: 0,
    });
    const f = (await s.call(s.tokens.security, 'GET', '/v1/security/findings')).json as {
      findings: Array<{ finding_id: string; state: string }>;
    };
    expect(f.findings).toEqual([
      expect.objectContaining({ finding_id: findingId, state: 'rotated' }),
    ]);
    expect(
      (
        (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/app/security-summary')).json as {
          b1_blocked: boolean;
        }
      ).b1_blocked,
    ).toBe(false);
  });

  it('lists by state and repo', async () => {
    const byState = async (st: string) =>
      (
        (await s.call(s.tokens.security, 'GET', `/v1/security/findings?state=${st}&repo=acme/app`))
          .json as { findings: unknown[] }
      ).findings.length;
    expect(await byState('rotated')).toBe(1);
    expect(await byState('open')).toBe(0);
    expect(
      (
        (await s.call(s.tokens.security, 'GET', '/v1/security/findings?repo=acme/other')).json as {
          findings: unknown[];
        }
      ).findings,
    ).toEqual([]);
  });
});

describe('the Security-only store', () => {
  it('is granted to aisdlc_security alone: aisdlc_app, the group role of every record writer, cannot read or write a finding', async () => {
    const c = await s.db.pool.connect();
    try {
      const priv = await c.query<{
        r: string;
        usage: boolean;
        sel: boolean;
        ins: boolean;
        loc: boolean;
      }>(
        `SELECT r,
                has_schema_privilege(r, 'security_findings', 'USAGE') AS usage,
                has_table_privilege(r, 'security_findings.finding', 'SELECT') AS sel,
                has_table_privilege(r, 'security_findings.finding', 'INSERT') AS ins,
                has_table_privilege(r, 'security_findings.finding_location', 'SELECT') AS loc
           FROM unnest(ARRAY['aisdlc_app', 'aisdlc_security']) AS r`,
      );
      expect(priv.rows).toEqual([
        { r: 'aisdlc_app', usage: false, sel: false, ins: false, loc: false },
        { r: 'aisdlc_security', usage: true, sel: true, ins: true, loc: true },
      ]);
      await c.query('SET ROLE aisdlc_app');
      await expect(c.query('SELECT * FROM security_findings.finding')).rejects.toThrow(
        /permission denied/,
      );
      await expect(c.query('SELECT * FROM security_findings.finding_location')).rejects.toThrow(
        /permission denied/,
      );
      // aisdlc_app does read the job table (counts only).
      await c.query('SELECT * FROM knowledge.knowledge_job');
      await c.query('RESET ROLE');
      await c.query('SET ROLE aisdlc_security');
      const n = await c.query('SELECT count(*)::int AS n FROM security_findings.finding');
      expect(n.rows[0]?.n).toBe(1);
      await c.query('RESET ROLE');
    } finally {
      c.release();
    }
  });

  it('is the only place a fingerprint or location lives: no other table in the database holds the fingerprint', async () => {
    const fp = (
      await s.db.pool.query<{ fingerprint: string }>(
        'SELECT fingerprint FROM security_findings.finding',
      )
    ).rows[0]?.fingerprint as string;
    const tables = await s.db.pool.query<{ table_schema: string; table_name: string }>(
      `SELECT table_schema, table_name FROM information_schema.tables
        WHERE table_schema IN ('record', 'knowledge', 'public') AND table_type = 'BASE TABLE'`,
    );
    for (const t of tables.rows) {
      const dump = await s.db.pool.query(
        `SELECT t::text AS row FROM ${t.table_schema}.${t.table_name} t`,
      );
      expect(JSON.stringify(dump.rows), `${t.table_schema}.${t.table_name}`).not.toContain(fp);
      expect(JSON.stringify(dump.rows), `${t.table_schema}.${t.table_name}`).not.toContain(canary);
    }
  });
});

describe('the record', () => {
  it('has an intact hash chain, and the job read model is a pure fold of it', async () => {
    const v = await verifyAll(s.db.pool);
    expect(v.valid).toBe(true);
    const jobs = await expectRebuildEqualsLive(s.db.pool, knowledgeJobs);
    expect(jobs.length).toBeGreaterThanOrEqual(2);
    expect(jobs.every((j) => j.state === 'done')).toBe(true);
  });
});
