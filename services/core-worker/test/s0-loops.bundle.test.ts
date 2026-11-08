import { spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { S0_EVENT, s0Stream } from '@aisdlc/contracts';
import {
  pid,
  publishSettings,
  request,
  setAdmins,
  startCoreStack,
  type CoreStack,
} from '@aisdlc/core/testing';
import { readS0, requestOnboarding } from '@aisdlc/core';
import { dbUrlRef } from '@aisdlc/db/testing';
import { listen, newApp } from '@aisdlc/service-kit';
import { settingsOf } from '@aisdlc/identity/testing';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startFakeCodehost } from './fake-codehost.js';

// The core-worker bundle as a process with the two M7 loops on (PLAN M7.1, M7.2): the S0 step
// driver and the role-map sync, over a migrated record database, the codehost's read routes, and
// stand-ins for knowledge and identity. The database URL reaches the child as an `env:` reference
// (`dbUrlRef`), the way CI's password-protected Postgres needs it. Repos come from core's own read
// model (there is no registered-repos file).

const root = join(import.meta.dirname, '..', '..', '..');
const bundle = join(root, 'services', 'core-worker', 'dist', 'main.js');

let s: CoreStack;
let child: ChildProcess | undefined;
let output = '';
const stubs: FastifyInstance[] = [];
const tok = (n: string) => `${n}-token-`.padEnd(32, 'x');
const jobs: Array<{ repo: string; id: string }> = [];
const reconciles: Array<{ project: string; body: Record<string, unknown> }> = [];
let ch: Awaited<ReturnType<typeof startFakeCodehost>>;

beforeAll(async () => {
  s = await startCoreStack();
  ch = await startFakeCodehost(tok('codehost'));
  const auth = (token: string) => async (req: FastifyRequest, reply: FastifyReply) => {
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'no' } });
    }
  };
  // knowledge: a job that is done as soon as it is asked for, and its census.
  const knowledge = newApp();
  knowledge.addHook('onRequest', auth(tok('knowledge')));
  knowledge.post('/v1/jobs/census-intake', async (req, reply) => {
    const { repo } = req.body as { repo: string };
    const id = `job-${jobs.length + 1}`;
    jobs.push({ repo, id });
    return reply.code(202).send({ job_id: id, state: 'queued' });
  });
  knowledge.get('/v1/jobs/:id', async (req) => ({
    job_id: (req.params as { id: string }).id,
    state: 'done',
    error: null,
  }));
  knowledge.get('/v1/repos/:owner/:name/census/latest', async () => ({
    census_id: `census:acme.app:${'a'.repeat(40)}`,
    census_hash: 'b'.repeat(64),
    job_id: jobs.at(-1)?.id ?? 'none',
    census: {
      blockers: [
        { id: 'B1', status: 'met' },
        { id: 'B2', status: 'met' },
      ],
    },
  }));
  stubs.push(knowledge);
  // identity: records the reconcile calls.
  const identity = newApp();
  identity.addHook('onRequest', auth(tok('identity')));
  identity.post('/v1/projects/:project/reconcile', async (req) => {
    reconciles.push({
      project: (req.params as { project: string }).project,
      body: req.body as Record<string, unknown>,
    });
    return { events: 1 };
  });
  stubs.push(identity);
  const [knowledgeUrl, identityUrl] = [await listen(knowledge), await listen(identity)];

  child = spawn(process.execPath, ['--enable-source-maps', bundle], {
    env: {
      PATH: process.env['PATH'] ?? '',
      ...dbUrlRef('CORE_WORKER_DATABASE_URL', s.record.url),
      CORE_WORKER_CODEHOST_URL: ch.url,
      CORE_WORKER_CODEHOST_TOKEN_REF: 'env:CW_CODEHOST',
      CW_CODEHOST: tok('codehost'),
      CORE_WORKER_KNOWLEDGE_URL: knowledgeUrl,
      CORE_WORKER_KNOWLEDGE_TOKEN_REF: 'env:CW_KNOWLEDGE',
      CW_KNOWLEDGE: tok('knowledge'),
      CORE_WORKER_IDENTITY_URL: identityUrl,
      CORE_WORKER_IDENTITY_TOKEN_REF: 'env:CW_IDENTITY',
      CW_IDENTITY: tok('identity'),
      CORE_WORKER_S0_DRIVER_INTERVAL_MS: '200',
      CORE_WORKER_ROLE_MAP_SYNC_INTERVAL_MS: '200',
      CORE_WORKER_HEAD_INTERVAL_MS: '200',
      CORE_WORKER_INSTALLATION_INTERVAL_MS: '200',
      CORE_WORKER_RULES_TICK_MS: '200',
      CORE_WORKER_OUTBOX_WATCH_INTERVAL_MS: '200',
      CORE_WORKER_PORT: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d) => (output += d));
  child.stderr?.on('data', (d) => (output += d));
}, 60_000);

