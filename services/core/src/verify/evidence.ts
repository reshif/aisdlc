import { buildHandoffPack, type SessionStore } from '@aisdlc/build';
import type { S7Disposition } from '@aisdlc/contracts';
import {
  D2HandoffRecord,
  EVIDENCE_BUCKET,
  EVIDENCE_EVENT,
  EVIDENCE_LEDGER_ENTRY_TYPE,
  EVIDENCE_PACK_FORMAT,
  EvidencePack,
  EvidencePackSignedPayload,
  HANDOFF_PACK_CONTENT_TYPE,
  SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
  SIGNED_EVIDENCE_PACK_FORMAT,
  d2HandoffHash,
  evidencePackId,
  evidenceStream,
  repairClassOf,
  signedEvidencePackBytes,
  type EvidenceGate,
  type LedgerEntryDraft,
  SignedEvidencePack,
  type StageOutcome,
  type VerifyCheckResult,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION } from '@aisdlc/decisions';
import {
  canonicalJson,
  deterministicId,
  err,
  hashCanonical,
  ok,
  sha256Hex,
  type Clock,
  type Result,
} from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import type { EvidenceSignerPort, ObjectStorePort } from '@aisdlc/ports';
import type { Executor, Tx } from '@aisdlc/record';
import { evidenceSteps, isFailing, outcomeOf76, type RaisedGate } from '@aisdlc/verify';
import type { ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { listPushReceipts } from '../build/push.js';
import { coreError } from '../errors.js';
import { clockOf, inCoreLedgerTx, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import type { SubjectFields } from './subject.js';

// 7.6 Evidence Pack assembly (PLAN M14.4; FL S7 "7.6 Pack assembly + sign", D2 "Handoff Pack + Evidence Pack"):
//
//   1. the pack is built from core's record only: the latest result of each step for EXACTLY the head (by hash, with
//      its verdict and the failing findings classed), the Unit, the base and head, the item's lane, tier, gating profile
//      (by hash) and pinned catalogue, every gate the item raised with its ledger decisions, the Push Broker's receipt
//      for the head, the oracle locks; its id is the sha256 of its canonical JSON;
//   2. the Notary signs that id (its `evidence` purpose: a domain-separated message, journalled by the Notary);
//   3. the signed pack goes to the object store's write-once bucket under the sha256 of its bytes; for a D2 the Handoff
//      Pack (A11, from the S6 session) goes beside it;
//   4. `evidence.pack_signed` is recorded with the pack id, the head, the object keys and the disposition, as a record
//      event AND a ledger entry in one transaction (the ledger lock before the first append, the entry last), and folded
//      into `core.evidence_pack`, which `rebuildEvidencePacks` derives again from the events alone.
//
// Every disposition gets a pack: a passing one (the only kind gate-check accepts) and, marked not passing, the pack of a
// B9 or B11 round and of a D2. A retry of the same command finds its row and does nothing again; a crash after the
// Notary signed or the store kept the bytes and before the record leaves an orphan signature or object (harmless: the
// record never names it), and the retry signs and stores the pack it then builds.

export const EVIDENCE_ACTOR = 'system.verify';
export const evidenceLockKey = (itemId: string): string => `evidence:${itemId}`;

export interface CoreEvidenceDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  readonly ledger: LedgerClientDeps;
  /** The Notary's evidence purpose. */
  readonly signer: EvidenceSignerPort;
  readonly objects: ObjectStorePort;
  /** S6's session store: where a D2's Handoff Pack is built from (absent: the D2 carries none, said so in the record). */
  readonly store?: SessionStore;
}

// ---------------------------------------------------------------- read model

interface EvidenceRow {
  pack_sha256: string;
  command_key: string;
  item_id: string;
  unit_key: string;
  base_sha: string;
  head_sha: string;
  passing: boolean;
  detail: unknown;
  bucket: string;
  object_key: string;
  key_id: string;
  handoff_pack_sha256: string | null;
  handoff_object_key: string | null;
  produced_at: Date;
}

const COLUMNS = `pack_sha256, command_key, item_id, unit_key, base_sha, head_sha, passing, detail, bucket, object_key,
  key_id, handoff_pack_sha256, handoff_object_key, produced_at`;

const payloadOf = (r: EvidenceRow): EvidencePackSignedPayload =>
  EvidencePackSignedPayload.parse({
    command_key: r.command_key,
    item_id: r.item_id,
    unit_key: r.unit_key,
    base_sha: r.base_sha,
    head_sha: r.head_sha,
    pack_sha256: r.pack_sha256,
    bucket: r.bucket,
    object_key: r.object_key,
    disposition: r.detail,
    passing: r.passing,
    key_id: r.key_id,
    handoff_pack_sha256: r.handoff_pack_sha256,
    handoff_object_key: r.handoff_object_key,
    produced_at: r.produced_at.toISOString(),
  });

/** The pack a command already produced, or `null`. */
export async function evidenceByCommand(
  db: Executor,
  commandKey: string,
): Promise<EvidencePackSignedPayload | null> {
  const q = await db.query<EvidenceRow>(
    `SELECT ${COLUMNS} FROM core.evidence_pack WHERE command_key = $1`,
    [commandKey],
  );
  const r = q.rows[0];
  return r ? payloadOf(r) : null;
}

/** Every pack of an item, in the order they were recorded. */
export async function listEvidencePacks(
  db: Executor,
  itemId: string,
): Promise<EvidencePackSignedPayload[]> {
  const q = await db.query<EvidenceRow>(
    `SELECT ${COLUMNS} FROM core.evidence_pack WHERE item_id = $1 ORDER BY event_gseq`,
    [itemId],
  );
  return q.rows.map(payloadOf);
}

/** The passing pack of exactly this head, or `null` (what gate-check asks, M14.5). */
export async function passingPackFor(
  db: Executor,
  itemId: string,
  headSha: string,
): Promise<EvidencePackSignedPayload | null> {
  const q = await db.query<EvidenceRow>(
    `SELECT ${COLUMNS} FROM core.evidence_pack WHERE item_id = $1 AND head_sha = $2 AND passing
      ORDER BY event_gseq DESC LIMIT 1`,
    [itemId, headSha],
  );
  const r = q.rows[0];
  return r ? payloadOf(r) : null;
}

export async function applyEvidenceEvent(
  tx: Tx,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type !== EVIDENCE_EVENT.pack_signed) return;
  const p = EvidencePackSignedPayload.parse(e.payload);
  await tx.query(
    `INSERT INTO core.evidence_pack
       (pack_sha256, command_key, item_id, unit_key, base_sha, head_sha, disposition, passing, detail, bucket,
        object_key, key_id, handoff_pack_sha256, handoff_object_key, produced_at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
     ON CONFLICT (pack_sha256) DO NOTHING`,
    [
      p.pack_sha256,
      p.command_key,
      p.item_id,
      p.unit_key,
      p.base_sha,
      p.head_sha,
      p.disposition.kind,
      p.passing,
      JSON.stringify(p.disposition),
      p.bucket,
      p.object_key,
      p.key_id,
      p.handoff_pack_sha256,
      p.handoff_object_key,
      p.produced_at,
      e.global_seq,
    ],
  );
}

