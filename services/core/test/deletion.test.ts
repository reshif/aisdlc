import { EVIDENCE_BUCKET, DELETION_ENTRY_TYPE, type DeletionResult } from '@aisdlc/contracts';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { sha256Hex } from '@aisdlc/kernel';
import { verifyLedger } from '@aisdlc/ledger';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeObjectStore } from '@aisdlc/ports';
import { verifyAll } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DELETION_KEPT_TABLES,
  createCoreApp,
  readItem,
  submitRequest,
  type CoreScope,
} from '../src/index.js';
import { catchUpReadModels, readModelDigests, rebuildReadModels } from '../src/rebuild-check.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_ON,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// Delete means delete (owner decision 2026-11-13; docs/specs/deletion.md), on a real Postgres with the real ledger and
// Notary: a project goes after a whole item lifecycle, and afterwards nothing of it can be read anywhere in the
// database (every table, every column, as text), the ledger and the record still verify, the read models rebuild to
// what they are, and the other project is untouched.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const objects = new FakeObjectStore();
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = { bff: ['delete', 'work'], reader: ['read'] };

const GONE = {
  project: 'zebracorn-proj',
  repo: 'acme/zebracorn-repo',
  text: 'make the quokkafish widget glow',
};
const KEPT = {
  project: 'keeper-proj',
  repo: 'acme/keeper-repo',
  text: 'keep the lighthouse lamp lit',
};
let goneItem = '';
let keptItem = '';
let packSha = '';

const call = async (method: string, path: string, body: unknown, token = TOKENS.bff) => {
  const r = await fetch(`${url}${path}`, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: r.status, body: (await r.json()) as Json };
};

