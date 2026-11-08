import {
  LedgerEntryDraft,
  checkCheckpointSignature,
  draftOfEntry,
  ledgerDraftHash,
  type CheckpointCore,
  type LedgerEntry,
  type Signature,
} from '@aisdlc/contracts';
import { merkleRoot, newId, type Jwk } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import { assembleLedgerEntry, hexBytes, type NotaryPort } from './notary.js';
import type { CosignRequest, EntryLink, WitnessPort } from './witness.js';

/** A valid non-decision ledger draft. `n` makes the body, and so the hash, different. */
export function sampleDraft(n: number, at = '2026-11-08T10:00:00.000Z'): LedgerEntryDraft {
  return LedgerEntryDraft.parse({
    entry_id: newId<'LedgerEntry'>(),
    entry_type: 'config_publish',
    gate_instance_id: null,
    gate_id: null,
    subject_kind: null,
    subject_id: null,
    subject_hash: null,
    decision: null,
    actor: null,
    sod_waiver: false,
    policy_bundle_version: 'roles-2.0.0',
    body: { n },
    created_at: at,
  });
}

/** Reserves and signs `count` entries in a row (not confirmed). Returns them in order. */
export async function signEntries(
  notary: NotaryPort,
  count: number,
  opts: { after?: LedgerEntry | null; start?: number; tag?: string } = {},
): Promise<LedgerEntry[]> {
  const out: LedgerEntry[] = [];
  let prev = opts.after ?? null;
  for (let i = 0; i < count; i++) {
    const draft = sampleDraft((opts.start ?? 0) + i);
    if (opts.tag) draft.body['tag'] = opts.tag;
    const r = await notary.reserve({
      prev_hash: prev?.entry_hash ?? null,
      body_hash: ledgerDraftHash(draft),
    });
    if (!r.ok) throw new Error(`reserve: ${r.error.code}`);
    const s = await notary.sign({ ledger_seq: r.value.ledger_seq, draft });
    if (!s.ok) throw new Error(`sign: ${s.error.code}`);
    prev = assembleLedgerEntry(draft, s.value);
    out.push(prev);
  }
  return out;
}

const forgedRootOf = (entries: LedgerEntry[]): string =>
  merkleRoot(entries.map((e) => hexBytes(e.entry_hash)));

export const linksOf = (entries: LedgerEntry[]): EntryLink[] =>
  entries.map((e) => ({
    ledger_seq: e.ledger_seq,
    prev_hash: e.prev_hash,
    entry_hash: e.entry_hash,
  }));

/**
 * Behaviour every `NotaryPort` must have, run against the fake, the service and the HTTP client.
 * `make` returns a fresh, empty Notary.
 */
