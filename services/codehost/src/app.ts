import {
  BundleRefs,
  CodeownersSyncRequest,
  GitSha,
  ProjectId,
  RepoFullName,
  type CodeHostNotOk,
  type CodeHostRead,
} from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import {
  TRACKER_ROUTES,
  mapRead,
  readUnreadable,
  repoKey,
  type IssueTrackerPort,
} from '@aisdlc/ports';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { b4Checks } from './b4.js';
import { CODEOWNERS_SYNC_STATUS, syncCodeowners } from './codeowners-sync.js';
import type { IdentityLinksPort } from './identity-client.js';
import type { AllowListedCodeHost } from './repo-allow-list.js';
import type { TokenBroker } from './token-broker.js';

/**
 * What a caller may do (PLAN M5.2, M5.3): `census` reads repo facts for the Census (the repos,
 * files, heads, CODEOWNERS) and the credential-free bundle, `posture` reads the posture facts (installation, effective rules,
 * collaborators, CODEOWNERS errors, the B4 verdict), `codeowners_sync` feeds CODEOWNERS owners into
 * the project's g4 group, `reload` re-reads the integration registry now (M10.4), `push` is the Push Broker (M13.6),
 * `tracker` the issue twin's tracker (M16: its own App, `issues: write`; only core-worker holds a token with it).
 */
export type CodeHostScope =
  'census' | 'posture' | 'codeowners_sync' | 'reload' | 'push' | 'tracker';

export interface CodeHostAppOptions {
  /** The host to serve with. With `runtime` it is ignored: the runtime's current host is used per request. */
  readonly host?: AllowListedCodeHost;
  /**
   * A host and broker that can change under a running process (the registry-selected adapter: a new
   * revision of its row swaps them without a restart). Read on every request, never cached.
   */
  readonly runtime?: {
    readonly host: AllowListedCodeHost;
    readonly broker?: TokenBroker | undefined;
  };
  /** `POST /v1/admin/reload` (scope `reload`): re-read the registry now; `force` rebuilds even an unchanged row. */
  readonly reload?: (opts: { force: boolean }) => Promise<unknown>;
  readonly identity: IdentityLinksPort;
  readonly auth: ServiceAuth;
  /** caller name -> scopes. A caller with no entry may do nothing. */
  readonly callers: Record<string, readonly CodeHostScope[]>;
  /** For the B4a check on the permissions of tokens actually minted. */
  readonly broker?: TokenBroker;
  readonly clock?: Clock;
  /**
   * M16 (user decision 2026-11-12: core-worker keeps no route out): the issue twin's tracker, through ITS OWN App
   * (`GitHubIssueTracker`; never the Push Broker's or the read App's credential). Absent: the tracker routes answer
   * `unknown`.
   */
  readonly tracker?: IssueTrackerPort;
}

const statusOf = (r: CodeHostNotOk): number => {
  if (r.state === 'unknown') return 503;
  // a stale writer or a branch that moved is a conflict, not a prohibition
  if (r.code === 'stale_epoch' || r.code === 'no_lease' || r.code === 'non_fast_forward')
    return 409;
  if (r.reason === 'repo_not_allowed' || r.reason === 'refused') return 403;
  if (r.reason === 'not_found') return 404;
  if (r.reason === 'head_moved') return 409;
  return 422;
};

