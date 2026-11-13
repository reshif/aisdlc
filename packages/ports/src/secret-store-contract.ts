import { describe, expect, it } from 'vitest';
import type { SecretStoreError, SecretStorePort } from './secret-store.js';

// The SecretStorePort contract suite. `secretStoreContract` runs against any adapter: the fake always,
// `VaultSecretStore` against a real Vault (a dev server in Docker) when one is reachable, the AWS stub against its
// fake HTTP server. The harness names a fresh path per test (a real store keeps what earlier runs wrote).

export interface SecretStoreHarness {
  readonly port: SecretStorePort;
  /** A path unique to this run and `label` (lower-case segments). */
  path(label: string): string;
  stop?: () => Promise<void>;
}

function failure(r: { ok: boolean; error?: SecretStoreError }): SecretStoreError {
  if (r.ok || !r.error) throw new Error('expected an error result');
  return r.error;
}

const VALUE = 'sk-test-0123456789abcdef-NOT-A-REAL-KEY';
// a PEM-shaped value, built at run time so the repository's own secret scan does not see one
const PEM_LABEL = ['PRIVATE', 'KEY'].join(' ');
const PEM = `-----BEGIN ${PEM_LABEL}-----\n${'A'.repeat(64)}\n${'B'.repeat(64)}\n-----END ${PEM_LABEL}-----\n`;

export function secretStoreContract(name: string, make: () => Promise<SecretStoreHarness>): void {
  describe(`SecretStorePort contract: ${name}`, () => {
    it('meta of a reference never written: not set, no version', async () => {
      const h = await make();
      const ref = `${h.path('absent')}#value`;
      expect(await h.port.meta(ref)).toEqual({
        ok: true,
        value: { ref, set: false, version: null, updated_at: null },
      });
      expect(failure(await h.port.get(ref)).code).toBe('not_found');
      await h.stop?.();
    });

    it('put stores a version, get returns it, meta says set with the version and never the value', async () => {
      const h = await make();
      const ref = `${h.path('put')}#value`;
      const p1 = await h.port.put(ref, VALUE);
      expect(p1.ok && p1.value.version).toBe(1);
      expect(p1.ok && Number.isNaN(Date.parse(p1.value.updated_at))).toBe(false);
      expect(await h.port.get(ref)).toEqual({ ok: true, value: VALUE });
      const m = await h.port.meta(ref);
      expect(m.ok && m.value).toMatchObject({ ref, set: true, version: 1 });
      expect(JSON.stringify(m)).not.toContain(VALUE);
      expect(JSON.stringify(p1)).not.toContain(VALUE);
      await h.stop?.();
    });

    it('a second put is a new version; multi-line values round-trip exactly', async () => {
      const h = await make();
      const ref = `${h.path('versions')}#value`;
      await h.port.put(ref, VALUE);
      const p2 = await h.port.put(ref, PEM);
      expect(p2.ok && p2.value.version).toBe(2);
      expect(await h.port.get(ref)).toEqual({ ok: true, value: PEM });
      const m = await h.port.meta(ref);
      expect(m.ok && m.value.version).toBe(2);
      await h.stop?.();
    });

    it('delete destroys every version; it is idempotent; a later put starts again', async () => {
      const h = await make();
      const ref = `${h.path('delete')}#value`;
      await h.port.put(ref, VALUE);
      await h.port.put(ref, `${VALUE}-2`);
      expect((await h.port.delete(ref)).ok).toBe(true);
      expect(failure(await h.port.get(ref)).code).toBe('not_found');
      const m = await h.port.meta(ref);
      expect(m.ok && m.value).toMatchObject({ set: false, version: null });
      expect((await h.port.delete(ref)).ok).toBe(true);
      const again = await h.port.put(ref, VALUE);
      expect(again.ok).toBe(true);
      expect(await h.port.get(ref)).toEqual({ ok: true, value: VALUE });
      await h.stop?.();
    });

    it('refuses a reference that is not <path>#<key>, and an empty value; errors never echo a value', async () => {
      const h = await make();
      for (const bad of [
        '',
        'no-key',
        'UPPER/case#value',
        '../escape#value',
        'a//b#value',
        'a/b#',
      ]) {
        expect(failure(await h.port.put(bad, VALUE)).code).toBe('invalid_ref');
        expect(failure(await h.port.meta(bad)).code).toBe('invalid_ref');
      }
      const ref = `${h.path('empty')}#value`;
      const e = failure(await h.port.put(ref, ''));
      expect(e.code).toBe('invalid_value');
      const long = failure(await h.port.put(ref, 'x'.repeat(70_000)));
      expect(long.code).toBe('invalid_value');
      expect(long.message).not.toContain('xxxxxxxx');
      await h.stop?.();
    });
  });
}
