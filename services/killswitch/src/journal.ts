import {
  KILL_EVENT,
  KILL_SIGNATURE_PENDING,
  KillEvent,
  type KillEventKind,
} from '@aisdlc/contracts';
import {
  b64urlEncode,
  canonicalJson,
  err,
  hashCanonical,
  ok,
  verifyEs256,
  type Clock,
  type Jwk,
  type Result,
} from '@aisdlc/kernel';
import { hexBytes, type KeyCustodyPort } from '@aisdlc/ports';
import type pg from 'pg';
import { killswitchError, type KillswitchError } from './errors.js';

// The kill switch's own journal (AR9): hash-chained, each entry signed with the kill switch's own key.
// Nothing else signs it, and core does not write to it. A reader (core's observer, an auditor) verifies
// the chain and the signatures with the public key alone.

/** What is hashed and signed: every field of an entry except the hash and the signature. */
export const entryCore = (e: {
  seq: number;
  kind: string;
  subject: string;
  actor: string | null;
  body: unknown;
  at: string;
  prev_hash: string | null;
}) => ({
  seq: e.seq,
  kind: e.kind,
  subject: e.subject,
  actor: e.actor,
  body: e.body,
  at: e.at,
  prev_hash: e.prev_hash,
});

export interface JournalRow {
  seq: string;
  kind: string;
  subject: string;
  actor: string | null;
  body: Record<string, unknown>;
  at: Date;
  prev_hash: string | null;
  entry_hash: string;
  signature: string;
  key_id: string;
}

export const toEvent = (r: JournalRow): KillEvent =>
  KillEvent.parse({
    seq: Number(r.seq),
    kind: r.kind,
    subject: r.subject,
    actor: r.actor,
    body: r.body,
    at: r.at.toISOString(),
    prev_hash: r.prev_hash,
    entry_hash: r.entry_hash,
    signature: r.signature,
    key_id: r.key_id,
  });

export class KillJournal {
  constructor(
    private readonly custody: KeyCustodyPort,
    private readonly keyId: string,
    private readonly clock: Clock,
  ) {}

  /**
   * Appends one entry in the open transaction. The head row is locked, so entries are one at a time and
   * gap-free; the KMS call happens under that lock. A signing failure is an error and the caller's
   * transaction rolls back: nothing is recorded that is not signed.
   */
  async append(
    tx: pg.PoolClient,
    kind: KillEventKind,
    subject: string,
    actor: string | null,
    body: Record<string, unknown>,
    o: { allowUnsigned?: boolean } = {},
  ): Promise<Result<KillEvent, KillswitchError>> {
    const h = await tx.query<{ last_seq: string; last_hash: string | null }>(
      'SELECT last_seq, last_hash FROM killswitch.head WHERE id FOR UPDATE',
    );
    const seq = Number(h.rows[0]?.last_seq ?? 0) + 1;
    const prev_hash = h.rows[0]?.last_hash ?? null;
    const at = this.clock.now().toISOString();
    const entry_hash = hashCanonical(entryCore({ seq, kind, subject, actor, body, at, prev_hash }));
    const sig = await this.custody.sign(this.keyId, hexBytes(entry_hash));
    // A kill is never held up by its signer: it is written unsigned (still in the chain) and attested later.
    if (!sig.ok && o.allowUnsigned !== true) {
      return err(
        killswitchError('unavailable', `cannot sign the journal entry: ${sig.error.message}`),
      );
    }
    const signature = sig.ok ? b64urlEncode(sig.value) : KILL_SIGNATURE_PENDING;
    await tx.query(
      `INSERT INTO killswitch.journal (seq, kind, subject, actor, body, at, prev_hash, entry_hash, signature, key_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
      [
        seq,
        kind,
        subject,
        actor,
        JSON.stringify(body),
        at,
        prev_hash,
        entry_hash,
        signature,
        this.keyId,
      ],
    );
    await tx.query('UPDATE killswitch.head SET last_seq = $1, last_hash = $2 WHERE id', [
      seq,
      entry_hash,
    ]);
    return ok(
      KillEvent.parse({
        seq,
        kind,
        subject,
        actor,
        body,
        at,
        prev_hash,
        entry_hash,
        signature,
        key_id: this.keyId,
      }),
    );
  }
}

export type JournalProblem = { seq: number; problem: string };

export interface JournalReport {
  /** What is wrong: a broken link, a changed entry, a bad signature, an unsigned entry that may not be. */
  readonly problems: JournalProblem[];
  /** Kills still waiting for their signature: accepted (they are enforced), and reported. */
  readonly pending: number[];
}

/**
 * Verifies a run of entries (from seq 1, or from an entry whose predecessor hash is `after`): the
 * chain links, every hash is the hash of its contents, every signature verifies under `jwk`. An entry
 * with `KILL_SIGNATURE_PENDING` is accepted only for a `kill.requested`, and is reported in `pending`
 * until a signed `kill.signature_attested` that names it (seq and hash) appears. Pure.
 */
export async function verifyKillJournalReport(
  entries: readonly KillEvent[],
  jwk: Jwk,
  after: { seq: number; hash: string | null } = { seq: 0, hash: null },
): Promise<JournalReport> {
  const problems: JournalProblem[] = [];
  const pending = new Map<number, string>();
  let prevSeq = after.seq;
  let prevHash = after.hash;
  for (const e of entries) {
    if (e.seq !== prevSeq + 1) problems.push({ seq: e.seq, problem: `gap after ${prevSeq}` });
    if (e.prev_hash !== prevHash) problems.push({ seq: e.seq, problem: 'prev_hash does not link' });
    const h = hashCanonical(entryCore(e));
    if (h !== e.entry_hash)
      problems.push({ seq: e.seq, problem: 'entry_hash is not the hash of the entry' });
    if (e.signature === KILL_SIGNATURE_PENDING) {
      if (e.kind === KILL_EVENT.requested) pending.set(e.seq, e.entry_hash);
      else problems.push({ seq: e.seq, problem: `a ${e.kind} entry may not be unsigned` });
    } else {
      const msg = new TextEncoder().encode(canonicalJson(entryCore(e)));
      const okSig = await verifyEs256(jwk, msg, e.signature);
      if (!okSig) problems.push({ seq: e.seq, problem: 'signature does not verify' });
      else if (e.kind === KILL_EVENT.signature_attested) {
        const b = e.body as { pending_seq?: number; pending_hash?: string };
        if (typeof b.pending_seq === 'number' && pending.get(b.pending_seq) === b.pending_hash) {
          pending.delete(b.pending_seq);
        } else if (typeof b.pending_seq !== 'number' || b.pending_seq > after.seq) {
          problems.push({ seq: e.seq, problem: 'attests an entry that is not pending' });
        }
      }
    }
    prevSeq = e.seq;
    prevHash = e.entry_hash;
  }
  return { problems, pending: [...pending.keys()] };
}

/** The problems of a run (see `verifyKillJournalReport`); a pending kill is not a problem. */
export async function verifyKillJournal(
  entries: readonly KillEvent[],
  jwk: Jwk,
  after: { seq: number; hash: string | null } = { seq: 0, hash: null },
): Promise<JournalProblem[]> {
  return (await verifyKillJournalReport(entries, jwk, after)).problems;
}
