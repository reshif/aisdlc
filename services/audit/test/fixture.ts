import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { LedgerEntryDraft } from '@aisdlc/contracts';
import { createPool, migrate, withTransaction } from '@aisdlc/db';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { identityProjection } from '@aisdlc/identity/read';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { manualClock, newId, type Jwk, type ManualClock } from '@aisdlc/kernel';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import {
  appendLedgerEntryTx,
  confirmAll,
  runCheckpoint,
  type LedgerClientDeps,
} from '@aisdlc/ledger';
import type { HttpNotary } from '@aisdlc/notary/client';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import { Pdp, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import {
  FakeErasablePayloads,
  FakeObjectStore,
  FakeProjectSettings,
  FakeWitness,
  type ObjectStorePort,
} from '@aisdlc/ports';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { appendEvents, runProjection, type JsonObject } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { createAuditApp } from '../src/app.js';
import type { ExportDeps } from '../src/exporter.js';
import type { GovernDeps, RetentionRead } from '../src/govern.js';
import { DEFAULT_AUDIT_RETENTION } from '@aisdlc/contracts';

// The world of the audit tests (PLAN M19): ONE real Postgres with the WHOLE migrate plan, identity's real read model
// (factory admins, an auditor, a project's role map) folded from identity's own journal, the real Notary service (its
// own database, the real kms-local) signing the ledger and the exports, a Witness co-signing the checkpoint, the audit
// service running as a least-privilege login role in `aisdlc_audit`, and the fakes behind the ports (core's erasable
// payloads, the object store). Some of each project's record and ledger is written first, as their owners would.

export const T0 = '2026-11-12T10:00:00.000Z';
export const FROM = '2026-11-12T00:00:00.000Z';
export const TO = '2026-11-13T00:00:00.000Z';
const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');

export interface World {
  readonly db: TestDatabase;
  readonly rolePool: pg.Pool;
  readonly roleUrl: string;
  readonly clock: ManualClock;
  readonly kms: TestKms;
  readonly notary: TestNotary;
  readonly auditNotary: HttpNotary;
  readonly keys: { notary: Jwk; witness: Jwk };
  readonly ownerLedger: LedgerClientDeps;
  readonly payloads: FakeErasablePayloads;
  objects: ObjectStorePort;
  retention: RetentionRead;
  readonly items: { acme: string; beta: string };
  govern(): GovernDeps;
  exporter(): ExportDeps;
  /** The audit HTTP API (the bff's view of it), with the token of the caller `bff`. */
  readonly url: string;
  readonly token: string;
  append(stream: string, type: string, body: object): Promise<void>;
  ownerEntry(body: Record<string, unknown>): Promise<void>;
  checkpoint(): Promise<void>;
  stop(): Promise<void>;
}

const urlFor = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

export async function startWorld(): Promise<World> {
  const stoppers: Array<() => Promise<void>> = [];
  const db = await createTestDatabase();
  stoppers.push(() => db.drop());
  const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')) as {
    databases: { record: Array<{ scope: string; dir: string }> };
  };
  for (const e of plan.databases.record)
    await migrate(db.pool, { scope: e.scope, dir: join(planDir, e.dir) });
  const clock = manualClock(T0);

  const kms = await startTestKms();
  stoppers.push(() => kms.stop());
  const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
  stoppers.push(() => notary.stop());
  const key = async (id: string): Promise<Jwk> => {
    const k = await kms.custodyFor('witness').publicKey(id);
    if (!k.ok) throw new Error(k.error.message);
    return k.value;
  };
  const keys = { notary: await key('dev:notary'), witness: await key('dev:witness') };
  const ownerLedger: LedgerClientDeps = {
    notary: notary.clientFor('core'),
    notaryKey: keys.notary,
  };
  const witness = new FakeWitness(kms.custodyFor('witness'));

  // identity: two factory admins, an auditor, a project admin, a viewer
  const ideps = { pool: db.pool, clock };
  await seedPrincipals(ideps, ['fran', 'root', 'audrey', 'pam', 'vic']);
  await grantFleetRole(ideps, 'fran', 'factory.admin');
  await grantFleetRole(ideps, 'root', 'factory.admin');
  await grantFleetRole(ideps, 'audrey', 'factory.auditor');
  const settings = new FakeProjectSettings();
  await bindProject({ deps: ideps, settings }, 'acme', { admin: ['pam'], requesters: ['vic'] });
  const folded = await runProjection(db.pool, identityProjection);
  if (!folded.ok) throw new Error('identity projection');

  const roleName = `au_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await db.pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_audit`);
  await db.pool.query(`GRANT CONNECT ON DATABASE "${db.name}" TO ${roleName}`);
  const roleUrl = urlFor(db.url, roleName, pw);
  const rolePool = createPool(roleUrl, 6);
  stoppers.push(() => rolePool.end());

  const append = async (stream: string, type: string, body: object) => {
    await withTransaction(db.pool, async (tx) => {
      const head = await tx.query<{ seq: string }>(
        'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
        [stream],
      );
      const a = await appendEvents(
        tx,
        stream,
        Number(head.rows[0]?.seq ?? 0),
        [{ type, body: body as JsonObject, actor: 'system.test' }],
        { clock },
      );
      if (!a.ok) throw new Error(a.error._tag);
    });
  };
  const ownerEntry = async (body: Record<string, unknown>) => {
    const draft = LedgerEntryDraft.parse({
      entry_id: newId(),
      entry_type: 'config_publish',
      gate_instance_id: null,
      gate_id: null,
      subject_kind: null,
      subject_id: null,
      subject_hash: null,
      decision: null,
      actor: null,
      sod_waiver: false,
      policy_bundle_version: 'test',
      body,
      created_at: clock.now().toISOString(),
    });
    const pending = await withTransaction(db.pool, async (tx) => {
      const r = await appendLedgerEntryTx(tx, ownerLedger, draft);
      if (!r.ok) throw new Error(r.error.message);
      return r.value.pending;
    });
    await confirmAll(ownerLedger.notary, pending);
  };
  const checkpoint = async () => {
    const r = await runCheckpoint(db.pool, {
      notary: notary.clientFor('checkpointer'),
      witness,
      clock,
    });
    if (!r.ok) throw new Error(`checkpoint: ${r.error.message}`);
  };

  // some record and ledger of two projects
  const items = { acme: newId(), beta: newId() };
  await append(`item:${items.acme}`, 'item.created', { item_id: items.acme, project_id: 'acme' });
  await append(`item:${items.acme}`, 'item.noted', { item_id: items.acme, note: 'n1' });
  await append(`item:${items.beta}`, 'item.created', { item_id: items.beta, project_id: 'beta' });
  await ownerEntry({ project_id: 'acme', what: 'acme settings' });
  await ownerEntry({ project_id: 'beta', what: 'beta settings' });
  clock.advance(60_000);
  await checkpoint();

  const payloads = new FakeErasablePayloads(() => clock.now().toISOString());
  const auditNotary = notary.clientFor('audit');
  const ledger = { notary: auditNotary, notaryKey: keys.notary };
  const policyVersion = () => 'test-bundle';
  const world: World = {
    db,
    rolePool,
    roleUrl,
    clock,
    kms,
    notary,
    auditNotary,
    keys,
    ownerLedger,
    payloads,
    objects: new FakeObjectStore(),
    retention: { config: DEFAULT_AUDIT_RETENTION, rev_hash: null },
    items,
    govern: () => ({ pool: rolePool, ledger, payloads, clock, policyVersion }),
    exporter: () => ({
      pool: rolePool,
      ledger,
      signer: auditNotary,
      objects: world.objects,
      keys,
      clock,
      policyVersion,
    }),
    url: '',
    token: 'bff-at-audit-'.padEnd(32, 'x'),
    append,
    ownerEntry,
    checkpoint,
    stop: async () => {
      for (const s of stoppers.reverse()) await s().catch(() => undefined);
      const { default: pgmod } = await import('pg');
      const c = new pgmod.Pool({
        connectionString: new URL('/postgres', db.url).toString(),
        max: 1,
      });
      await c.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => undefined);
      await c.end();
    },
  };
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: rolePool, freshness: 'check' }),
    clock,
  });
  const app: FastifyInstance = createAuditApp({
    pool: rolePool,
    auth: new ServiceAuth({ bff: world.token, reader: 'reader-at-audit-'.padEnd(32, 'x') }),
    callers: { bff: ['read', 'export', 'govern'], reader: ['read'] },
    pdp,
    // the routes read the world's current ports
    exporter: new Proxy({} as ExportDeps, {
      get: (_t, k) => world.exporter()[k as keyof ExportDeps],
    }),
    govern: new Proxy({} as GovernDeps, { get: (_t, k) => world.govern()[k as keyof GovernDeps] }),
    objects: new Proxy({} as ObjectStorePort, {
      get: (_t, k) => {
        const v = world.objects[k as keyof ObjectStorePort];
        return typeof v === 'function' ? v.bind(world.objects) : v;
      },
    }),
    retention: () => world.retention,
  });
  (world as { url: string }).url = await listen(app);
  stoppers.push(() => app.close());
  return world;
}

export interface Http {
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- assertions index the JSON freely
  json: any;
}

export async function call(
  w: World,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  token = w.token,
): Promise<Http> {
  const r = await fetch(`${w.url}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: await r.json().catch(() => null) };
}
