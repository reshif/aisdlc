import type { KeyCustodyPort } from '@aisdlc/ports';
import { ScanFailure } from './git.js';

/** The kms-local key the knowledge caller may use (kms-local's allow list: caller `knowledge`). */
export const FINGERPRINT_KEY_ID = 'dev:fingerprint-hmac';

export interface Fingerprinter {
  /**
   * HMAC(factory key, value) for each value, in order, as lowercase hex. The key never enters this
   * process: every MAC is a call to kms-local through `KeyCustodyPort` (OB §5.3 item 4). Equal
   * values are sent once (a batch), and at most `concurrency` calls are in flight.
   */
  fingerprints(values: readonly Buffer[]): Promise<string[]>;
}

export function kmsFingerprinter(
  custody: KeyCustodyPort,
  opts: { keyId?: string; concurrency?: number } = {},
): Fingerprinter {
  const keyId = opts.keyId ?? FINGERPRINT_KEY_ID;
  const concurrency = Math.max(1, opts.concurrency ?? 8);
  return {
    async fingerprints(values) {
      const unique = new Map<string, Buffer>();
      for (const v of values) unique.set(v.toString('base64'), v);
      const macs = new Map<string, string>();
      const queue = [...unique];
      const worker = async (): Promise<void> => {
        for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
          const [key, value] = next;
          // An error is a refusal: the scan cannot say what it found without a fingerprint.
          const r = await custody.hmac(keyId, value);
          if (!r.ok)
            throw new ScanFailure(
              'fingerprint_unavailable',
              `kms-local refused the fingerprint: ${r.error.kind}`,
            );
          if (!/^[0-9a-f]{64}$/.test(r.value)) {
            throw new ScanFailure(
              'fingerprint_unavailable',
              'kms-local answered with a malformed MAC',
            );
          }
          macs.set(key, r.value);
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
      return values.map((v) => macs.get(v.toString('base64')) as string);
    },
  };
}
