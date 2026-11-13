import {
  ApplyPatchRequest,
  RedraftPrRequest,
  badPatchPath,
  badPushBranch,
  isWorkflowPath,
  patchHashOf,
  protectedPushPath,
  replanCommentOf,
  type CodeHostNotOk,
  type CodeHostRead,
  type PushEvidence,
  type PushLeaseFacts,
  type PushRefusalCode,
} from '@aisdlc/contracts';
import { scanText } from '@aisdlc/secrets-rules';
import { readUnknown, readUnreadable } from './codehost.js';

// The Push Broker's checks (PLAN M13.6), written ONCE: the in-memory fake and the GitHub adapter call `preflightPush`
// and make no request before it says yes. Everything here is a function of the request and of what the Unit's owner
// (core) says about the Unit's lease and about an X2 decision; nothing here reaches GitHub.
//
//   1. the request has the shape (zod), the branch is `agent/<item>/<unit>` and no other ref, the lane is not a spike;
//   2. every path is a plain relative path (no `..`, no `.git`, no backslash, no symlink or submodule mode, no
//      workflow file, no file-under-file clash), the patch is bounded;
//   3. the shared secret ruleset runs over every file's content: any hit refuses the whole patch (rule ids only);
//   4. the lease: the Unit's owner says the lease is held at exactly the epoch the writer holds (stale: refused);
//   5. protected paths (AGENTS.md, CLAUDE.md, CODEOWNERS, .factory/**, .claude/**, .mcp.json): refused unless an X2
//      decision in the ledger is bound to exactly this patch's hash (SP-FID-3). A different patch is a different hash.
//
// Fail closed: a guard that cannot answer is `unknown`, which refuses; a refusal is never turned into an approval.

/** Asked of the Unit's owner (core); a deployment without one allows nothing. */
export interface PushGuardsPort {
  /** The Unit's lease: held or not, at which epoch, and the item's lane (a spike never pushes). */
  lease(item_id: string, unit_key: string): Promise<CodeHostRead<PushLeaseFacts>>;
  /** Is there an APPROVED X2 decision in the ledger bound to this item and exactly this patch hash? */
  x2Bound(item_id: string, patch_hash: string): Promise<CodeHostRead<boolean>>;
}

export const refusal = (code: PushRefusalCode, message: string): CodeHostNotOk => ({
  state: 'unreadable',
  reason: 'refused',
  code,
  message,
});

/** The refusal code of a not-ok write, if it carries one the broker knows. */
export const refusalCodeOf = (r: CodeHostNotOk): string | null => r.code ?? null;

/** A fake of the Unit's owner: the leases and X2 decisions a test sets. */
export class FakePushGuards implements PushGuardsPort {
  readonly asked: string[] = [];
  private leases = new Map<string, PushLeaseFacts>();
  private x2 = new Set<string>();
  private down = false;

  setLease(item_id: string, unit_key: string, facts: PushLeaseFacts): this {
    this.leases.set(`${item_id}/${unit_key}`, facts);
    return this;
  }
  /** An approved X2 decision bound to this patch hash for this item. */
  approveX2(item_id: string, patch_hash: string): this {
    this.x2.add(`${item_id}/${patch_hash}`);
    return this;
  }
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async lease(item_id: string, unit_key: string): Promise<CodeHostRead<PushLeaseFacts>> {
    this.asked.push(`lease:${item_id}/${unit_key}`);
    if (this.down) return readUnknown('network', 'the Unit owner did not answer');
    const l = this.leases.get(`${item_id}/${unit_key}`);
    return { state: 'ok', value: l ?? { held: false, epoch: 0, lane: 'L4' } };
  }
  async x2Bound(item_id: string, patch_hash: string): Promise<CodeHostRead<boolean>> {
    this.asked.push(`x2:${item_id}/${patch_hash}`);
    if (this.down) return readUnknown('network', 'the Unit owner did not answer');
    return { state: 'ok', value: this.x2.has(`${item_id}/${patch_hash}`) };
  }
}

/** A guard set that allows nothing: what a code host without a Unit owner behind it has. */
export const NO_PUSH_GUARDS: PushGuardsPort = {
  lease: async () =>
    readUnreadable('forbidden', 'no Unit owner is configured: nothing may be pushed'),
  x2Bound: async () =>
    readUnreadable('forbidden', 'no Unit owner is configured: nothing may be pushed'),
};

export const PATCH_MAX_BYTES = 20 * 1024 * 1024;

export interface Preflight {
  readonly req: ApplyPatchRequest;
  readonly patch_hash: string;
  /** Protected-path rules the patch touches (the X2 decision covers them). */
  readonly protected_rules: readonly string[];
  readonly bytes: number;
}