/** Every row of every table of the record database, as text, that contains `needle` (case-insensitive). */
async function grepDatabase(needle: string): Promise<string[]> {
  const t = await s.record.pool.query<{ s: string; t: string }>(
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE' AND table_schema NOT IN ('pg_catalog', 'information_schema')`,
  );
  const hits: string[] = [];
  for (const r of t.rows) {
    const q = await s.record.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM "${r.s}"."${r.t}" x WHERE position(lower($1) in lower(x::text)) > 0`,
      [needle],
    );
    if (Number(q.rows[0]?.n) > 0) hits.push(`${r.s}.${r.t}`);
  }
  return hits;
}

async function lifecycle(o: typeof GONE): Promise<string> {
  const seeded = await seedActivePrr(s, {
    project: o.project,
    repo: o.repo,
    level: 'full',
    gating: GATING_ON,
  });
  approvers(s, seeded.project, ['bob']);
  const sub = await submitRequest(s.deps, {
    project_id: pid(seeded.project),
    repo: seeded.repo,
    lane: 'L4',
    requester: pr('alice'),
    channel: 'N1',
    text: o.text,
  });
  if (!sub.ok) throw new Error(sub.error.message);
  const item = await runItem(s, driverOver(s), sub.value.item_id as string);
  expect(item?.state.terminal).not.toBeNull();
  return sub.value.item_id as string;
}

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'pat', 'ria']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  goneItem = await lifecycle(GONE);
  keptItem = await lifecycle(KEPT);
  await bindProject(s.id, GONE.project, { admin: ['pat'] });
  await bindProject(s.id, KEPT.project, { requesters: ['ria'] });
  // An Evidence Pack of the item in the write-once bucket (core's 7.6 stores them so).
  await objects.declareBucket(EVIDENCE_BUCKET, 'write_once');
  const put = await objects.put(EVIDENCE_BUCKET, new TextEncoder().encode(`pack of ${goneItem}`), {
    contentType: 'application/json',
  });
  if (!put.ok) throw new Error('put');
  packSha = put.value.sha256;
  await s.record.pool.query(
    `INSERT INTO core.evidence_pack (pack_sha256, command_key, item_id, unit_key, base_sha, head_sha, disposition,
       passing, detail, bucket, object_key, key_id, produced_at, event_gseq)
     VALUES ($1, $2, $3, 'main', repeat('a', 40), repeat('b', 40), 'passed', true, '{}', $4, $1, 'dev:notary', now(), 1)`,
    [packSha, `cmd:${goneItem}`, goneItem, EVIDENCE_BUCKET],
  );
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
    // the test login is the cluster's superuser, which may take the purge role; production's is a member of it
    deletion: { purgePool: s.record.pool, ledger: s.config.ledger, clock: s.clock, objects },
  });
  url = await listen(app);
  await catchUpReadModels(s.record.pool);
}, 600_000);
afterAll(async () => {
  await app?.close();
  await s?.stop();
});

describe('deleting a project after a full item lifecycle', () => {
  it('before: the project is all over the database', async () => {
    expect((await grepDatabase(GONE.project)).length).toBeGreaterThan(5);
    expect((await grepDatabase(GONE.text)).length).toBeGreaterThan(0);
  });

  it('refuses without the delete scope, a person without project.delete, a wrong confirm, a reason naming it', async () => {
    const body = { on_behalf_of: 'ria', reason: 'the customer left', confirm: GONE.project };
    expect((await call('DELETE', `/v1/projects/${GONE.project}`, body, TOKENS.reader)).status).toBe(
      403,
    );
    expect((await call('DELETE', `/v1/projects/${GONE.project}`, body)).status).toBe(403);
    const wrong = await call('DELETE', `/v1/projects/${GONE.project}`, {
      ...body,
      on_behalf_of: 'ada',
      confirm: 'nope',
    });
    expect(wrong.status).toBe(400);
    const naming = await call('DELETE', `/v1/projects/${GONE.project}`, {
      ...body,
      on_behalf_of: 'ada',
      reason: `remove ${GONE.project}`,
    });
    expect(naming.status).toBe(400);
    expect(
      (
        await call('DELETE', '/v1/projects/no-such-project', {
          ...body,
          confirm: 'no-such-project',
          on_behalf_of: 'ada',
        })
      ).status,
    ).toBe(404);
  });

  it('previews what would go, writing nothing', async () => {
    const before = await s.record.pool.query('SELECT count(*)::int AS n FROM record.record_event');
    const p = await call('POST', '/v1/deletions/preview', {
      on_behalf_of: 'ada',
      kind: 'project',
      id: GONE.project,
    });
    expect(p.status).toBe(200);
    expect(p.body.counts.record_events_removed).toBeGreaterThan(10);
    expect(p.body.counts.ledger_entries_redacted).toBeGreaterThan(0);
    expect(p.body.counts.objects).toBe(1);
    expect(p.body.tables).toContain('core.work_item');
    expect(p.body.blockers).toEqual([]);
    const after = await s.record.pool.query('SELECT count(*)::int AS n FROM record.record_event');
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  let result: DeletionResult;
  it('the factory admin deletes it alone', async () => {
    await catchUpReadModels(s.record.pool);
    const r = await call('DELETE', `/v1/projects/${GONE.project}`, {
      on_behalf_of: 'ada',
      reason: 'the customer left',
      confirm: GONE.project,
    });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    result = r.body;
    expect(result.objects_purged).toBe(true);
    expect(result.counts.record_events_removed).toBeGreaterThan(10);
  });

  it('afterwards nothing of it can be read anywhere in the database', async () => {
    for (const needle of [
      GONE.project,
      GONE.repo,
      GONE.text,
      goneItem,
      'zebracorn',
      'quokkafish',
    ]) {
      expect(await grepDatabase(needle), needle).toEqual([]);
    }
    expect(
      (await objects.head(EVIDENCE_BUCKET, packSha)).ok &&
        (await objects.head(EVIDENCE_BUCKET, packSha)),
    ).toMatchObject({ value: null });
    expect(await readItem(s.record.pool, goneItem)).toBeNull();
  });

  it('the other project is untouched', async () => {
    expect((await grepDatabase(KEPT.text)).length).toBeGreaterThan(0);
    const kept = await readItem(s.record.pool, keptItem);
    expect(kept?.state.terminal).not.toBeNull();
  });

  it('the deletion leaves one ledger entry with hashes and counts, no name and no content', async () => {
    const e = await s.record.pool.query<{ body: Json; actor: string }>(
      `SELECT body, actor FROM ledger.ledger_entry WHERE entry_type = $1`,
      [DELETION_ENTRY_TYPE],
    );
    expect(e.rows).toHaveLength(1);
    const b = e.rows[0]?.body;
    expect(e.rows[0]?.actor).toBe('ada');
    expect(b.root_hash).toBe(sha256Hex(GONE.project));
    expect(b.id_hashes).toContain(sha256Hex(goneItem));
    expect(b.redacted_ledger_seqs.length).toBe(result.counts.ledger_entries_redacted);
    expect(JSON.stringify(b)).not.toContain('zebracorn');
  });

  it('the ledger verifies with its redacted entries; the record verifies with its purged gaps', async () => {
    const w = await s.id.kms.custodyFor('witness').publicKey('dev:witness');
    const n = await s.id.kms.custodyFor('witness').publicKey('dev:notary');
    if (!w.ok || !n.ok) throw new Error('keys');
    const strict = await verifyLedger(
      s.record.pool,
      { notary: n.value, witness: w.value },
      { allowUncoveredTail: true },
    );
    expect(!strict.ok && strict.error.code).toBe('redacted');
    const v = await verifyLedger(
      s.record.pool,
      { notary: n.value, witness: w.value },
      { allowUncoveredTail: true, allowRedacted: true },
    );
    expect(v.ok, JSON.stringify(v)).toBe(true);
    if (v.ok) expect(v.value.redacted).toBe(result.counts.ledger_entries_redacted);
    const r = await verifyAll(s.record.pool);
    expect(r.valid, JSON.stringify(r)).toBe(true);
  });

  it('the read models rebuilt from the record alone are what they are', async () => {
    await catchUpReadModels(s.record.pool);
    const before = await readModelDigests(s.record.pool);
    await rebuildReadModels(s.record.pool);
    const after = await readModelDigests(s.record.pool);
    const differ = Object.keys(before).filter(
      (k) => JSON.stringify(before[k]) !== JSON.stringify(after[k]),
    );
    expect(differ).toEqual([]);
    expect(after).toEqual(before);
  });

  it('a second delete of it is a 404', async () => {
    const r = await call('DELETE', `/v1/projects/${GONE.project}`, {
      on_behalf_of: 'ada',
      reason: 'again',
      confirm: GONE.project,
    });
    expect(r.status).toBe(404);
  });

  it('every table is swept or kept with a reason', async () => {
    for (const [t, why] of Object.entries(DELETION_KEPT_TABLES))
      expect(why.length, t).toBeGreaterThan(3);
  });
});
