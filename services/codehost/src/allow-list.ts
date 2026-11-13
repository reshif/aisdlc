import { REPLAN_COMMENT_PATTERN, type CodeHostRole } from '@aisdlc/contracts';

// The request allow-list (PLAN M5.2, OB §6.5 and §5.5). It is enforced in the transport before any
// network call: a request is made only if its method and path match a row, with only the query
// keys that row names. Rows are `GET`s. `GET /repos/{r}/rulesets` is deliberately not a row (the
// factory reads effective rules from `rules/branches/{b}`; bypass actors are human-attested), and
// is named in the refusal so the reason is clear. Any other method is refused in Census mode.

/**
 * `census` reads. `push` (M13.6) adds the Push Broker's write rows (`PUSH_ALLOW_LIST`) and mints the `docs` role: the
 * only writes the factory makes, all on `agent/**` and its Draft PR.
 */
export type CodeHostMode = 'census' | 'push';

export interface AllowRow {
  readonly id: string;
  /** The path with its variable parts named: what the request log shows (no repo, no ref, no id). */
  readonly template: string;
  readonly method: 'GET' | 'POST' | 'PATCH';
  /** Matches the URL path (not decoded). */
  readonly path: RegExp;
  /** The role whose token is used, or `jwt` for the App itself. */
  readonly auth: CodeHostRole | 'jwt';
  readonly query: readonly string[];
  /**
   * A write row checks its JSON body too, before the network: `null` when the body is acceptable, else why not. The
   * body is what makes a row narrow: a ref other than `agent/**`, a forced update, a PR that is not a draft, a PATCH
   * of a PR that would close it or move its base, all fail here.
   */
  readonly body?: (json: unknown) => string | null;
}

const SEG = '[A-Za-z0-9_.-]+';
const R = `/repos/(${SEG})/(${SEG})`;

