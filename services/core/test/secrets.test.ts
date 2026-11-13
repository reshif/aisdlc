import { generateKeyPairSync } from 'node:crypto';
import { SECRET_NAMES, SecretList, SecretStoredPayload } from '@aisdlc/contracts';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeSecretStore } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// The write-only secret API (portal v2 N15): a person the PDP allows `config.propose` on the fleet puts a value; it
// goes to the secret store and nowhere else. The record and the ledger hold {name, version, by, at}; no response, log
// line, record event, ledger entry or decision log row holds the value (or a hash of it). Real Postgres, real ledger.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const store = new FakeSecretStore();
const lines: string[] = [];
const orig = { log: console.log, error: console.error, warn: console.warn, info: console.info };

const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal', 'secrets'],
  reader: ['read', 'portal'],
};
const VALUE = 'sk-ant-api03-CORE-SECRET-TEST-VALUE-9f8e7d6c5b4a';
const PEM = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

beforeAll(async () => {
  for (const k of ['log', 'error', 'warn', 'info'] as const) {
    console[k] = (...a: unknown[]) => void lines.push(a.map(String).join(' '));
  }
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob']);
  await grantFleetRole(s.id.deps, 'alice', 'factory.admin');
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
    secretStore: store,
  });
  url = await listen(app);
});
afterAll(async () => {
  Object.assign(console, orig);
  await app?.close();
  await s?.stop();
});

async function call(token: string | null, method: string, path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: text ? (JSON.parse(text) as Json) : null };
}

/** Everything the database holds as text: every row of every table of every schema. */
async function wholeDatabase(): Promise<string> {
  const tables = await s.record.pool.query<{ t: string }>(
    `SELECT format('%I.%I', schemaname, tablename) AS t FROM pg_tables
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')`,
  );
  let all = '';
  for (const { t } of tables.rows) {
    const r = await s.record.pool.query(`SELECT * FROM ${t}`);
    all += JSON.stringify(r.rows);
  }
  return all;
}

