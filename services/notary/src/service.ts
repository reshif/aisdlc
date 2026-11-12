import {
  LEDGER_SIGNATURE_ALG,
  LedgerEntry,
  LedgerEntryDraft,
  checkLedgerEntrySignature,
  checkpointDigestHex,
  Signature,
  computeLedgerEntryHash,
  evidencePackSigningDigest,
  ledgerDraftHash,
  type CheckpointCore,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import {
  b64urlEncode,
  err,
  merkleRoot,
  ok,
  systemClock,
  type Clock,
  type Jwk,
  type Result,
} from '@aisdlc/kernel';
import {
  assembleLedgerEntry,
  badEvidenceSignRequest,
  hexBytes,
  notaryError,
  type CheckpointSignRequest,
  type EvidenceSignRequest,
  type EvidenceSignerPort,
  type NotaryError,
  type NotaryPort,
  type ReserveRequest,
  type SignRequest,
  type SignedCheckpoint,
  type SignedLedgerEntry,
  type KeyCustodyPort,
} from '@aisdlc/ports';
import type pg from 'pg';
import type { z } from 'zod';

export interface NotaryServiceOptions {
  /** The Notary's own database (schema `notary`). */
  pool: pg.Pool;
  custody: KeyCustodyPort;
  /** Key id used for every signature. Default `dev:notary`. */
  keyId?: string;
  clock?: Clock;
}

interface StateRow {
  last_seq: string;
  last_hash: string | null;
}

interface JournalRow {
  ledger_seq: string;
  status: 'reserved' | 'signed' | 'committed';
  prev_hash: string | null;
  body_hash: string;
  entry_hash: string | null;
  entry: unknown;
}

/**
 * The Notary's logic, directly over its database. `app.ts` puts HTTP in front of it and
 * `client.ts` is the matching `NotaryPort` client.
 *
 * Serialisation: every state-changing call takes `SELECT ... FOR UPDATE` on the single
 * `notary.state` row, so reservations and signatures are strictly one at a time and `ledger_seq`
 * is gap-free in signing order. The KMS call happens while the row lock is held; a failed
 * signature rolls the transaction back and the reservation stays `reserved`.
 */
export class NotaryService implements NotaryPort, EvidenceSignerPort {
  private readonly keyId: string;
  private readonly clock: Clock;
  private publicKey: Jwk | undefined;

  constructor(private readonly o: NotaryServiceOptions) {
    this.keyId = o.keyId ?? 'dev:notary';
    this.clock = o.clock ?? systemClock;
  }

  async reserve(req: ReserveRequest): Promise<Result<{ ledger_seq: number }, NotaryError>> {
    return this.guard(() =>
      withTransaction(this.o.pool, async (tx) => {
        const st = await this.lockState(tx);
        if (req.prev_hash !== st.last_hash) {
          return err(
            notaryError(
              'prev_hash_mismatch',
              `prev_hash is not the last signed entry hash (last seq ${st.last_seq})`,
            ),
          );
        }
        const seq = Number(st.last_seq) + 1;
        // A reservation nobody signed is replaced; a signed seq cannot be here (seq is last+1).
        await tx.query(
          `INSERT INTO notary.journal (ledger_seq, status, prev_hash, body_hash, reserved_at)
           VALUES ($1, 'reserved', $2, $3, $4)
           ON CONFLICT (ledger_seq) DO UPDATE
             SET prev_hash = EXCLUDED.prev_hash, body_hash = EXCLUDED.body_hash,
                 reserved_at = EXCLUDED.reserved_at
             WHERE notary.journal.status = 'reserved'`,
          [seq, req.prev_hash, req.body_hash, this.clock.now()],
        );
        return ok({ ledger_seq: seq });
      }),
    );
  }

  async sign(req: SignRequest): Promise<Result<SignedLedgerEntry, NotaryError>> {
    const draft = LedgerEntryDraft.safeParse(req.draft);
    if (!draft.success) return err(notaryError('invalid_entry', draft.error.message));
    return this.guard(() =>
      withTransaction(this.o.pool, async (tx) => {
        const st = await this.lockState(tx);
        const q = await tx.query<JournalRow>(
          'SELECT * FROM notary.journal WHERE ledger_seq = $1 FOR UPDATE',
          [req.ledger_seq],
        );
        const row = q.rows[0];
        if (!row) return err(notaryError('not_reserved', `seq ${req.ledger_seq} is not reserved`));
        if (row.status !== 'reserved') {
          return err(
            notaryError('seq_already_signed', `seq ${req.ledger_seq} already has a signed entry`),
          );
        }
        if (req.ledger_seq !== Number(st.last_seq) + 1 || row.prev_hash !== st.last_hash) {
          return err(notaryError('prev_hash_mismatch', 'the chain moved since this reservation'));
        }
        if (ledgerDraftHash(draft.data) !== row.body_hash) {
          return err(notaryError('body_mismatch', 'the draft is not the one that was reserved'));
        }
        const entry_hash = computeLedgerEntryHash(draft.data, req.ledger_seq, row.prev_hash);
        const sig = await this.o.custody.sign(this.keyId, hexBytes(entry_hash));
        if (!sig.ok) return err(notaryError('signer_unavailable', sig.error.message));
        const signed: SignedLedgerEntry = {
          ledger_seq: req.ledger_seq,
          prev_hash: row.prev_hash,
          entry_hash,
          signature: b64urlEncode(sig.value),
          key_id: this.keyId,
        };
        const entry = assembleLedgerEntry(draft.data, signed);
        await tx.query(
          `UPDATE notary.journal
              SET status = 'signed', entry_hash = $2, entry = $3, key_id = $4, signed_at = $5
            WHERE ledger_seq = $1`,
          [req.ledger_seq, entry_hash, JSON.stringify(entry), this.keyId, this.clock.now()],
        );
        await tx.query('UPDATE notary.state SET last_seq = $1, last_hash = $2', [
          req.ledger_seq,
          entry_hash,
        ]);
        return ok(signed);
      }),
    );
  }

  async confirm(req: {
    ledger_seq: number;
    entry_hash: string;
  }): Promise<Result<true, NotaryError>> {
    return this.guard(() =>
      withTransaction(this.o.pool, async (tx) => {
        const q = await tx.query<JournalRow>(
          'SELECT * FROM notary.journal WHERE ledger_seq = $1 FOR UPDATE',
          [req.ledger_seq],
        );
        const row = q.rows[0];
        if (!row || row.status === 'reserved') {
          return err(notaryError('unknown_seq', `seq ${req.ledger_seq} has no signed entry`));
        }
        if (row.entry_hash !== req.entry_hash) {
          return err(
            notaryError('entry_mismatch', 'entry_hash is not the one signed for this seq'),
          );
        }
        if (row.status === 'signed') {
          await tx.query(
            "UPDATE notary.journal SET status = 'committed', committed_at = $2 WHERE ledger_seq = $1",
            [req.ledger_seq, this.clock.now()],
          );
        }
        return ok(true as const);
      }),
    );
  }

  async unconfirmed(): Promise<Result<LedgerEntry[], NotaryError>> {
    return this.guard(async () => {
      const q = await this.o.pool.query<{ entry: unknown }>(
        "SELECT entry FROM notary.journal WHERE status = 'signed' ORDER BY ledger_seq",
      );
      const out: LedgerEntry[] = [];
      for (const r of q.rows) {
        const e = LedgerEntry.safeParse(r.entry);
        if (!e.success) return err(notaryError('internal', 'journal holds an invalid entry'));
        out.push(e.data);
      }
      return ok(out);
    });
  }

  async signCheckpoint(req: CheckpointSignRequest): Promise<Result<SignedCheckpoint, NotaryError>> {
    if (req.from_ledger_seq !== 1 || req.to_ledger_seq < req.from_ledger_seq) {
      return err(notaryError('checkpoint_range', 'a checkpoint covers entries 1..n'));
    }
    return this.guard(async () => {
      // The root is recomputed from the Notary's own journal, never taken from the caller.
      const q = await this.o.pool.query<{ ledger_seq: string; entry_hash: string }>(
        `SELECT ledger_seq, entry_hash FROM notary.journal
          WHERE ledger_seq <= $1 AND status IN ('signed', 'committed') ORDER BY ledger_seq`,
        [req.to_ledger_seq],
      );
      if (q.rows.length !== req.to_ledger_seq) {
        return err(notaryError('checkpoint_range', 'the Notary has not signed that many entries'));
      }
      const core: CheckpointCore = {
        cp_seq: req.cp_seq,
        from_ledger_seq: 1,
        to_ledger_seq: req.to_ledger_seq,
        root_hash: merkleRoot(q.rows.map((r) => hexBytes(r.entry_hash))),
        head_hash: (q.rows[q.rows.length - 1] as { entry_hash: string }).entry_hash,
        created_at: req.created_at,
      };
      const sig = await this.o.custody.sign(this.keyId, hexBytes(checkpointDigestHex(core)));
      if (!sig.ok) return err(notaryError('signer_unavailable', sig.error.message));
      const signature = {
        key_id: this.keyId,
        alg: LEDGER_SIGNATURE_ALG,
        value: b64urlEncode(sig.value),
      };
      await this.o.pool.query(
        `INSERT INTO notary.checkpoint_journal
           (cp_seq, to_ledger_seq, root_hash, head_hash, created_at, signature, signed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          core.cp_seq,
          core.to_ledger_seq,
          core.root_hash,
          core.head_hash,
          core.created_at,
          JSON.stringify(signature),
          this.clock.now(),
        ],
      );
      return ok({ root_hash: core.root_hash, head_hash: core.head_hash, signature });
    });
  }

  async verify(entry: LedgerEntry): Promise<Result<true, NotaryError>> {
    const parsed = LedgerEntry.safeParse(entry);
    if (!parsed.success) return err(notaryError('invalid_entry', parsed.error.message));
    if (parsed.data.notary.key_id !== this.keyId) {
      return err(notaryError('invalid_signature', 'signed by another key'));
    }
    return this.guard(async () => {
      if (!this.publicKey) {
        const k = await this.o.custody.publicKey(this.keyId);
        if (!k.ok) return err(notaryError('signer_unavailable', k.error.message));
        this.publicKey = k.value;
      }
      const bad = await checkLedgerEntrySignature(parsed.data, this.publicKey);
      return bad === null ? ok(true as const) : err(notaryError('invalid_signature', bad));
    });
  }

  /**
   * PLAN M14.4: signs an Evidence Pack id under the domain-separated pack message, journalled once per pack. The same
   * pack asked again gets the signature it got the first time; under the state lock, so two callers never race.
   */
  async signEvidencePack(
    req: EvidenceSignRequest,
  ): Promise<Result<z.infer<typeof Signature>, NotaryError>> {
    const bad = badEvidenceSignRequest(req);
    if (bad) return err(notaryError('invalid_request', bad));
    return this.guard(() =>
      withTransaction(this.o.pool, async (tx) => {
        await this.lockState(tx);
        const have = await tx.query<{ item_id: string; head_sha: string; signature: unknown }>(
          'SELECT item_id, head_sha, signature FROM notary.evidence_signature WHERE pack_sha256 = $1',
          [req.pack_sha256],
        );
        const row = have.rows[0];
        if (row) {
          if (row.item_id !== req.item_id || row.head_sha !== req.head_sha) {
            return err(
              notaryError('invalid_request', 'this pack was signed for another item or head'),
            );
          }
          const sig = Signature.safeParse(row.signature);
          return sig.success
            ? ok(sig.data)
            : err(notaryError('internal', 'the journal holds an invalid signature'));
        }
        const raw = await this.o.custody.sign(
          this.keyId,
          hexBytes(evidencePackSigningDigest(req.pack_sha256)),
        );
        if (!raw.ok) return err(notaryError('signer_unavailable', raw.error.message));
        const signature = {
          key_id: this.keyId,
          alg: LEDGER_SIGNATURE_ALG,
          value: b64urlEncode(raw.value),
        };
        await tx.query(
          `INSERT INTO notary.evidence_signature (pack_sha256, item_id, head_sha, key_id, signature, signed_at)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            req.pack_sha256,
            req.item_id,
            req.head_sha,
            this.keyId,
            JSON.stringify(signature),
            this.clock.now(),
          ],
        );
        return ok(signature);
      }),
    );
  }

  private async lockState(tx: pg.PoolClient): Promise<StateRow> {
    const q = await tx.query<StateRow>(
      'SELECT last_seq, last_hash FROM notary.state WHERE id FOR UPDATE',
    );
    return q.rows[0] as StateRow;
  }

  /** A database error is a refusal, never an approval. */
  private async guard<T>(
    fn: () => Promise<Result<T, NotaryError>>,
  ): Promise<Result<T, NotaryError>> {
    try {
      return await fn();
    } catch (e) {
      return err(notaryError('internal', e instanceof Error ? e.message : String(e)));
    }
  }
}