/**
 * Everything the broker checks before it asks GitHub anything. `ok: false` carries the refusal (never a secret value).
 */
export async function preflightPush(
  input: unknown,
  guards: PushGuardsPort,
): Promise<{ ok: true; value: Preflight } | { ok: false; error: CodeHostNotOk }> {
  const no = (code: PushRefusalCode, message: string) => ({
    ok: false as const,
    error: refusal(code, message),
  });
  // A branch outside agent/** is refused before anything else is looked at (and so before the network).
  const rawBranch = (input as { branch?: unknown } | null)?.branch;
  if (typeof rawBranch !== 'string' || !rawBranch.startsWith('agent/')) {
    return no('branch_not_allowed', 'only refs under agent/ are written');
  }
  const parsed = ApplyPatchRequest.safeParse(input);
  if (!parsed.success) return no('bad_patch', 'the request is not a valid patch request');
  const req = parsed.data;
  const badBranch = badPushBranch(req.branch, req.item_id, req.unit_key);
  if (badBranch) return no('branch_not_allowed', badBranch);
  if (req.lane === 'L7') return no('spike_lane', 'a spike never reaches the Push Broker');

  // paths
  const seen = new Set<string>();
  let bytes = 0;
  const putPaths: string[] = [];
  for (const f of req.patch.files) {
    const bad = badPatchPath(f.path);
    if (bad) return no('bad_path', `${f.path.slice(0, 80)}: ${bad}`);
    const key = f.path.normalize('NFC').toLowerCase();
    if (seen.has(key)) return no('bad_patch', 'the patch names a path twice');
    seen.add(key);
    if (isWorkflowPath(f.path)) {
      return no(
        'workflow_path',
        'workflow files are never written (the factory has no workflows permission)',
      );
    }
    if (f.op === 'put') {
      putPaths.push(key);
      bytes += Math.floor((f.content_b64.length * 3) / 4);
    }
  }
  // a file and a directory of the same name in one patch cannot both be written
  for (const p of putPaths) {
    if ([...seen].some((q) => q.startsWith(`${p}/`))) {
      return no('bad_patch', 'the patch writes a file and something under it');
    }
  }
  if (bytes > PATCH_MAX_BYTES) return no('bad_patch', 'the patch is too large');

  // the shared secret ruleset, over every file: one hit refuses the whole patch
  const rules = new Set<string>();
  for (const f of req.patch.files) {
    if (f.op !== 'put') continue;
    const text = Buffer.from(f.content_b64, 'base64').toString('utf8');
    for (const m of scanText(text)) rules.add(m.rule_id);
  }
  if (rules.size > 0) {
    return no('secret_in_patch', `the shared secret ruleset hit (${[...rules].sort().join(', ')})`);
  }

  const patch_hash = patchHashOf(req.patch);

  // the Unit's lease
  const lease = await guards.lease(req.item_id, req.unit_key);
  if (lease.state !== 'ok')
    return no('guards_unavailable', 'the Unit owner could not say who holds the lease');
  if (lease.value.lane === 'L7') return no('spike_lane', 'a spike never reaches the Push Broker');
  if (!lease.value.held) return no('no_lease', 'the Unit has no held lease');
  // a suspended record closes the agent lanes (OB §8, DEC-21): in-flight work cannot push; human-led L8 can
  if (lease.value.suspended === true && req.lane !== 'L8') {
    return no(
      'prr_suspended',
      'the repo is suspended for drift: agent lanes are closed until a person restores it',
    );
  }
  if (lease.value.epoch !== req.lease_epoch) {
    return no(
      'stale_epoch',
      `the writer holds epoch ${req.lease_epoch} and the lease is at ${lease.value.epoch}`,
    );
  }

  // protected paths need an X2 bound to exactly this patch
  const protectedRules = [
    ...new Set(
      req.patch.files.map((f) => protectedPushPath(f.path)).filter((x): x is string => x !== null),
    ),
  ].sort();
  if (protectedRules.length > 0) {
    const x2 = await guards.x2Bound(req.item_id, patch_hash);
    if (x2.state !== 'ok')
      return no('guards_unavailable', 'the Unit owner could not say whether X2 is decided');
    if (!x2.value) {
      return no(
        'protected_path',
        `the patch touches protected paths (${protectedRules.join(', ')}) and no X2 decision is bound to patch ${patch_hash}`,
      );
    }
  }
  return { ok: true, value: { req, patch_hash, protected_rules: protectedRules, bytes } };
}

// ---------------------------------------------------------------- The re-plan of a pushed Unit (owner decision 2026-11-13)

