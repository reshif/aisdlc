import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  EVAL_BASELINES_FORMAT,
  EVAL_STORE_FORMAT,
  EvalBaselineFile,
  EvalCase,
  EvalGrader,
  EvalManifest,
  type EvalBaseline,
} from '@aisdlc/contracts';
import { canonicalJson, err, ok, type Clock, type Result, systemClock } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import { z } from 'zod';
import { unsupportedKeywords } from './grader.js';
import { storeError, type EvalStoreError } from './errors.js';
import {
  MANIFEST_FILE,
  STORE_DIRS,
  baselineFile,
  hiddenFile,
  holdoutFile,
  holdoutHiddenFile,
  taskFile,
} from './layout.js';
import { signManifest } from './manifest.js';
import { resolveStorePath } from './repo-guard.js';
import { listStoreFiles } from './store.js';

// Authoring a store (the operator's side: `init`, `add-case`, `baseline`, `sign`). These write into a
// directory that is OUTSIDE the repo (the guard runs first) and leave the manifest stale until `sign`
// signs the tree as it is: an unsigned or stale store cannot be opened.

/** What `add-case` takes: a case without its `hidden_ref`, plus the grader (which goes to a hidden file). */
export const CaseDraft = z.strictObject({
  ...EvalCase.omit({ hidden_ref: true }).shape,
  grader: EvalGrader,
});
export type CaseDraft = z.infer<typeof CaseDraft>;

const sha = (b: string | Buffer): string => createHash('sha256').update(b).digest('hex');
const json = (v: unknown): string => `${JSON.stringify(v, null, 2)}\n`;

function put(root: string, rel: string, text: string): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text, { mode: 0o600 });
}

function guard(path: string | undefined): Result<string, EvalStoreError> {
  return resolveStorePath(path);
}

/** Creates the directories of an empty store at an existing, outside-the-repo path, and signs it. */
export async function initStore(
  path: string | undefined,
  o: { store_id: string; key_id: string; custody: KeyCustodyPort; clock?: Clock },
): Promise<Result<string, EvalStoreError>> {
  const where = guard(path);
  if (!where.ok) return where;
  if (existsSync(join(where.value, MANIFEST_FILE))) {
    return err(storeError('exists', 'the directory already holds a store'));
  }
  for (const d of STORE_DIRS) mkdirSync(join(where.value, d), { recursive: true, mode: 0o700 });
  const signed = await signStore(path, {
    ...o,
    created_at: (o.clock ?? systemClock).now().toISOString(),
  });
  return signed.ok ? ok(where.value) : signed;
}

/** Writes a case (and its hidden grader). The manifest is stale until `signStore`. */
export function addCase(
  path: string | undefined,
  draftRaw: unknown,
): Result<{ case_id: string; hidden_ref: string }, EvalStoreError> {
  const where = guard(path);
  if (!where.ok) return where;
  const p = CaseDraft.safeParse(draftRaw);
  if (!p.success)
    return err(storeError('invalid', `the case is invalid: ${p.error.issues[0]?.message ?? ''}`));
  const { grader, ...rest } = p.data;
  if (grader.type === 'schema' && unsupportedKeywords(grader.schema).length > 0) {
    return err(
      storeError(
        'invalid',
        `the schema grader uses keywords the grader does not check: ${unsupportedKeywords(grader.schema).join(', ')}`,
      ),
    );
  }
  const holdout = rest.kind === 'holdout';
  const hiddenText = json({ grader });
  const hex = sha(canonicalJson({ grader }));
  const c: EvalCase = { ...rest, hidden_ref: `sha256:${hex}` };
  const caseRel = holdout ? holdoutFile(c.case_id) : taskFile(c.case_id);
  if (
    existsSync(join(where.value, holdout ? taskFile(c.case_id) : holdoutFile(c.case_id))) ||
    existsSync(join(where.value, caseRel))
  ) {
    return err(storeError('exists', `case ${c.case_id} already exists`));
  }
  put(where.value, holdout ? holdoutHiddenFile(hex) : hiddenFile(hex), hiddenText);
  put(where.value, caseRel, json(c));
  return ok({ case_id: c.case_id, hidden_ref: c.hidden_ref });
}

/** Adds or replaces the baseline of (suite, agent, profile) in `baselines/<provider>.json`. */
export function setBaseline(
  path: string | undefined,
  b: EvalBaseline,
): Result<void, EvalStoreError> {
  const where = guard(path);
  if (!where.ok) return where;
  const rel = baselineFile(b.provider);
  let file: EvalBaselineFile = {
    format: EVAL_BASELINES_FORMAT,
    provider: b.provider,
    baselines: [],
  };
  if (existsSync(join(where.value, rel))) {
    const p = EvalBaselineFile.safeParse(JSON.parse(readFileSync(join(where.value, rel), 'utf8')));
    if (!p.success) return err(storeError('invalid', `${rel} is malformed`));
    file = p.data;
  }
  const rest = file.baselines.filter(
    (x) => !(x.suite_id === b.suite_id && x.agent_id === b.agent_id && x.profile === b.profile),
  );
  put(where.value, rel, json({ ...file, baselines: [...rest, b] }));
  return ok(undefined);
}

export function removeFile(path: string | undefined, rel: string): Result<void, EvalStoreError> {
  const where = guard(path);
  if (!where.ok) return where;
  rmSync(join(where.value, rel), { force: true });
  return ok(undefined);
}

/** Signs the tree as it is: lists every file, hashes it, signs the manifest with key custody. */
export async function signStore(
  path: string | undefined,
  o: {
    store_id?: string;
    key_id: string;
    custody: KeyCustodyPort;
    created_at?: string;
    clock?: Clock;
  },
): Promise<Result<EvalManifest, EvalStoreError>> {
  const where = guard(path);
  if (!where.ok) return where;
  let store_id = o.store_id;
  let created_at = o.created_at;
  const mpath = join(where.value, MANIFEST_FILE);
  if ((store_id === undefined || created_at === undefined) && existsSync(mpath)) {
    try {
      const prev = EvalManifest.safeParse(JSON.parse(readFileSync(mpath, 'utf8')).manifest);
      if (prev.success) {
        store_id ??= prev.data.store_id;
        created_at ??= prev.data.created_at;
      }
    } catch {
      // an unreadable manifest is replaced
    }
  }
  if (store_id === undefined)
    return err(storeError('invalid', 'the store has no id yet: pass --store-id'));
  const files: Record<string, string> = {};
  for (const rel of listStoreFiles(where.value)) {
    // a stray top-level entry is not a store file: refuse to bless it
    if (
      !rel.includes('/') ||
      !(STORE_DIRS as readonly string[]).includes(rel.split('/')[0] as string)
    ) {
      return err(storeError('unlisted_file', `${rel} is not part of the store layout`));
    }
    files[rel] = sha(readFileSync(join(where.value, rel)));
  }
  const manifest = EvalManifest.parse({
    format: EVAL_STORE_FORMAT,
    store_id,
    created_at: created_at ?? (o.clock ?? systemClock).now().toISOString(),
    key_id: o.key_id,
    files,
  });
  const signed = await signManifest(manifest, o.custody);
  if (!signed.ok) return signed;
  writeFileSync(mpath, json(signed.value), { mode: 0o600 });
  return ok(manifest);
}
