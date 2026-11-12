import { CONVERSATION_EVENT, threadStream } from '@aisdlc/contracts';
import { HttpErasablePayloads } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendTurns, createCoreApp, openThread } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// The erasable payloads core owns (PLAN M19), through the audit service's port adapter against core's real routes on a
// real Postgres: listed by id, hash, owner, thread and project (never their text), erased by id AND hash, idempotent,
// recorded on the thread; scope `erasure` only.

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const AUDIT = 'audit-at-core-'.padEnd(32, 'x');
const BFF = 'bff-at-core-'.padEnd(32, 'x');
let thread = '';

beforeAll(async () => {
  s = await startCoreStack();
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth({ audit: AUDIT, bff: BFF }),
    callers: { audit: ['erasure'], bff: ['work'] },
    registry: s.registry,
    clock: s.clock,
  });
  url = await listen(app);
  const t = await openThread(s.deps, {
    owner: 'vic',
    subject: { kind: 'project', project_id: 'acme' },
    first: { role: 'person', kind: 'message', text: 'my private question', redactions: [] },
  });
  if (!t.ok) throw new Error(t.error.message);
  thread = t.value.thread_id;
  const a = await appendTurns(s.deps, {
    owner: 'vic',
    thread_id: thread,
    turns: [{ role: 'assistant', kind: 'answer', text: 'an answer', redactions: [] }],
  });
  if (!a.ok) throw new Error(a.error.message);
  const other = await openThread(s.deps, {
    owner: 'ada',
    subject: { kind: 'project', project_id: 'beta' },
    first: { role: 'person', kind: 'message', text: 'ada asks', redactions: [] },
  });
  if (!other.ok) throw new Error(other.error.message);
});
afterAll(async () => {
  await app?.close();
  await s?.stop();
});

describe('erasable payloads (PLAN M19)', () => {
  it('lists a person’s payloads by id, hash, thread and project, never the text', async () => {
    const port = new HttpErasablePayloads({ baseUrl: url, token: AUDIT });
    const r = await port.list({ owner: 'vic', limit: 100 });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    if (!r.ok) return;
    expect(r.value).toHaveLength(2);
    for (const p of r.value) {
      expect(p).toMatchObject({
        owner: 'vic',
        thread_id: thread,
        project_id: 'acme',
        erased_at: null,
      });
    }
    expect(JSON.stringify(r.value)).not.toContain('private question');
    const beta = await port.list({ project_id: 'beta', limit: 100 });
    expect(beta.ok && beta.value.map((p) => p.owner)).toEqual(['ada']);
    const none = await port.list({ created_before: '2000-01-01T00:00:00.000Z', limit: 100 });
    expect(none.ok && none.value).toEqual([]);
  });

  it('erases exactly the payload named by id and hash, once, and records it on its thread', async () => {
    const port = new HttpErasablePayloads({ baseUrl: url, token: AUDIT });
    const list = await port.list({ owner: 'vic', limit: 100 });
    if (!list.ok) throw new Error('list');
    const target = list.value[0];
    if (!target) throw new Error('no payload');
    const wrong = await port.erase({ ...target, sha256: 'f'.repeat(64) });
    expect(!wrong.ok && wrong.error.code).toBe('mismatch');
    const notTheirs = await port.erase({ ...target, owner: 'ada' });
    expect(!notTheirs.ok && notTheirs.error.code).toBe('not_found');
    const e = await port.erase(target);
    expect(e).toEqual({ ok: true, value: { already: false } });
    expect(await port.erase(target)).toEqual({ ok: true, value: { already: true } });
    const row = await s.record.pool.query(
      'SELECT text, sha256, erased_at FROM core.conversation_payload WHERE payload_id = $1',
      [target.payload_id],
    );
    expect(row.rows[0]).toMatchObject({ text: null, sha256: target.sha256 });
    const ev = await s.record.pool.query(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [threadStream(thread), CONVERSATION_EVENT.payload_erased],
    );
    expect(ev.rows.map((r) => r.body)).toEqual([
      { thread_id: thread, payload_id: target.payload_id, sha256: target.sha256 },
    ]);
    const live = await port.list({ owner: 'vic', live_only: true, limit: 100 });
    expect(live.ok && live.value).toHaveLength(1);
  });

  it('answers only the erasure scope', async () => {
    const port = new HttpErasablePayloads({ baseUrl: url, token: BFF });
    const r = await port.list({ owner: 'vic', limit: 10 });
    expect(!r.ok && r.error.code).toBe('refused');
    const down = new HttpErasablePayloads({ baseUrl: 'http://127.0.0.1:1', token: AUDIT });
    const d = await down.list({ owner: 'vic', limit: 10 });
    expect(!d.ok && d.error.code).toBe('unavailable');
  });
});
