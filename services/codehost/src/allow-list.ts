import type { CodeHostRole } from '@aisdlc/contracts';

// The request allow-list (PLAN M5.2, OB §6.5 and §5.5). It is enforced in the transport before any
// network call: a request is made only if its method and path match a row, with only the query
// keys that row names. Rows are `GET`s. `GET /repos/{r}/rulesets` is deliberately not a row (the
// factory reads effective rules from `rules/branches/{b}`; bypass actors are human-attested), and
// is named in the refusal so the reason is clear. Any other method is refused in Census mode.

/** `census` is the only mode built: every row reads. Write modes arrive with M13. */
export type CodeHostMode = 'census';

export interface AllowRow {
  readonly id: string;
  readonly method: 'GET';
  /** Matches the URL path (not decoded). */
  readonly path: RegExp;
  /** The role whose token is used, or `jwt` for the App itself. */
  readonly auth: CodeHostRole | 'jwt';
  readonly query: readonly string[];
}

const SEG = '[A-Za-z0-9_.-]+';
const R = `/repos/(${SEG})/(${SEG})`;

export const ALLOW_LIST: readonly AllowRow[] = [
  {
    id: 'installation_repos',
    method: 'GET',
    path: /^\/installation\/repositories$/,
    auth: 'hub',
    query: ['per_page', 'page'],
  },
  {
    id: 'app_installation',
    method: 'GET',
    path: /^\/app\/installations\/(\d+)$/,
    auth: 'jwt',
    query: [],
  },
  {
    id: 'contents',
    method: 'GET',
    path: new RegExp(`^${R}/contents/(.+)$`),
    auth: 'hub',
    query: ['ref'],
  },
  { id: 'git_ref', method: 'GET', path: new RegExp(`^${R}/git/ref/(.+)$`), auth: 'hub', query: [] },
  {
    id: 'git_matching_refs',
    method: 'GET',
    path: new RegExp(`^${R}/git/matching-refs/(.+)$`),
    auth: 'hub',
    query: ['per_page', 'page'],
  },
  {
    id: 'commit',
    method: 'GET',
    path: new RegExp(`^${R}/commits/([^/]+)$`),
    auth: 'hub',
    query: [],
  },
  {
    id: 'rules_for_branch',
    method: 'GET',
    path: new RegExp(`^${R}/rules/branches/([^/]+)$`),
    auth: 'posture',
    query: ['per_page', 'page'],
  },
  {
    id: 'codeowners_errors',
    method: 'GET',
    path: new RegExp(`^${R}/codeowners/errors$`),
    auth: 'hub',
    query: ['ref'],
  },
  {
    id: 'collaborators',
    method: 'GET',
    path: new RegExp(`^${R}/collaborators$`),
    auth: 'posture',
    query: ['affiliation', 'per_page', 'page'],
  },
];

export type RefusalCode =
  'method_refused' | 'ruleset_listing_refused' | 'not_allow_listed' | 'bad_path' | 'bad_query';

export type Verdict =
  | { readonly ok: true; readonly row: AllowRow; readonly url: string }
  | { readonly ok: false; readonly code: RefusalCode; readonly message: string };

const refuse = (code: RefusalCode, message: string): Verdict => ({ ok: false, code, message });

/** A segment that decodes to nothing, `.` or `..`, or contains NUL or a backslash, is a traversal attempt. */
function badSegments(path: string): boolean {
  for (const raw of path.split('/').slice(1)) {
    let seg: string;
    try {
      seg = decodeURIComponent(raw);
    } catch {
      return true;
    }
    if (seg === '' || seg === '.' || seg === '..' || seg.includes('\0') || seg.includes('\\')) {
      return true;
    }
    // An encoded slash inside a segment is allowed only where the row takes one segment as a name
    // (branch names); it can never make a `..` segment, because the decoded segment is checked whole.
    if (seg.split('/').some((p) => p === '..' || p === '.')) return true;
  }
  return false;
}

/**
 * Decides whether `method path?query` may be sent in `mode`. `target` is a path with an optional
 * query, never a full URL (the transport adds the configured base URL, so a request can never be
 * redirected to another host by its own text).
 */
export function checkRequest(mode: CodeHostMode, method: string, target: string): Verdict {
  void mode; // census is the only mode; every allowed row is a GET
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) {
    return refuse('bad_path', 'the request target must be an absolute path');
  }
  const q = target.indexOf('?');
  const path = q < 0 ? target : target.slice(0, q);
  const search = q < 0 ? '' : target.slice(q + 1);
  if (method !== 'GET') {
    return refuse('method_refused', `${method} is refused: the code host is read-only here`);
  }
  if (/\/rulesets(\/|$)/.test(path)) {
    return refuse(
      'ruleset_listing_refused',
      'listing rulesets is refused; effective rules come from rules/branches/{branch}',
    );
  }
  if (badSegments(path)) return refuse('bad_path', 'the path has an empty, "." or ".." segment');
  const row = ALLOW_LIST.find((r) => r.method === method && r.path.test(path));
  if (!row) return refuse('not_allow_listed', `GET ${path} is not on the allow-list`);
  if (search !== '') {
    const keys = new URLSearchParams(search);
    for (const k of new Set(keys.keys())) {
      if (!row.query.includes(k)) {
        return refuse('bad_query', `query parameter ${k} is not allowed for ${row.id}`);
      }
    }
  }
  return { ok: true, row, url: target };
}
