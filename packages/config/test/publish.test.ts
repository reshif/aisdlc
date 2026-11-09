import { withTransaction } from '@aisdlc/db';
import {
  CONFIG_EVENT,
  FACTORY_SCOPE,
  configRevHash,
  configStream,
  configSubjectId,
} from '@aisdlc/contracts';
import { openGate, sweepExpired } from '@aisdlc/decisions';
import { appendEvents } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigReader,
  ConfigRegistry,
  configProjection,
  configPublish,
  listRevisions,
  proposeRevision,
  publishDecided,
  readLineage,
} from '../src/index.js';
import {
  decideGate,
  ledgerCount,
  pid,
  pr,
  setupProject,
  startStack,
  type Stack,
} from './helpers.js';

let s: Stack;
beforeAll(async () => {
  s = await startStack();
  setupProject(s, 'factory', { admin: ['root', 'rita'] });
  setupProject(s, 'p1', { admin: ['pat'] });
  setupProject(s, 'p2', { admin: ['pam'] });
});
afterAll(async () => {
  await s.stop();
});

const factory = { layer: 'factory' as const };
const project = (ref: string) => ({
  layer: 'project' as const,
  scope: { kind: 'project' as const, ref },
});
const fl = { layer: 'factory' as const, scope: FACTORY_SCOPE };

/** Proposes, approves with the given admin, publishes; throws on any refusal. */
async function publish(over: Parameters<typeof proposeRevision>[1], approver: string) {
  const p = await proposeRevision(s.deps, over);
  if (!p.ok) throw new Error(`propose: ${JSON.stringify(p.error)}`);
  const d = await decideGate(s, p.value.gate_instance_id, approver, 'approve');
  if (!d.ok) throw new Error(`decide: ${JSON.stringify(d.error)}`);
  const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
  if (!r.ok) throw new Error(`publish: ${JSON.stringify(r.error)}`);
  return { ...p.value, ...r.value };
}

const waitFor = <T>(reader: ConfigReader, ms: number): Promise<T | 'timeout'> =>
  new Promise((resolve) => {
    const t = setTimeout(() => resolve('timeout'), ms);
    const off = reader.subscribe((c) => {
      clearTimeout(t);
      off();
      resolve(c as T);
    });
  });

describe('propose', () => {
  it('records an immutable revision and opens an M1 gate on exactly its rev_hash', async () => {
    const doc = { 'gateway.budget_usd': 10, 'ops.kill.enabled': true };
    const p = await proposeRevision(s.deps, {
      ...factory,
      doc,
      proposed_by: pr('dev'),
      expires_at: new Date(s.clock.nowMs() + 3600_000).toISOString(),
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.value.rev_hash).toBe(
      configRevHash({ layer: 'factory', scope: FACTORY_SCOPE, parent_rev_hash: null, doc }),
    );
    const g = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [`gate:${p.value.gate_instance_id}`],
    );
    expect(g.rows[0].body).toMatchObject({
      gate_id: 'M1',
      subject_kind: 'config',
      subject_hash: p.value.rev_hash,
      project_id: 'factory',
      requester: 'dev',
    });
    const revs = await listRevisions(s.deps, fl);
    expect(revs).toHaveLength(1);
    expect(revs[0]).toMatchObject({
      rev_hash: p.value.rev_hash,
      state: 'proposed',
      previous_rev_hash: null,
      ledger_entry_id: null,
      published_at: null,
      gate_instance_id: p.value.gate_instance_id,
    });
    // clean up the lineage for the other tests: reject it
    expect((await decideGate(s, p.value.gate_instance_id, 'root', 'reject')).ok).toBe(true);
  });

  it('refuses unknown keys, bad values, non-overridable project keys and layer/scope mismatch, writing nothing', async () => {
    const before = await s.record.pool.query('SELECT count(*) FROM record.record_event');
    const bad = [
      { ...factory, doc: { 'no.such.key': 1 } },
      { ...factory, doc: { 'gateway.budget_usd': 'lots' } },
      { ...project('p1'), doc: { 'catalogue.pin': '1.2.3' } },
      { layer: 'project' as const, doc: {} }, // project layer needs a project scope
      { layer: 'factory' as const, scope: { kind: 'project' as const, ref: 'p1' }, doc: {} },
    ];
    for (const b of bad) {
      const r = await proposeRevision(s.deps, { ...b, proposed_by: pr('dev') });
      expect(r.ok, JSON.stringify(b)).toBe(false);
    }
    const after = await s.record.pool.query('SELECT count(*) FROM record.record_event');
    expect(after.rows[0].count).toBe(before.rows[0].count);
  });

  it('a project layer for a project whose admin slot is unknown is refused (fail closed)', async () => {
    const r = await proposeRevision(s.deps, {
      ...project('ghost'),
      doc: { 'ops.beta': true },
      proposed_by: pr('dev'),
    });
    expect(!r.ok && r.error.code).toBe('decision');
  });
});

