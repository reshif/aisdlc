import { patchHashOf } from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import { renderOnboardingPack, type PackInput } from '../src/index.js';

const AGENTS = '# app\n\n## Commands\n\n- `npm test`\n\n## Boundaries\n\n- Never push to main.\n';
const input = (over: Partial<PackInput> = {}): PackInput => ({
  s0_id: '01970000-0000-7000-8000-000000000001',
  repo: 'acme/app',
  base_sha: 'a'.repeat(40),
  c2_card_id: '01970000-0000-7000-8000-000000000002',
  c2_payload_hash: 'b'.repeat(64),
  instructions: [
    {
      path: 'AGENTS.md',
      text: AGENTS,
      text_sha256: sha256Hex(AGENTS),
      source_text_sha256: sha256Hex('# app\n'),
    },
  ],
  claims: [
    {
      claim_id: 'cl-0000000000000002',
      category: 'build',
      text: 'Tests run with npm test',
      verdict: 'affirm',
      correction: null,
      evidence: [{ path: 'package.json', line: 4 }],
    },
    {
      claim_id: 'cl-0000000000000001',
      category: 'deploy',
      text: 'Merges deploy to production',
      verdict: 'unknown',
      correction: null,
      evidence: [{ path: '.github/workflows/ci.yml', line: 9 }],
    },
  ],
  ...over,
});
const text = (r: NonNullable<ReturnType<typeof renderOnboardingPack>>, path: string) => {
  const f = r.patch.files.find((x) => x.path === path);
  return f && f.op === 'put' ? Buffer.from(f.content_b64, 'base64').toString('utf8') : null;
};

describe('the onboarding pack, rendered from the record', () => {
  it('the affirmed text byte for byte, the claims and unknowns, a manifest; every file a protected path', () => {
    const r = renderOnboardingPack(input());
    if (!r) throw new Error('nothing rendered');
    expect(r.files.map((f) => f.path)).toEqual([
      '.factory/knowledge/claims.yaml',
      '.factory/knowledge/pack.json',
      '.factory/knowledge/unknowns.yaml',
      'AGENTS.md',
    ]);
    expect(r.files.map((f) => f.protected_rule)).toEqual([
      '.factory/**',
      '.factory/**',
      '.factory/**',
      'AGENTS.md',
    ]);
    expect(text(r, 'AGENTS.md')).toBe(AGENTS);
    const claims = JSON.parse(text(r, '.factory/knowledge/claims.yaml') ?? '{}');
    expect(claims.claims.map((c: { id: string }) => c.id)).toEqual([
      'cl-0000000000000001',
      'cl-0000000000000002',
    ]);
    expect(JSON.parse(text(r, '.factory/knowledge/unknowns.yaml') ?? '{}').unknowns).toEqual([
      { id: 'cl-0000000000000001', category: 'deploy', text: 'Merges deploy to production' },
    ]);
    const manifest = JSON.parse(text(r, '.factory/knowledge/pack.json') ?? '{}');
    expect(manifest).toMatchObject({
      renderer: 'onboarding-pack/1',
      card_2: { payload_hash: 'b'.repeat(64) },
    });
    expect(manifest.note).toMatch(/record is the authority/);
    // nothing of the intent or practices answers is ever rendered
    expect(JSON.stringify(r.patch)).not.toContain('intent');
    expect(r.patch_hash).toBe(patchHashOf(r.patch));
  });

  it('deterministic: the same record is the same patch hash; a different claim verdict is another', () => {
    const a = renderOnboardingPack(input());
    const b = renderOnboardingPack({ ...input(), claims: [...input().claims].reverse() });
    expect(a?.patch_hash).toBe(b?.patch_hash);
    const c = renderOnboardingPack({
      ...input(),
      claims: input().claims.map((x) => ({ ...x, verdict: 'affirm' as const })),
    });
    expect(c?.patch_hash).not.toBe(a?.patch_hash);
  });

  it('an instruction file the repo already holds verbatim is not rewritten; a text that does not hash is refused', () => {
    const same = renderOnboardingPack(
      input({
        instructions: [
          {
            path: 'AGENTS.md',
            text: AGENTS,
            text_sha256: sha256Hex(AGENTS),
            source_text_sha256: sha256Hex(AGENTS),
          },
        ],
      }),
    );
    expect(same?.files.map((f) => f.path)).not.toContain('AGENTS.md');
    expect(() =>
      renderOnboardingPack(
        input({
          instructions: [
            {
              path: 'AGENTS.md',
              text: AGENTS,
              text_sha256: 'c'.repeat(64),
              source_text_sha256: null,
            },
          ],
        }),
      ),
    ).toThrow(/does not hash/);
  });
});
