import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { gitBlobSha } from './codehost.js';

// KnowledgeSearchPort (PLAN M12.1 2.1b): the read-only query an agent's `KnowledgeSearch` tool runs over
// knowledge's indexed copy of a repository, AT ONE COMMIT. The caller names the commit (the merged
// default-branch head the run is grounded on) and the index answers only if it was built at exactly that
// commit: a stale or missing index is an error, never an answer from some other commit (fail closed). An
// excerpt is repo text: DATA, quoted by the caller, never instructions. The real adapter is knowledge's
// `GET /v1/repos/:owner/:name/search`; the fake searches files a test gives it.

export const KnowledgeSearchError = taggedError('KnowledgeSearchError');
export type KnowledgeSearchError = TaggedError<
  'KnowledgeSearchError',
  { code: 'unavailable' | 'not_indexed' | 'stale_index' | 'invalid'; message: string }
>;
export const knowledgeSearchError = (
  code: KnowledgeSearchError['code'],
  message: string,
): KnowledgeSearchError => KnowledgeSearchError({ code, message });

export interface KnowledgeSearchRequest {
  readonly repo: string;
  /** The commit the answer must be about (the merged head). */
  readonly sha: string;
  readonly query: string;
  readonly path_prefix?: string;
  /** 1-20, default 8. */
  readonly limit?: number;
}

export interface KnowledgeHit {
  readonly path: string;
  /** The git blob the excerpt came from (what a citation can name). */
  readonly blob_sha: string;
  readonly commit_sha: string;
  /** 1-based, inclusive. */
  readonly line_from: number;
  readonly line_to: number;
  readonly excerpt: string;
}

export interface KnowledgeSearchPort {
  search(req: KnowledgeSearchRequest): Promise<Result<KnowledgeHit[], KnowledgeSearchError>>;
}

/** Excerpt rules shared by the adapter and the fake: a line with the term, one line of context each side. */
export const EXCERPT_CONTEXT_LINES = 1;
export const EXCERPT_MAX_CHARS = 600;
export const SEARCH_DEFAULT_LIMIT = 8;
export const SEARCH_MAX_LIMIT = 20;

/** Deterministic fake: searches `files` (path -> text) as they were at `sha`. */
export class FakeKnowledgeSearch implements KnowledgeSearchPort {
  readonly calls: KnowledgeSearchRequest[] = [];
  private down = false;

  constructor(
    private readonly o: {
      readonly repo: string;
      /** The commit the fake's index was built at. */
      readonly sha: string;
      readonly files: Readonly<Record<string, string>>;
    },
  ) {}

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async search(req: KnowledgeSearchRequest): Promise<Result<KnowledgeHit[], KnowledgeSearchError>> {
    this.calls.push({ ...req });
    if (this.down) return err(knowledgeSearchError('unavailable', 'knowledge did not answer'));
    if (req.repo.toLowerCase() !== this.o.repo.toLowerCase()) {
      return err(knowledgeSearchError('not_indexed', 'no index for this repository'));
    }
    if (req.sha !== this.o.sha) {
      return err(knowledgeSearchError('stale_index', 'the index is not at the requested commit'));
    }
    const q = req.query.trim().toLowerCase();
    if (q.length < 2) return err(knowledgeSearchError('invalid', 'the query is too short'));
    const limit = Math.min(req.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT);
    const hits: KnowledgeHit[] = [];
    for (const path of Object.keys(this.o.files).sort()) {
      if (req.path_prefix !== undefined && !path.startsWith(req.path_prefix)) continue;
      const text = this.o.files[path] as string;
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.toLowerCase().includes(q));
      if (at < 0) continue;
      const from = Math.max(0, at - EXCERPT_CONTEXT_LINES);
      const to = Math.min(lines.length - 1, at + EXCERPT_CONTEXT_LINES);
      hits.push({
        path,
        blob_sha: gitBlobSha(text),
        commit_sha: this.o.sha,
        line_from: from + 1,
        line_to: to + 1,
        excerpt: lines
          .slice(from, to + 1)
          .join('\n')
          .slice(0, EXCERPT_MAX_CHARS),
      });
      if (hits.length >= limit) break;
    }
    return ok(hits);
  }
}