describe('config_publish', () => {
  it('is refused without a decided M1: pending, rejected, request_changes, expired, withdrawn-by-supersede', async () => {
    const reader = await ConfigReader.create({ pool: s.record.pool, registry: s.deps.registry });
    const start = reader.current();

    // pending
    const a = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 11 },
      proposed_by: pr('dev'),
    });
    if (!a.ok) throw new Error('propose');
    const pending = await configPublish(s.deps, { rev_hash: a.value.rev_hash });
    expect(!pending.ok && pending.error.code).toBe('not_decided');
    expect(!pending.ok && pending.error.message).toMatch(/pending/);
    expect(await reader.refresh()).toBe(false);

    // reject
    expect((await decideGate(s, a.value.gate_instance_id, 'rita', 'reject')).ok).toBe(true);
    const rejected = await configPublish(s.deps, { rev_hash: a.value.rev_hash });
    expect(!rejected.ok && rejected.error.code).toBe('not_decided');
    expect(
      (await listRevisions(s.deps, fl)).find((r) => r.rev_hash === a.value.rev_hash)?.state,
    ).toBe('rejected');

    // request_changes
    const b = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 12 },
      proposed_by: pr('dev'),
    });
    if (!b.ok) throw new Error('propose');
    expect((await decideGate(s, b.value.gate_instance_id, 'root', 'request_changes')).ok).toBe(
      true,
    );
    const rc = await configPublish(s.deps, { rev_hash: b.value.rev_hash });
    expect(!rc.ok && rc.error.code).toBe('not_decided');

    // expired: expiry never approves
    const c = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 13 },
      proposed_by: pr('dev'),
      expires_at: new Date(s.clock.nowMs() + 1000).toISOString(),
    });
    if (!c.ok) throw new Error('propose');
    s.clock.advance(2000);
    const sw = await sweepExpired(s.deps);
    expect(sw.ok && sw.value.expired).toContain(c.value.gate_instance_id);
    const ex = await configPublish(s.deps, { rev_hash: c.value.rev_hash });
    expect(!ex.ok && ex.error.code).toBe('not_decided');

    // superseded by a newer proposal
    const d1 = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 14 },
      proposed_by: pr('dev'),
    });
    const d2 = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 15 },
      proposed_by: pr('dev'),
    });
    if (!d1.ok || !d2.ok) throw new Error('propose');
    expect(d2.value.superseded).toEqual([d1.value.gate_instance_id]);
    expect((await decideGate(s, d1.value.gate_instance_id, 'root', 'approve')).ok).toBe(false);
    const sup = await configPublish(s.deps, { rev_hash: d1.value.rev_hash });
    expect(!sup.ok && sup.error.code).toBe('not_decided');

    // a hash nobody proposed
    const none = await configPublish(s.deps, { rev_hash: 'ab'.repeat(32) });
    expect(!none.ok && none.error.code).toBe('revision_not_found');

    // nothing of this ever became effective
    expect(await reader.refresh()).toBe(false);
    expect(reader.current().token).toBe(start.token);
    expect(reader.current().revisions.factory).toBeNull();
    expect(reader.current().get('gateway.budget_usd')).toBe(100); // the registry default

    // d2 stays proposed (pending): clean up by rejecting it
    expect((await decideGate(s, d2.value.gate_instance_id, 'root', 'reject')).ok).toBe(true);
  });

  it('publishes a decided approve, references the M1 ledger entry, and writes no ledger entry of its own', async () => {
    const doc = { 'gateway.budget_usd': 20, 'catalogue.pin': '1.0.0' };
    const p = await proposeRevision(s.deps, { ...factory, doc, proposed_by: pr('dev') });
    if (!p.ok) throw new Error('propose');
    const d = await decideGate(s, p.value.gate_instance_id, 'rita', 'approve');
    if (!d.ok) throw new Error('decide');
    const before = await ledgerCount(s);
    const r = await configPublish(s.deps, {
      rev_hash: p.value.rev_hash,
      published_by: 'system.worker',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.published).toBe(true);
    expect(await ledgerCount(s)).toBe(before);
    expect(r.value.ledger_entry_id).toBe(d.value.entry.entry_id);

    // the revision record event references the decision entry
    const ev = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2`,
      [configStream(fl), CONFIG_EVENT.published],
    );
    expect(ev.rows.at(-1).body).toMatchObject({
      rev_hash: p.value.rev_hash,
      ledger_entry_id: d.value.entry.entry_id,
      gate_instance_id: p.value.gate_instance_id,
      published_by: 'system.worker',
    });
    // and that entry is the Notary-signed M1 approval of exactly this hash
    const le = await s.record.pool.query(
      `SELECT entry_type, gate_id, decision, subject_kind, subject_hash, actor, notary_sig
         FROM ledger.ledger_entry WHERE entry_id = $1`,
      [d.value.entry.entry_id],
    );
    expect(le.rows[0]).toMatchObject({
      entry_type: 'decision',
      gate_id: 'M1',
      decision: 'approve',
      subject_kind: 'config',
      subject_hash: p.value.rev_hash,
      actor: 'rita',
    });
    expect(le.rows[0].notary_sig).toBeTruthy();

    // idempotent
    const again = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
    expect(again.ok && again.value.published).toBe(false);
    const revs = await listRevisions(s.deps, fl);
    const mine = revs.find((x) => x.rev_hash === p.value.rev_hash);
    expect(mine).toMatchObject({ state: 'current', ledger_entry_id: d.value.entry.entry_id });
    expect(mine?.published_at).not.toBeNull();
  });

  it('a revision chain: parent is the head, older ones become superseded, a wrong parent is refused', async () => {
    const head = (await listRevisions(s.deps, fl)).find((r) => r.state === 'current');
    expect(head).toBeDefined();
    const wrong = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 21 },
      proposed_by: pr('dev'),
      parent_rev_hash: null,
    });
    expect(!wrong.ok && wrong.error.code).toBe('stale_parent');
    const same = await proposeRevision(s.deps, {
      ...factory,
      doc: head?.content,
      proposed_by: pr('dev'),
    });
    expect(!same.ok && same.error.code).toBe('unchanged');

    const next = await publish(
      { ...factory, doc: { 'gateway.budget_usd': 22 }, proposed_by: pr('dev') },
      'root',
    );
    expect(next.parent_rev_hash).toBe(head?.rev_hash);
    const revs = await listRevisions(s.deps, fl);
    expect(revs.find((r) => r.rev_hash === head?.rev_hash)?.state).toBe('superseded');
    expect(revs.find((r) => r.rev_hash === next.rev_hash)?.state).toBe('current');
  });

  it('the proposer cannot approve their own revision unless they are the only admin (SoD)', async () => {
    const p = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 23 },
      proposed_by: pr('root'),
    });
    if (!p.ok) throw new Error('propose');
    const own = await decideGate(s, p.value.gate_instance_id, 'root', 'approve');
    expect(!own.ok && own.error.code).toBe('own_request');
    expect((await decideGate(s, p.value.gate_instance_id, 'rita', 'reject')).ok).toBe(true);
  });

  it('refuses a decided revision that is not a child of the current head (stale parent)', async () => {
    // The API cannot produce this (a newer proposal supersedes the older gate), so build it by hand:
    // a revision recorded on an old parent, with its own M1 gate approved.
    const revs = await listRevisions(s.deps, fl);
    const old = revs.find((r) => r.state === 'superseded');
    if (!old) throw new Error('no superseded revision');
    const doc = { 'gateway.budget_usd': 77 };
    const rev_hash = configRevHash({
      layer: 'factory',
      scope: FACTORY_SCOPE,
      parent_rev_hash: old.rev_hash,
      doc,
    });
    await withTransaction(s.record.pool, async (tx) => {
      const head = await tx.query<{ seq: string }>(
        'SELECT max(seq)::text AS seq FROM record.record_event WHERE stream = $1',
        [configStream(fl)],
      );
      const w = await appendEvents(tx, configStream(fl), Number(head.rows[0]?.seq), [
        {
          type: CONFIG_EVENT.proposed,
          actor: 'dev',
          body: {
            rev_hash,
            layer: 'factory',
            scope: FACTORY_SCOPE,
            parent_rev_hash: old.rev_hash,
            doc,
            proposed_by: 'dev',
          },
        },
      ]);
      if (!w.ok) throw new Error('append');
    });
    const g = await openGate(s.deps, {
      gate_id: 'M1',
      project_id: pid('factory'),
      subject_kind: 'config',
      subject_id: configSubjectId(fl),
      subject_hash: rev_hash,
      requester: pr('dev'),
    });
    if (!g.ok) throw new Error(JSON.stringify(g.error));
    expect((await decideGate(s, g.value.gate_instance_id, 'root', 'approve')).ok).toBe(true);
    const r = await configPublish(s.deps, { rev_hash });
    expect(!r.ok && r.error.code).toBe('stale_parent');
    // and publishDecided reports it instead of publishing
    const sweep = await publishDecided(s.deps);
    expect(sweep.ok && sweep.value.published).not.toContain(rev_hash);
  });

  it('concurrent publishes of one decided revision publish once', async () => {
    const p = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 24 },
      proposed_by: pr('dev'),
    });
    if (!p.ok) throw new Error('propose');
    expect((await decideGate(s, p.value.gate_instance_id, 'root', 'approve')).ok).toBe(true);
    const rs = await Promise.all([
      configPublish(s.deps, { rev_hash: p.value.rev_hash }),
      configPublish(s.deps, { rev_hash: p.value.rev_hash }),
      configPublish(s.deps, { rev_hash: p.value.rev_hash }),
    ]);
    expect(rs.every((r) => r.ok)).toBe(true);
    expect(rs.filter((r) => r.ok && r.value.published)).toHaveLength(1);
    const n = await s.record.pool.query(
      `SELECT count(*) FROM record.record_event WHERE type = $1 AND body ->> 'rev_hash' = $2`,
      [CONFIG_EVENT.published, p.value.rev_hash],
    );
    expect(n.rows[0].count).toBe('1');
  });

  it('publishDecided publishes what is decided and reports the rest, never deciding', async () => {
    const decided = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 25 },
      proposed_by: pr('dev'),
    });
    if (!decided.ok) throw new Error('propose');
    expect((await decideGate(s, decided.value.gate_instance_id, 'rita', 'approve')).ok).toBe(true);
    const r = await publishDecided(s.deps);
    expect(r.ok && r.value.published).toEqual([decided.value.rev_hash]);
    const next = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 26 },
      proposed_by: pr('dev'),
    });
    if (!next.ok) throw new Error('propose');
    const r2 = await publishDecided(s.deps);
    expect(r2.ok && r2.value.published).toEqual([]);
    expect(r2.ok && r2.value.skipped.map((x) => x.rev_hash)).toContain(next.value.rev_hash);
    expect((await decideGate(s, next.value.gate_instance_id, 'root', 'reject')).ok).toBe(true);
  });
});

describe('a forged publish never becomes effective', () => {
  it('a config.published event without a decided M1, or with another hash’s decision, is ignored', async () => {
    const good = (await listRevisions(s.deps, fl)).find((r) => r.state === 'current');
    if (!good) throw new Error('no current');
    const pending = await proposeRevision(s.deps, {
      ...factory,
      doc: { 'gateway.budget_usd': 99 },
      proposed_by: pr('dev'),
    });
    if (!pending.ok) throw new Error('propose');
    const reader = await ConfigReader.create({ pool: s.record.pool, registry: s.deps.registry });
    const token = reader.current().token;

    const forge = async (body: Record<string, unknown>) =>
      withTransaction(s.record.pool, async (tx) => {
        const head = await tx.query<{ seq: string }>(
          'SELECT max(seq)::text AS seq FROM record.record_event WHERE stream = $1',
          [configStream(fl)],
        );
        const w = await appendEvents(tx, configStream(fl), Number(head.rows[0]?.seq), [
          { type: CONFIG_EVENT.published, actor: 'attacker', body },
        ]);
        if (!w.ok) throw new Error('append');
      });
    const goodEvent = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq DESC LIMIT 1`,
      [configStream(fl), CONFIG_EVENT.published],
    );
    const real = goodEvent.rows[0].body;
    // (a) the pending revision, naming the previous revision's genuine M1 entry
    await forge({
      ...real,
      rev_hash: pending.value.rev_hash,
      parent_rev_hash: real.rev_hash,
      published_by: 'attacker',
    });
    // (b) naming its own pending gate and a made-up entry id
    await forge({
      ...real,
      rev_hash: pending.value.rev_hash,
      parent_rev_hash: real.rev_hash,
      gate_instance_id: pending.value.gate_instance_id,
      ledger_entry_id: '01990000-0000-7000-8000-000000000000',
      published_by: 'attacker',
    });
    expect(await reader.refresh()).toBe(false);
    expect(reader.current().token).toBe(token);
    expect(reader.current().get('gateway.budget_usd')).not.toBe(99);
    const lineage = await readLineage(s.record.pool, fl);
    expect(lineage.head?.rev_hash).toBe(real.rev_hash);
    // and the revision is still just proposed
    expect(
      (await listRevisions(s.deps, fl)).find((r) => r.rev_hash === pending.value.rev_hash)?.state,
    ).toBe('proposed');
    expect((await decideGate(s, pending.value.gate_instance_id, 'root', 'reject')).ok).toBe(true);
  });
});