/** Rebuilds an item's `core.evidence_pack` rows from its `evidence:` events alone. Returns how many. */
export async function rebuildEvidencePacks(d: CoreDeps, itemId: string): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [evidenceStream(itemId)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [evidenceLockKey(itemId)]);
    await tx.query('DELETE FROM core.evidence_pack WHERE item_id = $1', [itemId]);
    let n = 0;
    for (const e of q.rows) {
      await applyEvidenceEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
      });
      if (e.type === EVIDENCE_EVENT.pack_signed) n += 1;
    }
    return ok(n);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

/** The D2 record a handoff binds (both packs by hash), from what was recorded. */
export function d2RecordOf(p: EvidencePackSignedPayload): D2HandoffRecord | null {
  if (p.disposition.kind !== 'handoff') return null;
  return D2HandoffRecord.parse({
    schema: 'd2-handoff/1',
    item_id: p.item_id,
    trigger: p.disposition.trigger,
    reason_code: p.disposition.reason_code,
    evidence_pack_sha256: p.pack_sha256,
    handoff_pack_sha256: p.handoff_pack_sha256,
  });
}

/** The stage outcome a recorded pack stands for (a retry of its command answers exactly this). */
export function outcomeOfRecorded(p: EvidencePackSignedPayload): StageOutcome {
  const d2 = d2RecordOf(p);
  return outcomeOf76(p.disposition, p.pack_sha256, d2 ? d2HandoffHash(d2) : null);
}

// ---------------------------------------------------------------- assembly

export interface ProduceInput {
  readonly command_key: string;
  readonly item: ItemState;
  readonly subject: SubjectFields;
  /** The results for exactly `subject.head_sha`, in record order. */
  readonly results: readonly VerifyCheckResult[];
  readonly approved: (gate: RaisedGate, step: string) => boolean;
  readonly disposition: S7Disposition;
}

const portErr = (m: string) => err(m.slice(0, 300));

export class CoreEvidence {
  private declared = false;

  constructor(private readonly d: CoreEvidenceDeps) {}

