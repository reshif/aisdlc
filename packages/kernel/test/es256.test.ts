import { generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { b64urlDecode, b64urlEncode, verifyEs256 } from '../src/index.js';

describe('verifyEs256', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const msg = new TextEncoder().encode('hello');
  const sig = b64urlEncode(
    createSign('sha256').update(msg).sign({ key: privateKey, dsaEncoding: 'ieee-p1363' }),
  );

  it('accepts a good signature and rejects a changed message, key or signature', async () => {
    expect(await verifyEs256(jwk, msg, sig)).toBe(true);
    expect(await verifyEs256(jwk, new TextEncoder().encode('hellO'), sig)).toBe(false);
    const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({
      format: 'jwk',
    });
    expect(await verifyEs256(other, msg, sig)).toBe(false);
    expect(await verifyEs256(jwk, msg, sig.slice(0, -2))).toBe(false);
    expect(await verifyEs256({ kty: 'RSA' }, msg, sig)).toBe(false);
    expect(await verifyEs256(jwk, msg, '***')).toBe(false);
  });

  it('base64url round-trips and rejects other alphabets', () => {
    const b = Uint8Array.from([251, 255, 0, 1]);
    expect(b64urlDecode(b64urlEncode(b))).toEqual(b);
    expect(() => b64urlDecode('a+b/')).toThrow();
  });
});
