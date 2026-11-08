import { Checkpoint, LEDGER_SIGNATURE_ALG } from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import {
  b64urlEncode,
  err,
  ok,
  systemClock,
  type Clock,
  type Jwk,
  type MerkleFrontierState,
  type Result,
} from '@aisdlc/kernel';
import {
  buildCheckpoint,
  decideCosign,
  hexBytes,
  witnessError,
  type CosignRequest,
  type KeyCustodyPort,
  type WitnessError,
  type WitnessLast,
  type WitnessPort,
} from '@aisdlc/ports';
import type pg from 'pg';

export interface WitnessServiceOptions {
  /** The Witness's own database (schema `witness`). */
  pool: pg.Pool;
  custody: KeyCustodyPort;
  /** The Witness's signing key. Default `dev:witness`. */
  keyId?: string;
  /** Whose checkpoint signatures it trusts. Default `dev:notary`. */
  notaryKeyId?: string;
  clock?: Clock;
}

interface CosignedRow {
  frontier: MerkleFrontierState;
  checkpoint: unknown;
}

/**
 * The Witness's logic. The decision itself is `decideCosign` (shared with the fake); this adds
 * the database, the key and the one-at-a-time rule: co-signing runs under an advisory lock so two
 * requests cannot both extend the same checkpoint.
 */
export class WitnessService implements WitnessPort {
  private readonly keyId: string;
  private readonly notaryKeyId: string;
  private readonly clock: Clock;
  private notaryKey: Jwk | undefined;

  constructor(private readonly o: WitnessServiceOptions) {
    this.keyId = o.keyId ?? 'dev:witness';
    this.notaryKeyId = o.notaryKeyId ?? 'dev:notary';
    this.clock = o.clock ?? systemClock;
  }

  async cosign(req: CosignRequest): Promise<Result<Checkpoint, WitnessError>> {
    try {
      if (!this.notaryKey) {
        const k = await this.o.custody.publicKey(this.notaryKeyId);
        if (!k.ok) return err(witnessError('signer_unavailable', k.error.message));
        this.notaryKey = k.value;
      }
      const notaryKey = this.notaryKey;
      return await withTransaction(this.o.pool, async (tx) => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtext('aisdlc.witness.cosign'))");
        const last = await this.readLast(tx);
        const d = await decideCosign(last, req, notaryKey);
        if (!d.ok) return d;
        if (d.value.kind === 'replay') return ok(d.value.checkpoint);
        const sig = await this.o.custody.sign(this.keyId, hexBytes(d.value.digestHex));
        if (!sig.ok) return err(witnessError('signer_unavailable', sig.error.message));
        const checkpoint = buildCheckpoint(req, {
          key_id: this.keyId,
          alg: LEDGER_SIGNATURE_ALG,
          value: b64urlEncode(sig.value),
        });
        await tx.query(
          `INSERT INTO witness.cosigned
             (cp_seq, to_ledger_seq, root_hash, head_hash, frontier, checkpoint, cosigned_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            checkpoint.cp_seq,
            checkpoint.to_ledger_seq,
            checkpoint.root_hash,
            checkpoint.head_hash,
            JSON.stringify(d.value.frontier),
            JSON.stringify(checkpoint),
            this.clock.now(),
          ],
        );
        return ok(checkpoint);
      });
    } catch (e) {
      return err(witnessError('internal', e instanceof Error ? e.message : String(e)));
    }
  }

  async last(): Promise<Result<Checkpoint | null, WitnessError>> {
    try {
      const l = await this.readLast(this.o.pool);
      return ok(l?.checkpoint ?? null);
    } catch (e) {
      return err(witnessError('internal', e instanceof Error ? e.message : String(e)));
    }
  }

  private async readLast(db: Pick<pg.Pool, 'query'>): Promise<WitnessLast | null> {
    const q = await db.query<CosignedRow>(
      'SELECT frontier, checkpoint FROM witness.cosigned ORDER BY cp_seq DESC LIMIT 1',
    );
    const row = q.rows[0];
    if (!row) return null;
    const checkpoint = Checkpoint.parse(row.checkpoint); // our own row; invalid means corrupt
    return { checkpoint, frontier: row.frontier };
  }
}