/**
 * What the broker checks before it marks a PR draft again (one function for the fake and the adapter): the request has
 * the shape, the branch is `agent/<item>/<unit>` of exactly this item and Unit, and the one comment is made of the ids
 * (`replanCommentOf`), never of a text the caller sent. The PR itself must then be OPEN from exactly that branch (the
 * host's answer, checked by each implementation): a closed PR is never reopened, another branch's PR is never touched.
 */
export function preflightRedraft(
  input: unknown,
):
  | { ok: true; value: { req: RedraftPrRequest; comment: string } }
  | { ok: false; error: CodeHostNotOk } {
  const parsed = RedraftPrRequest.safeParse(input);
  if (!parsed.success)
    return { ok: false, error: refusal('bad_patch', 'the request is not a valid redraft request') };
  const req = parsed.data;
  const badBranch = badPushBranch(req.branch, req.item_id, req.unit_key);
  if (badBranch) return { ok: false, error: refusal('branch_not_allowed', badBranch) };
  return {
    ok: true,
    value: { req, comment: replanCommentOf(req.item_id, req.unit_key, req.lease_epoch) },
  };
}

// ---------------------------------------------------------------- Text the broker writes (commit message, PR body)

/**
 * Makes text from anywhere inert for a commit message or a Markdown PR body: one line, a conservative character set
 * (letters, digits, space and a little punctuation; no `:` or `/`, so no bare URL is autolinked), so repo text cannot start a heading, a link, an image, an HTML tag,
 * a mention (`@team`), an issue reference (`#12`), a closing keyword's target or a code fence.
 */
export function inertText(s: string, max = 200): string {
  return s
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .replace(/[^A-Za-z0-9 .,;_()'+=-]/g, '?')
    .trim()
    .slice(0, max);
}

const idLike = (s: string): string => s.replace(/[^A-Za-z0-9._:-]/g, '?').slice(0, 64);

export interface BodyFacts {
  readonly item_id: string;
  readonly unit_key: string;
  readonly lease_epoch: number;
  readonly patch_hash: string;
  readonly protected_rules: readonly string[];
}

/** The commit message: the (inert) subject and the trailers (DM §3.6 Commit: item, unit, epoch, patch). */
export function commitMessage(subject: string, f: BodyFacts): string {
  return [
    inertText(subject, 72) || 'Unit patch',
    '',
    `Aisdlc-Item: ${idLike(f.item_id)}`,
    `Aisdlc-Unit: ${idLike(f.unit_key)}`,
    `Aisdlc-Lease-Epoch: ${f.lease_epoch}`,
    `Aisdlc-Patch: ${f.patch_hash}`,
    '',
  ].join('\n');
}

/**
 * The Draft PR's title and body, built from the evidence the factory holds (never from a file of the repo, a session
 * message or a request text). The PR is a DRAFT: the factory never marks it ready, never approves it and never merges
 * it; a person does (G4, S8).
 */
export function renderPr(e: PushEvidence, f: BodyFacts): { title: string; body: string } {
  const title = `[agent] ${inertText(e.title, 120)}`;
  const lines = [
    '**Draft pull request opened by the factory.** A person reviews it (G4) and merges it; the factory never does.',
    '',
    '| | |',
    '|---|---|',
    `| Item | \`${idLike(f.item_id)}\` |`,
    `| Unit | \`${idLike(f.unit_key)}\` |`,
    `| Lane | \`${idLike(e.lane)}\` |`,
    `| Base commit | \`${e.base_sha}\` |`,
    `| Lease epoch | ${f.lease_epoch} |`,
    `| Patch | \`${f.patch_hash}\` |`,
    `| Files changed | ${e.files_changed} |`,
    `| Lines changed | ${e.lines_changed} |`,
  ];
  if (f.protected_rules.length > 0) {
    lines.push(
      '',
      `**Protected paths touched** (${f.protected_rules.map((r) => `\`${idLike(r)}\``).join(', ')}): written only because an X2 decision is bound to this exact patch.`,
    );
  }
  if (e.oracles.length > 0) {
    lines.push('', '### Oracles', '');
    for (const o of e.oracles)
      lines.push(`- \`${idLike(o.oracle_id)}\` (spec \`${o.spec_sha256}\`)`);
  }
  if (e.checks.length > 0) {
    lines.push('', '### Checks the factory ran before pushing', '');
    for (const c of e.checks) lines.push(`- ${inertText(c.name, 64)}: ${c.result}`);
  }
  const refs = Object.entries(e.refs);
  if (refs.length > 0) {
    lines.push('', '### References', '');
    for (const [k, v] of refs) lines.push(`- ${inertText(k, 32)}: \`${idLike(v)}\``);
  }
  lines.push('');
  return { title, body: lines.join('\n') };
}
