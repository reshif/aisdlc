import {
  CLOSEOUT_EVENT,
  CLOSEOUT_LEDGER_ENTRY_TYPE,
  CLOSEOUT_SCHEMA,
  CloseOutRecord,
  CloseOutRecordedPayload,
  EscapeReportedPayload,
  G4Review,
  G4_REVIEW_FACT,
  G6Acceptance,
  GATECHECK_EVENT,
  GitSha,
  ITEM_EVENT,
  ItemEventPayloads,
  MergeObservedPayload,
  closeOutId,
  closeoutStream,
  mergeSubjectId,
  type CloseOutBreakGlass,
  type CloseOutGate,
  type CloseOutUnit,
  type LedgerEntryDraft,
  type StageOutcome,
  type StageRequest,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION, readOpened } from '@aisdlc/decisions';
import { deterministicId, err, ok, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import type { ReleasePort, StagePortError, StagePorts } from '@aisdlc/ports';
import type { Executor, Tx } from '@aisdlc/record';
import type { ItemState } from '@aisdlc/work';
import { listPullRequests } from '../build/push.js';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreLedgerTx, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { listMergeReconciled } from '../review/merge.js';
import { passingPackFor } from '../verify/evidence.js';
import { readItem, readItemEvents } from '../work-items.js';
import { requestSpawn } from '../work-signals.js';

// S9 close-out (PLAN M15.4; FL S9 9.2 "Requester acceptance", 9.3 "Close-out record", B17; FIX 4).
//
//   9.2 / G6  the acceptance the requester decides: `g6AcceptanceOf` is what the G6 card binds (the merge commit 8.2
//             observed, S8b's release output); the work driver opens G6 with exactly the requester as its decider.
//   9.3       `buildCloseOut` is a pure read of the record and the ledger: the item, its pinned catalogue, every gate it
//             opened with its ledger decision, the merged commit, each PR with its merge commit and the passing pack of
//             exactly its head, G4's mode and deciders, the release, the acceptance, the break-glass merges with their
//             X4 and the rework counters. Its id is the sha256 of its canonical JSON. `CloseOutReleasePort` records it
//             (`closeout.recorded` on `closeout:<item>` and a ledger entry in one transaction, the ledger lock before
//             the first append and the entry last) and folds it into `core.closeout`; `rebuildCloseOut` derives the
//             table again from the events. X4 is opened by the merge observers (gate-check's `gatecheck_merges`, 8.2's
//             `merge_reconcile`) for every break-glass merge, never on this chain: the record links the instance.
//   B17       `reportEscape`: an escape found after the merge of a closed-out item: ET13, recorded on the close-out
//             stream, and a NEW L0/L1 linked item (the engine takes it even after Done).

export const CLOSEOUT_ACTOR = 'system.closeout';
export const closeoutLockKey = (itemId: string): string => `closeout:${itemId}`;

export interface CloseOutDeps extends CoreDeps {
  readonly ledger: LedgerClientDeps;
}

/** The merge commit 8.2 observed for the item (`item.merge_observed`), the one shape M15.2 writes; else `null`. */
export async function mergedShaOf(db: Executor, itemId: string): Promise<string | null> {
  const ev = (await readItemEvents(db, itemId))
    .filter((e) => e.type === ITEM_EVENT.merge_observed)
    .at(-1);
  const p = ItemEventPayloads[ITEM_EVENT.merge_observed].safeParse(ev?.payload);
  const sha = p.success ? GitSha.safeParse(p.data.merged_sha) : null;
  return sha?.success ? sha.data : null;
}

/** What G6 binds: the requester, the merged commit, the release (9.2). */
export async function g6AcceptanceOf(db: Executor, s: ItemState): Promise<G6Acceptance> {
  return G6Acceptance.parse({
    requester: s.requester,
    merged_sha: await mergedShaOf(db, s.item_id),
    release_output: s.outputs['S8b'] ?? null,
  });
}

/** The approving actors of a gate instance, from the ledger. */
async function approversOf(db: Executor, gateInstanceId: string): Promise<string[]> {
  const q = await db.query<{ actor: string }>(
    `SELECT actor FROM ledger.ledger_entry
      WHERE entry_type = 'decision' AND gate_instance_id::text = $1 AND decision = 'approve' AND actor IS NOT NULL
      ORDER BY ledger_seq`,
    [gateInstanceId],
  );
  return [...new Set(q.rows.map((r) => r.actor))];
}

/** The deciding actor of a decided gate instance (its last decision entry), or `null`. */
async function deciderOf(db: Executor, gateInstanceId: string): Promise<string | null> {
  const q = await db.query<{ actor: string | null }>(
    `SELECT actor FROM ledger.ledger_entry
      WHERE entry_type = 'decision' AND gate_instance_id::text = $1 ORDER BY ledger_seq DESC LIMIT 1`,
    [gateInstanceId],
  );
  return q.rows[0]?.actor ?? null;
}

/** The X4 opened for a merge (gate-check's or 8.2's), by subject or by repo, PR and merge commit. */
async function x4Of(
  db: Executor,
  m: { repo: string; pr_number: number; head_sha: string; merge_commit_sha: string | null },
): Promise<string | null> {
  const q = await db.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = 'gate.opened' AND seq = 1 AND body ->> 'gate_id' = 'X4' AND body ->> 'subject_kind' = 'merge'
        AND (body ->> 'subject_id' = $1
             OR ($3::text IS NOT NULL AND lower(body -> 'facts' ->> 'repo') = $2
                 AND body -> 'facts' ->> 'pr_number' = $4 AND body -> 'facts' ->> 'merge_commit_sha' = $3))
      ORDER BY global_seq LIMIT 1`,
    [
      mergeSubjectId(m.repo, m.pr_number, m.head_sha),
      m.repo.toLowerCase(),
      m.merge_commit_sha,
      String(m.pr_number),
    ],
  );
  const s = q.rows[0]?.stream;
  return s === undefined ? null : s.slice('gate:'.length);
}

/** The merges of the item's PRs that did not go through the gate: gate-check's bypass and unauthorised, 8.2's. */
async function breakGlassOf(db: Executor, s: ItemState): Promise<CloseOutBreakGlass[]> {
  const out = new Map<string, CloseOutBreakGlass>();
  const q = await db.query<{ type: string; body: unknown }>(
    `SELECT type, body FROM record.record_event
      WHERE type = ANY($1::text[]) AND starts_with(stream, 'gatecheck:') AND body ->> 'item_id' = $2
      ORDER BY global_seq`,
    [[GATECHECK_EVENT.bypass_merge, GATECHECK_EVENT.unauthorised_merge], s.item_id],
  );
  for (const r of q.rows) {
    const p = MergeObservedPayload.safeParse(r.body);
    if (!p.success || (p.data.class !== 'bypass' && p.data.class !== 'unauthorised')) continue;
    const key = `${p.data.repo.toLowerCase()}#${p.data.pr_number}@${p.data.head_sha}`;
    if (out.has(key)) continue;
    out.set(key, {
      repo: p.data.repo,
      pr_number: p.data.pr_number,
      head_sha: p.data.head_sha,
      class: p.data.class,
      x4_gate_instance_id: (await x4Of(db, p.data)) as never,
    });
  }
  for (const p of await listMergeReconciled(db, s.item_id)) {
    if (p.outcome !== 'post_hoc_review') continue;
    const key = `${p.repo.toLowerCase()}#${p.pr_number}@${p.head_sha}`;
    if (out.has(key)) continue;
    out.set(key, {
      repo: p.repo,
      pr_number: p.pr_number,
      head_sha: p.head_sha,
      class: 'post_hoc_review',
      x4_gate_instance_id: (await x4Of(db, p)) as never,
    });
  }
  return [...out.values()].slice(0, 50);
}

