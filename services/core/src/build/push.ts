import {
  PUSH_EVENT,
  PUSH_LEDGER_ENTRY_TYPE,
  PushIntendedPayload,
  PushReceipt,
  PushRefusalCode,
  PushLeaseFacts,
  patchHashOf,
  pushStream,
  unitBranchOf,
  type LedgerEntryDraft,
  type UnitState,
} from '@aisdlc/contracts';
import { PushPortError, type PushPort, type PushRequest, type PushResult } from '@aisdlc/build';
import { DEFAULT_POLICY_BUNDLE_VERSION, readGateState } from '@aisdlc/decisions';
import { deterministicId, err, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { readOk, readUnknown, type CodeHostPort, type PushGuardsPort } from '@aisdlc/ports';
import type { Executor, Tx } from '@aisdlc/record';
import type pg from 'pg';
import { recordUnitProgress } from '../admission/admit.js';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreLedgerTx, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { readItem } from '../work-items.js';

// What core does for the Push Broker (PLAN M13.6; DM §3.6 PushReceipt, PullRequest; DEC-12(a) record-first):
//
//   - it ANSWERS the broker's two questions (`CorePushGuards`): is the Unit's lease held, at which epoch, in which lane,
//     and is an approved X2 decision in the ledger bound to this item and exactly this patch hash. Both come from core's
//     own authority (the lease epoch is the Unit's, the decision is a fold of ledger rows: `readGateState`), never from the
//     caller's word.
//   - it RECORDS what the broker does (`CorePush`): `push.intended` BEFORE the broker is asked, then the receipt as a record
//     event AND a ledger entry (`push.receipt`) in one transaction (the ledger lock before the first append, the entry
//     last), then the Unit moves to Pushed with the head SHA (checked against the lease epoch the writer held). A refusal
//     is recorded as a receipt too. The tables `core.push_receipt` and `core.pull_request` are folds of these events and are
//     rebuilt from them (`rebuildPushes`).

export const PUSH_ACTOR = 'system.push';
export const pushLockKey = (itemId: string): string => `push:${itemId}`;

// ---------------------------------------------------------------- Guards

/** The Unit's lease and the item's lane, from core's own rows. An unknown Unit is "no lease". */
export async function unitLeaseFacts(
  db: Pick<pg.Pool, 'query'>,
  itemId: string,
  unitKey: string,
  laneOf: () => Promise<string>,
): Promise<PushLeaseFacts> {
  const q = await db.query<{ epoch: number; status: string }>(
    `SELECT l.epoch, l.status FROM core.lease l JOIN core.unit u USING (unit_id)
      WHERE u.item_id = $1 AND u.unit_key = $2`,
    [itemId, unitKey],
  );
  const lane = await laneOf();
  const l = q.rows[0];
  return PushLeaseFacts.parse({ held: l?.status === 'held', epoch: l?.epoch ?? 0, lane });
}

/**
 * Is there an APPROVED X2 decision bound to exactly this patch? The X2 gate at 6.6 carries the patch as its artefact (its
 * sha256 IS the patch hash) in the facts the gate opened with, and those facts are in the gate's subject hash, so a
 * decision on the gate is a decision on that patch. Read the way every gate status is read: the instance's decisions from
 * the LEDGER, folded (`readGateState`), never a projection. A rejected, expired, superseded or still-pending gate is not
 * an approval; a decision of ANOTHER item or of another patch (another hash) does not count.
 */
export async function x2BoundToPatch(
  db: Executor,
  itemId: string,
  patchHash: string,
): Promise<boolean> {
  const q = await db.query<{ gate_instance_id: string }>(
    `SELECT DISTINCT gate_instance_id FROM ledger.ledger_entry
      WHERE entry_type = 'decision' AND gate_id = 'X2' AND subject_kind = 'item'
        AND subject_id = $1 AND decision = 'approve' AND gate_instance_id IS NOT NULL`,
    [itemId],
  );
  for (const row of q.rows) {
    const g = await readGateState(db, row.gate_instance_id);
    if (!g || g.status !== 'decided' || g.outcome !== 'approve') continue;
    if (g.open.payload.subject_id !== itemId || g.open.payload.gate_id !== 'X2') continue;
    const facts = g.open.payload.facts as { artefacts?: unknown };
    const arts = Array.isArray(facts.artefacts) ? facts.artefacts : [];
    if (
      arts.some(
        (a) =>
          typeof a === 'object' &&
          a !== null &&
          (a as { step?: unknown }).step === '6.6' &&
          (a as { sha256?: unknown }).sha256 === patchHash,
      )
    ) {
      return true;
    }
  }
  return false;
}

export class CorePushGuards implements PushGuardsPort {
  /** `laneOf` replaces the item's lane (for a test of the spike guard: the catalogue lets no L7 item into S6 today). */
  constructor(
    private readonly pool: pg.Pool,
    private readonly laneOf?: (itemId: string) => Promise<string>,
  ) {}

  private async lane(itemId: string): Promise<string> {
    if (this.laneOf) return this.laneOf(itemId);
    const item = await readItem(this.pool, itemId);
    // an item core does not know has no lane to push from: a spike's lane is the one that matters, so unknown is refused below
    return item ? (item.state.lane ?? item.state.proposed_lane) : 'L7';
  }

  async lease(item_id: string, unit_key: string) {
    try {
      return readOk(await unitLeaseFacts(this.pool, item_id, unit_key, () => this.lane(item_id)));
    } catch {
      return readUnknown('server_error', 'the lease could not be read');
    }
  }

  async x2Bound(item_id: string, patch_hash: string) {
    try {
      return readOk(await x2BoundToPatch(this.pool, item_id, patch_hash));
    } catch {
      return readUnknown('server_error', 'the X2 decisions could not be read');
    }
  }
}

// ---------------------------------------------------------------- Read models

export async function listPushReceipts(db: Executor, itemId: string): Promise<PushReceipt[]> {
  const q = await db.query<Record<string, unknown>>(
    `SELECT receipt_id, item_id, unit_key, repo, branch, lease_epoch, patch_hash, status, code, base_sha, head_sha,
            pr_number, files, at FROM core.push_receipt WHERE item_id = $1 ORDER BY event_gseq`,
    [itemId],
  );
  return q.rows.map((r) => PushReceipt.parse({ ...r, at: (r['at'] as Date).toISOString() }));
}

export async function listPullRequests(db: Executor, itemId: string) {
  const q = await db.query<{
    repo: string;
    number: number;
    item_id: string;
    unit_key: string;
    head_ref: string;
    head_sha: string;
    state: string;
    draft: boolean;
  }>(
    'SELECT repo, number, item_id, unit_key, head_ref, head_sha, state, draft FROM core.pull_request WHERE item_id = $1 ORDER BY number',
    [itemId],
  );
  return q.rows.map((r) => ({ ...r, pr_ref: `pr:${r.number}` }));
}

interface FoldedPush {
  readonly type: string;
  readonly payload: unknown;
  readonly global_seq: number;
}

/** Folds one push event into the rows. Idempotent (an upsert by key). */
export async function applyPushEvent(tx: Tx, e: FoldedPush): Promise<void> {
  if (e.type !== PUSH_EVENT.receipt_recorded) return;
  const r = PushReceipt.parse(e.payload);
  await tx.query(
    `INSERT INTO core.push_receipt
       (receipt_id, item_id, unit_key, repo, branch, lease_epoch, patch_hash, status, code, base_sha, head_sha,
        pr_number, files, at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
     ON CONFLICT (receipt_id) DO NOTHING`,
    [
      r.receipt_id,
      r.item_id,
      r.unit_key,
      r.repo,
      r.branch,
      r.lease_epoch,
      r.patch_hash,
      r.status,
      r.code,
      r.base_sha,
      r.head_sha,
      r.pr_number,
      r.files,
      r.at,
      e.global_seq,
    ],
  );
  if (r.status === 'applied' && r.head_sha !== null && r.pr_number !== null) {
    await tx.query(
      `INSERT INTO core.pull_request (repo, number, item_id, unit_key, head_ref, head_sha, state, draft)
       VALUES ($1,$2,$3,$4,$5,$6,'open',true)
       ON CONFLICT (repo, number) DO UPDATE SET head_sha = EXCLUDED.head_sha`,
      [r.repo, r.pr_number, r.item_id, r.unit_key, r.branch, r.head_sha],
    );
  }
}

/** Rebuilds an item's receipts and pull requests from its push events alone. Returns how many receipts. */
export async function rebuildPushes(d: CoreDeps, itemId: string): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [pushStream(itemId)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [pushLockKey(itemId)]);
    await tx.query('DELETE FROM core.push_receipt WHERE item_id = $1', [itemId]);
    await tx.query('DELETE FROM core.pull_request WHERE item_id = $1', [itemId]);
    let n = 0;
    for (const e of q.rows) {
      await applyPushEvent(tx, { type: e.type, payload: e.body, global_seq: Number(e.global_seq) });
      if (e.type === PUSH_EVENT.receipt_recorded) n += 1;
    }
    return ok(n);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

// ---------------------------------------------------------------- The recorder and client

export const receiptIdOf = (
  itemId: string,
  unitKey: string,
  patchHash: string,
  epoch: number,
  status: string,
  code: string | null,
): string =>
  `rcpt-${sha256Hex(`${itemId}|${unitKey}|${patchHash}|${epoch}|${status}|${code ?? ''}`).slice(0, 32)}`;

const STATUS_OF: Record<string, PushReceipt['status']> = {
  stale_epoch: 'refused_stale_epoch',
  no_lease: 'no_lease',
};

export interface CorePushDeps extends CoreDeps {
  readonly ledger: NonNullable<CoreDeps['ledger']>;
  /** Replaces the item's lane (tests only; see `CorePushGuards`). */
  readonly laneOf?: (itemId: string) => Promise<string>;
}

/**
 * The `PushPort` of core: `broker` is the code host's Push Broker (`HttpCodeHostPush` in a deployment; the REST adapter or
 * the fake in tests); every check that matters is its own (it asks `CorePushGuards`, or the HTTP route in front of it,
 * not this class).
 */
export class CorePush implements PushPort {
  constructor(
    private readonly d: CorePushDeps,
    private readonly broker: Pick<CodeHostPort, 'apply_patch'>,
  ) {}

  private async lane(itemId: string): Promise<string> {
    if (this.d.laneOf) return this.d.laneOf(itemId);
    const item = await readItem(this.d.pool, itemId);
    return item ? (item.state.lane ?? item.state.proposed_lane) : 'L7';
  }

  async push(req: PushRequest): Promise<Result<PushResult, PushPortError>> {
    try {
      return ok(await this.run(req));
    } catch (e) {
      return err(PushPortError({ message: (e as Error).message.slice(0, 300) }));
    }
  }

  private async run(req: PushRequest): Promise<PushResult> {
    const branch = unitBranchOf(req.item_id, req.unit_key);
    const patch_hash = patchHashOf(req.patch);
    const receipts = await listPushReceipts(this.d.pool, req.item_id);
    const mine = receipts.filter((r) => r.unit_key === req.unit_key && r.status === 'applied');

    // a redelivery after the push was recorded: the receipt is the answer (and the Unit is moved, idempotently)
    const prior = mine.find(
      (r) => r.patch_hash === patch_hash && r.lease_epoch === req.lease_epoch,
    );
    if (prior && prior.head_sha !== null && prior.pr_number !== null) {
      await this.moveToPushed(req, prior.head_sha, prior.pr_number, prior.receipt_id);
      return {
        kind: 'pushed',
        head_sha: prior.head_sha,
        branch,
        pr_number: prior.pr_number,
        patch_hash,
        receipt_id: prior.receipt_id,
      };
    }

    // record first (DEC-12(a)): what is about to be asked of the code host is in the record before it is asked
    const intent = PushIntendedPayload.parse({
      item_id: req.item_id,
      unit_key: req.unit_key,
      repo: req.repo,
      branch,
      lease_epoch: req.lease_epoch,
      base_sha: req.base_sha,
      patch_hash,
      files: req.patch.files.length,
      command_key: req.command_key,
    });
    const w = await this.recordIntent(intent);
    if (!w.ok) throw new Error(w.error.message);

    const expected_head = mine.at(-1)?.head_sha ?? null;
    // core's own word for the lane (the request's is untrusted): a spike never reaches the broker
    const lane = await this.lane(req.item_id);
    if (lane === 'L7' || req.lane === 'L7') {
      return this.refuse(
        req,
        branch,
        patch_hash,
        'spike_lane',
        'a spike never reaches the Push Broker',
      );
    }
    const r = await this.broker.apply_patch({
      repo: req.repo,
      item_id: req.item_id,
      unit_key: req.unit_key,
      lane,
      lease_epoch: req.lease_epoch,
      branch,
      base_sha: req.base_sha,
      expected_head,
      patch: req.patch,
      message: req.message,
      evidence: req.evidence,
    } as never);
    if (r.state === 'ok') {
      const a = r.value;
      const receipt = PushReceipt.parse({
        receipt_id: receiptIdOf(
          req.item_id,
          req.unit_key,
          patch_hash,
          req.lease_epoch,
          'applied',
          null,
        ),
        item_id: req.item_id,
        unit_key: req.unit_key,
        repo: req.repo,
        branch,
        lease_epoch: req.lease_epoch,
        patch_hash,
        status: 'applied',
        code: null,
        base_sha: req.base_sha,
        head_sha: a.commit_sha,
        pr_number: a.pr.number,
        files: req.patch.files.length,
        at: clockOf(this.d).now().toISOString(),
      });
      const rec = await this.recordReceipt(receipt);
      if (!rec.ok) throw new Error(rec.error.message);
      await this.moveToPushed(req, a.commit_sha, a.pr.number, receipt.receipt_id);
      return {
        kind: 'pushed',
        head_sha: a.commit_sha,
        branch,
        pr_number: a.pr.number,
        patch_hash,
        receipt_id: receipt.receipt_id,
      };
    }
    const code = r.code ? PushRefusalCode.safeParse(r.code) : null;
    if (code?.success) return this.refuse(req, branch, patch_hash, code.data, r.message);
    if (r.state === 'unreadable' && r.reason === 'repo_not_allowed') {
      return this.refuse(req, branch, patch_hash, 'repo_not_allowed', r.message);
    }
    // no verdict (unreachable, unauthenticated, garbled): unknown whether it ran. Delivered again; the intent stays.
    throw new Error(`the Push Broker gave no verdict (${r.state}/${r.reason})`);
  }

  private async refuse(
    req: PushRequest,
    branch: string,
    patch_hash: string,
    code: PushRefusalCode,
    message: string,
  ): Promise<PushResult> {
    const status = STATUS_OF[code] ?? 'refused';
    const receipt = PushReceipt.parse({
      receipt_id: receiptIdOf(req.item_id, req.unit_key, patch_hash, req.lease_epoch, status, code),
      item_id: req.item_id,
      unit_key: req.unit_key,
      repo: req.repo,
      branch,
      lease_epoch: req.lease_epoch,
      patch_hash,
      status,
      code,
      base_sha: req.base_sha,
      head_sha: null,
      pr_number: null,
      files: req.patch.files.length,
      at: clockOf(this.d).now().toISOString(),
    });
    const rec = await this.recordReceipt(receipt);
    if (!rec.ok) throw new Error(rec.error.message);
    return { kind: 'refused', code, message: message.slice(0, 300), patch_hash };
  }

  private recordIntent(p: PushIntendedPayload): Promise<Result<void, CoreError>> {
    return inCoreLedgerTx(this.d, async (j, tx) => {
      await lockKeys(tx, [pushLockKey(p.item_id)]);
      const w = await j.emitAll(pushStream(p.item_id), [
        {
          type: PUSH_EVENT.intended,
          body: p as unknown as Record<string, unknown>,
          actor: PUSH_ACTOR,
          idempotency_key: `push:intent:${p.command_key}`,
        },
      ]);
      return w.ok ? ok({ value: undefined, pending: [] as PendingConfirm[] }) : w;
    });
  }

  /** The receipt: a record event, its fold, and the ledger entry, in one transaction (the ledger entry last). */
  private recordReceipt(r: PushReceipt): Promise<Result<void, CoreError>> {
    return inCoreLedgerTx(this.d, async (j, tx) => {
      await lockKeys(tx, [pushLockKey(r.item_id)]);
      // the ledger lock before the first record append, the entry last (AGENTS.md lock order)
      await lockLedger(tx);
      const pending: PendingConfirm[] = [];
      const caught = await importUnconfirmed(tx, this.d.ledger);
      if (!caught.ok) return err(coreError('unavailable', caught.error.message));
      pending.push(...caught.value.pending);
      const w = await j.emitAll(pushStream(r.item_id), [
        {
          type: PUSH_EVENT.receipt_recorded,
          body: r as unknown as Record<string, unknown>,
          actor: PUSH_ACTOR,
          idempotency_key: `push:receipt:${r.receipt_id}`,
        },
      ]);
      if (!w.ok) return w;
      if (w.value.duplicate) return ok({ value: undefined, pending });
      const ev = w.value.events[0];
      await applyPushEvent(tx, {
        type: PUSH_EVENT.receipt_recorded,
        payload: r,
        global_seq: Number(ev?.global_seq ?? 0),
      });
      const draft: LedgerEntryDraft = {
        entry_id: deterministicId<'LedgerEntry'>(`push.receipt:${r.receipt_id}`),
        entry_type: PUSH_LEDGER_ENTRY_TYPE,
        gate_instance_id: null,
        gate_id: null,
        subject_kind: 'item',
        subject_id: r.item_id,
        subject_hash: r.patch_hash as never,
        decision: null,
        actor: null,
        sod_waiver: false,
        policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
        body: { kind: 'push_receipt', ...r } as never,
        created_at: r.at as never,
      };
      const l = await appendLedgerEntryTx(tx, this.d.ledger, draft);
      if (!l.ok) return err(coreError('unavailable', l.error.message));
      pending.push(...l.value.pending);
      return ok({ value: undefined, pending });
    });
  }

  /** The Unit is Pushed, with the head: through Building if the session had not been recorded, and again through it on a re-push. */
  private async moveToPushed(
    req: PushRequest,
    head_sha: string,
    pr_number: number,
    receipt_id: string,
  ): Promise<void> {
    const unit_id = `${req.item_id}:${req.unit_key}`;
    const cur = await this.d.pool.query<{ state: UnitState }>(
      'SELECT state FROM core.unit WHERE unit_id = $1',
      [unit_id],
    );
    const from = cur.rows[0]?.state;
    if (from === undefined) throw new Error(`no Unit ${unit_id}`);
    const step = async (to: UnitState, reason: string, extra: object = {}) => {
      const r = await recordUnitProgress(this.d, {
        item_id: req.item_id,
        unit_id,
        lease_epoch: req.lease_epoch,
        to,
        reason,
        key: `${receipt_id}:${to}`,
        ...extra,
      });
      if (!r.ok) throw new Error(r.error.message);
    };
    if (from === 'Admitted' || from === 'Verifying' || from === 'InReview') {
      await step('Building', 'push_started');
    }
    await step('Pushed', 'pushed', { head_sha, pr_ref: `pr:${pr_number}` });
  }
}
