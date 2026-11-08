import {
  CodeownersSyncRequest,
  GitSha,
  ProjectId,
  RepoFullName,
  type CodeHostNotOk,
  type CodeHostRead,
} from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { mapRead, repoKey } from '@aisdlc/ports';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { b4Checks } from './b4.js';
import { CODEOWNERS_SYNC_STATUS, syncCodeowners } from './codeowners-sync.js';
import type { IdentityLinksPort } from './identity-client.js';
import type { AllowListedCodeHost } from './repo-allow-list.js';
import type { TokenBroker } from './token-broker.js';

/**
 * What a caller may do (PLAN M5.2): `census` reads repo facts for the Census (the repos, files,
 * heads, CODEOWNERS), `posture` reads the posture facts (installation, effective rules,
 * collaborators, CODEOWNERS errors, the B4 verdict), `codeowners_sync` feeds CODEOWNERS owners into
 * the project's g4 group.
 */
export type CodeHostScope = 'census' | 'posture' | 'codeowners_sync';

export interface CodeHostAppOptions {
  readonly host: AllowListedCodeHost;
  readonly identity: IdentityLinksPort;
  readonly auth: ServiceAuth;
  /** caller name -> scopes. A caller with no entry may do nothing. */
  readonly callers: Record<string, readonly CodeHostScope[]>;
  /** For the B4a check on the permissions of tokens actually minted. */
  readonly broker?: TokenBroker;
  readonly clock?: Clock;
}

const statusOf = (r: CodeHostNotOk): number => {
  if (r.state === 'unknown') return 503;
  if (r.reason === 'repo_not_allowed' || r.reason === 'refused') return 403;
  if (r.reason === 'not_found') return 404;
  return 422;
};

/** HTTP in front of the code host: service tokens only; a read that is not `ok` is never a 2xx. */
export function createCodeHostApp(o: CodeHostAppOptions): FastifyInstance {
  const app = newApp();
  const clock = o.clock ?? systemClock;

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
    return send(reply, await o.host.list_repos());
  });

  app.get('/v1/repos/:owner/:name/file', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const sha = GitSha.safeParse(q(req)['sha']);
    const path = q(req)['path'];
    if (!repo || !sha.success || !path) return bad(reply, 'owner/name, sha and path are required');
    return send(reply, await o.host.read_at_sha({ repo, sha: sha.data, path }));
  });

  app.get('/v1/repos/:owner/:name/head', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const branch = q(req)['branch'];
    if (!repo || !branch) return bad(reply, 'owner/name and branch are required');
    return send(reply, await o.host.branch_head({ repo, branch }));
  });

  app.get('/v1/repos/:owner/:name/codeowners', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = repoOf(req);
    const sha = GitSha.safeParse(q(req)['sha']);
    if (!repo || !sha.success) return bad(reply, 'owner/name and sha are required');
    return send(reply, await o.host.codeowners({ repo, sha: sha.data }));
  });

  // ------------------------------------------------------------ posture

  app.get('/v1/installation', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    return send(reply, await o.host.installation());
  });

  app.get('/v1/repos/:owner/:name/rules', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    const branch = q(req)['branch'];
    if (!repo || !branch) return bad(reply, 'owner/name and branch are required');
    return send(reply, await o.host.rules_for_branch({ repo, branch }));
  });

  app.get('/v1/repos/:owner/:name/collaborators', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    if (!repo) return bad(reply, 'owner/name is required');
    return send(reply, await o.host.collaborators({ repo }));
  });

  app.get('/v1/repos/:owner/:name/codeowners/errors', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    if (!repo) return bad(reply, 'owner/name is required');
    const ref = q(req)['ref'];
    return send(
      reply,
      await o.host.codeowners_errors({ repo, ...(ref === undefined ? {} : { ref }) }),
    );
  });

  /** B4a/b/c for one repo's default branch. A repo that is not allowed is refused; any unreadable input is `unknown`. */
  app.get('/v1/repos/:owner/:name/b4', async (req, reply) => {
    if (!allowed(req, 'posture')) return forbid(reply, 'posture');
    const repo = repoOf(req);
    if (!repo) return bad(reply, 'owner/name is required');
    const repos = await o.host.list_repos();
    if (repos.state !== 'ok') return send(reply, repos);
    const info = repos.value.find((r) => repoKey(r.full_name) === repoKey(repo));
    if (!info) {
      return sendError(reply, 403, 'repo_not_allowed', `${repo} is not on the repo allow-list`);
    }
    const [installation, rules] = await Promise.all([
      o.host.installation(),
      o.host.rules_for_branch({ repo, branch: info.default_branch }),
    ]);
    const report = b4Checks({
      installation,
      required_checks: mapRead(rules, (r) => r.required_checks),
      ...(o.broker ? { token_permissions: o.broker.observedPermissions() } : {}),
    });
    return { repo: info.full_name, branch: info.default_branch, report };
  });

  // ------------------------------------------------------------ CODEOWNERS feed

  app.post('/v1/projects/:project/codeowners/sync', async (req, reply) => {
    if (!allowed(req, 'codeowners_sync')) return forbid(reply, 'codeowners_sync');
    const project = ProjectId.safeParse((req.params as { project: string }).project);
    if (!project.success) return bad(reply, 'bad project id');
    const body = CodeownersSyncRequest.safeParse(req.body);
    if (!body.success) return bad(reply, 'body must be {repos: [{repo, sha?}]}');
    const r = await syncCodeowners(
      { host: o.host, identity: o.identity, clock },
      project.data,
      body.data,
    );
    return r.ok
      ? r.value
      : sendError(reply, CODEOWNERS_SYNC_STATUS[r.error.code], r.error.code, r.error.message);
  });

  return app;
}