/** The close-out record of an item as the record and the ledger say now (pure apart from the reads). */
export async function buildCloseOut(db: Executor, s: ItemState): Promise<CloseOutRecord> {
  const events = await readItemEvents(db, s.item_id);
  const entries = new Map<string, string | null>();
  for (const e of events) {
    if (e.type !== ITEM_EVENT.gate_decided) continue;
    const p = e.payload as { gate_instance_id: string; ledger_entry_id: string | null };
    entries.set(p.gate_instance_id, p.ledger_entry_id);
  }
  const gates: CloseOutGate[] = s.gates.slice(-500).map((g) => ({
    gate: g.gate,
    gate_instance_id: g.gate_instance_id as never,
    outcome: (g.status === 'decided' ? g.outcome : null) as never,
    ledger_entry_id: entries.get(g.gate_instance_id) ?? null,
  }));

  const merged = await listMergeReconciled(db, s.item_id);
  const units: CloseOutUnit[] = [];
  for (const pr of await listPullRequests(db, s.item_id)) {
    const done = merged
      .filter((m) => m.pr_number === pr.number && m.outcome === 'completed')
      .at(-1);
    const pack = await passingPackFor(db, s.item_id, pr.head_sha);
    units.push({
      unit_key: pr.unit_key as never,
      pr_number: pr.number,
      head_sha: pr.head_sha as never,
      merge_commit_sha: done?.merge_commit_sha ?? null,
      pack_sha256: pack?.pack_sha256 ?? null,
    });
  }

  const g4 = s.gates.filter((g) => g.gate === 'G4' && g.outcome === 'approve').at(-1);
  let g4Record: CloseOutRecord['g4'] = null;
  if (g4) {
    const opened = await readOpened(db, g4.gate_instance_id);
    const review = G4Review.safeParse(
      (opened?.payload.facts as Record<string, unknown> | undefined)?.[G4_REVIEW_FACT],
    );
    g4Record = {
      gate_instance_id: g4.gate_instance_id as never,
      // no review in the card (the review was not wired): unknown, never mode E
      mode: review.success ? review.data.mode : null,
      deciders: (await approversOf(db, g4.gate_instance_id)).slice(0, 16) as never,
    };
  }
  const g6 = s.gates.filter((g) => g.gate === 'G6' && g.status === 'decided').at(-1);

  return CloseOutRecord.parse({
    schema: CLOSEOUT_SCHEMA,
    item_id: s.item_id,
    project_id: s.project_id,
    repo: s.repo,
    lane: s.lane ?? s.proposed_lane,
    requester: s.requester,
    catalogue: s.catalogue_ref,
    gates,
    merged_sha: await mergedShaOf(db, s.item_id),
    units,
    g4: g4Record,
    release_output: s.outputs['S8b'] ?? null,
    acceptance: {
      outcome: g6?.outcome ?? null,
      by: g6 ? await deciderOf(db, g6.gate_instance_id) : null,
    },
    break_glass: await breakGlassOf(db, s),
    rework: { total: s.rework.total, by_edge: { ...s.rework.by_edge } },
  });
}