export const ALLOW_LIST: readonly AllowRow[] = [
  {
    id: 'installation_repos',
    template: '/installation/repositories',
    method: 'GET',
    path: /^\/installation\/repositories$/,
    auth: 'hub',
    query: ['per_page', 'page'],
  },
  {
    id: 'app_installation',
    template: '/app/installations/{installation_id}',
    method: 'GET',
    path: /^\/app\/installations\/(\d+)$/,
    auth: 'jwt',
    query: [],
  },
  {
    id: 'contents',
    template: '/repos/{owner}/{repo}/contents/{path}',
    method: 'GET',
    path: new RegExp(`^${R}/contents/(.+)$`),
    auth: 'hub',
    query: ['ref'],
  },
  {
    id: 'git_ref',
    template: '/repos/{owner}/{repo}/git/ref/{ref}',
    method: 'GET',
    path: new RegExp(`^${R}/git/ref/(.+)$`),
    auth: 'hub',
    query: [],
  },
  {
    id: 'git_matching_refs',
    template: '/repos/{owner}/{repo}/git/matching-refs/{ref}',
    method: 'GET',
    path: new RegExp(`^${R}/git/matching-refs/(.+)$`),
    auth: 'hub',
    query: ['per_page', 'page'],
  },
  {
    id: 'commit',
    template: '/repos/{owner}/{repo}/commits/{sha}',
    method: 'GET',
    path: new RegExp(`^${R}/commits/([^/]+)$`),
    auth: 'hub',
    query: [],
  },
  {
    id: 'rules_for_branch',
    template: '/repos/{owner}/{repo}/rules/branches/{branch}',
    method: 'GET',
    path: new RegExp(`^${R}/rules/branches/([^/]+)$`),
    auth: 'posture',
    query: ['per_page', 'page'],
  },
  {
    id: 'codeowners_errors',
    template: '/repos/{owner}/{repo}/codeowners/errors',
    method: 'GET',
    path: new RegExp(`^${R}/codeowners/errors$`),
    auth: 'hub',
    query: ['ref'],
  },
  {
    id: 'collaborators',
    template: '/repos/{owner}/{repo}/collaborators',
    method: 'GET',
    path: new RegExp(`^${R}/collaborators$`),
    auth: 'posture',
    query: ['affiliation', 'per_page', 'page'],
  },
];

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const onlyKeys = (o: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(o).every((k) => keys.includes(k));
const HEADS_AGENT = /^refs\/heads\/agent\/[0-9a-f-]{36}\/[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * The ONE GraphQL document the Push Broker may send (owner decision 2026-11-13: a re-plan marks the Unit's PR draft
 * again). GitHub's REST API cannot convert a PR to draft; this mutation is the only way. The row accepts exactly this
 * text with exactly one variable, the PR's node id: no other query, mutation or field can ride along.
 */
export const CONVERT_TO_DRAFT_MUTATION =
  'mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { number isDraft } } }';
const NODE_ID = /^[A-Za-z0-9_=-]{1,128}$/;

/**
 * The Push Broker's rows (M13.6; OB §6.5 `docs` role: contents:write, pull_requests:write, refs `agent/<s0-uuid>/...`
 * only). There is NO row for a merge, a review, a review request, an approval, a ruleset, a workflow, a delete, a
 * label, an issue, a status or a check: those requests do not exist here, so they are refused before the network
 * (`not_allow_listed`), whatever the code above asks. The re-plan of a pushed Unit (owner decision 2026-11-13) adds
 * exactly three: list a PR's comments, post the ONE ids-only re-plan comment (its body must match
 * `REPLAN_COMMENT_PATTERN`), and the ONE GraphQL mutation that marks a PR draft (`CONVERT_TO_DRAFT_MUTATION`).
 */
export const PUSH_ALLOW_LIST: readonly AllowRow[] = [
  {
    id: 'git_commit_read',
    template: '/repos/{owner}/{repo}/git/commits/{sha}',
    method: 'GET',
    path: new RegExp(`^${R}/git/commits/([0-9a-f]{40})$`),
    auth: 'hub',
    query: [],
  },
  {
    id: 'pulls_list',
    template: '/repos/{owner}/{repo}/pulls',
    method: 'GET',
    path: new RegExp(`^${R}/pulls$`),
    auth: 'docs',
    query: ['head', 'state', 'per_page', 'page'],
  },
  {
    id: 'pull_read',
    template: '/repos/{owner}/{repo}/pulls/{number}',
    method: 'GET',
    path: new RegExp(`^${R}/pulls/(\\d+)$`),
    auth: 'docs',
    query: [],
  },
  {
    id: 'git_blob_create',
    template: '/repos/{owner}/{repo}/git/blobs',
    method: 'POST',
    path: new RegExp(`^${R}/git/blobs$`),
    auth: 'docs',
    query: [],
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['content', 'encoding']) &&
      typeof j['content'] === 'string' &&
      j['encoding'] === 'base64'
        ? null
        : 'a blob is {content, encoding: base64}',
  },
  {
    id: 'git_tree_create',
    template: '/repos/{owner}/{repo}/git/trees',
    method: 'POST',
    path: new RegExp(`^${R}/git/trees$`),
    auth: 'docs',
    query: [],
    body: (j) => {
      if (!isObj(j) || !onlyKeys(j, ['base_tree', 'tree']) || !Array.isArray(j['tree'])) {
        return 'a tree is {base_tree, tree: [...]}';
      }
      for (const e of j['tree']) {
        if (!isObj(e) || !onlyKeys(e, ['path', 'mode', 'type', 'sha']))
          return 'a tree entry is {path, mode, type, sha}';
        if (e['type'] !== 'blob' || (e['mode'] !== '100644' && e['mode'] !== '100755')) {
          return 'a tree entry is a regular file (100644 or 100755): no symlink, submodule or subtree';
        }
      }
      return null;
    },
  },
  {
    id: 'git_commit_create',
    template: '/repos/{owner}/{repo}/git/commits',
    method: 'POST',
    path: new RegExp(`^${R}/git/commits$`),
    auth: 'docs',
    query: [],
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['message', 'tree', 'parents', 'author', 'committer']) &&
      typeof j['message'] === 'string' &&
      typeof j['tree'] === 'string' &&
      Array.isArray(j['parents']) &&
      j['parents'].length === 1 &&
      !('signature' in j)
        ? null
        : 'a commit is {message, tree, parents: [one parent], author, committer}',
  },
  {
    id: 'git_ref_create',
    template: '/repos/{owner}/{repo}/git/refs',
    method: 'POST',
    path: new RegExp(`^${R}/git/refs$`),
    auth: 'docs',
    query: [],
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['ref', 'sha']) &&
      typeof j['ref'] === 'string' &&
      HEADS_AGENT.test(j['ref']) &&
      typeof j['sha'] === 'string'
        ? null
        : 'a ref is created only as refs/heads/agent/<item>/<unit>',
  },
  {
    id: 'git_ref_update',
    template: '/repos/{owner}/{repo}/git/refs/heads/agent/{item}/{unit}',
    method: 'PATCH',
    path: new RegExp(`^${R}/git/refs/heads/agent/[0-9a-f-]{36}/[a-z0-9][a-z0-9._-]{0,62}$`),
    auth: 'docs',
    query: [],
    // never a force push: `force` is absent or false
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['sha', 'force']) &&
      typeof j['sha'] === 'string' &&
      (j['force'] === undefined || j['force'] === false)
        ? null
        : 'a ref update is {sha, force: false}',
  },
  {
    id: 'pull_create',
    template: '/repos/{owner}/{repo}/pulls',
    method: 'POST',
    path: new RegExp(`^${R}/pulls$`),
    auth: 'docs',
    query: [],
    // always a DRAFT, always from an agent/** branch of the same repo
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['title', 'head', 'base', 'body', 'draft']) &&
      typeof j['title'] === 'string' &&
      typeof j['head'] === 'string' &&
      /^agent\//.test(j['head']) &&
      typeof j['base'] === 'string' &&
      typeof j['body'] === 'string' &&
      j['draft'] === true
        ? null
        : 'a pull request is a draft from an agent/** branch',
  },
  {
    // a re-plan's "one comment" is checked against the comments already there (a redelivery posts nothing)
    id: 'pull_comments_list',
    template: '/repos/{owner}/{repo}/issues/{number}/comments',
    method: 'GET',
    path: new RegExp(`^${R}/issues/(\\d+)/comments$`),
    auth: 'docs',
    query: ['per_page', 'page'],
  },
  {
    // owner decision 2026-11-13: the ONE comment of a re-plan, ids only (`replanCommentOf`); any other text is refused
    id: 'pull_replan_comment',
    template: '/repos/{owner}/{repo}/issues/{number}/comments',
    method: 'POST',
    path: new RegExp(`^${R}/issues/(\\d+)/comments$`),
    auth: 'docs',
    query: [],
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['body']) &&
      typeof j['body'] === 'string' &&
      REPLAN_COMMENT_PATTERN.test(j['body'])
        ? null
        : 'a comment is the re-plan notice made of ids, nothing else',
  },
  {
    // owner decision 2026-11-13: a re-plan marks the PR draft again; the one mutation, never ready, never closed
    id: 'pull_convert_to_draft',
    template: '/graphql',
    method: 'POST',
    path: /^\/graphql$/,
    auth: 'docs',
    query: [],
    body: (j) =>
      isObj(j) &&
      onlyKeys(j, ['query', 'variables']) &&
      j['query'] === CONVERT_TO_DRAFT_MUTATION &&
      isObj(j['variables']) &&
      onlyKeys(j['variables'], ['id']) &&
      typeof j['variables']['id'] === 'string' &&
      NODE_ID.test(j['variables']['id'])
        ? null
        : 'the only GraphQL request is convertPullRequestToDraft of one pull request',
  },
  {
    id: 'pull_update',
    template: '/repos/{owner}/{repo}/pulls/{number}',
    method: 'PATCH',
    path: new RegExp(`^${R}/pulls/(\\d+)$`),
    auth: 'docs',
    query: [],
    // title and body only: not `state` (close, reopen), not `base`, not `draft`
    body: (j) =>
      isObj(j) && onlyKeys(j, ['title', 'body']) && Object.keys(j).length > 0
        ? null
        : 'a pull request update carries a title and a body only',
  },
];