export function notaryConformance(
  name: string,
  make: () => Promise<{ notary: NotaryPort; stop?: () => Promise<void> }>,
): void {
  describe(`NotaryPort conformance: ${name}`, () => {
    const withNotary = async (fn: (n: NotaryPort) => Promise<void>): Promise<void> => {
      const { notary, stop } = await make();
      try {
        await fn(notary);
      } finally {
        await stop?.();
      }
    };

    it('chains entries and each one verifies', () =>
      withNotary(async (n) => {
        const [a, b] = await signEntries(n, 2);
        expect(a?.ledger_seq).toBe(1);
        expect(a?.prev_hash).toBeNull();
        expect(b?.ledger_seq).toBe(2);
        expect(b?.prev_hash).toBe(a?.entry_hash);
        expect((await n.verify(a as LedgerEntry)).ok).toBe(true);
        const forged = { ...(b as LedgerEntry), body: { n: 99 } };
        const v = await n.verify(forged);
        expect(!v.ok && v.error.code).toBe('invalid_signature');
      }));

    it('refuses a prev_hash that is not its last signed entry hash', () =>
      withNotary(async (n) => {
        const bad = await n.reserve({ prev_hash: 'a'.repeat(64), body_hash: 'b'.repeat(64) });
        expect(!bad.ok && bad.error.code).toBe('prev_hash_mismatch');
        const [a] = await signEntries(n, 1);
        const first = await n.reserve({ prev_hash: null, body_hash: 'b'.repeat(64) });
        expect(!first.ok && first.error.code).toBe('prev_hash_mismatch');
        const ok = await n.reserve({ prev_hash: a?.entry_hash ?? null, body_hash: 'b'.repeat(64) });
        expect(ok.ok && ok.value.ledger_seq).toBe(2);
      }));

    it('refuses to sign a second entry for the same seq', () =>
      withNotary(async (n) => {
        const d1 = sampleDraft(1);
        const r = await n.reserve({ prev_hash: null, body_hash: ledgerDraftHash(d1) });
        const seq = r.ok ? r.value.ledger_seq : 0;
        expect((await n.sign({ ledger_seq: seq, draft: d1 })).ok).toBe(true);
        const again = await n.sign({ ledger_seq: seq, draft: d1 });
        expect(!again.ok && again.error.code).toBe('seq_already_signed');
        const other = await n.sign({ ledger_seq: seq, draft: sampleDraft(2) });
        expect(!other.ok && other.error.code).toBe('seq_already_signed');
        const unreserved = await n.sign({ ledger_seq: seq + 5, draft: sampleDraft(3) });
        expect(!unreserved.ok && unreserved.error.code).toBe('not_reserved');
      }));

    it('refuses a draft that is not the reserved one, and one that breaks the contract', () =>
      withNotary(async (n) => {
        const d = sampleDraft(1);
        const r = await n.reserve({ prev_hash: null, body_hash: ledgerDraftHash(d) });
        const seq = r.ok ? r.value.ledger_seq : 0;
        const swapped = await n.sign({ ledger_seq: seq, draft: sampleDraft(2) });
        expect(!swapped.ok && swapped.error.code).toBe('body_mismatch');
        const decision = { ...d, entry_type: 'decision' } as LedgerEntryDraft; // gate fields null
        const bad = await n.sign({ ledger_seq: seq, draft: decision });
        expect(!bad.ok && bad.error.code).toBe('invalid_entry');
        const junk = await n.sign({
          ledger_seq: seq,
          draft: { nope: 1 } as unknown as LedgerEntryDraft,
        });
        expect(!junk.ok && junk.error.code).toBe('invalid_entry');
        // The reservation is still good for the real draft.
        expect((await n.sign({ ledger_seq: seq, draft: d })).ok).toBe(true);
      }));

    it('lets a reservation nobody signed be replaced', () =>
      withNotary(async (n) => {
        const d1 = sampleDraft(1);
        const d2 = sampleDraft(2);
        const r1 = await n.reserve({ prev_hash: null, body_hash: ledgerDraftHash(d1) });
        const r2 = await n.reserve({ prev_hash: null, body_hash: ledgerDraftHash(d2) });
        expect(r1.ok && r2.ok && r1.value.ledger_seq === r2.value.ledger_seq).toBe(true);
        const stale = await n.sign({ ledger_seq: 1, draft: d1 });
        expect(!stale.ok && stale.error.code).toBe('body_mismatch');
        expect((await n.sign({ ledger_seq: 1, draft: d2 })).ok).toBe(true);
      }));

    it('lists signed entries until they are confirmed; confirm is idempotent and exact', () =>
      withNotary(async (n) => {
        const entries = await signEntries(n, 3);
        const listed = await n.unconfirmed();
        expect(listed.ok && listed.value.map((e) => e.entry_hash)).toEqual(
          entries.map((e) => e.entry_hash),
        );
        const e2 = entries[1] as LedgerEntry;
        expect((await n.confirm({ ledger_seq: 2, entry_hash: e2.entry_hash })).ok).toBe(true);
        expect((await n.confirm({ ledger_seq: 2, entry_hash: e2.entry_hash })).ok).toBe(true);
        const wrong = await n.confirm({ ledger_seq: 1, entry_hash: e2.entry_hash });
        expect(!wrong.ok && wrong.error.code).toBe('entry_mismatch');
        const unknown = await n.confirm({ ledger_seq: 9, entry_hash: e2.entry_hash });
        expect(!unknown.ok && unknown.error.code).toBe('unknown_seq');
        const after = await n.unconfirmed();
        expect(after.ok && after.value.map((e) => e.ledger_seq)).toEqual([1, 3]);
        // The listed entry is the complete signed entry, ready to insert.
        const first = listed.ok ? listed.value[0] : undefined;
        expect(first && draftOfEntry(first)).toEqual(draftOfEntry(entries[0] as LedgerEntry));
      }));

    it('signs a checkpoint over its own journal and refuses a range it has not signed', () =>
      withNotary(async (n) => {
        const entries = await signEntries(n, 5);
        const at = '2026-11-08T10:05:00.000Z';
        const cp = await n.signCheckpoint({
          cp_seq: 1,
          from_ledger_seq: 1,
          to_ledger_seq: 5,
          created_at: at,
        });
        expect(cp.ok).toBe(true);
        if (!cp.ok) return;
        expect(cp.value.root_hash).toBe(merkleRoot(entries.map((e) => hexBytes(e.entry_hash))));
        expect(cp.value.head_hash).toBe(entries[4]?.entry_hash);
        const part = await n.signCheckpoint({
          cp_seq: 2,
          from_ledger_seq: 1,
          to_ledger_seq: 3,
          created_at: at,
        });
        expect(part.ok && part.value.root_hash).toBe(
          merkleRoot(entries.slice(0, 3).map((e) => hexBytes(e.entry_hash))),
        );
        const beyond = await n.signCheckpoint({
          cp_seq: 3,
          from_ledger_seq: 1,
          to_ledger_seq: 6,
          created_at: at,
        });
        expect(!beyond.ok && beyond.error.code).toBe('checkpoint_range');
        const from2 = await n.signCheckpoint({
          cp_seq: 3,
          from_ledger_seq: 2,
          to_ledger_seq: 5,
          created_at: at,
        });
        expect(!from2.ok && from2.error.code).toBe('checkpoint_range');
      }));
  });
}

