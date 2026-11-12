import {
  ConfigKeySummary,
  ConfigKeyView,
  ConfigProposeResult,
  DEFAULT_SANDBOX_CAPS,
  SANDBOX_CAPS_KEY,
  SANDBOX_EXEC_ALLOWED_REPOS_KEY,
} from '@aisdlc/contracts';
import { configPublish } from '@aisdlc/config';
import { readGateState } from '@aisdlc/decisions';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { decideGate, setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';

// The configuration console's core routes on two real factory keys, `sandbox.caps` and
// `sandbox.exec_allowed_repos`: a proposal is an ordinary revision with an M1 gate, and nothing the
// console reads as effective changes until that gate is decided approve and the revision published.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;

const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob', 'carol']);
  await grantFleetRole(s.id.deps, 'alice', 'factory.admin');
  // the M1 gate of a factory revision is decided by the `factory` project's admin slot
  setAdmins(s, 'factory', ['carol']);
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s?.stop();
});

async function call(token: string | null, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

const view = async (key: string) => {
  const r = await call(TOKENS.bff, 'GET', `/v1/config/keys/${key}`);
  expect(r.status).toBe(200);
  return ConfigKeyView.parse(r.json);
};
const propose = (who: string, key: string, value: unknown, parent: string | null) =>
  call(TOKENS.bff, 'POST', `/v1/config/keys/${key}/proposals`, {
    on_behalf_of: who,
    value,
    parent_rev_hash: parent,
  });

describe('the configuration console in core', () => {
  it('lists the registered keys with a JSON Schema generated from each Zod schema', async () => {
    expect((await call(null, 'GET', '/v1/config/keys')).status).toBe(401);
    const r = await call(TOKENS.reader, 'GET', '/v1/config/keys');
    expect(r.status).toBe(200);
    const keys = z.array(ConfigKeySummary).parse(r.json);
    const caps = keys.find((k) => k.key === SANDBOX_CAPS_KEY);
    expect(caps?.json_schema).toMatchObject({
      type: 'object',
      properties: { total: { type: 'integer' }, coding: { type: 'integer' } },
    });
    expect(keys.find((k) => k.key === SANDBOX_EXEC_ALLOWED_REPOS_KEY)?.json_schema).toMatchObject({
      type: 'array',
    });
    expect((await call(TOKENS.bff, 'GET', '/v1/config/keys/no.such_key')).status).toBe(404);
    expect((await call(TOKENS.bff, 'GET', '/v1/config/keys/Not%20a%20key')).status).toBe(400);
  });

  it('before any revision the effective value is the default, with nothing pending', async () => {
    const v = await view(SANDBOX_CAPS_KEY);
    expect(v.effective).toMatchObject({ value: DEFAULT_SANDBOX_CAPS, source: 'default' });
    expect(v.head_rev_hash).toBeNull();
    expect(v.pending).toEqual([]);
    expect(v.history).toEqual([]);
  });

  it('a proposal needs scope portal and config.propose; the schema refuses a bad value', async () => {
    const body = { on_behalf_of: 'alice', value: { total: 6, coding: 2 }, parent_rev_hash: null };
    expect(
      (await call(TOKENS.reader, 'POST', `/v1/config/keys/${SANDBOX_CAPS_KEY}/proposals`, body))
        .status,
    ).toBe(403);
    const bob = await propose('bob', SANDBOX_CAPS_KEY, { total: 6, coding: 2 }, null);
    expect(bob.status).toBe(403);
    expect(bob.json.error.message).toBe('config.propose denied');
    const bad = await propose('alice', SANDBOX_CAPS_KEY, { total: 2, coding: 3 }, null);
    expect(bad.status).toBe(400);
    expect(bad.json.error.message).toMatch(/coding cap cannot be above the total/);
    expect((await view(SANDBOX_CAPS_KEY)).history).toEqual([]);
  });

  let gate = '';
  it('a proposal opens an M1 gate and changes nothing until it is decided', async () => {
    const r = await propose('alice', SANDBOX_CAPS_KEY, { total: 6, coding: 2 }, null);
    expect(r.status).toBe(201);
    const p = ConfigProposeResult.parse(r.json);
    gate = p.gate_instance_id;
    const g = await readGateState(s.record.pool, gate);
    expect(g?.open.payload).toMatchObject({
      gate_id: 'M1',
      subject_kind: 'config',
      subject_hash: p.rev_hash,
    });
    expect(g?.status).toBe('pending');

    const v = await view(SANDBOX_CAPS_KEY);
    expect(v.effective).toMatchObject({ value: DEFAULT_SANDBOX_CAPS, source: 'default' });
    expect(v.pending).toHaveLength(1);
    expect(v.pending[0]).toMatchObject({
      gate_status: 'pending',
      deciders: { slot: 'admin', holders: ['carol'] },
      revision: {
        rev_hash: p.rev_hash,
        state: 'proposed',
        changes_key: true,
        value: { total: 6, coding: 2 },
      },
    });
    // a draft made against another head is refused
    const stale = await propose('alice', SANDBOX_CAPS_KEY, { total: 5, coding: 1 }, 'a'.repeat(64));
    expect(stale.status).toBe(409);
  });

  it('once carol approves the M1 gate and it is published, the value is effective with its lineage', async () => {
    const d = await decideGate(s, gate, 'carol', 'approve');
    expect(d.ok).toBe(true);
    const before = await view(SANDBOX_CAPS_KEY);
    expect(before.effective.source).toBe('default'); // decided, not yet published: still not effective
    const rev = before.pending[0]?.revision.rev_hash as string;
    const pub = await configPublish(s.config, { rev_hash: rev });
    expect(pub.ok).toBe(true);
    const v = await view(SANDBOX_CAPS_KEY);
    expect(v.effective).toMatchObject({
      value: { total: 6, coding: 2 },
      source: 'revision',
      rev_hash: rev,
      gate_instance_id: gate,
    });
    expect(v.effective.ledger_entry_id).not.toBeNull();
    expect(v.head_rev_hash).toBe(rev);
    expect(v.pending).toEqual([]);
    expect(v.history.map((h) => h.state)).toEqual(['current']);
  });

  it('a second key is proposed on the same lineage: the other key keeps its value', async () => {
    const head = (await view(SANDBOX_EXEC_ALLOWED_REPOS_KEY)).head_rev_hash;
    const r = await propose('alice', SANDBOX_EXEC_ALLOWED_REPOS_KEY, ['acme/web'], head);
    expect(r.status).toBe(201);
    const exec = await view(SANDBOX_EXEC_ALLOWED_REPOS_KEY);
    expect(exec.effective).toMatchObject({ value: [], source: 'default' });
    expect(exec.pending[0]?.revision).toMatchObject({ value: ['acme/web'], changes_key: true });
    const caps = await view(SANDBOX_CAPS_KEY);
    expect(caps.effective.value).toEqual({ total: 6, coding: 2 });
    // the pending revision carries sandbox.caps unchanged: for this key it changes nothing
    expect(caps.pending[0]?.revision).toMatchObject({
      value: { total: 6, coding: 2 },
      changes_key: false,
    });
  });
});
