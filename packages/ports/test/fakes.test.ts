import { checkpointDigestHex } from '@aisdlc/contracts';
import { b64urlEncode, verifyEs256 } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import {
  FakeNotary,
  FakeWitness,
  fakeKeyCustody,
  hexBytes,
  type KeyCustodyPort,
} from '../src/index.js';
import { notaryConformance, witnessConformance } from '../src/testing.js';

describe('fakeKeyCustody', () => {
  it('is deterministic: same seed, same keys and signatures', async () => {
    const a = fakeKeyCustody({ seed: 's' });
    const b = fakeKeyCustody({ seed: 's' });
    const c = fakeKeyCustody({ seed: 't' });
    const digest = new Uint8Array(32).fill(7);
    expect(await a.publicKey('dev:notary')).toEqual(await b.publicKey('dev:notary'));
    expect(await a.sign('dev:notary', digest)).toEqual(await b.sign('dev:notary', digest));
    expect(await a.publicKey('dev:notary')).not.toEqual(await c.publicKey('dev:notary'));
    expect(await a.publicKey('dev:notary')).not.toEqual(await a.publicKey('dev:witness'));
    expect(await a.hmac('dev:fingerprint-hmac', digest)).toEqual(
      await b.hmac('dev:fingerprint-hmac', digest),
    );
  });

  it('signs so that WebCrypto verifies over the message behind the digest', async () => {
    const k = fakeKeyCustody();
    const msg = new TextEncoder().encode('m');
    const digest = hexBytes((await import('@aisdlc/kernel')).sha256Hex(msg));
    const sig = await k.sign('dev:witness', digest);
    const jwk = await k.publicKey('dev:witness');
    expect(sig.ok && jwk.ok && (await verifyEs256(jwk.value, msg, b64urlEncode(sig.value)))).toBe(
      true,
    );
  });

  it('refuses unknown ids, the wrong key type and bad digests', async () => {
    const k = fakeKeyCustody();
    const d = new Uint8Array(32);
    const r1 = await k.sign('dev:nope', d);
    expect(!r1.ok && r1.error.kind).toBe('unknown_key');
    const r2 = await k.sign('dev:fingerprint-hmac', d);
    expect(!r2.ok && r2.error.kind).toBe('wrong_key_type');
    const r3 = await k.hmac('dev:notary', d);
    expect(!r3.ok && r3.error.kind).toBe('wrong_key_type');
    const r4 = await k.sign('dev:notary', new Uint8Array(5));
    expect(!r4.ok && r4.error.kind).toBe('invalid_request');
  });
});

notaryConformance('FakeNotary', async () => ({
  notary: new FakeNotary(fakeKeyCustody()),
}));

witnessConformance('FakeWitness', async () => {
  const custody: KeyCustodyPort = fakeKeyCustody();
  const key = async (id: string) => {
    const k = await custody.publicKey(id);
    if (!k.ok) throw new Error('no key');
    return k.value;
  };
  return {
    witness: new FakeWitness(custody),
    notary: new FakeNotary(custody),
    forkedNotary: new FakeNotary(custody),
    notaryKey: () => key('dev:notary'),
    witnessKey: () => key('dev:witness'),
    signAsNotary: async (core) => {
      const s = await custody.sign('dev:notary', hexBytes(checkpointDigestHex(core)));
      if (!s.ok) throw new Error('sign');
      return { key_id: 'dev:notary', alg: 'ES256', value: b64urlEncode(s.value) };
    },
  };
});
