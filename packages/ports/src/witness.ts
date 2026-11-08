import {
  LEDGER_SIGNATURE_ALG,
  checkCheckpointSignature,
  checkpointDigestHex,
  type Checkpoint,
  type CheckpointCore,
  type Signature,
} from '@aisdlc/contracts';
import {
  MerkleFrontier,
  b64urlEncode,
  err,
  ok,
  taggedError,
  type Jwk,
  type MerkleFrontierState,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import { hexBytes } from './notary.js';
import type { KeyCustodyPort } from './key-custody.js';

export type WitnessErrorCode =
  | 'unauthenticated'
  | 'forbidden'
  | 'invalid_request'
  | 'invalid_notary_signature'
  /** `cp_seq` is not the next one, or an already co-signed `cp_seq` is offered with other content. */
  | 'cp_seq_mismatch'
  /** The checkpoint covers fewer entries than the last co-signed one. */
  | 'size_regressed'
  /** The entries shown are not a contiguous chain from the last co-signed head. */
  | 'entries_invalid'
  /** The checkpoint's head is not the last entry shown. */
  | 'head_mismatch'
  /** The recomputed root differs from the checkpoint's: history was rewritten or the root is wrong. */
  | 'not_append_only'
  | 'signer_unavailable'
  | 'unavailable'
  | 'internal';

export const WitnessError = taggedError('WitnessError');
export type WitnessError = TaggedError<'WitnessError', { code: WitnessErrorCode; message: string }>;
export const witnessError = (code: WitnessErrorCode, message: string): WitnessError =>
  WitnessError({ code, message });

/** One ledger entry as the Witness sees it: its place in the chain, not its content. */
export interface EntryLink {
  ledger_seq: number;
  prev_hash: string | null;
  entry_hash: string;
}

export interface CosignRequest {
  /** The checkpoint without signatures. */
  core: CheckpointCore;
  /** The Notary's signature over `checkpointDigestHex(core)`. */
  notary: Signature;
  /** Entries `last co-signed size + 1` .. `core.to_ledger_seq`, in order. */
  entries: EntryLink[];
}

/**
 * The Witness: an independent verifier with its own key and its own database (PLAN M2.4). It
 * co-signs a checkpoint only if the checkpoint is consistent with the last one it co-signed.
 */
export interface WitnessPort {
  /** Returns the checkpoint with both signatures (Notary first, Witness second). */
  cosign(req: CosignRequest): Promise<Result<Checkpoint, WitnessError>>;
  /** The last checkpoint co-signed, or null. */
  last(): Promise<Result<Checkpoint | null, WitnessError>>;
}

/** What the Witness remembers about its last co-signature. */
export interface WitnessLast {
  checkpoint: Checkpoint;
  /** The tree over entries 1..checkpoint.to_ledger_seq. */
  frontier: MerkleFrontierState;
}

export type CosignDecision =
  /** Same checkpoint as the last one: answer again with what was stored. */
  | { kind: 'replay'; checkpoint: Checkpoint }
  /** Consistent and new: sign `digestHex`, store `frontier` with the result. */
  | { kind: 'new'; digestHex: string; frontier: MerkleFrontierState };

/**
 * The Witness's decision, as a pure function so the service and the fake cannot differ. The
 * simple correct check: take the stored tree head (a compact Merkle range), append the entry
 * hashes shown for the new range, and require the root to equal the checkpoint's. An unchanged
 * prefix gives the same compact range, so a rewritten past entry shows up as a different root.
 */
export async function decideCosign(
  last: WitnessLast | null,
  req: CosignRequest,
  notaryKey: Jwk,
): Promise<Result<CosignDecision, WitnessError>> {
  const { core, entries } = req;
  if (core.from_ledger_seq !== 1) {
    return err(witnessError('invalid_request', 'a checkpoint covers entries from seq 1'));
  }
  const badSig = await checkCheckpointSignature(core, req.notary, notaryKey);
  if (badSig !== null) {
    return err(witnessError('invalid_notary_signature', `notary signature: ${badSig}`));
  }

  const prev = last?.checkpoint ?? null;
  const lastSize = prev?.to_ledger_seq ?? 0;
  const sameContent =
    prev !== null &&
    prev.to_ledger_seq === core.to_ledger_seq &&
    prev.root_hash === core.root_hash &&
    prev.head_hash === core.head_hash;

  if (prev !== null && core.cp_seq === prev.cp_seq) {
    return sameContent
      ? ok({ kind: 'replay', checkpoint: prev })
      : err(witnessError('cp_seq_mismatch', `cp_seq ${core.cp_seq} is already co-signed`));
  }
  if (core.cp_seq !== (prev?.cp_seq ?? 0) + 1) {
    return err(witnessError('cp_seq_mismatch', `expected cp_seq ${(prev?.cp_seq ?? 0) + 1}`));
  }
  if (core.to_ledger_seq < lastSize) {
    return err(
      witnessError('size_regressed', `size ${core.to_ledger_seq} is below co-signed ${lastSize}`),
    );
  }
  if (entries.length !== core.to_ledger_seq - lastSize) {
    return err(witnessError('entries_invalid', 'entries do not cover the new range exactly'));
  }
  let expectPrev: string | null = prev?.head_hash ?? null;
  let expectSeq = lastSize + 1;
  const frontier = last ? MerkleFrontier.from(last.frontier) : new MerkleFrontier();
  for (const e of entries) {
    if (e.ledger_seq !== expectSeq || e.prev_hash !== expectPrev) {
      return err(
        witnessError('entries_invalid', `entry ${e.ledger_seq} does not extend the chain`),
      );
    }
    frontier.append(hexBytes(e.entry_hash));
    expectPrev = e.entry_hash;
    expectSeq += 1;
  }
  if (core.head_hash !== expectPrev) {
    return err(witnessError('head_mismatch', 'head_hash is not the last entry'));
  }
  if (frontier.root() !== core.root_hash) {
    return err(
      witnessError('not_append_only', 'root over the co-signed prefix and the new entries differs'),
    );
  }
  return ok({ kind: 'new', digestHex: checkpointDigestHex(core), frontier: frontier.state() });
}

/** Builds the stored checkpoint from a decision and the Witness's signature. */
export function buildCheckpoint(req: CosignRequest, witness: Signature): Checkpoint {
  return {
    ...req.core,
    signatures: [
      { signer: 'notary', signature: req.notary },
      { signer: 'witness', signature: witness },
    ],
  };
}

/** In-process Witness for tests of other packages; same decision function as the service. */
export class FakeWitness implements WitnessPort {
  private lastState: WitnessLast | null = null;

  constructor(
    private readonly custody: KeyCustodyPort,
    private readonly notaryKeyId = 'dev:notary',
    private readonly keyId = 'dev:witness',
  ) {}

  async cosign(req: CosignRequest) {
    const nk = await this.custody.publicKey(this.notaryKeyId);
    if (!nk.ok) return err(witnessError('signer_unavailable', nk.error.message));
    const d = await decideCosign(this.lastState, req, nk.value);
    if (!d.ok) return d;
    if (d.value.kind === 'replay') return ok(d.value.checkpoint);
    const sig = await this.custody.sign(this.keyId, hexBytes(d.value.digestHex));
    if (!sig.ok) return err(witnessError('signer_unavailable', sig.error.message));
    const checkpoint = buildCheckpoint(req, {
      key_id: this.keyId,
      alg: LEDGER_SIGNATURE_ALG,
      value: b64urlEncode(sig.value),
    });
    this.lastState = { checkpoint, frontier: d.value.frontier };
    return ok(checkpoint);
  }

  async last() {
    return ok(this.lastState?.checkpoint ?? null);
  }
}