afterAll(async () => {
  if (child && child.exitCode === null) child.kill('SIGKILL');
  for (const a of stubs) await a.close();
  await ch?.stop();
  await s?.stop();
});

const until = async (cond: () => Promise<boolean>, what: string, diag?: () => Promise<string>) => {
  const end = Date.now() + 25_000;
  while (!(await cond())) {
    if (Date.now() > end)
      throw new Error(
        `timed out: ${what}\n${(await diag?.()) ?? ''}\n${output
          .split('\n')
          .filter((l) => !l.includes('tick ok'))
          .join('\n')
          .slice(-2500)}`,
      );
    await new Promise((r) => setTimeout(r, 100));
  }
};

describe('core-worker with the S0 driver and the role-map sync', () => {
  it('drives a requested onboarding to its first card and reconciles a published role map, then stops on SIGTERM', async () => {
    const base = await new Promise<string>((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error(`core-worker did not start:\n${output}`)),
        20_000,
      );
      const poll = setInterval(() => {
        const m = /core-worker listening on (http:\/\/\S+)/.exec(output);
        if (m) {
          clearTimeout(t);
          clearInterval(poll);
          resolve(m[1] as string);
        }
      }, 50);
      child?.once('exit', (code) => reject(new Error(`core-worker exited ${code}:\n${output}`)));
    });

    // The S0 request registers the repo in core; the worker's polls and the driver find it there.
    const r = await requestOnboarding(
      s.deps,
      request({ project_id: pid('proc'), repo: 'acme/app', level: 'census' }),
    );
    if (!r.ok) throw new Error(r.error.message);
    await until(
      async () => (await readS0(s.record.pool, r.value.s0_id))?.record.status === 'card',
      'the record waits at card 1',
      async () =>
        JSON.stringify(
          (
            await s.record.pool.query(
              'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
              [s0Stream(r.value.s0_id)],
            )
          ).rows.slice(1),
        ),
    );
    expect(jobs.map((j) => j.repo)).toEqual(['acme/app']);
    const cards = await s.record.pool.query(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [s0Stream(r.value.s0_id), S0_EVENT.card_required],
    );
    expect(cards.rows.map((c) => c.body.card)).toEqual(['C1']);
    // Core's own read model fed the polls: acme/app (registered) was polled, acme/lib was not.
    await until(
      async () =>
        (
          await s.record.pool.query(
            "SELECT count(*)::int AS n FROM record.record_event WHERE stream = 'inbound:default_branch_head:acme/app'",
          )
        ).rows[0].n >= 1,
      'the poll of the registered repo',
    );
    expect(ch.seen.some((u) => u.includes('acme/lib'))).toBe(false);

    // A published role map reaches identity.
    setAdmins(s, 'proc', ['alice']);
    const pub = await publishSettings(
      s,
      'proc',
      { role_map: settingsOf('proc', { admin: ['alice'] }).role_map },
      'alice',
    );
    await until(async () => reconciles.length > 0, 'the reconcile call');
    expect(reconciles[0]).toEqual({
      project: 'proc',
      body: { config_rev: pub.rev_hash, m_gate_ref: pub.ledger_entry_id },
    });
    await new Promise((res) => setTimeout(res, 800));
    expect(reconciles.length).toBe(1); // acknowledged once: not asked again

    const health = await fetch(new URL('/healthz', base));
    const body = (await health.json()) as { status: string; loops: Array<{ name: string }> };
    expect(body.status).toBe('ok');
    expect(body.loops.map((l) => l.name)).toEqual(
      expect.arrayContaining(['s0_driver', 'role_map_sync', 'default_branch_head']),
    );

    const exited = new Promise<number | null>((resolve) => child?.once('exit', (c) => resolve(c)));
    child?.kill('SIGTERM');
    expect(await exited).toBe(0);
    expect(output.includes(tok('knowledge'))).toBe(false);
  }, 90_000);
});
