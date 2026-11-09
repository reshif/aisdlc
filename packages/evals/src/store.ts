import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, posix } from 'node:path';
import {
  EvalBaselineFile,
  EvalCase,
  EvalHidden,
  type EvalManifest,
  type EvalSuite,
} from '@aisdlc/contracts';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import type { z } from 'zod';
import { storeError, type EvalStoreError } from './errors.js';
import {
  MANIFEST_FILE,
  STORE_DIRS,
  TASKS_DIR,
  baselineFile,
  hiddenFile,
  taskFile,
} from './layout.js';
import { manifestDigest, verifyManifest } from './manifest.js';
import { loadPinnedKey, type PinnedKey } from './pinned.js';
import { resolveStorePath } from './repo-guard.js';

// The eval store, opened (PLAN M11.3). `EvalStore.open` is the only way to read one, and it refuses
// unless: the path exists and is outside the repo and every git worktree; the manifest is signed by
// the PINNED key; every file the manifest lists is present with exactly that sha256; and no file is
// in the store that the manifest does not list. Every later read re-checks the file's hash against
// the manifest (a file changed after open is refused, not served).
//
// This module serves what an eval RUN needs and nothing an AGENT can reach: `tasks/` (inputs and
// hidden refs), `hidden/` (graders) and `baselines/`. It never reads `holdouts/` content; names only
// (for the suite's `holdout_case_ids`). Holdout content is read by `holdout.ts` alone.

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');

/** Every file under the store's directories, as posix relative paths (the manifest itself excluded). */
export function listStoreFiles(root: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === MANIFEST_FILE && entry.isFile()) continue;
    if (!entry.isDirectory() || !(STORE_DIRS as readonly string[]).includes(entry.name)) {
      // anything else at the top level (a stray file, an unknown directory) is not part of the store
      out.push(entry.name);
      continue;
    }
    for (const f of readdirSync(join(root, entry.name), { withFileTypes: true })) {
      out.push(posix.join(entry.name, f.name));
    }
  }
  return out.sort();
}

/** A grader must hash to the ref that names it (content-addressed, so a swapped grader is refused). */
export function checkHiddenRef(hex: string, h: EvalHidden): Result<EvalHidden, EvalStoreError> {
  return sha(Buffer.from(canonicalJson({ grader: h.grader }))) === hex
    ? ok(h)
    : err(storeError('tampered', 'a grader does not hash to the ref that names it'));
}

export class EvalStore {
  private constructor(
    readonly root: string,
    readonly manifest: EvalManifest,
    readonly pinned: PinnedKey,
  ) {}

  get store_id(): string {
    return this.manifest.store_id;
  }
  get manifest_digest(): string {
    return manifestDigest(this.manifest);
  }

  /** `path`: usually `process.env.AISDLC_EVAL_STORE`. */
  static async open(
    path: string | undefined,
    opts: { pinned?: PinnedKey; repoRoot?: string } = {},
  ): Promise<Result<EvalStore, EvalStoreError>> {
    const where = resolveStorePath(path, opts.repoRoot);
    if (!where.ok) return where;
    let pinned = opts.pinned;
    if (pinned === undefined) {
      const k = loadPinnedKey();
      if (!k.ok) return k;
      pinned = k.value;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(readFileSync(join(where.value, MANIFEST_FILE), 'utf8'));
    } catch {
      return err(storeError('unsigned', 'manifest.json is missing or is not JSON'));
    }
    const signed = await verifyManifest(raw, pinned);
    if (!signed.ok) return signed;
    const m = signed.value.manifest;
    let present: string[];
    try {
      present = listStoreFiles(where.value);
    } catch {
      return err(storeError('io', 'the store cannot be listed'));
    }
    for (const f of present) {
      if (!(f in m.files)) return err(storeError('unlisted_file', `${f} is not in the manifest`));
    }
    for (const [f, want] of Object.entries(m.files)) {
      let got: string;
      try {
        if (f.includes('..') || f.startsWith('/')) throw new Error('bad path');
        got = sha(readFileSync(join(where.value, f)));
      } catch {
        return err(storeError('tampered', `${f} is listed in the manifest and cannot be read`));
      }
      if (got !== want) return err(storeError('tampered', `${f} differs from the manifest`));
    }
    return ok(new EvalStore(where.value, m, pinned));
  }

