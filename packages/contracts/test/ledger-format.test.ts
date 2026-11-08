import { generateKeyPairSync, sign } from 'node:crypto';
import { sha256Hex, b64urlEncode } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import {
  LedgerEntry,
  LedgerEntryDraft,
  LedgerTimestamp,
  checkCheckpointSignature,
  checkLedgerEntrySignature,
  checkpointDigestHex,
  checkpointMessage,
  computeLedgerEntryHash,
  draftOfEntry,
  ledgerDraftHash,
  ledgerEntryMessage,
} from '../src/index.js';

const draft = LedgerEntryDraft.parse({
  entry_id: '0194f3a0-0000-7000-8000-000000000001',
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
  body: { b: 1, a: [true, null] },
  created_at: '2026-11-08T10:00:00.123Z',
});

const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'dev:notary' };
const signMsg = (m: Uint8Array): string =>
  b64urlEncode(sign('sha256', m, { key: privateKey, dsaEncoding: 'ieee-p1363' }));

describe('ledger format', () => {
  it('timestamps must be in toISOString form', () => {
    expect(LedgerTimestamp.safeParse('2026-11-08T10:00:00.123Z').success).toBe(true);
    expect(LedgerTimestamp.safeParse('2026-11-08T10:00:00Z').success).toBe(false);
    expect(LedgerTimestamp.safeParse('2026-11-08T10:00:00.1234Z').success).toBe(false);
  });

  it('a decision draft needs every gate field', () => {
    expect(LedgerEntryDraft.safeParse({ ...draft, entry_type: 'decision' }).success).toBe(false);
  });

  it('entry hash is independent of key order, covers seq and prev_hash, and is the signed digest', () => {
    const h1 = computeLedgerEntryHash(draft, 1, null);
    const reordered = { ...draft, body: { a: [true, null], b: 1 } };
    expect(computeLedgerEntryHash(reordered, 1, null)).toBe(h1);
    expect(computeLedgerEntryHash(draft, 2, 'a'.repeat(64))).not.toBe(h1);
    expect(sha256Hex(ledgerEntryMessage(draft, 1, null))).toBe(h1);
    expect(ledgerDraftHash(draft)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('verifies a signature with the JWK alone and rejects tampering', async () => {
    const hash = computeLedgerEntryHash(draft, 1, null);
    const value = signMsg(ledgerEntryMessage(draft, 1, null));
    const entry = LedgerEntry.parse({
      ...draft,
      ledger_seq: 1,
      prev_hash: null,
      entry_hash: hash,
      notary: { key_id: 'dev:notary', alg: 'ES256', value },
    });
    expect(draftOfEntry(entry)).toEqual(draft);
    expect(await checkLedgerEntrySignature(entry, jwk)).toBeNull();
    expect(await checkLedgerEntrySignature({ ...entry, body: { x: 1 } }, jwk)).toBe(
      'entry_hash_mismatch',
    );
    expect(
      await checkLedgerEntrySignature({ ...entry, notary: { ...entry.notary, key_id: 'x' } }, jwk),
    ).toBe('wrong_key_id');
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'jwk',
    });
    expect(await checkLedgerEntrySignature(entry, other)).toBe('bad_signature');
  });

  it('checkpoint digest covers every field', async () => {
    const cp = {
      cp_seq: 1,
      from_ledger_seq: 1,
      to_ledger_seq: 4,
      root_hash: 'a'.repeat(64),
      head_hash: 'b'.repeat(64),
      created_at: '2026-11-08T10:05:00.000Z',
    };
    const d = checkpointDigestHex(cp);
    expect(checkpointDigestHex({ ...cp, root_hash: 'c'.repeat(64) })).not.toBe(d);
    expect(checkpointDigestHex({ ...cp, cp_seq: 2 })).not.toBe(d);
    const sig = { key_id: 'dev:notary', alg: 'ES256', value: signMsg(checkpointMessage(cp)) };
    expect(await checkCheckpointSignature(cp, sig, jwk)).toBeNull();
    expect(await checkCheckpointSignature({ ...cp, to_ledger_seq: 5 }, sig, jwk)).toBe(
      'bad_signature',
    );
  });
});