// ---------------------------------------------------------------- read model

export interface CloseOutRow {
  readonly item_id: string;
  readonly project_id: string;
  readonly closeout_sha256: string;
  readonly g4_mode: 'E' | 'C' | null;
  readonly record: CloseOutRecord;
  readonly event_gseq: number;
}

export async function applyCloseOutEvent(
  tx: Tx,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type !== CLOSEOUT_EVENT.recorded) return;
  const p = CloseOutRecordedPayload.parse(e.payload);
  await tx.query(
    `INSERT INTO core.closeout (item_id, project_id, closeout_sha256, g4_mode, record, recorded_at, event_gseq)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (item_id) DO NOTHING`,
    [
      p.record.item_id,
      p.record.project_id,
      p.closeout_sha256,
      p.record.g4?.mode ?? null,
      JSON.stringify(p.record),
      p.recorded_at,
      e.global_seq,
    ],
  );
}

export async function readCloseOut(db: Executor, itemId: string): Promise<CloseOutRow | null> {
  const q = await db.query<{
    item_id: string;
    project_id: string;
    closeout_sha256: string;
    g4_mode: 'E' | 'C' | null;
    record: unknown;
    event_gseq: string;
  }>(
    `SELECT item_id::text, project_id, closeout_sha256, g4_mode, record, event_gseq::text
       FROM core.closeout WHERE item_id = $1`,
    [itemId],
  );
  const r = q.rows[0];
  if (!r) return null;
  return { ...r, record: CloseOutRecord.parse(r.record), event_gseq: Number(r.event_gseq) };
}

/** Derives `core.closeout` for an item again from its `closeout:<item>` events alone. */
export async function rebuildCloseOut(d: CoreDeps, itemId: string): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [closeoutStream(itemId)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [closeoutLockKey(itemId)]);
    await tx.query('DELETE FROM core.closeout WHERE item_id = $1', [itemId]);
    let n = 0;
    for (const e of q.rows) {
      await applyCloseOutEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
      });
      if (e.type === CLOSEOUT_EVENT.recorded) n += 1;
    }
    return ok(n);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

// ---------------------------------------------------------------- 9.3

