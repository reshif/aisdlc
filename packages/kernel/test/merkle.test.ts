import { describe, expect, it } from 'vitest';
import {
  EMPTY_MERKLE_ROOT_HEX,
  MerkleFrontier,
  merkleLeafHash,
  merkleNodeHash,
  merkleRoot,
} from '../src/index.js';

const bytes = (...b: number[]): Uint8Array => Uint8Array.from(b);
const range = (from: number, to: number): number[] =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

// The RFC 6962 / Certificate Transparency reference leaves and roots (Trillian test vectors).
const LEAVES = [
  bytes(),
  bytes(0x00),
  bytes(0x10),
  bytes(0x20, 0x21),
  bytes(0x30, 0x31),
  bytes(0x40, 0x41, 0x42, 0x43),
  bytes(...range(0x50, 0x57)),
  bytes(...range(0x60, 0x6f)),
];
const ROOTS = [
  '6e340b9cffb37a989ca544e6bb780a2c78901d3fb33738768511a30617afa01d',
  'fac54203e7cc696cf0dfcb42c92a1d9dbaf70ad9e621f4bd8d98662f00e3c125',
  'aeb6bcfe274b70a14fb067a5e5578264db0fa9b51af5e0ba159158f329e06e77',
  'd37ee418976dd95753c1c73862b9398fa2a2cf9b4ff0fdfe8b30cd95209614b7',
  '4e3bbb1f7b478dcfe71fb631631519a3bca12c9aefca1612bfce4c13a86264d4',
  '76e67dadbcdf1e10e1b74ddc608abd2f98dfb16fbce75277b5232a127f2087ef',
  'ddb89be403809e325750d3d263cd78929c2942b7942a34b77e122c9594a74c8c',
  '5dc9da79a70659a9ad559cb701ded9a2ab9d823aad2f4960cfe370eff4604328',
];

/** The RFC 6962 §2.1 definition, written recursively and independently of the frontier. */
function reference(leaves: Uint8Array[]): Buffer {
  if (leaves.length === 0) return Buffer.from(EMPTY_MERKLE_ROOT_HEX, 'hex');
  if (leaves.length === 1) return merkleLeafHash(leaves[0] as Uint8Array);
  let k = 1;
  while (k * 2 < leaves.length) k *= 2;
  return merkleNodeHash(reference(leaves.slice(0, k)), reference(leaves.slice(k)));
}

describe('merkle (RFC 6962)', () => {
  it('empty tree is sha256 of the empty string', () => {
    expect(EMPTY_MERKLE_ROOT_HEX).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(merkleRoot([])).toBe(EMPTY_MERKLE_ROOT_HEX);
  });

  it('matches the published vectors for 1..8 leaves', () => {
    ROOTS.forEach((root, i) => expect(merkleRoot(LEAVES.slice(0, i + 1))).toBe(root));
  });

  it('frontier equals the recursive definition for every size up to 70', () => {
    const leaves = Array.from({ length: 70 }, (_, i) => bytes(i, i >> 1, 7));
    const f = new MerkleFrontier();
    for (let n = 1; n <= 70; n++) {
      f.append(leaves[n - 1] as Uint8Array);
      expect(f.root()).toBe(reference(leaves.slice(0, n)).toString('hex'));
    }
  });

  it('a restored frontier continues to the same root', () => {
    const f = new MerkleFrontier();
    for (let i = 0; i < 13; i++) f.append(bytes(i));
    const g = MerkleFrontier.from(f.state());
    for (let i = 13; i < 21; i++) {
      f.append(bytes(i));
      g.append(bytes(i));
    }
    expect(g.root()).toBe(f.root());
    expect(() => MerkleFrontier.from({ size: 3, peaks: [] })).toThrow();
  });

  it('changing one leaf changes the root', () => {
    const a = merkleRoot([bytes(1), bytes(2), bytes(3)]);
    expect(merkleRoot([bytes(1), bytes(9), bytes(3)])).not.toBe(a);
  });
});