  /** The gates the item raised, each with the ledger decisions on its instance. */
  private async gates(s: ItemState): Promise<EvidenceGate[]> {
    const gates = s.gates.slice(-100);
    const ids = gates.map((g) => g.gate_instance_id);
    const q = await this.d.pool.query<{
      gate_instance_id: string;
      entry_id: string;
      ledger_seq: string;
      entry_hash: string;
      decision: string | null;
    }>(
      `SELECT gate_instance_id::text AS gate_instance_id, entry_id::text AS entry_id, ledger_seq::text AS ledger_seq,
              entry_hash, decision
         FROM ledger.ledger_entry
        WHERE entry_type = 'decision' AND gate_instance_id::text = ANY($1::text[])
        ORDER BY ledger_seq`,
      [ids],
    );
    return gates.map((g) => ({
      gate: g.gate,
      gate_instance_id: g.gate_instance_id,
      station: g.station.slice(0, 64),
      status: g.status,
      outcome: g.outcome,
      decisions: q.rows
        .filter((r) => r.gate_instance_id === g.gate_instance_id)
        .slice(-20)
        .map((r) => ({
          entry_id: r.entry_id,
          ledger_seq: Number(r.ledger_seq),
          entry_hash: r.entry_hash,
          decision: r.decision ?? 'none',
        })),
    }));
  }

  /** The pack, from the record (pure apart from the reads). */
  async buildPack(o: ProduceInput): Promise<EvidencePack> {
    const s = o.item;
    const head = o.subject.head_sha;
    const receipt = (await listPushReceipts(this.d.pool, s.item_id))
      .filter(
        (r) =>
          r.unit_key === o.subject.unit_key &&
          r.status === 'applied' &&
          r.head_sha === head &&
          r.pr_number !== null,
      )
      .at(-1);
    const steps = evidenceSteps(o.results, o.approved);
    return EvidencePack.parse({
      format: EVIDENCE_PACK_FORMAT,
      item_id: s.item_id,
      project_id: s.project_id,
      repo: s.repo,
      lane: s.lane ?? s.proposed_lane,
      tier: s.tier,
      profile_sha256: hashCanonical(s.profile as never),
      catalogue_ref: s.catalogue_ref,
      units: [{ unit_key: o.subject.unit_key }],
      base_sha: o.subject.base_sha,
      head_sha: head,
      disposition: o.disposition,
      passing: o.disposition.kind === 'passed',
      steps,
      gates: await this.gates(s),
      push_receipt: receipt
        ? {
            receipt_id: receipt.receipt_id,
            patch_hash: receipt.patch_hash,
            head_sha: head,
            pr_number: receipt.pr_number,
          }
        : null,
      oracle_locks: o.subject.locks,
      produced_at: clockOf(this.d).now().toISOString(),
    });
  }

  private async bucket(): Promise<Result<void, string>> {
    if (this.declared) return ok(undefined);
    const b = await this.d.objects.declareBucket(EVIDENCE_BUCKET, 'write_once');
    if (!b.ok) return portErr(`the evidence bucket: ${b.error.message}`);
    this.declared = true;
    return ok(undefined);
  }

  /** A D2's Handoff Pack (A11) from the S6 session, stored beside the Evidence Pack; `null` without a session. */
  private async handoffPack(
    o: ProduceInput,
  ): Promise<Result<{ sha256: string; object_key: string } | null, string>> {
    const d = o.disposition;
    if (d.kind !== 'handoff' || !this.d.store) return ok(null);
    const store = this.d.store;
    const session = store.load(o.item.item_id);
    if (session === null || session.unit_key !== o.subject.unit_key) return ok(null);
    const failing = o.results.flatMap((r) =>
      r.findings
        .filter(isFailing)
        .map(
          (f) => `${r.step} ${f.kind} (${repairClassOf(f, r.step)})${f.path ? ` ${f.path}` : ''}`,
        ),
    );
    const pack = buildHandoffPack(
      session,
      store.getTree(session.base_tree_sha256),
      store.getTree(session.tree_sha256),
      { trigger: d.trigger, reason_code: d.reason_code, failing: failing.slice(0, 200) },
    );
    const sha = store.putRecord('handoff-pack', pack);
    const put = await this.d.objects.put(
      EVIDENCE_BUCKET,
      new TextEncoder().encode(canonicalJson(pack as never)),
      { contentType: HANDOFF_PACK_CONTENT_TYPE },
    );
    if (!put.ok) return portErr(`the handoff pack: ${put.error.message}`);
    return ok({ sha256: sha, object_key: put.value.sha256 });
  }