/** HTTP in front of the code host: service tokens only; a read that is not `ok` is never a 2xx. */
export function createCodeHostApp(o: CodeHostAppOptions): FastifyInstance {
  const app = newApp();
  const clock = o.clock ?? systemClock;
  const hostOf = (): AllowListedCodeHost => (o.runtime?.host ?? o.host) as AllowListedCodeHost;
  const brokerOf = (): TokenBroker | undefined => (o.runtime ? o.runtime.broker : o.broker);

  app.get('/healthz', async () => ({ ok: true }));

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null) {
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    }
    (req as unknown as { caller: string }).caller = caller;
  });

  // Whatever goes wrong inside, the body is generic: no stack, no message, nothing that was read.
  app.setErrorHandler((e, _req, reply) => {
    const status = (e as { statusCode?: number }).statusCode;
    if (typeof status === 'number' && status >= 400 && status < 500) {
      return sendError(reply, status, 'bad_request', 'the request could not be understood');
    }
    return sendError(reply, 500, 'internal', 'internal error');
  });

  const allowed = (req: FastifyRequest, scope: CodeHostScope): boolean =>
    (o.callers[(req as unknown as { caller: string }).caller] ?? []).includes(scope);
  const forbid = (reply: FastifyReply, scope: CodeHostScope) =>
    sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
  const bad = (reply: FastifyReply, message: string) =>
    sendError(reply, 400, 'invalid_input', message);

  /** A `CodeHostRead` as an answer: `ok` is 200, anything else a non-2xx with the read as the body. */
  const send = <T>(reply: FastifyReply, r: CodeHostRead<T>) =>
    r.state === 'ok' ? reply.send(r) : reply.code(statusOf(r)).send(r);

  const repoOf = (req: FastifyRequest): string | null => {
    const p = req.params as { owner: string; name: string };
    const full = RepoFullName.safeParse(`${p.owner}/${p.name}`);
    return full.success ? full.data : null;
  };
  const q = (req: FastifyRequest): Record<string, string | undefined> =>
    req.query as Record<string, string | undefined>;

  // ------------------------------------------------------------ census

  app.get('/v1/repos', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    return send(reply, await hostOf().list_repos());
  });

  app.get('/v1/repos/:owner/:name/file', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const sha = GitSha.safeParse(q(req)['sha']);
    const path = q(req)['path'];
    if (!repo || !sha.success || !path) return bad(reply, 'owner/name, sha and path are required');
    return send(reply, await hostOf().read_at_sha({ repo, sha: sha.data, path }));
  });

  app.get('/v1/repos/:owner/:name/head', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const branch = q(req)['branch'];
    if (!repo || !branch) return bad(reply, 'owner/name and branch are required');
    return send(reply, await hostOf().branch_head({ repo, branch }));
  });

  app.get('/v1/repos/:owner/:name/codeowners', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const sha = GitSha.safeParse(q(req)['sha']);
    if (!repo || !sha.success) return bad(reply, 'owner/name and sha are required');
    return send(reply, await hostOf().codeowners({ repo, sha: sha.data }));
  });

  /**
   * The credential-free bundle (M5.3): `?refs=all|default_only` (default all) and optionally
   * `base_sha`. The body is the bundle, streamed from an already-unlinked file; `X-Base-Sha` is the
   * default branch's head and `X-Bundle-Manifest` the manifest as one line of JSON.
   */
  app.get('/v1/repos/:owner/:name/bundle', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const refs = BundleRefs.safeParse(q(req)['refs'] ?? 'all');
    const baseRaw = q(req)['base_sha'];
    const base = baseRaw === undefined ? undefined : GitSha.safeParse(baseRaw);
    if (!repo || !refs.success || (base !== undefined && !base.success)) {
      return bad(reply, 'owner/name, refs (all|default_only) and base_sha must be valid');
    }
    const r = await hostOf().bundle({
      repo,
      refs: refs.data,
      ...(base?.success ? { base_sha: base.data } : {}),
    });
    if (r.state !== 'ok') return send(reply, r);
    const { manifest, stream } = r.value;
    reply.raw.once('close', () => r.value.dispose());
    return reply
      .header('content-type', 'application/x-git-bundle')
      .header('content-length', String(manifest.bytes))
      .header('x-base-sha', manifest.head_sha)
      .header('x-bundle-manifest', JSON.stringify(manifest))
      .send(stream);
  });

  // ------------------------------------------------------------ the Push Broker (M13.6)

  /**
   * The one write the factory makes. The body is an `ApplyPatchRequest`; the checks (the `agent/**` ref, the lease epoch,
   * the secret ruleset, the paths, X2 for a protected path, a fast-forward) are the host's and run before any request to
   * GitHub. The answer is the read as for every route: `ok` with the applied patch, or the refusal with its `code`.
   */
  app.post('/v1/repos/:owner/:name/push', async (req, reply) => {
    if (!allowed(req, 'push')) return forbid(reply, 'push');
    const repo = repoOf(req);
    const body = req.body as { repo?: unknown } | null;
    if (!repo || typeof body !== 'object' || body === null || typeof body.repo !== 'string') {
      return bad(reply, 'owner/name and a patch request are required');
    }
    if (repoKey(body.repo) !== repoKey(repo))
      return bad(reply, 'the body names another repository');
    return send(reply, await hostOf().apply_patch(body as never));
  });

  app.get('/v1/repos/:owner/:name/pulls/:number', async (req, reply) => {
    if (!allowed(req, 'push')) return forbid(reply, 'push');
    const repo = repoOf(req);
    const number = Number((req.params as { number: string }).number);
    if (!repo || !Number.isInteger(number) || number < 1)
      return bad(reply, 'owner/name and a pull request number');
    return send(reply, await hostOf().pr_status({ repo, number }));
  });

  // ------------------------------------------------------------ the issue twin's tracker (M16)

  /**
   * The five operations of `IssueTrackerPort`, under scope `tracker`, for a REGISTERED repo only, through the tracker's
   * own App. The tracker's own checks (a twin's two labels and one marker; comments and closes on its own issues only)
   * run in `GitHubIssueTracker` before any request.
   */
  async function trackerFor(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ t: IssueTrackerPort; repo: RepoFullName } | null> {
    if (!allowed(req, 'tracker')) {
      forbid(reply, 'tracker');
      return null;
    }
    const repo = repoOf(req);
    if (!repo) {
      bad(reply, 'owner/name is required');
      return null;
    }
    if (!o.tracker) {
      send(
        reply,
        readUnreadable('not_implemented', 'no tracker App is configured on the codehost'),
      );
      return null;
    }
    const project = await hostOf().projectOf(repo);
    if (project.state !== 'ok') {
      send(reply, project);
      return null;
    }
    if (project.value === null) {
      send(reply, readUnreadable('repo_not_allowed', `${repo} is not a registered repository`));
      return null;
    }
    return { t: o.tracker, repo: repo as RepoFullName };
  }
  const numberOf = (req: FastifyRequest): number | null => {
    const n = Number((req.params as { number?: string }).number);
    return Number.isInteger(n) && n >= 1 ? n : null;
  };
  const strings = (b: unknown, keys: readonly string[]): Record<string, unknown> | null => {
    if (typeof b !== 'object' || b === null) return null;
    const r = b as Record<string, unknown>;
    if (Object.keys(r).some((k) => !keys.includes(k))) return null;
    return r;
  };

  app.get(TRACKER_ROUTES.issues(':owner/:name'), async (req, reply) => {
    const c = await trackerFor(req, reply);
    if (!c) return;
    const label = q(req)['label'];
    if (!label) return bad(reply, 'label is required');
    return send(reply, await c.t.list_labelled({ repo: c.repo, label }));
  });

  app.get(TRACKER_ROUTES.issue(':owner/:name', ':number' as never), async (req, reply) => {
    const c = await trackerFor(req, reply);
    if (!c) return;
    const n = numberOf(req);
    if (n === null) return bad(reply, 'an issue number');
    return send(reply, await c.t.read_issue({ repo: c.repo, number: n }));
  });

  app.post(TRACKER_ROUTES.issues(':owner/:name'), async (req, reply) => {
    const c = await trackerFor(req, reply);
    if (!c) return;
    const b = strings(req.body, ['title', 'body', 'labels']);
    if (
      !b ||
      typeof b['title'] !== 'string' ||
      typeof b['body'] !== 'string' ||
      !Array.isArray(b['labels']) ||
      !b['labels'].every((l) => typeof l === 'string')
    ) {
      return bad(reply, 'title, body and labels are required, and nothing else');
    }
    return send(
      reply,
      await c.t.file_issue({
        repo: c.repo,
        title: b['title'],
        body: b['body'],
        labels: b['labels'] as string[],
      }),
    );
  });

  app.post(TRACKER_ROUTES.comments(':owner/:name', ':number' as never), async (req, reply) => {
    const c = await trackerFor(req, reply);
    if (!c) return;
    const n = numberOf(req);
    const b = strings(req.body, ['body']);
    if (n === null || !b || typeof b['body'] !== 'string') {
      return bad(reply, 'an issue number and a body, and nothing else');
    }
    return send(reply, await c.t.comment_issue({ repo: c.repo, number: n, body: b['body'] }));
  });

  app.post(TRACKER_ROUTES.close(':owner/:name', ':number' as never), async (req, reply) => {
    const c = await trackerFor(req, reply);
    if (!c) return;
    const n = numberOf(req);
    if (n === null || !strings(req.body ?? {}, [])) return bad(reply, 'an issue number, no body');
    return send(reply, await c.t.close_issue({ repo: c.repo, number: n }));
  });

  // ------------------------------------------------------------ posture

  app.get('/v1/installation', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    return send(reply, await hostOf().installation());
  });

  app.get('/v1/repos/:owner/:name/rules', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    const branch = q(req)['branch'];
    if (!repo || !branch) return bad(reply, 'owner/name and branch are required');
    return send(reply, await hostOf().rules_for_branch({ repo, branch }));
  });

  app.get('/v1/repos/:owner/:name/collaborators', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    if (!repo) return bad(reply, 'owner/name is required');
    return send(reply, await hostOf().collaborators({ repo }));
  });

  app.get('/v1/repos/:owner/:name/codeowners/errors', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    if (!repo) return bad(reply, 'owner/name is required');
    const ref = q(req)['ref'];
    return send(
      reply,
      await hostOf().codeowners_errors({ repo, ...(ref === undefined ? {} : { ref }) }),
    );
  });

  /** B4a/b/c for one repo's default branch. A repo that is not allowed is refused; any unreadable input is `unknown`. */
  app.get('/v1/repos/:owner/:name/b4', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    if (!repo) return bad(reply, 'owner/name is required');
    const repos = await hostOf().list_repos();
    if (repos.state !== 'ok') return send(reply, repos);
    const info = repos.value.find((r) => repoKey(r.full_name) === repoKey(repo));
    if (!info) {
      return sendError(reply, 403, 'repo_not_allowed', `${repo} is not on the repo allow-list`);
    }
    const [installation, rules] = await Promise.all([
      hostOf().installation(),
      hostOf().rules_for_branch({ repo, branch: info.default_branch }),
    ]);
    const report = b4Checks({
      installation,
      required_checks: mapRead(rules, (r) => r.required_checks),
      ...(brokerOf()
        ? { token_permissions: (brokerOf() as TokenBroker).observedPermissions() }
        : {}),
    });
    return { repo: info.full_name, branch: info.default_branch, report };
  });

  // ------------------------------------------------------------ registry reload (M10.4)

  app.post('/v1/admin/reload', async (req, reply) => {
    if (!allowed(req, 'reload')) return forbid(reply, 'reload');
    if (!o.reload)
      return sendError(reply, 404, 'not_found', 'this code host has no registry reload');
    const force = (req.body as { force?: unknown } | null)?.force === true;
    return reply.send(await o.reload({ force }));
  });

  // ------------------------------------------------------------ CODEOWNERS feed

  app.post('/v1/projects/:project/codeowners/sync', async (req, reply) => {
    if (!allowed(req, 'codeowners_sync')) return forbid(reply, 'codeowners_sync');
    const project = ProjectId.safeParse((req.params as { project: string }).project);
    if (!project.success) return bad(reply, 'bad project id');
    const body = CodeownersSyncRequest.safeParse(req.body);
    if (!body.success) return bad(reply, 'body must be {repos: [{repo, sha?}]}');
    const r = await syncCodeowners(
      { host: hostOf(), identity: o.identity, clock },
      project.data,
      body.data,
    );
    return r.ok
      ? r.value
      : sendError(reply, CODEOWNERS_SYNC_STATUS[r.error.code], r.error.code, r.error.message);
  });

  return app;
}
