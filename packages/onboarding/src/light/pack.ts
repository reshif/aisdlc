import {
  ONBOARDING_PACK_RENDERER,
  PACK_CODEOWNERS_PATH,
  patchHashOf,
  patchSetOf,
  protectedPushPath,
  type ClaimVerdict,
  type PackFile,
  type PackFileSource,
  type PatchFile,
  type PatchSet,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';

// The affirmed pack rendered for git (PLAN M16 R2b; onboarding-roadmap §4.1 item 7, §6.4; DEC-12(a) record-first).
// Pure and deterministic: the same record renders the same bytes, so the same patch hash, so the X2 decision bound
// to it is a decision on exactly these files. Every file says it is a projection of the factory record: agents read
// the record copy, and the git copy is never re-read as authority.
//
//   AGENTS.md, CLAUDE.md           the text card 2 affirmed, byte for byte (only when it differs from the repo's)
//   .factory/knowledge/claims.yaml  the claims as decided: id, category, text, verdict, the correction, the evidence
//   .factory/knowledge/unknowns.yaml the claims the person said they do not know (what the factory must not assume)
//   .factory/knowledge/pack.json    the manifest: the S0 record, card 2's payload hash, each file's sha256
//
//   .github/CODEOWNERS             only when the record resolved owners (the admin slot as linked GitHub logins) and
//                                   the repo has none: every path owned by them
//
// Left out on purpose: the intent and practices answers (a person's words about risk and data, kept in the record and
// never pushed to a repository that may be public).
// The YAML files are JSON documents (JSON is YAML 1.2), so nothing here needs a YAML writer.

export interface PackInstruction {
  readonly path: string;
  /** The affirmed text (the record copy, by its hash). */
  readonly text: string;
  readonly text_sha256: string;
  /** The repo file's text hash at the census head (`null`: the file is absent). */
  readonly source_text_sha256: string | null;
}

export interface PackClaim {
  readonly claim_id: string;
  readonly category: string;
  readonly text: string;
  readonly verdict: ClaimVerdict;
  readonly correction: string | null;
  readonly evidence: ReadonlyArray<{ readonly path: string; readonly line: number }>;
}

export interface PackInput {
  readonly s0_id: string;
  readonly repo: string;
  readonly base_sha: string;
  readonly c2_card_id: string;
  readonly c2_payload_hash: string;
  readonly instructions: readonly PackInstruction[];
  readonly claims: readonly PackClaim[];
  /** The GitHub logins the record resolved as owners (`pack.codeowners_resolved`); empty or absent: no CODEOWNERS. */
  readonly codeowners?: readonly string[];
}

export interface RenderedPack {
  readonly patch: PatchSet;
  readonly patch_hash: string;
  readonly files: readonly PackFile[];
}

const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;
const HEADER =
  'A projection of the AISDLC factory record, written by the factory. The record is the authority; edits here are not read back.';

/** The pack as a patch, or `null` when nothing would change in the repository. */
export function renderOnboardingPack(i: PackInput): RenderedPack | null {
  const out: Array<{ path: string; source: PackFileSource; content: string }> = [];
  for (const ins of [...i.instructions].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    if (sha256Hex(ins.text) !== ins.text_sha256) {
      throw new Error(`the affirmed text of ${ins.path} does not hash to its record hash`);
    }
    if (ins.source_text_sha256 === ins.text_sha256) continue; // the repo already holds exactly this text
    out.push({ path: ins.path, source: 'affirmed_instructions', content: ins.text });
  }
  const claims = [...i.claims].sort((a, b) => (a.claim_id < b.claim_id ? -1 : 1));
  const claimRows = claims.map((c) => ({
    id: c.claim_id,
    category: c.category,
    text: c.text,
    verdict: c.verdict,
    ...(c.correction === null ? {} : { correction: c.correction }),
    evidence: c.evidence.map((e) => `${e.path}:${e.line}`),
  }));
  out.push({
    path: '.factory/knowledge/claims.yaml',
    source: 'claims',
    content: json({ note: HEADER, s0_record: i.s0_id, claims: claimRows }),
  });
  out.push({
    path: '.factory/knowledge/unknowns.yaml',
    source: 'unknowns',
    content: json({
      note: HEADER,
      s0_record: i.s0_id,
      unknowns: claimRows
        .filter((c) => c.verdict === 'unknown')
        .map((c) => ({ id: c.id, category: c.category, text: c.text })),
    }),
  });
  const owners = [...new Set((i.codeowners ?? []).map((l) => l.toLowerCase()))].sort();
  if (owners.length > 0) {
    out.push({
      path: PACK_CODEOWNERS_PATH,
      source: 'codeowners',
      content: [
        `# ${HEADER}`,
        "# The owners are the project's admin slot, as the GitHub logins linked to their factory principals.",
        `* ${owners.map((l) => `@${l}`).join(' ')}`,
        '',
      ].join('\n'),
    });
  }
  if (!out.some((f) => f.source === 'affirmed_instructions') && claims.length === 0) return null;
  const files = out.map((f) => ({
    path: f.path,
    source: f.source,
    sha256: sha256Hex(f.content),
    bytes: Buffer.byteLength(f.content, 'utf8'),
    protected_rule: protectedPushPath(f.path),
  }));
  const manifest = json({
    note: HEADER,
    renderer: ONBOARDING_PACK_RENDERER,
    s0_record: i.s0_id,
    repo: i.repo,
    base_sha: i.base_sha,
    card_2: { card_id: i.c2_card_id, payload_hash: i.c2_payload_hash },
    files: files.map((f) => ({ path: f.path, source: f.source, sha256: f.sha256 })),
  });
  const all = [
    ...out,
    { path: '.factory/knowledge/pack.json', source: 'manifest' as const, content: manifest },
  ];
  const patchFiles: PatchFile[] = all.map((f) => ({
    op: 'put',
    path: f.path,
    mode: '100644',
    content_b64: b64(f.content),
  }));
  const patch = patchSetOf(patchFiles);
  const metas: PackFile[] = all
    .map((f) => ({
      path: f.path,
      source: f.source,
      sha256: sha256Hex(f.content),
      bytes: Buffer.byteLength(f.content, 'utf8'),
      protected_rule: protectedPushPath(f.path),
    }))
    .sort((a, b) => (a.path < b.path ? -1 : 1));
  return { patch, patch_hash: patchHashOf(patch), files: metas };
}