export interface WitnessHarness {
  witness: WitnessPort;
  /** The Notary the Witness trusts. */
  notary: NotaryPort;
  /** A second Notary with the same key and no shared history: "history rewritten and re-signed". */
  forkedNotary: NotaryPort;
  /** The public key of the Notary, for assertions on signatures. */
  notaryKey: () => Promise<Jwk>;
  witnessKey: () => Promise<Jwk>;
  /** Signs any checkpoint core with the Notary key: what an attacker holding that key could do. */
  signAsNotary: (core: CheckpointCore) => Promise<Signature>;
  stop?: () => Promise<void>;
}

/** Builds a Notary-signed checkpoint request over entries 1..to, showing entries `from+1..to`. */
export async function checkpointRequest(
  notary: NotaryPort,
  all: LedgerEntry[],
  cp_seq: number,
  alreadyCosigned: number,
  to: number,
  created_at: string,
): Promise<CosignRequest> {
  const signed = await notary.signCheckpoint({
    cp_seq,
    from_ledger_seq: 1,
    to_ledger_seq: to,
    created_at,
  });
  if (!signed.ok) throw new Error(`signCheckpoint: ${signed.error.code}`);
  const core: CheckpointCore = {
    cp_seq,
    from_ledger_seq: 1,
    to_ledger_seq: to,
    root_hash: signed.value.root_hash,
    head_hash: signed.value.head_hash,
    created_at,
  };
  return { core, notary: signed.value.signature, entries: linksOf(all.slice(alreadyCosigned, to)) };
}