describe('the write-only secret API', () => {
  it('needs the secrets scope and a person the PDP allows; bob is refused and nothing is stored', async () => {
    expect((await call(null, 'GET', '/v1/secrets?on_behalf_of=alice')).status).toBe(401);
    expect((await call(TOKENS.reader, 'GET', '/v1/secrets?on_behalf_of=alice')).status).toBe(403);
    const r = await call(TOKENS.bff, 'PUT', '/v1/secrets/anthropic-api-key', {
      value: VALUE,
      on_behalf_of: 'bob',
    });
    expect(r.status).toBe(403);
    expect(r.text).not.toContain(VALUE);
    const m = await store.meta('gateway/anthropic-api-key#value');
    expect(m.ok && m.value.set).toBe(false);
  });

  it('a factory admin puts a value: stored, answered with metadata only, recorded and ledgered without it', async () => {
    const r = await call(TOKENS.bff, 'PUT', '/v1/secrets/anthropic-api-key', {
      value: VALUE,
      on_behalf_of: 'alice',
    });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ name: 'anthropic-api-key', version: 1 });
    expect(r.text).not.toContain(VALUE);
    expect(await store.get('gateway/anthropic-api-key#value')).toEqual({ ok: true, value: VALUE });

    const ev = await s.record.pool.query<{ type: string; body: unknown; actor: string }>(
      `SELECT type, body, actor FROM record.record_event WHERE stream = 'secret:anthropic-api-key'`,
    );
    expect(ev.rows).toHaveLength(1);
    expect(ev.rows[0]?.type).toBe('secret.stored');
    expect(Object.keys(SecretStoredPayload.parse(ev.rows[0]?.body)).sort()).toEqual([
      'at',
      'by',
      'name',
      'version',
    ]);
    const le = await s.record.pool.query<{ entry_type: string; actor: string }>(
      `SELECT entry_type, actor FROM ledger.ledger_entry WHERE entry_type = 'secret.stored'`,
    );
    expect(le.rows).toEqual([{ entry_type: 'secret.stored', actor: 'alice' }]);
  });

  it('lists names and metadata only, with who stored the current version', async () => {
    const r = await call(TOKENS.bff, 'GET', '/v1/secrets?on_behalf_of=alice');
    expect(r.status).toBe(200);
    const l = SecretList.parse(r.json);
    expect(l.store_reachable).toBe(true);
    expect(l.secrets.map((x) => x.name)).toEqual([...SECRET_NAMES]);
    expect(l.secrets.find((x) => x.name === 'anthropic-api-key')).toMatchObject({
      set: true,
      version: 1,
      updated_by: 'alice',
      ref: 'vault:gateway/anthropic-api-key#value',
      owner: 'gateway',
    });
    expect(l.secrets.find((x) => x.name === 'github-app-key')?.set).toBe(false);
    expect(r.text).not.toContain(VALUE);
    expect((await call(TOKENS.bff, 'GET', '/v1/secrets?on_behalf_of=bob')).status).toBe(403);
  });

  it('checks the shape of a key and refuses without quoting it; an unknown name is 404', async () => {
    const bad = await call(TOKENS.bff, 'PUT', '/v1/secrets/github-app-key', {
      value: `NOT-A-PEM-${VALUE}`,
      on_behalf_of: 'alice',
    });
    expect(bad.status).toBe(400);
    expect(bad.text).not.toContain(VALUE);
    const good = await call(TOKENS.bff, 'PUT', '/v1/secrets/github-app-key', {
      value: PEM,
      on_behalf_of: 'alice',
    });
    expect(good.status).toBe(200);
    const url1 = await call(TOKENS.bff, 'PUT', '/v1/secrets/slack-webhook-url', {
      value: 'http://hooks.slack.com/services/T/B/x',
      on_behalf_of: 'alice',
    });
    expect(url1.status).toBe(400);
    const unknown = await call(TOKENS.bff, 'PUT', '/v1/secrets/aws-root-password', {
      value: VALUE,
      on_behalf_of: 'alice',
    });
    expect(unknown.status).toBe(404);
    const extra = await call(TOKENS.bff, 'PUT', '/v1/secrets/anthropic-api-key', {
      value: VALUE,
      on_behalf_of: 'alice',
      echo: true,
    });
    expect(extra.status).toBe(400);
    expect(extra.text).not.toContain(VALUE);
  });

  it('a second put is version 2; delete destroys every version and is recorded', async () => {
    const r2 = await call(TOKENS.bff, 'PUT', '/v1/secrets/anthropic-api-key', {
      value: `${VALUE}-v2`,
      on_behalf_of: 'alice',
    });
    expect(r2.json).toMatchObject({ version: 2 });
    const d = await call(TOKENS.bff, 'DELETE', '/v1/secrets/anthropic-api-key', {
      on_behalf_of: 'alice',
    });
    expect(d.status).toBe(200);
    const m = await store.meta('gateway/anthropic-api-key#value');
    expect(m.ok && m.value.set).toBe(false);
    const l = SecretList.parse(
      (await call(TOKENS.bff, 'GET', '/v1/secrets?on_behalf_of=alice')).json,
    );
    expect(l.secrets.find((x) => x.name === 'anthropic-api-key')).toMatchObject({
      set: false,
      version: null,
      updated_by: null,
    });
    const types = await s.record.pool.query<{ type: string }>(
      `SELECT type FROM record.record_event WHERE stream = 'secret:anthropic-api-key' ORDER BY seq`,
    );
    expect(types.rows.map((x) => x.type)).toEqual([
      'secret.stored',
      'secret.stored',
      'secret.destroyed',
    ]);
  });

  it('a store that does not answer: the list says so (nothing shown as set), a put is refused and not recorded', async () => {
    store.down = true;
    try {
      const l = SecretList.parse(
        (await call(TOKENS.bff, 'GET', '/v1/secrets?on_behalf_of=alice')).json,
      );
      expect(l.store_reachable).toBe(false);
      expect(l.secrets.every((x) => !x.set)).toBe(true);
      const before = await s.record.pool.query(
        `SELECT count(*)::int AS n FROM record.record_event WHERE starts_with(stream, 'secret:')`,
      );
      const r = await call(TOKENS.bff, 'PUT', '/v1/secrets/openai-api-key', {
        value: VALUE,
        on_behalf_of: 'alice',
      });
      expect(r.status).toBe(503);
      const after = await s.record.pool.query(
        `SELECT count(*)::int AS n FROM record.record_event WHERE starts_with(stream, 'secret:')`,
      );
      expect(after.rows[0]).toEqual(before.rows[0]);
    } finally {
      store.down = false;
    }
  });

  it('GREP: no value, and no part of the PEM, is anywhere in the database or the logs', async () => {
    const db = await wholeDatabase();
    const pemBody = PEM.replace(/-----[^-]+-----|\s/g, '');
    for (const needle of [VALUE, `${VALUE}-v2`, pemBody.slice(100, 160), 'CORE-SECRET-TEST']) {
      expect(db).not.toContain(needle);
      expect(lines.join('\n')).not.toContain(needle);
    }
  });
});
