import { createHash } from 'node:crypto';
import { bindProject, grantFleetRole } from '@aisdlc/identity/testing';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Browser } from '../src/testing.js';
import { signIn, startBffStack, type BffStack } from '../src/testing.js';
import { startFakeCore, type FakeCore } from './portal-fixtures.js';

// PLAN M19: the bff's Govern › Audit routes. The person is always the session's (`on_behalf_of` is added here, a body
// that names one is refused), the PDP decides here before the audit service is asked (audit.read on the scope, the
// fleet for holds and erasures; config.decide for the factory admins' acts), and the signed bytes are re-hashed to
// their object key before a byte is sent. The audit service's own side is services/audit/test.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
type Who = 'alice' | 'bob' | 'root';

let s: BffStack;
let audit: FakeCore;
const sessions = new Map<Who, { browser: Browser; csrf: string }>();

async function as(who: Who) {
  const known = sessions.get(who);
  if (known) return known;
  const { browser } = await signIn(s, who);
  const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
  const v = { browser, csrf: me.csrf_token as string };
  sessions.set(who, v);
  return v;
}

async function api(who: Who, method: 'GET' | 'POST', path: string, body?: unknown) {
  const v = await as(who);
  const headers: Record<string, string> = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (method !== 'GET') headers['x-csrf-token'] = v.csrf;
  const res = await v.browser.request(`${s.base}${path}`, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: Json = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    /* not JSON */
  }
  return { status: res.status, json, buf, headers: res.headers };
}

const EXPORT_ID = '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a90';
const exportView = (project: string | null) => ({
  export_id: EXPORT_ID,
  scope: project === null ? { kind: 'fleet' } : { kind: 'project', project_id: project },
  from: '2026-11-12T00:00:00.000Z',
  to: '2026-11-13T00:00:00.000Z',
  reason: 'SOC 2',
  requested_by: 'alice',
  export_sha256: 'a'.repeat(64),
  bucket: 'audit-exports',
  object_key: 'b'.repeat(64),
  size: 10,
  key_id: 'dev:notary',
  checkpoint_seq: 1,
  covered_to: 4,
  entries: 1,
  events: 2,
  uncovered: 0,
  produced_at: '2026-11-12T10:00:00.000Z',
  entry_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a91',
  entry_seq: 5,
});
const REQ = {
  scope: { kind: 'project', project_id: 'acme' },
  from: '2026-11-12T00:00:00.000Z',
  to: '2026-11-13T00:00:00.000Z',
  reason: 'SOC 2',
};

beforeAll(async () => {
  audit = await startFakeCore();
  s = await startBffStack({ override: { audit: audit.client } });
  await bindProject(s.identity, 'acme', { admin: ['alice'] });
  await grantFleetRole(s.identity.deps, 'bob', 'factory.auditor');
  await grantFleetRole(s.identity.deps, 'root', 'factory.admin');
});
afterAll(async () => {
  await s?.stop();
  await audit?.stop();
});
beforeEach(() => {
  audit.seen.length = 0;
  audit.override.clear();
});

