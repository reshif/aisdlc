import { ORACLE_LOCK_PATH, patchHashOf } from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import { buildFullBaseline, renderFullPack, type FullPackInput } from '../src/index.js';
import { CENSUS_HASH, FACTS, HEAD, S0, graphFixture } from './full-fixtures.js';

// M17, the oracle lock through X2: card 3's oracle lock and its intended seeds rendered for git, pure and
// deterministic (the same record, the same bytes, the same patch hash X2 is bound to).

const baseline = () => {
  const b = buildFullBaseline({
    s0_id: S0,
    repo: 'acme/app',
    census_hash: CENSUS_HASH,
    baseline_sha: HEAD,
    graph: graphFixture(),
    facts: FACTS,
  });
  if (!b.ok) throw new Error(b.error.message);
  return b.value;
};

const input = (o: Partial<FullPackInput> = {}): FullPackInput => {
  const b = baseline();
  const seed = b.seeds[0];
  if (!seed) throw new Error('the fixture has seeds');
  return {
    s0_id: S0,
    repo: 'acme/app',
    base_sha: HEAD,
    c3_card_id: '00000000-0000-4000-8000-0000000000c3',
    c3_payload_hash: 'c'.repeat(64),
    oracle_lock: b.oracle_lock,
    seeds: [
      {
        seed_id: seed.seed_id,
        area: seed.area,
        path: seed.path,
        text: seed.text,
        text_sha256: seed.text_sha256,
      },
    ],
    ...o,
  };
};

const text = (r: ReturnType<typeof renderFullPack>, path: string): string => {
  const f = r?.patch.files.find((x) => x.path === path);
  return f && f.op === 'put' ? Buffer.from(f.content_b64, 'base64').toString('utf8') : '';
};

describe('renderFullPack', () => {
  it('renders the oracle lock, the intended seeds and a manifest; deterministic; the lock is a protected path', () => {
    const i = input();
    const r = renderFullPack(i);
    expect(r).not.toBeNull();
    expect(renderFullPack(input())).toEqual(r);
    expect(r?.patch_hash).toBe(patchHashOf(r!.patch));
    expect(r?.files.map((f) => [f.path, f.source])).toEqual(
      [
        ['.factory/knowledge/full-pack.json', 'manifest'],
        [ORACLE_LOCK_PATH, 'oracle_lock'],
        [i.seeds[0]!.path, 'seed'],
      ].sort((a, b) => (a[0]! < b[0]! ? -1 : 1)),
    );
    expect(r?.files.find((f) => f.path === ORACLE_LOCK_PATH)?.protected_rule).toBe('.factory/**');
    const lock = JSON.parse(text(r, ORACLE_LOCK_PATH));
    expect(lock).toMatchObject({
      schema: 'oracle-lock/1',
      s0_record: S0,
      base_sha: HEAD,
      lock_hash: i.oracle_lock.lock_hash,
    });
    expect(lock.tests).toHaveLength(i.oracle_lock.tests.length);
    expect(lock.note).toMatch(/record is the authority/);
    expect(text(r, i.seeds[0]!.path)).toContain('status: intended');
    const manifest = JSON.parse(text(r, '.factory/knowledge/full-pack.json'));
    expect(manifest).toMatchObject({ kind: 'full', card_3: { payload_hash: 'c'.repeat(64) } });
    for (const f of r!.files) {
      if (f.source !== 'manifest')
        expect(manifest.files.map((m: { path: string }) => m.path)).toContain(f.path);
    }
  });

  it('a different correction is a different patch; a text that does not hash to its record hash is refused', () => {
    const a = renderFullPack(input());
    const corrected = 'The area keeps money in integer cents.\n';
    const seed = input().seeds[0]!;
    const b = renderFullPack(
      input({ seeds: [{ ...seed, text: corrected, text_sha256: sha256Hex(corrected) }] }),
    );
    expect(b?.patch_hash).not.toBe(a?.patch_hash);
    expect(() => renderFullPack(input({ seeds: [{ ...seed, text: corrected }] }))).toThrow(
      /does not hash/,
    );
  });

  it('nothing to lock and no intended seed: nothing to write', () => {
    const b = baseline();
    expect(
      renderFullPack(input({ seeds: [], oracle_lock: { ...b.oracle_lock, tests: [] } })),
    ).toBeNull();
    // only seeds: no lock file
    const r = renderFullPack(input({ oracle_lock: { ...b.oracle_lock, tests: [] } }));
    expect(r?.files.some((f) => f.path === ORACLE_LOCK_PATH)).toBe(false);
  });
});