export type RefusalCode =
  | 'method_refused'
  | 'ruleset_listing_refused'
  | 'not_allow_listed'
  | 'bad_path'
  | 'bad_query'
  | 'bad_body';

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
export function checkRequest(
  mode: CodeHostMode,
  method: string,
  target: string,
  body?: unknown,
): Verdict {
  if (!target.startsWith('/') || target.startsWith('//') || target.includes('#')) {
    return refuse('bad_path', 'the request target must be an absolute path');
  }
  const q = target.indexOf('?');
  const path = q < 0 ? target : target.slice(0, q);
  const search = q < 0 ? '' : target.slice(q + 1);
  const methods = mode === 'push' ? ['GET', 'POST', 'PATCH'] : ['GET'];
  if (!methods.includes(method)) {
    return refuse(
      'method_refused',
      `${method} is refused: ${mode === 'push' ? 'the Push Broker only creates and updates agent/** refs, blobs, trees, commits and draft pull requests' : 'the code host is read-only here'}`,
    );
  }
  if (/\/rulesets(\/|$)/.test(path)) {
    return refuse(
      'ruleset_listing_refused',
      'listing rulesets is refused; effective rules come from rules/branches/{branch}',
    );
  }
  if (badSegments(path)) return refuse('bad_path', 'the path has an empty, "." or ".." segment');
  const rows = mode === 'push' ? [...ALLOW_LIST, ...PUSH_ALLOW_LIST] : ALLOW_LIST;
  const row = rows.find((r) => r.method === method && r.path.test(path));
  if (!row) return refuse('not_allow_listed', `${method} ${path} is not on the allow-list`);
  if (row.body) {
    const why = row.body(body);
    if (why !== null) return refuse('bad_body', `${row.id}: ${why}`);
  } else if (method !== 'GET') {
    return refuse('bad_body', `${row.id}: a write row without a body check is refused`);
  }
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