describe('the bff audit routes (PLAN M19)', () => {
  it('a project admin lists and writes their project’s exports; the fleet is refused before the service is asked', async () => {
    audit.override.set('GET /v1/exports?on_behalf_of=alice&project=acme', {
      status: 200,
      json: { exports: [exportView('acme')] },
    });
    const list = await api('alice', 'GET', '/api/audit/exports?project=acme');
    expect(list.status).toBe(200);
    expect(list.json.exports[0].export_id).toBe(EXPORT_ID);
    const fleet = await api('alice', 'GET', '/api/audit/exports');
    expect(fleet.status).toBe(403);
    expect(audit.seen.map((x) => x.path)).toEqual(['/v1/exports?on_behalf_of=alice&project=acme']);

    audit.override.set('POST /v1/exports', { status: 201, json: exportView('acme') });
    const w = await api('alice', 'POST', '/api/audit/exports', REQ);
    expect(w.status).toBe(201);
    expect(audit.seen.at(-1)?.body).toEqual({ ...REQ, on_behalf_of: 'alice' });
    // the person is the session's: a body naming one is not a body this route takes
    const other = await api('alice', 'POST', '/api/audit/exports', {
      ...REQ,
      on_behalf_of: 'root',
    });
    expect(other.status).toBe(400);
    const fleetWrite = await api('alice', 'POST', '/api/audit/exports', {
      ...REQ,
      scope: { kind: 'fleet' },
    });
    expect(fleetWrite.status).toBe(403);
  });

  it('serves the signed bytes only when they hash to their object key', async () => {
    const bytes = Buffer.from('{"format":"aisdlc-signed-audit-export/1"}');
    const key = createHash('sha256').update(bytes).digest('hex');
    audit.override.set(`GET /v1/exports/${EXPORT_ID}/signed?on_behalf_of=bob`, {
      status: 200,
      json: { object_key: key, bytes_b64: bytes.toString('base64') },
    });
    const ok = await api('bob', 'GET', `/api/audit/exports/${EXPORT_ID}/signed`);
    expect(ok.status).toBe(200);
    expect(ok.buf.equals(bytes)).toBe(true);
    expect(ok.headers.get('content-disposition')).toContain(key);
    audit.override.set(`GET /v1/exports/${EXPORT_ID}/signed?on_behalf_of=bob`, {
      status: 200,
      json: { object_key: 'c'.repeat(64), bytes_b64: bytes.toString('base64') },
    });
    const bad = await api('bob', 'GET', `/api/audit/exports/${EXPORT_ID}/signed`);
    expect(bad.status).toBe(502);
  });

  it('holds and erasures: an auditor reads, only a factory admin acts, the service’s refusals pass through', async () => {
    audit.override.set('GET /v1/holds?on_behalf_of=bob', { status: 200, json: { holds: [] } });
    expect((await api('bob', 'GET', '/api/audit/holds')).status).toBe(200);
    expect((await api('alice', 'GET', '/api/audit/holds')).status).toBe(403);
    const hold = {
      scope: { kind: 'principal', principal_id: 'carol' },
      matter_ref: 'LA-1',
      reason: 'litigation',
    };
    expect((await api('bob', 'POST', '/api/audit/holds', hold)).status).toBe(403);
    audit.override.set('POST /v1/holds', {
      status: 201,
      json: {
        hold_id: '0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a92',
        ...hold,
        state: 'active',
        placed_by: 'root',
        placed_at: '2026-11-12T10:00:00.000Z',
        place_entry_seq: 6,
        released_by: null,
        released_at: null,
        release_reason: null,
        release_entry_seq: null,
      },
    });
    const placed = await api('root', 'POST', '/api/audit/holds', hold);
    expect(placed.status).toBe(201);
    expect(audit.seen.at(-1)?.body).toEqual({ ...hold, on_behalf_of: 'root' });
    // the audit service's two-person refusal reaches the person as it was given
    audit.override.set('POST /v1/erasures/0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a93/approve', {
      status: 403,
      json: {
        error: { code: 'forbidden', message: 'the requester does not approve their own erasure' },
      },
    });
    const own = await api(
      'root',
      'POST',
      '/api/audit/erasures/0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a93/approve',
      {
        matter_ref: 'LA-2',
        reason: 'ok',
      },
    );
    expect(own.status).toBe(403);
    expect(own.json.error.message).toMatch(/own erasure/);
    audit.override.set('POST /v1/erasures/0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a93/approve', {
      status: 409,
      json: { error: { code: 'legal_hold', message: 'a legal hold covers the subject' } },
    });
    const held = await api(
      'root',
      'POST',
      '/api/audit/erasures/0190a8c4-6d6f-7b8e-9a1b-2c3d4e5f6a93/approve',
      {
        matter_ref: 'LA-2',
        reason: 'ok',
      },
    );
    expect(held.status).toBe(409);
    expect(held.json.error.code).toBe('legal_hold');
    expect(
      (
        await api('alice', 'POST', '/api/audit/erasures', {
          subject: { principal_id: 'carol', project_id: null },
          reason: 'SAR',
        })
      ).status,
    ).toBe(403);
    audit.override.set('GET /v1/retention?on_behalf_of=bob', {
      status: 503,
      json: { error: { code: 'unavailable', message: 'down' } },
    });
    expect((await api('bob', 'GET', '/api/audit/retention')).status).toBe(502);
  });
});
