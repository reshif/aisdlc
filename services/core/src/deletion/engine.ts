import {
  AUDIT_BUCKET,
  DELETION_ENTRY_TYPE,
  DELETION_EVENT,
  DeletionPerformedBody,
  DeletionPerformedEvent,
  EVIDENCE_BUCKET,
  deletionStream,
  type DeletionCounts,
  type DeletionKind,
  type DeletionObjectKey,
  type DeletionPreview,
  type JsonObject,
  type LedgerEntry,
  type LedgerEntryDraft,
  type PrincipalId,
} from '@aisdlc/contracts';
import type { JournalRedactorPort } from '@aisdlc/ports';
import { err, newId, ok, sha256Hex, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  confirmAll,
  importUnconfirmed,
  lockLedger,
  redactEntriesActor,
  redactEntriesFully,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import {
  appendEvents,
  enterPurgeRole,
  redactEvents,
  removeEvents,
  type Executor,
} from '@aisdlc/record';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { needlePath, needleRegexes } from './match.js';

// The deletion (owner decision 2026-11-13, "delete means delete"; docs/specs/deletion.md). One transaction on the
// purge login, in the lock order: the ledger lock (stranded Notary entries imported first), the purge role, the legal
// hold check, the needles (the object's ids, to a fixpoint over the record), the object-store keys, then the ledger
// redactions, the record removals and redactions, the read-model sweep, and `deletion.performed` LAST (its record
// event, then its ledger entry). After COMMIT: the Notary confirm and the object-store purge (retried from the event).

/** How a kind of object is found in the record and the read models. */
export interface DeletionSpec {
  readonly kind: DeletionKind;
  /** The ids that are the object (the first needles). */
  readonly roots: readonly string[];
  /**
   * Stream types whose creation event naming a needle makes the stream the object's (removed whole), its id a
   * needle in turn. A stream whose NAME names a needle is the object's whatever its type.
   */
  readonly expand: readonly string[];
  /** May an event of this stream type, naming a needle, be redacted (or its stream removed when every event does)? */
  readonly touch: (streamType: string) => boolean;
  /** Which read-model tables are swept: every schema but the kept tables, or only these schemas. */
  readonly tables: 'all' | readonly string[];
  /**
   * `full`: every entry naming a needle is redacted whole. `person`: only the person's own gate decisions, to the
   * actor (their gate columns kept, docs/specs/deletion.md §3). `none`: the ledger is not touched.
   */
  readonly ledger: 'full' | 'person' | 'none';
  /** Kept tables this kind does sweep (a person's own `identity.principal` row, a team's `identity.team`). */
  readonly alsoSweep?: readonly string[];
}

/** Stream types of a project's things: an item, its gates and cards, S0, planning, packs, units, threads, ... */
export const PROJECT_STREAM_TYPES: readonly string[] = [
  'project',
  'repo',
  's0',
  'prr',
  'census',
  'kjob',
  'probe',
  'spike',
  'drift',
  'kdefect',
  'reonboard',
  'issue_twin',
  'work',
  'item',
  'gate',
  'card',
  'planning',
  'evidence',
  'agent',
  'unit',
  'verify',
  'push',
  'handoff',
  'thread',
  'merge',
  'finding',
  'binding',
  'access_grant',
  'control',
  'banner',
  'alert',
  'ops_action',
  'ops_preview',
  'pack',
  'closeout',
  'learn',
];

/** Streams of independent things: never redacted nor removed by a project, repo or item delete. */
export const INDEPENDENT_STREAM_TYPES: readonly string[] = [
  'principal',
  'group',
  'team',
  'config',
  'notifier',
  'notifier-pref',
  'deletion',
  'audit-hold',
  'audit-erasure',
];

/**
 * Tables a deletion never sweeps, and why. Every table of the record database is either swept or listed here (a test
 * holds it). Schemas: `public` (migration bookkeeping) is never swept.
 */
export const DELETION_KEPT_TABLES: Readonly<Record<string, string>> = {
  'record.record_event': 'the record: removed and redacted by the purge path, never swept',
  'record.purged_event': 'positions only, the proof a gap is a purge',
  'record.global_counter': 'a number',
  'record.projection_checkpoint': 'positions only',
  'record.stream_type_counts': 'counts per stream type, corrected by the deletion',
  'ledger.ledger_entry': 'the ledger: redacted in place, never swept',
  'ledger.checkpoint': 'hashes only, signed',
  'config.config_revision':
    'swept by lineage: a factory revision is factory settings (deletion.md §7)',
  'config.config_published': 'swept by lineage',
  'audit.legal_hold': 'a hold blocks the deletion; it is never removed by one',
  'identity.principal': 'a person, deleted only as a person',
  'identity.grp': 'a group, independent',
  'identity.team': 'a team, deleted only as a team',
  'directory.principal': 'a person, deleted only as a person',
  'directory.team': 'a team, deleted only as a team',
};

export interface DeletionDeps {
  /** The purge login (`CORE_PURGE_DATABASE_URL`): a member of `aisdlc_purge`. */
  readonly purgePool: pg.Pool;
  readonly ledger: LedgerClientDeps;
  readonly clock?: Clock;
  /** Removes an object from the store whatever its bucket's lock; absent: the keys wait in the record. */
  readonly objects?: ObjectPurger;
  readonly policyBundleVersion?: string;
}

/** The deletion's own hand on the object store (`S3ObjectStore.purge`, `FakeObjectStore.purge`). */
export interface ObjectPurger {
  purge(bucket: string, sha256: string): Promise<Result<void, { message: string }>>;
}

interface Plan {
  readonly needles: Set<string>;
  readonly remove: number[];
  readonly redact: number[];
  readonly removedByType: Map<string, number>;
  readonly ledgerFull: number[];
  readonly ledgerActor: number[];
  readonly tables: Array<{ table: string; rows: number }>;
  readonly objects: DeletionObjectKey[];
}

const q = <T extends pg.QueryResultRow>(db: Executor, sql: string, args: unknown[] = []) =>
  db.query<T>(sql, args);

const exists = async (db: Executor, rel: string): Promise<boolean> =>
  (await q<{ t: string | null }>(db, 'SELECT to_regclass($1)::text AS t', [rel])).rows[0]?.t !=
  null;

/** The needles of the object: its roots, then every expandable stream's id the record ties to them, to a fixpoint. */
async function plan(db: Executor, spec: DeletionSpec): Promise<Plan> {
  const needles = new Set(spec.roots);
  const owned = new Set<string>();
  for (let round = 0; round < 12; round++) {
    const res = needleRegexes(needles);
    const path = needlePath(needles);
    const hits = await q<{ stream: string; seq: string; by_name: boolean }>(
      db,
      `SELECT stream, seq::text AS seq, (stream ~* ANY($1::text[])) AS by_name
         FROM record.record_event
        WHERE redacted_at IS NULL
          AND (stream ~* ANY($1::text[])
               OR jsonb_path_exists(jsonb_build_array(body, actor), $2::jsonpath, '{}'::jsonb, true))`,
      [res, path],
    );
    let grew = false;
    for (const h of hits.rows) {
      const type = h.stream.split(':', 1)[0] as string;
      const own = h.by_name || (Number(h.seq) === 1 && spec.expand.includes(type));
      if (!own || owned.has(h.stream)) continue;
      owned.add(h.stream);
      grew = true;
      if (spec.expand.includes(type)) {
        const id = h.stream.slice(type.length + 1);
        if (id.length >= 2 && !needles.has(id) && /^[A-Za-z0-9_.@/:-]+$/.test(id)) needles.add(id);
      }
    }
    if (!grew) break;
  }

  // The record: owned streams go whole; elsewhere, events naming a needle are redacted, or their stream removed
  // when every event of it names one (a decision log entry, a one-event stream).
  const res = needleRegexes(needles);
  const path = needlePath(needles);
  const rows = await q<{ stream: string; g: string; hit: boolean; total: string }>(
    db,
    `WITH s AS (
       SELECT stream, global_seq, (stream = ANY($3::text[])) AS own,
              jsonb_path_exists(jsonb_build_array(body, actor), $2::jsonpath, '{}'::jsonb, true) AS hit
         FROM record.record_event
        WHERE redacted_at IS NULL
          AND (stream = ANY($3::text[]) OR stream ~* ANY($1::text[])
               OR jsonb_path_exists(jsonb_build_array(body, actor), $2::jsonpath, '{}'::jsonb, true)))
     SELECT s.stream, s.global_seq::text AS g, (s.own OR s.hit) AS hit,
            (SELECT count(*) FROM record.record_event r WHERE r.stream = s.stream)::text AS total
       FROM s`,
    [res, path, [...owned]],
  );
  const byStream = new Map<string, { gs: number[]; total: number }>();
  for (const r of rows.rows) {
    if (!r.hit) continue;
    const e = byStream.get(r.stream) ?? { gs: [], total: Number(r.total) };
    e.gs.push(Number(r.g));
    byStream.set(r.stream, e);
  }
  const remove: number[] = [];
  const redact: number[] = [];
  const removedByType = new Map<string, number>();
  for (const [stream, e] of byStream) {
    const type = stream.split(':', 1)[0] as string;
    const whole = owned.has(stream) || (spec.touch(type) && e.gs.length === e.total);
    if (whole) {
      const all = await q<{ g: string }>(
        db,
        'SELECT global_seq::text AS g FROM record.record_event WHERE stream = $1',
        [stream],
      );
      remove.push(...all.rows.map((x) => Number(x.g)));
      removedByType.set(type, (removedByType.get(type) ?? 0) + all.rows.length);
    } else if (spec.touch(type)) {
      redact.push(...e.gs);
    }
  }

  // The ledger.
  const led =
    spec.ledger === 'none'
      ? { rows: [] as Array<{ seq: string; actor_only: boolean }> }
      : spec.ledger === 'person'
        ? await q<{ seq: string; actor_only: boolean }>(
            db,
            `SELECT ledger_seq::text AS seq, true AS actor_only FROM ledger.ledger_entry
              WHERE entry_type = 'decision' AND redacted_at IS NULL AND actor = ANY($1::text[])
              ORDER BY ledger_seq`,
            [[...spec.roots]],
          )
        : await q<{ seq: string; actor_only: boolean }>(
            db,
            `SELECT ledger_seq::text AS seq,
            NOT (coalesce(gate_instance_id::text, '') ~* ANY($1::text[])
                 OR coalesce(subject_id, '') ~* ANY($1::text[])
                 OR jsonb_path_exists(body, $2::jsonpath, '{}'::jsonb, true)) AS actor_only
       FROM ledger.ledger_entry
      WHERE entry_type NOT IN ('redacted', $3)
        AND (coalesce(gate_instance_id::text, '') ~* ANY($1::text[])
             OR coalesce(subject_id, '') ~* ANY($1::text[])
             OR coalesce(actor, '') ~* ANY($1::text[])
             OR jsonb_path_exists(body, $2::jsonpath, '{}'::jsonb, true))
      ORDER BY ledger_seq`,
            [res, path, DELETION_ENTRY_TYPE],
          );
  const ledgerFull: number[] = [];
  const ledgerActor: number[] = [];
  for (const r of led.rows) {
    (spec.ledger === 'person' && r.actor_only ? ledgerActor : ledgerFull).push(Number(r.seq));
  }

  // The read models.
  const tables: Array<{ table: string; rows: number }> = [];
  for (const t of await sweptTables(db, spec)) {
    const c = await q<{ n: string }>(
      db,
      `SELECT count(*)::text AS n FROM ${t.sql} x WHERE ${t.where}`,
      [t.byLineage ? res : path],
    );
    const n = Number(c.rows[0]?.n ?? 0);
    if (n > 0) tables.push({ table: t.name, rows: n });
  }

  // The object store: the packs of the object's items and the exports of its scope, read before the rows go.
  const objects: DeletionObjectKey[] = [];
  if (await exists(db, 'core.evidence_pack')) {
    const p = await q<{ bucket: string; object_key: string; handoff_object_key: string | null }>(
      db,
      `SELECT bucket, object_key, handoff_object_key FROM core.evidence_pack x
        WHERE jsonb_path_exists(to_jsonb(x), $1::jsonpath, '{}'::jsonb, true)`,
      [path],
    );
    for (const r of p.rows) {
      objects.push({ bucket: r.bucket || EVIDENCE_BUCKET, sha256: r.object_key });
      if (r.handoff_object_key)
        objects.push({ bucket: r.bucket || EVIDENCE_BUCKET, sha256: r.handoff_object_key });
    }
  }
  if (await exists(db, 'audit.export')) {
    const p = await q<{ object_key: string }>(
      db,
      `SELECT object_key FROM audit.export x WHERE scope_kind = 'project'
          AND jsonb_path_exists(to_jsonb(x), $1::jsonpath, '{}'::jsonb, true)`,
      [path],
    );
    for (const r of p.rows) objects.push({ bucket: AUDIT_BUCKET, sha256: r.object_key });
  }
  const seen = new Set<string>();
  const uniq = objects.filter((o) => {
    const k = `${o.bucket}/${o.sha256}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return {
    needles,
    remove: [...new Set(remove)].sort((a, b) => a - b),
    redact: [...new Set(redact)].sort((a, b) => a - b),
    removedByType,
    ledgerFull,
    ledgerActor,
    tables,
    objects: uniq,
  };
}

interface SweptTable {
  readonly name: string;
  readonly sql: string;
  readonly where: string;
  readonly byLineage: boolean;
}

/** Every base table the spec sweeps, with the condition that picks the object's rows. */
async function sweptTables(db: Executor, spec: DeletionSpec): Promise<SweptTable[]> {
  const t = await q<{ s: string; t: string }>(
    db,
    `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
      WHERE table_type = 'BASE TABLE'
        AND table_schema NOT IN ('public', 'information_schema') AND table_schema NOT LIKE 'pg\\_%'
      ORDER BY 1, 2`,
  );
  const out: SweptTable[] = [];
  for (const r of t.rows) {
    const name = `${r.s}.${r.t}`;
    const sql = `"${r.s}"."${r.t}"`;
    if (spec.tables !== 'all' && !spec.tables.includes(r.s)) continue;
    if (name === 'config.config_revision' || name === 'config.config_published') {
      if (spec.tables === 'all')
        out.push({ name, sql, where: 'x.lineage ~* ANY($1::text[])', byLineage: true });
      continue;
    }
    if (name in DELETION_KEPT_TABLES && !(spec.alsoSweep ?? []).includes(name)) continue;
    out.push({
      name,
      sql,
      where: `jsonb_path_exists(to_jsonb(x), $1::jsonpath, '{}'::jsonb, true)`,
      byLineage: false,
    });
  }
  return out;
}

/** Is a legal hold in force on the object (the fleet's, the project's, the person's)? */
async function heldBy(
  db: Executor,
  kind: DeletionKind,
  project: string | null,
  principal: string | null,
) {
  if (!(await exists(db, 'audit.legal_hold'))) return [];
  const r = await q<{ matter_ref: string }>(
    db,
    `SELECT matter_ref FROM audit.legal_hold WHERE state = 'active' AND (
        scope_kind = 'fleet'
        OR (scope_kind = 'project' AND scope_ref = $1)
        OR (scope_kind = 'principal' AND scope_ref = $2))`,
    [project ?? '', principal ?? ''],
  );
  void kind;
  return r.rows.map((x) => x.matter_ref);
}

const countsOf = (p: Plan): DeletionCounts => ({
  record_events_removed: p.remove.length,
  record_events_redacted: p.redact.length,
  ledger_entries_redacted: p.ledgerFull.length + p.ledgerActor.length,
  read_model_rows: p.tables.reduce((n, t) => n + t.rows, 0),
  objects: p.objects.length,
});

export interface DeletionTarget {
  readonly spec: DeletionSpec;
  /** For the legal hold check. */
  readonly project: string | null;
  readonly principal: string | null;
}

/** What a deletion would remove, writing nothing. */
export async function previewDeletion(
  db: Executor,
  target: DeletionTarget,
  id: string,
): Promise<DeletionPreview> {
  const p = await plan(db, target.spec);
  const holds = await heldBy(db, target.spec.kind, target.project, target.principal);
  return {
    kind: target.spec.kind,
    id,
    counts: countsOf(p),
    tables: p.tables.map((t) => t.table),
    blockers: holds.map((m) => ({
      kind: 'legal_hold' as const,
      message: `legal hold ${m} is in force`,
    })),
  };
}

export interface PerformInput {
  readonly target: DeletionTarget;
  readonly actor: PrincipalId;
  readonly reason: string;
  /** The PDP allowed it only through the factory admin's override. */
  readonly override: boolean;
}

export interface Performed {
  readonly deletion_id: string;
  readonly counts: DeletionCounts;
  readonly ledger_entry_id: string;
  readonly objects_purged: boolean;
  readonly confirmed: boolean;
  /** The Notary erased its journal's copies of the redacted entries. */
  readonly notary_journal_redacted: boolean;
}

/** Deletes the object: one transaction (see the module note), then the confirm and the object purge. */
export async function performDeletion(
  deps: DeletionDeps,
  input: PerformInput,
): Promise<Result<Performed, CoreError>> {
  const clock = deps.clock ?? systemClock;
  const deletionId = newId<'Deletion'>(clock.nowMs());
  const client = await deps.purgePool.connect();
  let pending: readonly PendingConfirm[];
  let out: {
    counts: DeletionCounts;
    entryId: string;
    entry: LedgerEntry;
    objects: DeletionObjectKey[];
  };
  try {
    await client.query('BEGIN');
    try {
      // Lock order: the ledger lock before the first record append, the ledger entry last.
      await lockLedger(client);
      const imported = await importUnconfirmed(client, deps.ledger);
      if (!imported.ok) throw new DeletionAbort(coreError('unavailable', imported.error.message));
      try {
        await enterPurgeRole(client);
      } catch {
        throw new DeletionAbort(
          coreError(
            'unavailable',
            'deletion_unavailable: the deletion login cannot take the purge role',
          ),
        );
      }
      const { spec } = input.target;
      const holds = await heldBy(client, spec.kind, input.target.project, input.target.principal);
      if (holds.length > 0) {
        throw new DeletionAbort(
          coreError('conflict', `legal_hold: ${holds.join(', ')} is in force`),
        );
      }
      const p = await plan(client, spec);
      const at = clock.now();
      const full = await redactEntriesFully(client, deletionId, p.ledgerFull, at);
      const actorOnly =
        spec.ledger === 'person' && spec.roots[0]
          ? await redactEntriesActor(client, deletionId, spec.roots[0], p.ledgerActor, at)
          : 0;
      const removed = await removeEvents(client, deletionId, p.remove, at);
      const redacted = await redactEvents(client, p.redact, at);
      // The sample projection counts events per stream type: take the removed ones off, and drop a type none is
      // left of (a rebuild from the record has no row for it).
      for (const [type, n] of p.removedByType) {
        await client.query(
          `UPDATE record.stream_type_counts SET event_count = greatest(event_count - $2, 0)
            WHERE stream_type = $1`,
          [type, n],
        );
      }
      await client.query('DELETE FROM record.stream_type_counts WHERE event_count = 0');
      const rowsRemoved = await sweep(client, spec, p.needles);
      const counts: DeletionCounts = {
        record_events_removed: removed,
        record_events_redacted: redacted,
        ledger_entries_redacted: full + actorOnly,
        read_model_rows: rowsRemoved,
        objects: p.objects.length,
      };
      const body = DeletionPerformedBody.parse({
        deletion_id: deletionId,
        kind: spec.kind,
        root_hash: sha256Hex(spec.roots[0] ?? ''),
        id_hashes: [...p.needles].map((n) => sha256Hex(n)).sort(),
        counts,
        redacted_ledger_seqs: [...p.ledgerFull, ...p.ledgerActor].sort((a, b) => a - b),
        reason_hash: sha256Hex(input.reason),
        actor: input.actor,
        override: input.override,
        at: at.toISOString(),
      });
      const event = DeletionPerformedEvent.parse({
        ...body,
        reason: input.reason,
        objects: p.objects,
      });
      const ev = await appendEvents(
        client,
        deletionStream(deletionId),
        0,
        [
          {
            type: DELETION_EVENT.performed,
            actor: input.actor,
            idempotency_key: `${DELETION_EVENT.performed}:${deletionId}`,
            body: event as unknown as JsonObject,
          },
        ],
        { clock },
      );
      if (!ev.ok) throw new DeletionAbort(coreError('conflict', JSON.stringify(ev.error)));
      const entryId = newId<'LedgerEntry'>(clock.nowMs());
      const draft: LedgerEntryDraft = {
        entry_id: entryId as never,
        entry_type: DELETION_ENTRY_TYPE,
        gate_instance_id: null,
        gate_id: null,
        subject_kind: null,
        subject_id: null,
        subject_hash: null,
        decision: null,
        actor: input.actor,
        sod_waiver: false,
        policy_bundle_version: deps.policyBundleVersion ?? 'deletion-1.0.0',
        body: body as unknown as JsonObject,
        created_at: at.toISOString(),
      };
      const w = await appendLedgerEntryTx(client, deps.ledger, draft);
      if (!w.ok) throw new DeletionAbort(coreError('unavailable', w.error.message));
      pending = [...imported.value.pending, ...w.value.pending];
      await client.query('COMMIT');
      out = { counts, entryId, entry: w.value.entry, objects: p.objects };
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (e instanceof DeletionAbort) return err(e.error);
      return err(
        coreError('unavailable', `deletion failed: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  } finally {
    client.release();
  }
  const confirmed = await confirmAll(deps.ledger.notary, pending);
  // The Notary's journal keeps a copy of every entry it signed: it erases the ones this deletion redacted, on the word
  // of the deletion entry itself (which it checks it signed). A Notary that cannot is reported, never fatal: the ledger
  // row is what readers read, and the request can be made again with the same entry.
  const notary = deps.ledger.notary as Partial<JournalRedactorPort>;
  const journal =
    confirmed.ok && notary.redactJournal
      ? await notary.redactJournal(out.entry).then((r) => r.ok)
      : false;
  const purged = await purgeObjects(deps, out.objects);
  return ok({
    deletion_id: deletionId,
    counts: out.counts,
    ledger_entry_id: out.entryId,
    objects_purged: purged,
    confirmed: confirmed.ok,
    notary_journal_redacted: journal,
  });
}

/** Purges the objects a deletion named (idempotent). False when some could not be purged now. */
export async function purgeObjects(
  deps: Pick<DeletionDeps, 'objects'>,
  objects: readonly DeletionObjectKey[],
): Promise<boolean> {
  if (objects.length === 0) return true;
  if (!deps.objects) return false;
  let all = true;
  for (const o of objects) {
    const r = await deps.objects.purge(o.bucket, o.sha256);
    if (!r.ok) all = false;
  }
  return all;
}

class DeletionAbort extends Error {
  constructor(readonly error: CoreError) {
    super(error.message);
  }
}

/**
 * Removes the object's rows from every swept table. Tables are tried in passes, each in a savepoint, so a row that a
 * foreign key holds goes once the row that refers to it has gone; a table that still fails after the passes aborts.
 */
async function sweep(db: Executor, spec: DeletionSpec, needles: Set<string>): Promise<number> {
  const res = needleRegexes(needles);
  const path = needlePath(needles);
  let left = await sweptTables(db, spec);
  let total = 0;
  for (let pass = 0; pass < 6 && left.length > 0; pass++) {
    const failed: SweptTable[] = [];
    for (const t of left) {
      await db.query('SAVEPOINT deletion_sweep');
      try {
        const r = await db.query(`DELETE FROM ${t.sql} x WHERE ${t.where}`, [
          t.byLineage ? res : path,
        ]);
        total += r.rowCount ?? 0;
        await db.query('RELEASE SAVEPOINT deletion_sweep');
      } catch (e) {
        await db.query('ROLLBACK TO SAVEPOINT deletion_sweep');
        if ((e as { code?: string }).code !== '23503') throw e;
        failed.push(t);
      }
    }
    if (failed.length === left.length) break;
    left = failed;
  }
  if (left.length > 0 && (await anyRows(db, left, res, path))) {
    throw new Error(`rows of ${left.map((t) => t.name).join(', ')} are still referred to`);
  }
  return total;
}

async function anyRows(db: Executor, tables: SweptTable[], res: string[], path: string) {
  for (const t of tables) {
    const r = await db.query(`SELECT 1 FROM ${t.sql} x WHERE ${t.where} LIMIT 1`, [
      t.byLineage ? res : path,
    ]);
    if ((r.rowCount ?? 0) > 0) return true;
  }
  return false;
}