/** Behaviour every `WitnessPort` must have, run against the fake, the service and the client. */
export function witnessConformance(name: string, make: () => Promise<WitnessHarness>): void {
  describe(`WitnessPort conformance: ${name}`, () => {
    const T1 = '2026-11-08T10:05:00.000Z';
    const T2 = '2026-11-08T10:10:00.000Z';
    const T3 = '2026-11-08T10:15:00.000Z';
    const withHarness = async (fn: (h: WitnessHarness) => Promise<void>): Promise<void> => {
      const h = await make();
      try {
        await fn(h);
      } finally {
        await h.stop?.();
      }
    };

    it('co-signs a first and a consistent second checkpoint, both signatures verify', () =>
      withHarness(async (h) => {
        const entries = await signEntries(h.notary, 7);
        const first = await h.witness.cosign(
          await checkpointRequest(h.notary, entries, 1, 0, 3, T1),
        );
        expect(first.ok).toBe(true);
        const second = await h.witness.cosign(
          await checkpointRequest(h.notary, entries, 2, 3, 7, T2),
        );
        expect(second.ok).toBe(true);
        if (!second.ok) return;
        expect(second.value.signatures.map((s) => s.signer)).toEqual(['notary', 'witness']);
        expect(second.value.root_hash).toBe(merkleRoot(entries.map((e) => hexBytes(e.entry_hash))));
        for (const s of second.value.signatures) {
          const key = s.signer === 'notary' ? await h.notaryKey() : await h.witnessKey();
          expect(await checkCheckpointSignature(second.value, s.signature, key)).toBeNull();
        }
        const last = await h.witness.last();
        expect(last.ok && last.value).toEqual(second.value);
      }));

    it('answers a repeat of the last checkpoint with the stored one', () =>
      withHarness(async (h) => {
        const entries = await signEntries(h.notary, 4);
        const req = await checkpointRequest(h.notary, entries, 1, 0, 4, T1);
        const a = await h.witness.cosign(req);
        const again = await checkpointRequest(h.notary, entries, 1, 0, 4, T2); // new time, same content
        const b = await h.witness.cosign(again);
        expect(a.ok && b.ok && a.value).toEqual(b.ok && b.value);
        const other = await checkpointRequest(h.notary, entries, 1, 0, 3, T2);
        const c = await h.witness.cosign(other);
        expect(!c.ok && c.error.code).toBe('cp_seq_mismatch');
      }));

    it('refuses a checkpoint that goes backwards, skips a cp_seq or shows the wrong entries', () =>
      withHarness(async (h) => {
        const entries = await signEntries(h.notary, 6);
        expect(
          (await h.witness.cosign(await checkpointRequest(h.notary, entries, 1, 0, 4, T1))).ok,
        ).toBe(true);

        const back = await h.witness.cosign(
          await checkpointRequest(h.notary, entries, 2, 0, 2, T2),
        );
        expect(!back.ok && back.error.code).toBe('size_regressed');

        const skip = await h.witness.cosign(
          await checkpointRequest(h.notary, entries, 3, 4, 6, T2),
        );
        expect(!skip.ok && skip.error.code).toBe('cp_seq_mismatch');

        const short = await checkpointRequest(h.notary, entries, 2, 4, 6, T2);
        const missing = await h.witness.cosign({ ...short, entries: short.entries.slice(1) });
        expect(!missing.ok && missing.error.code).toBe('entries_invalid');

        const swapped = await h.witness.cosign({ ...short, entries: [...short.entries].reverse() });
        expect(!swapped.ok && swapped.error.code).toBe('entries_invalid');

        // Still able to proceed after refusals.
        expect((await h.witness.cosign(short)).ok).toBe(true);
      }));

    it('refuses a checkpoint over rewritten history, even with a valid Notary signature', () =>
      withHarness(async (h) => {
        const real = await signEntries(h.notary, 5);
        expect(
          (await h.witness.cosign(await checkpointRequest(h.notary, real, 1, 0, 3, T1))).ok,
        ).toBe(true);

        // Entry 2 is rewritten and the whole chain re-signed by a Notary with the same key.
        const forged = await signEntries(h.forkedNotary, 5, { tag: 'rewritten' });
        const asked = await checkpointRequest(h.forkedNotary, forged, 2, 3, 5, T2);
        // Shown as a continuation: the new entries chain from the forged head, not the stored one.
        const r1 = await h.witness.cosign(asked);
        expect(!r1.ok && r1.error.code).toBe('entries_invalid');

        // The forger shows real new entries but the root over the rewritten history, and has the
        // Notary key to sign it. Chain links and signature are fine; only the Merkle check catches it.
        const real45 = await checkpointRequest(h.notary, real, 2, 3, 5, T2);
        const forgedCore = { ...real45.core, root_hash: forgedRootOf(forged) };
        const r2 = await h.witness.cosign({
          core: forgedCore,
          notary: await h.signAsNotary(forgedCore),
          entries: real45.entries,
        });
        expect(!r2.ok && r2.error.code).toBe('not_append_only');

        // The honest checkpoint is still accepted afterwards.
        expect((await h.witness.cosign(real45)).ok).toBe(true);

        const last = await h.witness.last();
        expect(last.ok && last.value?.to_ledger_seq).toBe(5);
      }));

    it('refuses a checkpoint without a valid Notary signature', () =>
      withHarness(async (h) => {
        const entries = await signEntries(h.notary, 2);
        const req = await checkpointRequest(h.notary, entries, 1, 0, 2, T1);
        // Change one character in the middle of the signature, to a different one: the bytes change for
        // certain. (Replacing the last two characters with 'AA' left the signature unchanged whenever it
        // already ended in 'AA', which a random ES256 signature does once in 256 runs: the flake.)
        const sig = req.notary.value;
        const at = Math.floor(sig.length / 2);
        const flipped = sig.slice(0, at) + (sig[at] === 'A' ? 'B' : 'A') + sig.slice(at + 1);
        const bad = await h.witness.cosign({
          ...req,
          notary: { ...req.notary, value: flipped },
        });
        expect(!bad.ok && bad.error.code).toBe('invalid_notary_signature');
        const changed = await h.witness.cosign({ ...req, core: { ...req.core, created_at: T3 } });
        expect(!changed.ok && changed.error.code).toBe('invalid_notary_signature');
        const none = await h.witness.last();
        expect(none.ok && none.value).toBeNull();
      }));
  });
}
export * from './codehost-contract.js';