  /** A file of the store, only if it is in the manifest and still has its sha256. */
  readVerified(rel: string): Result<string, EvalStoreError> {
    const want = this.manifest.files[rel];
    if (want === undefined) return err(storeError('not_found', `${rel} is not in the store`));
    let buf: Buffer;
    try {
      buf = readFileSync(join(this.root, rel));
    } catch {
      return err(storeError('tampered', `${rel} cannot be read`));
    }
    if (sha(buf) !== want)
      return err(storeError('tampered', `${rel} changed since the store was opened`));
    return ok(buf.toString('utf8'));
  }

  /** Reads and parses one verified file. */
  read<S extends z.ZodType>(rel: string, schema: S): Result<z.infer<S>, EvalStoreError> {
    const t = this.readVerified(rel);
    if (!t.ok) return t;
    let json: unknown;
    try {
      json = JSON.parse(t.value);
    } catch {
      return err(storeError('invalid', `${rel} is not JSON`));
    }
    const p = schema.safeParse(json);
    return p.success ? ok(p.data) : err(storeError('invalid', `${rel} does not match its schema`));
  }

  /** Case ids of `tasks/` (holdouts are not listed here). */
  caseIds(): string[] {
    const pre = `${TASKS_DIR}/`;
    return Object.keys(this.manifest.files)
      .filter((f) => f.startsWith(pre) && f.endsWith('.json'))
      .map((f) => f.slice(pre.length, -'.json'.length))
      .sort();
  }

  loadCase(caseId: string): Result<EvalCase, EvalStoreError> {
    return this.read(taskFile(caseId), EvalCase);
  }

  /** The grader a `hidden_ref` of a `tasks/` case names. Verified against its content address. */
  loadHidden(ref: string): Result<EvalHidden, EvalStoreError> {
    const hex = ref.startsWith('sha256:') ? ref.slice('sha256:'.length) : '';
    const h = this.read(hiddenFile(hex), EvalHidden);
    return h.ok ? checkHiddenRef(hex, h.value) : h;
  }

  /** `baselines/<provider>.json`, or `null` when there is none (a provider with no baseline yet). */
  baselines(provider: string): Result<EvalBaselineFile | null, EvalStoreError> {
    const rel = baselineFile(provider);
    if (!(rel in this.manifest.files)) return ok(null);
    return this.read(rel, EvalBaselineFile);
  }

  /** The suites of `tasks/`, derived from the cases (one agent, one profile, one tag per suite). */
  suites(): Result<EvalSuite[], EvalStoreError> {
    const bySuite = new Map<string, EvalCase[]>();
    for (const id of this.caseIds()) {
      const c = this.loadCase(id);
      if (!c.ok) return c;
      bySuite.set(c.value.suite_id, [...(bySuite.get(c.value.suite_id) ?? []), c.value]);
    }
    const out: EvalSuite[] = [];
    for (const [suite_id, cases] of bySuite) {
      const first = cases[0] as EvalCase;
      if (
        cases.some(
          (c) =>
            c.agent_id !== first.agent_id ||
            c.profile !== first.profile ||
            c.project_tag !== first.project_tag,
        )
      ) {
        return err(storeError('invalid', `suite ${suite_id} mixes agents, profiles or tags`));
      }
      out.push({
        suite_id,
        agent_id: first.agent_id,
        profile: first.profile,
        project_tag: first.project_tag,
        case_ids: cases.map((c) => c.case_id).sort(),
        holdout_case_ids: [],
        store_id: this.store_id,
        manifest_digest: this.manifest_digest,
        local_prod_loadable: true,
      });
    }
    return ok(out.sort((a, b) => a.suite_id.localeCompare(b.suite_id)));
  }
}
