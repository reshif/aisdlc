import { createHash } from 'node:crypto';

/**
 * RFC 6962 (Certificate Transparency) Merkle tree hash.
 *   empty tree      = sha256("")
 *   leaf hash       = sha256(0x00 || leaf data)
 *   node hash       = sha256(0x01 || left || right)
 * A tree of n leaves splits at the largest power of two smaller than n. That is the same tree as
 * folding the binary decomposition of n from the right, which is what `MerkleFrontier` does, so a
 * verifier can append leaves one at a time and keep only O(log n) hashes.
 */

const sha = (...parts: Uint8Array[]): Buffer => {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
};

const LEAF_PREFIX = Buffer.from([0x00]);
const NODE_PREFIX = Buffer.from([0x01]);

export const EMPTY_MERKLE_ROOT_HEX: string = sha().toString('hex');

export function merkleLeafHash(data: Uint8Array): Buffer {
  return sha(LEAF_PREFIX, data);
}

export function merkleNodeHash(left: Uint8Array, right: Uint8Array): Buffer {
  return sha(NODE_PREFIX, left, right);
}

/** Serialisable state of a `MerkleFrontier`: the tree size and the hex peaks, largest subtree first. */
export interface MerkleFrontierState {
  size: number;
  peaks: string[];
}

/** Append-only compact range of an RFC 6962 tree. */
export class MerkleFrontier {
  private peaks: Buffer[] = [];
  private n = 0;

  get size(): number {
    return this.n;
  }

  /** Appends one leaf (the raw leaf data, not its hash). */
  append(data: Uint8Array): void {
    let h = merkleLeafHash(data);
    // Merge equal-size subtrees: one carry per trailing 1-bit of the size.
    for (let s = this.n; s & 1; s >>= 1) {
      h = merkleNodeHash(this.peaks.pop() as Buffer, h);
    }
    this.peaks.push(h);
    this.n += 1;
  }

  /** Root hash (hex) of the tree over everything appended so far. */
  root(): string {
    if (this.peaks.length === 0) return EMPTY_MERKLE_ROOT_HEX;
    let acc = this.peaks[this.peaks.length - 1] as Buffer;
    for (let i = this.peaks.length - 2; i >= 0; i--) {
      acc = merkleNodeHash(this.peaks[i] as Buffer, acc);
    }
    return acc.toString('hex');
  }

  state(): MerkleFrontierState {
    return { size: this.n, peaks: this.peaks.map((p) => p.toString('hex')) };
  }

  /** Restores a frontier; rejects a state whose peak count does not match the size. */
  static from(state: MerkleFrontierState): MerkleFrontier {
    const f = new MerkleFrontier();
    const expected = state.size.toString(2).split('1').length - 1;
    if (!Number.isInteger(state.size) || state.size < 0 || state.peaks.length !== expected) {
      throw new RangeError('MerkleFrontier.from: peaks do not match size');
    }
    for (const p of state.peaks) {
      if (!/^[0-9a-f]{64}$/.test(p)) throw new RangeError('MerkleFrontier.from: bad peak');
    }
    f.peaks = state.peaks.map((p) => Buffer.from(p, 'hex'));
    f.n = state.size;
    return f;
  }
}

/** Root hash (hex) over the given leaf data, in order. */
export function merkleRoot(leaves: Iterable<Uint8Array>): string {
  const f = new MerkleFrontier();
  for (const l of leaves) f.append(l);
  return f.root();
}