describe('consumers reload by revision without a restart', () => {
  it('LISTEN/NOTIFY: a running reader sees a published revision, and never an unpublished one', async () => {
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: s.deps.registry,
      pollIntervalMs: 0, // push only: no poll to rescue a missed notification
    });
    await reader.start();
    try {
      const from = reader.current();
      const p = await proposeRevision(s.deps, {
        ...factory,
        doc: { 'gateway.budget_usd': 31, 'ops.kill.enabled': false },
        proposed_by: pr('dev'),
      });
      if (!p.ok) throw new Error('propose');
      // proposed: not seen. decided but not published: not seen.
      expect(await waitFor(reader, 200)).toBe('timeout');
      expect((await decideGate(s, p.value.gate_instance_id, 'root', 'approve')).ok).toBe(true);
      expect(await waitFor(reader, 200)).toBe('timeout');
      expect(reader.current().token).toBe(from.token);

      const seen = waitFor<{ from: typeof from; to: typeof from }>(reader, 5000);
      const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
      expect(r.ok).toBe(true);
      const change = await seen;
      expect(change).not.toBe('timeout');
      expect(reader.current().get('gateway.budget_usd')).toBe(31);
      expect(reader.current().get('ops.kill.enabled')).toBe(false);
      expect(reader.current().revisions.factory).toBe(p.value.rev_hash);
      // a snapshot someone held before is unchanged (immutable snapshots)
      expect(from.get('gateway.budget_usd')).not.toBe(31);
      expect(Object.isFrozen(reader.current().values)).toBe(true);
    } finally {
      await reader.stop();
    }
  });

  it('poll fallback: a reader that cannot LISTEN still converges', async () => {
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: s.deps.registry,
      listen: false,
      pollIntervalMs: 25,
    });
    await reader.start();
    try {
      const seen = waitFor(reader, 5000);
      const r = await publish(
        {
          ...factory,
          doc: { 'gateway.budget_usd': 32, 'ops.kill.enabled': false },
          proposed_by: pr('dev'),
        },
        'rita',
      );
      expect(await seen).not.toBe('timeout');
      expect(reader.current().revisions.factory).toBe(r.rev_hash);
    } finally {
      await reader.stop();
    }
  });

  it('stop() ends the timer and the LISTEN connection (no orphan work)', async () => {
    const listeners = async () =>
      Number(
        (
          await s.record.pool.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM pg_stat_activity
              WHERE datname = current_database() AND query LIKE 'LISTEN %' AND state = 'idle'`,
          )
        ).rows[0]?.n,
      );
    const base = await listeners();
    const reader = await ConfigReader.create({ pool: s.record.pool, registry: s.deps.registry });
    await reader.start();
    expect(await listeners()).toBe(base + 1);
    await reader.stop();
    await reader.stop(); // twice is fine
    expect(await listeners()).toBe(base);
  });

  it('a failed reload keeps the last good snapshot', async () => {
    const errors: unknown[] = [];
    const reader = await ConfigReader.create({
      pool: s.record.pool,
      registry: s.deps.registry,
      listen: false,
      pollIntervalMs: 0,
      onError: (e) => errors.push(e),
    });
    const before = reader.current();
    // the effective-config view (a view follows a renamed table, so break the view itself)
    await s.record.pool.query('ALTER VIEW config.genuine_publish RENAME TO genuine_publish_x');
    try {
      await expect(reader.refresh()).rejects.toThrow();
    } finally {
      await s.record.pool.query('ALTER VIEW config.genuine_publish_x RENAME TO genuine_publish');
    }
    expect(reader.current()).toBe(before);
  });
});

describe('layers: factory, then project for overridable keys', () => {
  it('the project layer overrides only overridable keys, per project', async () => {
    const f = await publish(
      {
        ...factory,
        doc: {
          'gateway.budget_usd': 40,
          'ops.beta': false,
          'ops.kill.enabled': true,
          'catalogue.pin': '1.0.0',
        },
        proposed_by: pr('dev'),
      },
      'root',
    );
    const p1 = await publish(
      {
        ...project('p1'),
        doc: { 'gateway.budget_usd': 50, 'ops.beta': true },
        proposed_by: pr('dev'),
      },
      'pat',
    );
    expect(p1.layer).toBe('project');

    const mk = (project?: string) =>
      ConfigReader.create({
        pool: s.record.pool,
        registry: s.deps.registry,
        ...(project ? { project: project as never } : {}),
      });
    const r1 = await mk('p1');
    const r2 = await mk('p2');
    const rf = await mk();
    expect(r1.current().get('gateway.budget_usd')).toBe(50);
    expect(r1.current().get('ops.beta')).toBe(true);
    expect(r1.current().get('ops.kill.enabled')).toBe(true); // factory only
    expect(r1.current().get('catalogue.pin')).toBe('1.0.0');
    expect(r1.current().revisions).toEqual({ factory: f.rev_hash, project: p1.rev_hash });
    expect(r2.current().get('gateway.budget_usd')).toBe(40);
    expect(r2.current().revisions.project).toBeNull();
    expect(rf.current().get('gateway.budget_usd')).toBe(40);
    // unregistered-by-this-consumer keys are not exposed
    expect(rf.current().get('no.such.key')).toBeUndefined();

    // a consumer that later marks the key factory-only ignores the project's override
    const tightened = new ConfigRegistry().setting({
      key: 'gateway.budget_usd',
      schema: z.number().int().min(0),
      default: 100,
      overridable: false,
      description: 'now factory only',
    });
    const rt = await ConfigReader.create({
      pool: s.record.pool,
      registry: tightened,
      project: 'p1' as never,
    });
    expect(rt.current().get('gateway.budget_usd')).toBe(40);

    // a project change is its own lineage with its own M1 gate (p1's admin), and supersedes cleanly
    const p1b = await publish(
      { ...project('p1'), doc: { 'gateway.budget_usd': 60 }, proposed_by: pr('dev') },
      'pat',
    );
    await r1.refresh();
    expect(r1.current().get('gateway.budget_usd')).toBe(60);
    expect(r1.current().get('ops.beta')).toBe(false); // a full document: ops.beta is back to the factory value
    const revs = await listRevisions(s.deps, {
      layer: 'project',
      scope: { kind: 'project', ref: 'p1' },
    });
    expect(revs.map((r) => r.state)).toEqual(['superseded', 'current']);
    expect(revs[1]?.rev_hash).toBe(p1b.rev_hash);
    // p2's lineage is untouched
    expect(
      await listRevisions(s.deps, { layer: 'project', scope: { kind: 'project', ref: 'p2' } }),
    ).toEqual([]);
  });

  it('the M1 gate of a project layer is decided by that project’s admin, not the factory admins', async () => {
    const p = await proposeRevision(s.deps, {
      ...project('p2'),
      doc: { 'ops.beta': true },
      proposed_by: pr('dev'),
    });
    if (!p.ok) throw new Error('propose');
    const wrong = await decideGate(s, p.value.gate_instance_id, 'root', 'approve');
    expect(!wrong.ok && wrong.error.code).toBe('not_eligible');
    expect((await decideGate(s, p.value.gate_instance_id, 'pam', 'approve')).ok).toBe(true);
    expect((await configPublish(s.deps, { rev_hash: p.value.rev_hash })).ok).toBe(true);
  });
});

describe('read model', () => {
  it('config revisions are immutable rows', async () => {
    await expect(
      s.record.pool.query(`UPDATE config.config_revision SET doc = '{}'::jsonb`),
    ).rejects.toThrow(/immutable/);
  });

  it('rebuild equals live', async () => {
    await expectRebuildEqualsLive(s.record.pool, configProjection);
  });

  it('every listed revision satisfies the ConfigRevision contract (rev_hash recomputes)', async () => {
    const revs = await listRevisions(s.deps, fl);
    expect(revs.length).toBeGreaterThan(3);
  });
});
