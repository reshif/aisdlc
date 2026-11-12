import {
  ONBOARDING_PACK_RENDERER,
  ORACLE_LOCK_PATH,
  ORACLE_LOCK_SCHEMA_ID,
  patchHashOf,
  patchSetOf,
  protectedPushPath,
  type OracleLockProposal,
  type PackFile,
  type PackFileSource,
  type PatchFile,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import type { RenderedPack } from '../light/pack.js';

// The Full pack rendered for git (PLAN M17, "the oracle lock through X2"; OB §6.2 row 0.3; DEC-12(a) record-first,
// DEC-13(a)(i)). Pure and deterministic, like card 2's pack: the same record renders the same bytes, so the same
// patch hash, so the X2 decision bound to it is a decision on exactly these files.
//
//   .factory/oracle-lock.json        the oracle lock card 3 approved: the tests by path and blob, and its lock hash
//   specs/<area>.md                  each seed card 3 affirmed or corrected (`intended`), the person's text if corrected
//   .factory/knowledge/full-pack.json the manifest: the S0 record, card 3's payload hash, each file's sha256
//
// Seeds kept `observed` are not written: what the code merely does is not a specification yet. Golden tasks, the
// exam and the interview answers stay in the record (a public repository must not receive a person's answers).

export interface FullPackSeed {
  readonly seed_id: string;
  readonly area: string;
  readonly path: string;
  /** The text now held: the factory's seed, or the person's correction. */
  readonly text: string;
  readonly text_sha256: string;
}

export interface FullPackInput {
  readonly s0_id: string;
  readonly repo: string;
  readonly base_sha: string;
  readonly c3_card_id: string;
  readonly c3_payload_hash: string;
  readonly oracle_lock: OracleLockProposal;
  /** The seeds card 3 made `intended` (affirmed or corrected). */
  readonly seeds: readonly FullPackSeed[];
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const HEADER =
  'A projection of the AISDLC factory record, written by the factory. The record is the authority; edits here are not read back.';

/** The Full pack as a patch, or `null` when card 3 approved nothing to write (no test to lock, no intended seed). */
export function renderFullPack(i: FullPackInput): RenderedPack | null {
  const out: Array<{ path: string; source: PackFileSource; content: string }> = [];
  if (i.oracle_lock.tests.length > 0) {
    const tests = [...i.oracle_lock.tests].sort((a, b) => (a.path < b.path ? -1 : 1));
    out.push({
      path: ORACLE_LOCK_PATH,
      source: 'oracle_lock',
      content: json({
        note: HEADER,
        schema: ORACLE_LOCK_SCHEMA_ID,
        s0_record: i.s0_id,
        base_sha: i.base_sha,
        lock_hash: i.oracle_lock.lock_hash,
        truncated: i.oracle_lock.truncated,
        tests: tests.map((t) => ({ path: t.path, blob: t.blob })),
      }),
    });
  }
  const seen = new Set<string>();
  for (const s of [...i.seeds].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (sha256Hex(s.text) !== s.text_sha256) {
      throw new Error(`the seed ${s.seed_id} does not hash to its record hash`);
    }
    if (seen.has(s.path)) throw new Error(`two seeds for ${s.path}`);
    seen.add(s.path);
    const body = s.text.endsWith('\n') ? s.text : `${s.text}\n`;
    out.push({
      path: s.path,
      source: 'seed',
      content: `<!-- ${HEADER} status: intended; seed: ${s.seed_id}; area: ${s.area} -->\n\n${body}`,
    });
  }
  if (out.length === 0) return null;
  const meta = (f: { path: string; source: PackFileSource; content: string }): PackFile => ({
    path: f.path,
    source: f.source,
    sha256: sha256Hex(f.content),
    bytes: Buffer.byteLength(f.content, 'utf8'),
    protected_rule: protectedPushPath(f.path),
  });
  const manifest = json({
    note: HEADER,
    renderer: ONBOARDING_PACK_RENDERER,
    kind: 'full',
    s0_record: i.s0_id,
    repo: i.repo,
    base_sha: i.base_sha,
    card_3: { card_id: i.c3_card_id, payload_hash: i.c3_payload_hash },
    oracle_lock_hash: i.oracle_lock.lock_hash,
    files: out.map(meta).map((f) => ({ path: f.path, source: f.source, sha256: f.sha256 })),
  });
  const all = [
    ...out,
    { path: '.factory/knowledge/full-pack.json', source: 'manifest' as const, content: manifest },
  ];
  const patchFiles: PatchFile[] = all.map((f) => ({
    op: 'put',
    path: f.path,
    mode: '100644',
    content_b64: b64(f.content),
  }));
  const patch = patchSetOf(patchFiles);
  const files = all.map(meta).sort((a, b) => (a.path < b.path ? -1 : 1));
  return { patch, patch_hash: patchHashOf(patch), files };
}