  /**
   * Builds, signs, stores and records the pack of one command; answers what was recorded for it (also on a retry).
   * An error is a refusal: nothing passes without its pack signed, stored and recorded.
   */
  async produce(o: ProduceInput): Promise<Result<EvidencePackSignedPayload, string>> {
    const have = await evidenceByCommand(this.d.pool, o.command_key);
    if (have) return ok(have);
    const b = await this.bucket();
    if (!b.ok) return b;
    const pack = await this.buildPack(o);
    const pack_sha256 = evidencePackId(pack);
    const sig = await this.d.signer.signEvidencePack({
      pack_sha256,
      item_id: pack.item_id,
      head_sha: pack.head_sha,
    });
    if (!sig.ok) return portErr(`the notary: ${sig.error.code}: ${sig.error.message}`);
    const signed: SignedEvidencePack = {
      format: SIGNED_EVIDENCE_PACK_FORMAT,
      pack_sha256,
      pack,
      signature: sig.value,
    };
    const bytes = signedEvidencePackBytes(signed);
    const put = await this.d.objects.put(EVIDENCE_BUCKET, bytes, {
      contentType: SIGNED_EVIDENCE_PACK_CONTENT_TYPE,
    });
    if (!put.ok) return portErr(`the object store: ${put.error.code}: ${put.error.message}`);
    if (put.value.sha256 !== sha256Hex(bytes))
      return portErr('the object store keyed the pack wrongly');
    const hp = await this.handoffPack(o);
    if (!hp.ok) return hp;
    const payload = EvidencePackSignedPayload.parse({
      command_key: o.command_key,
      item_id: pack.item_id,
      unit_key: o.subject.unit_key,
      base_sha: pack.base_sha,
      head_sha: pack.head_sha,
      pack_sha256,
      bucket: EVIDENCE_BUCKET,
      object_key: put.value.sha256,
      disposition: pack.disposition,
      passing: pack.passing,
      key_id: sig.value.key_id,
      handoff_pack_sha256: hp.value?.sha256 ?? null,
      handoff_object_key: hp.value?.object_key ?? null,
      produced_at: pack.produced_at,
    });
    const rec = await this.record(payload);
    if (!rec.ok) return portErr(rec.error.message);
    const now = await evidenceByCommand(this.d.pool, o.command_key);
    return now ? ok(now) : portErr('the evidence record was not found after it was written');
  }

  /** The event, its fold and the ledger entry, in one transaction (the ledger entry last). */
  private record(p: EvidencePackSignedPayload) {
    return inCoreLedgerTx(this.d, async (j, tx) => {
      await lockKeys(tx, [evidenceLockKey(p.item_id)]);
      // the ledger lock before the first record append, the entry last (AGENTS.md lock order)
      await lockLedger(tx);
      const pending: PendingConfirm[] = [];
      const caught = await importUnconfirmed(tx, this.d.ledger);
      if (!caught.ok) return err(coreError('unavailable', caught.error.message));
      pending.push(...caught.value.pending);
      const w = await j.emitAll(evidenceStream(p.item_id), [
        {
          type: EVIDENCE_EVENT.pack_signed,
          body: p as unknown as Record<string, unknown>,
          actor: EVIDENCE_ACTOR,
          idempotency_key: `evidence:${p.command_key}`,
        },
      ]);
      if (!w.ok) return w;
      if (w.value.duplicate) return ok({ value: undefined, pending });
      const ev = w.value.events[0];
      await applyEvidenceEvent(tx, {
        type: EVIDENCE_EVENT.pack_signed,
        payload: p,
        global_seq: Number(ev?.global_seq ?? 0),
      });
      const draft: LedgerEntryDraft = {
        entry_id: deterministicId<'LedgerEntry'>(`evidence.pack_signed:${p.pack_sha256}`),
        entry_type: EVIDENCE_LEDGER_ENTRY_TYPE,
        gate_instance_id: null,
        gate_id: null,
        subject_kind: 'item',
        subject_id: p.item_id,
        subject_hash: p.pack_sha256 as never,
        decision: null,
        actor: null,
        sod_waiver: false,
        policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
        body: { kind: 'evidence_pack', ...p } as never,
        created_at: p.produced_at as never,
      };
      const l = await appendLedgerEntryTx(tx, this.d.ledger, draft);
      if (!l.ok) return err(coreError('unavailable', l.error.message));
      pending.push(...l.value.pending);
      return ok({ value: undefined, pending });
    });
  }
}

/** Reads a signed pack back from the object store and checks it is the one recorded (the bytes, then the id). */
export async function readSignedPack(
  objects: ObjectStorePort,
  p: Pick<EvidencePackSignedPayload, 'bucket' | 'object_key' | 'pack_sha256'>,
): Promise<Result<{ bytes: Uint8Array; signed: SignedEvidencePack }, string>> {
  const g = await objects.get(p.bucket, p.object_key);
  if (!g.ok) return err(`${g.error.code}: ${g.error.message}`);
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(g.value));
  } catch {
    return err('the stored object is not JSON');
  }
  const parsed = SignedEvidencePack.safeParse(raw);
  if (!parsed.success) return err('the stored object is not a signed evidence pack');
  if (parsed.data.pack_sha256 !== p.pack_sha256) return err('the stored pack is another pack');
  return ok({ bytes: g.value, signed: parsed.data });
}