/** Records the item's close-out once (record + ledger); a second call returns the first record. */
export async function recordCloseOut(
  d: CloseOutDeps,
  itemId: string,
  commandKey: string,
): Promise<Result<CloseOutRow, CoreError>> {
  const prior = await readCloseOut(d.pool, itemId);
  if (prior) return ok(prior);
  const item = await readItem(d.pool, itemId);
  if (!item) return err(coreError('not_found', `item ${itemId}`));
  const record = await buildCloseOut(d.pool, item.state);
  const sha = closeOutId(record);
  const payload = CloseOutRecordedPayload.parse({
    command_key: commandKey,
    closeout_sha256: sha,
    record,
    recorded_at: clockOf(d).now().toISOString(),
  });
  const w = await inCoreLedgerTx(d, async (j, tx) => {
    await lockKeys(tx, [closeoutLockKey(itemId)]);
    // the ledger lock before the first record append, the entry last (AGENTS.md lock order)
    await lockLedger(tx);
    const pending: PendingConfirm[] = [];
    const caught = await importUnconfirmed(tx, d.ledger);
    if (!caught.ok) return err(coreError('unavailable', caught.error.message));
    pending.push(...caught.value.pending);
    const e = await j.emitAll(closeoutStream(itemId), [
      {
        type: CLOSEOUT_EVENT.recorded,
        body: payload as unknown as Record<string, unknown>,
        actor: CLOSEOUT_ACTOR,
        idempotency_key: `closeout:${itemId}`,
      },
    ]);
    if (!e.ok) return e;
    if (e.value.duplicate) return ok({ value: undefined, pending });
    await applyCloseOutEvent(tx, {
      type: CLOSEOUT_EVENT.recorded,
      payload,
      global_seq: Number(e.value.events[0]?.global_seq ?? 0),
    });
    const draft: LedgerEntryDraft = {
      entry_id: deterministicId<'LedgerEntry'>(`closeout.recorded:${itemId}`),
      entry_type: CLOSEOUT_LEDGER_ENTRY_TYPE,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: 'item',
      subject_id: itemId,
      subject_hash: sha as never,
      decision: null,
      actor: null,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: {
        kind: 'closeout',
        closeout_sha256: sha,
        project_id: record.project_id,
        merged_sha: record.merged_sha,
        g4_mode: record.g4?.mode ?? null,
        break_glass: record.break_glass.length,
      } as never,
      created_at: payload.recorded_at as never,
    };
    const l = await appendLedgerEntryTx(tx, d.ledger, draft);
    if (!l.ok) return err(coreError('unavailable', l.error.message));
    pending.push(...l.value.pending);
    return ok({ value: undefined, pending });
  });
  if (!w.ok) return w;
  const now = await readCloseOut(d.pool, itemId);
  return now
    ? ok(now)
    : err(coreError('database', 'the close-out was not found after it was written'));
}

export interface CloseOutPortOptions extends CloseOutDeps {
  readonly base: ReleasePort;
}

/** The release port with 9.3 recorded here; every other release step is the base port's. */
export class CloseOutReleasePort implements ReleasePort {
  readonly port = 'release' as const;

  constructor(private readonly o: CloseOutPortOptions) {}

  async run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    if (req.step !== '9.3') return this.o.base.run(req);
    const r = await recordCloseOut(this.o, req.item_id, req.command_key);
    if (!r.ok) throw new Error(`9.3: ${r.error.message}`);
    return ok({ outcome: 'completed', output_hash: r.value.closeout_sha256 as never });
  }
}

/** Stage ports whose 9.3 records the close-out. */
export function closeOutStagePorts(o: CloseOutDeps & { base: StagePorts }): StagePorts {
  const { base, ...rest } = o;
  return { ...base, release: new CloseOutReleasePort({ ...rest, base: base.release }) };
}

// ---------------------------------------------------------------- B17

/**
 * B17 "escape found post-merge: NEW L0/L1, ET13": a defect in what a closed-out item shipped. Recorded on the close-out
 * stream (ET13, who, why), then the NEW linked item through the engine (which takes B17 after Done). Only an item with
 * a close-out record: before 9.3 there is no "post-merge" to escape from (fail closed). Seeing the same key again
 * records and asks nothing new.
 */
export async function reportEscape(
  d: CoreDeps,
  r: {
    item_id: string;
    by: string;
    lane: 'L0' | 'L1';
    reason_code: string;
    key: string;
  },
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  const c = await readCloseOut(d.pool, r.item_id);
  if (!c) {
    return err(coreError('conflict', `B17: item ${r.item_id} has no close-out record (9.3)`));
  }
  const payload = EscapeReportedPayload.safeParse({
    item_id: r.item_id,
    project_id: c.project_id,
    trigger: 'ET13',
    lane: r.lane,
    by: r.by,
    reason_code: r.reason_code,
    key: r.key,
    closeout_sha256: c.closeout_sha256,
    reported_at: clockOf(d).now().toISOString(),
  });
  if (!payload.success) return err(coreError('invalid_input', payload.error.message));
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [closeoutLockKey(r.item_id)]);
    const e = await j.emitAll(closeoutStream(r.item_id), [
      {
        type: CLOSEOUT_EVENT.escape_reported,
        body: payload.data as unknown as Record<string, unknown>,
        actor: r.by,
        idempotency_key: `escape:${r.key}`,
      },
    ]);
    return e.ok ? ok(e.value.duplicate) : e;
  });
  if (!w.ok) return w;
  const s = await requestSpawn(d, r.item_id, {
    edge: 'B17',
    kind: 'escape',
    lane: r.lane,
    key: r.key,
    by: r.by,
  });
  if (!s.ok) return s;
  return ok({ duplicate: w.value });
}

/** The escapes reported against an item. */
export async function listEscapes(db: Executor, itemId: string): Promise<EscapeReportedPayload[]> {
  const q = await db.query<{ body: unknown }>(
    'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq',
    [closeoutStream(itemId), CLOSEOUT_EVENT.escape_reported],
  );
  return q.rows.map((x) => EscapeReportedPayload.parse(x.body));
}
