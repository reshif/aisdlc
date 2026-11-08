import {
  CARD_EVENT,
  CARD_STEP_ENTRY_TYPE,
  CardOpenedPayload,
  CardPayloadRecordedPayload,
  S0RequestedPayload,
  S0_EVENT,
  cardPayloadHash,
  cardStream,
  checkLedgerEntrySignature,
  s0Stream,
  type FindingDecisionRef,
  type FindingState,
} from '@aisdlc/contracts';
import { err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import { LEDGER_ENTRY_COLUMNS, toLedgerEntry, type LedgerEntryRow } from '@aisdlc/ledger';
import type { Executor } from '@aisdlc/record';
import { knowledgeError, type KnowledgeError } from './errors.js';

// A finding's state changes only on the authority of a decided, ledgered security-card decision
// (PLAN M7.4). The reference names the card and the `card.step_decision` ledger entry; the
// verifier below checks them against the ledger and the card's record stream, for exactly this
// finding and this state, and for the same human who is named as acting.
//
// Where it is checked. Knowledge already runs in the record database (it appends the finding's
// `finding.state_changed` event to `record.record_event` in the same transaction as the state
// change), and the ledger lives in that database. So the check is a read of `ledger.ledger_entry`
// and the card stream inside the very transaction that changes the state, under the finding's row
// lock: nothing can change between the check and the write, no second service has to be up for a
// state change to be refused or allowed, and knowledge needs no credential for core. A callback to
// core would make knowledge's refusal depend on core's availability and on trusting core's
// answer, and it would add a cycle (core calls knowledge to apply the very decision it is asked
// about). With the Notary's public key (kms-local, which knowledge already uses) the entry's
// signature is checked as well, not only its hash.

export interface DecisionCheck {
  readonly finding_id: string;
  /** The finding's repo as the Security store has it. */
  readonly repo: string;
  readonly state: Exclude<FindingState, 'open'>;
  /** The human the state change is attributed to: the one who decided the card. */
  readonly principal_id: string;
}

/** Verifies a decision reference. An `Err` is a refusal: nothing is changed. */
export interface DecisionVerifier {
  verify(
    db: Executor,
    ref: FindingDecisionRef,
    check: DecisionCheck,
  ): Promise<Result<true, KnowledgeError>>;
}

const refuse = (message: string) => err(knowledgeError('decision_refused', message));

/** The real verifier: the ledger and the card stream in the record database. */
export class LedgerDecisionVerifier implements DecisionVerifier {
  private fetched: Jwk | null = null;

  /**
   * `notaryKey` absent and no `keySource`: the entry's hash is checked but not the Notary's
   * signature. `keySource` fetches the public key on the first use (knowledge makes no network call
   * at start); a key that cannot be fetched makes the check `unavailable`, never "unchecked".
   */
  constructor(
    private readonly o: { notaryKey?: Jwk; keySource?: () => Promise<Jwk | null> } = {},
  ) {}

  private async notaryKey(): Promise<Result<Jwk | null, KnowledgeError>> {
    if (this.o.notaryKey) return ok(this.o.notaryKey);
    if (!this.o.keySource) return ok(null);
    if (this.fetched) return ok(this.fetched);
    const k = await this.o.keySource();
    if (!k) return err(knowledgeError('unavailable', 'the Notary public key could not be fetched'));
    this.fetched = k;
    return ok(k);
  }

  async verify(db: Executor, ref: FindingDecisionRef, check: DecisionCheck) {
    // ---- the ledger entry: a card step decision, approve, by the acting human
    const row = await db.query<LedgerEntryRow>(
      `SELECT ${LEDGER_ENTRY_COLUMNS} FROM ledger.ledger_entry WHERE entry_id = $1`,
      [ref.ledger_entry_id],
    );
    const stored = row.rows[0];
    if (!stored) return refuse('the decision is not on the ledger');
    let entry;
    try {
      entry = toLedgerEntry(stored);
    } catch {
      return refuse('the ledger entry is not a valid entry');
    }
    const notary = await this.notaryKey();
    if (!notary.ok) return notary;
    if (notary.value) {
      const bad = await checkLedgerEntrySignature(entry, notary.value);
      if (bad !== null) return refuse(`the ledger entry does not verify (${bad})`);
    }
    if (entry.entry_type !== CARD_STEP_ENTRY_TYPE) {
      return refuse('the ledger entry is not a card step decision');
    }
    if (entry.decision !== 'approve') return refuse('the card was not approved');
    if (entry.body['card_id'] !== ref.card_id) {
      return refuse('the ledger entry belongs to another card');
    }
    if (entry.actor !== check.principal_id) {
      return refuse('the state change is attributed to someone who did not decide the card');
    }

    // ---- the card: the security card of this finding, in an S0 record of this repo
    const opened = await db.query<{ body: unknown; type: string }>(
      'SELECT body, type FROM record.record_event WHERE stream = $1 AND seq = 1',
      [cardStream(ref.card_id)],
    );
    const open = opened.rows[0];
    if (!open || open.type !== CARD_EVENT.opened) return refuse('no such card');
    const card = CardOpenedPayload.safeParse(open.body);
    if (!card.success || card.data.card_id !== ref.card_id) return refuse('no such card');
    if (card.data.label !== 'SECR' || card.data.subject_kind !== 's0_record') {
      return refuse('the card is not a security card');
    }
    // The card of one finding: its key is `<s0>:SECR:<occurrence>:<finding id>`.
    const key = card.data.key ?? '';
    const m = /^([0-9a-f-]{36}):SECR:\d+:([0-9a-f-]{36})$/.exec(key);
    if (!m || m[1] !== card.data.subject_id || m[2] !== check.finding_id) {
      return refuse('the card is for another finding');
    }
    if (
      !card.data.targets.some((t) => t.target === 'step' && t.step === entry.body['step']) ||
      card.data.targets.some((t) => t.target === 'gate')
    ) {
      return refuse('the ledger entry is not the decision of this card');
    }
    const s0 = await db.query<{ body: unknown }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq LIMIT 1',
      [s0Stream(card.data.subject_id), S0_EVENT.requested],
    );
    const intake = S0RequestedPayload.safeParse(s0.rows[0]?.body);
    if (!intake.success || intake.data.repo.toLowerCase() !== check.repo.toLowerCase()) {
      return refuse('the card belongs to a record of another repository');
    }
    // The first decision of the card's step is the one that counts.
    const earlier = await db.query(
      `SELECT 1 FROM ledger.ledger_entry
        WHERE entry_type = $1 AND body ->> 'card_id' = $2 AND body ->> 'step' = $3
          AND ledger_seq < $4 LIMIT 1`,
      [CARD_STEP_ENTRY_TYPE, ref.card_id, String(entry.body['step']), entry.ledger_seq],
    );
    if ((earlier.rowCount ?? 0) > 0) return refuse('the card was decided before by another entry');

    // ---- what was decided: this finding, this state, bound by the payload hash in the entry
    const rec = await db.query<{ body: unknown }>(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq DESC LIMIT 1`,
      [cardStream(ref.card_id), CARD_EVENT.payload_recorded],
    );
    const payload = CardPayloadRecordedPayload.safeParse(rec.rows[0]?.body);
    if (!payload.success) return refuse('the card has no recorded payload');
    const hash = cardPayloadHash(payload.data.payload);
    if (hash !== payload.data.payload_hash || hash !== entry.body['payload_hash']) {
      return refuse('the recorded payload is not the one the ledger entry signed');
    }
    const rows = payload.data.payload.filter((p) => p.kind === 'finding_state');
    const only = rows.length === 1 ? rows[0] : undefined;
    if (
      only?.kind !== 'finding_state' ||
      only.finding_id !== check.finding_id ||
      only.state !== check.state
    ) {
      return refuse('the decision is for another finding or another state');
    }
    return ok(true as const);
  }
}

/**
 * Deterministic `DecisionVerifier` for tests of knowledge on its own: accepts every reference
 * unless told otherwise, and records what it was asked. The real verifier is exercised with the
 * real ledger in core's tests.
 */
export class FakeDecisionVerifier implements DecisionVerifier {
  readonly asked: Array<{ ref: FindingDecisionRef; check: DecisionCheck }> = [];
  /** `refuse` set: every reference is refused with this reason. */
  refuse: string | null = null;

  async verify(_db: Executor, ref: FindingDecisionRef, check: DecisionCheck) {
    this.asked.push({ ref, check });
    return this.refuse === null ? ok(true as const) : refuse(this.refuse);
  }
}
