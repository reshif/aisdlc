import type { GitSha } from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { RULES, scanText, type SecretRule } from '@aisdlc/secrets-rules';
import type pg from 'pg';
import { z } from 'zod';
import type { TreeReader } from './detectors/index.js';

// The repository search index and its read-only query (PLAN M12.1 2.1b "focused reverse-engineering").
//
// The index is written once, at the end of a successful census job, from the same hardened tree reader the
// detectors use: text files of the head tree under a size and count cap, a file that holds a secret (the
// ONE shared ruleset) is not indexed at all, binary files are not indexed. It is replaced whole per
// repository in one transaction. The query is read-only, answers only for the commit the caller names (the
// index's own commit must match: a stale index is `stale_index`, never an answer from another commit) and
// returns short excerpts with the blob each came from. Repo text is data: the caller quotes it.

export const INDEX_MAX_FILES = 2_000;
export const INDEX_MAX_FILE_BYTES = 128 * 1024;
export const INDEX_MAX_TOTAL_BYTES = 16 * 1024 * 1024;
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;
const CONTEXT_LINES = 1;
const EXCERPT_MAX_CHARS = 600;

export interface IndexResult {
  readonly files: number;
  readonly bytes: number;
  readonly skipped: number;
}

export async function indexRepo(
  pool: pg.Pool,
  o: {
    repo: string;
    commit_sha: GitSha;
    job_id: string;
    reader: Pick<TreeReader, 'files' | 'readText'>;
    now: Date;
    rules?: readonly SecretRule[];
    signal?: AbortSignal;
  },
): Promise<IndexResult> {
  const rules = o.rules ?? RULES;
  const rows: Array<{ path: string; blob: string; content: string }> = [];
  let bytes = 0;
  let skipped = 0;
  for (const f of o.reader.files) {
    if (o.signal?.aborted) break;
    if (rows.length >= INDEX_MAX_FILES || bytes >= INDEX_MAX_TOTAL_BYTES) {
      skipped += 1;
      continue;
    }
    if (f.size > INDEX_MAX_FILE_BYTES || f.mode === '120000') {
      skipped += 1;
      continue;
    }
    const r = await o.reader.readText(f.path, INDEX_MAX_FILE_BYTES);
    if (r.state !== 'ok' || r.text.includes('\u0000') || r.text.includes('�')) {
      skipped += 1;
      continue;
    }
    // a secret is never copied into the index: the whole file stays out
    if (scanText(r.text, rules).length > 0) {
      skipped += 1;
      continue;
    }
    bytes += Buffer.byteLength(r.text);
    rows.push({ path: f.path, blob: f.blob, content: r.text });
  }
  await withTransaction(pool, async (tx) => {
    await tx.query('DELETE FROM knowledge.repo_index WHERE repo = $1', [o.repo.toLowerCase()]);
    await tx.query(
      `INSERT INTO knowledge.repo_index (repo, commit_sha, job_id, files, bytes, skipped, indexed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [o.repo.toLowerCase(), o.commit_sha, o.job_id, rows.length, bytes, skipped, o.now],
    );
    for (const r of rows) {
      await tx.query(
        'INSERT INTO knowledge.repo_file (repo, path, blob_sha, content) VALUES ($1,$2,$3,$4)',
        [o.repo.toLowerCase(), r.path, r.blob, r.content],
      );
    }
  });
  return { files: rows.length, bytes, skipped };
}

export const SearchQuery = z.strictObject({
  q: z.string().min(2).max(200),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  path_prefix: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(SEARCH_MAX_LIMIT).optional(),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export interface SearchHit {
  readonly path: string;
  readonly blob_sha: string;
  readonly commit_sha: string;
  readonly line_from: number;
  readonly line_to: number;
  readonly excerpt: string;
}

export type SearchOutcome =
  | { readonly state: 'ok'; readonly hits: SearchHit[] }
  | { readonly state: 'not_indexed' }
  | { readonly state: 'stale_index'; readonly indexed_sha: string };

export const FILE_MAX_LINES = 400;
export const FILE_MAX_CHARS = 32 * 1024;

export const FileQuery = z.strictObject({
  path: z
    .string()
    .min(1)
    .max(300)
    .refine((p) => !p.startsWith('/') && !p.split('/').includes('..') && !p.includes('\u0000'), {
      message: 'a repository-relative path',
    }),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  /** 1-based, inclusive; at most FILE_MAX_LINES lines are answered. */
  line_from: z.coerce.number().int().min(1).optional(),
  line_to: z.coerce.number().int().min(1).optional(),
});
export type FileQuery = z.infer<typeof FileQuery>;

export interface FileRead {
  readonly path: string;
  readonly blob_sha: string;
  readonly commit_sha: string;
  readonly line_from: number;
  readonly line_to: number;
  readonly total_lines: number;
  readonly truncated: boolean;
  readonly content: string;
}

export type FileOutcome =
  | { readonly state: 'ok'; readonly file: FileRead }
  | { readonly state: 'not_indexed' }
  | { readonly state: 'stale_index'; readonly indexed_sha: string }
  /** No such file in the index: absent, binary, too big, or one the secret ruleset hits. The same answer for all. */
  | { readonly state: 'not_available' };

/**
 * One file of the indexed head tree, at the commit the caller names (the index's own, else `stale_index`). A file that
 * holds a secret was never indexed, and is checked again here against the CURRENT ruleset: it is never served. Read-only;
 * a long file is cut to a window of lines and a character cap. Repo text is data: the caller quotes it.
 */
export async function readRepoFile(
  pool: pg.Pool,
  repo: string,
  q: FileQuery,
  rules: readonly SecretRule[] = RULES,
): Promise<FileOutcome> {
  const idx = await pool.query<{ commit_sha: string }>(
    'SELECT commit_sha FROM knowledge.repo_index WHERE repo = $1',
    [repo.toLowerCase()],
  );
  const at = idx.rows[0];
  if (!at) return { state: 'not_indexed' };
  if (at.commit_sha !== q.sha) return { state: 'stale_index', indexed_sha: at.commit_sha };
  const row = await pool.query<{ blob_sha: string; content: string }>(
    'SELECT blob_sha, content FROM knowledge.repo_file WHERE repo = $1 AND path = $2',
    [repo.toLowerCase(), q.path],
  );
  const f = row.rows[0];
  if (!f || scanText(f.content, rules).length > 0) return { state: 'not_available' };
  const lines = f.content.split('\n');
  const from = Math.max(1, q.line_from ?? 1);
  const wanted = Math.min(q.line_to ?? lines.length, lines.length);
  const to = Math.min(wanted, from + FILE_MAX_LINES - 1);
  let content = lines.slice(from - 1, to).join('\n');
  let truncated = to < lines.length || wanted > to;
  if (content.length > FILE_MAX_CHARS) {
    content = content.slice(0, FILE_MAX_CHARS);
    truncated = true;
  }
  const shown = content === '' ? 0 : content.split('\n').length;
  return {
    state: 'ok',
    file: {
      path: q.path,
      blob_sha: f.blob_sha,
      commit_sha: at.commit_sha,
      line_from: from,
      line_to: Math.max(from, from + shown - 1),
      total_lines: lines.length,
      truncated,
      content,
    },
  };
}

const escapeLike = (s: string): string => s.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Read-only: one SELECT of the index row and one of the matching files. */
export async function searchRepo(
  pool: pg.Pool,
  repo: string,
  q: SearchQuery,
): Promise<SearchOutcome> {
  const idx = await pool.query<{ commit_sha: string }>(
    'SELECT commit_sha FROM knowledge.repo_index WHERE repo = $1',
    [repo.toLowerCase()],
  );
  const at = idx.rows[0];
  if (!at) return { state: 'not_indexed' };
  if (at.commit_sha !== q.sha) return { state: 'stale_index', indexed_sha: at.commit_sha };
  const limit = Math.min(q.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
  const prefix = q.path_prefix === undefined ? '' : escapeLike(q.path_prefix);
  const rows = await pool.query<{ path: string; blob_sha: string; content: string }>(
    `SELECT path, blob_sha, content FROM knowledge.repo_file
      WHERE repo = $1 AND path LIKE $2 ESCAPE '\\' AND content ILIKE $3 ESCAPE '\\'
      ORDER BY path LIMIT $4`,
    [repo.toLowerCase(), `${prefix}%`, `%${escapeLike(q.q)}%`, limit],
  );
  const needle = q.q.toLowerCase();
  const hits: SearchHit[] = rows.rows.map((r) => {
    const lines = r.content.split('\n');
    const at0 = Math.max(
      0,
      lines.findIndex((l) => l.toLowerCase().includes(needle)),
    );
    const from = Math.max(0, at0 - CONTEXT_LINES);
    const to = Math.min(lines.length - 1, at0 + CONTEXT_LINES);
    return {
      path: r.path,
      blob_sha: r.blob_sha,
      commit_sha: at.commit_sha,
      line_from: from + 1,
      line_to: to + 1,
      excerpt: lines
        .slice(from, to + 1)
        .join('\n')
        .slice(0, EXCERPT_MAX_CHARS),
    };
  });
  return { state: 'ok', hits };
}
