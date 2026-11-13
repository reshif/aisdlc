import {
  FindingState,
  SetFindingStateRequest,
  StartCensusIntakeRequest,
  RepoFullName,
  b1Blocked,
  b2Reasons,
} from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { KNOWLEDGE_STATUS, knowledgeError, type KnowledgeError } from './errors.js';
import type { DecisionVerifier } from './decision-ref.js';
import type { PrincipalDirectory } from './principals.js';
import { getLatestCensus } from './census/store.js';
import type { JobRunner } from './runner.js';
import { FileQuery, SearchQuery, readRepoFile, searchRepo } from './search.js';
import { codeGraphAt } from './codegraph.js';
import {
  countFindings,
  getFinding,
  getJob,
  latestDoneJob,
  listFindings,
  setFindingState,
} from './store.js';

/**
 * What a caller may do. `census`: start a census-intake job, read a job and the COUNTS of a repo's
 * scan. `security`: read findings (fingerprints, locations) and set their state. The two are
 * separate scopes (OB §5.3 item 10: findings are for the Security role only), and a caller that
 * holds `census` can read no finding. `search` (M12.1): the read-only repository search an agent's
 * `KnowledgeSearch` tool runs; it reads indexed text (never a finding) and changes nothing.
 */
export type KnowledgeScope = 'census' | 'security' | 'search';

export interface KnowledgeAppOptions {
  readonly pool: pg.Pool;
  readonly auth: ServiceAuth;
  /** caller name -> scopes. A caller with no entry may do nothing. */
  readonly callers: Record<string, readonly KnowledgeScope[]>;
  readonly runner: JobRunner;
  readonly principals: PrincipalDirectory;
  /** Checks the ledgered card decision a finding state change rests on (PLAN M7.4). */
  readonly decisions: DecisionVerifier;
  readonly clock?: Clock;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** HTTP in front of knowledge (service tokens only). */
export function createKnowledgeApp(o: KnowledgeAppOptions): FastifyInstance {
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

  const callerOf = (req: FastifyRequest): string => (req as unknown as { caller: string }).caller;
  const allowed = (req: FastifyRequest, scope: KnowledgeScope): boolean =>
    (o.callers[callerOf(req)] ?? []).includes(scope);
  const forbid = (reply: FastifyReply, scope: KnowledgeScope) =>
    sendError(reply, 403, 'forbidden', `caller may not use scope ${scope}`);
  const fail = (reply: FastifyReply, e: KnowledgeError) =>
    sendError(reply, KNOWLEDGE_STATUS[e.code], e.code, e.message);
  const bad = (reply: FastifyReply, message: string) =>
    fail(reply, knowledgeError('invalid_input', message));
  const params = (req: FastifyRequest): Record<string, string> =>
    req.params as Record<string, string>;
  const query = (req: FastifyRequest): Record<string, string | undefined> =>
    req.query as Record<string, string | undefined>;

  // ------------------------------------------------------------ census

  app.post('/v1/jobs/census-intake', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const body = StartCensusIntakeRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.message);
    const job = await o.runner.start(body.data);
    if (!job.ok) return fail(reply, job.error);
    return reply.code(202).send(job.value);
  });

  app.get('/v1/jobs/:id', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const id = params(req)['id'] as string;
    if (!UUID.test(id)) return bad(reply, 'job id must be a UUID');
    const job = await getJob(o.pool, id);
    return job ? job : fail(reply, knowledgeError('not_found', 'no such job'));
  });

  /**
   * What the census reads: the newest finished scan of a repo with the CURRENT finding counts (a
   * human may have decided since), and whether B1 or B2 blocks. Counts only. No finished job, or
   * one whose scan did not complete, is B2: absence is never "clean".
   */
  app.get('/v1/repos/:owner/:name/security-summary', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return bad(reply, 'owner/name is not a repository');
    const job = await latestDoneJob(o.pool, repo.data);
    if (!job?.result) {
      return { repo: repo.data, scanned: false, b1_blocked: false, b2_reasons: ['no_scan'] };
    }
    const counts = await countFindings(o.pool, repo.data);
    const r = job.result;
    return {
      repo: repo.data,
      scanned: true,
      job_id: job.job_id,
      finished_at: job.finished_at,
      base_sha: r.base_sha,
      scan_status: r.scan_status,
      scan_coverage: r.scan_coverage,
      coverage_counts: r.coverage_counts,
      finding_counts: counts,
      b1_blocked: b1Blocked(counts),
      b2_reasons: b2Reasons(r),
    };
  });

  /**
   * The newest census of a repo and its gap ledger (PLAN M6.5). Counts only where secrets are
   * concerned: the record holds no finding, fingerprint, path or commit, and neither does this.
   */
  app.get('/v1/repos/:owner/:name/census/latest', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return bad(reply, 'owner/name is not a repository');
    const latest = await getLatestCensus(o.pool, repo.data);
    return latest ?? fail(reply, knowledgeError('not_found', 'no census for this repository'));
  });

  /**
   * Read-only search over the indexed head tree of a repo (PLAN M12.1 2.1b). The caller names the commit it
   * needs (`sha`); an index built at another commit answers `409 stale_index`, none at all `404`.
   */
  app.get('/v1/repos/:owner/:name/search', async (req, reply) => {
    if (!allowed(req, 'search')) return forbid(reply, 'search');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return bad(reply, 'owner/name is not a repository');
    const q = SearchQuery.safeParse(query(req));
    if (!q.success) return bad(reply, q.error.message);
    const r = await searchRepo(o.pool, repo.data, q.data);
    if (r.state === 'not_indexed') {
      return fail(reply, knowledgeError('not_found', 'this repository has no search index'));
    }
    if (r.state === 'stale_index') {
      return sendError(reply, 409, 'stale_index', 'the index is not at the requested commit');
    }
    return { repo: repo.data, commit_sha: q.data.sha, hits: r.hits };
  });

  /**
   * One file of the indexed head tree (the onboarder's RepoRead). Same commit rule as the search; a file the index
   * does not hold, or one the secret ruleset hits, is `404 not_available` (the same answer, so existence is not leaked).
   */
  app.get('/v1/repos/:owner/:name/file', async (req, reply) => {
    if (!allowed(req, 'search')) return forbid(reply, 'search');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return bad(reply, 'owner/name is not a repository');
    const q = FileQuery.safeParse(query(req));
    if (!q.success) return bad(reply, q.error.message);
    const r = await readRepoFile(o.pool, repo.data, q.data);
    if (r.state === 'not_indexed') {
      return fail(reply, knowledgeError('not_found', 'this repository has no search index'));
    }
    if (r.state === 'stale_index') {
      return sendError(reply, 409, 'stale_index', 'the index is not at the requested commit');
    }
    if (r.state === 'not_available') {
      return sendError(reply, 404, 'not_available', 'that file is not available');
    }
    return r.file;
  });

  /**
   * The code graph of a repo's indexed head tree (PLAN M17, step 0.3): files, areas, exported names and the
   * imports between them; paths, blob ids and identifiers only. Same commit rule as the search: another
   * commit is `409 stale_index`, no index `404`. Scope `census` (it is part of the onboarding baseline).
   */
  app.get('/v1/repos/:owner/:name/codegraph', async (req, reply) => {
    if (!allowed(req, 'census')) return forbid(reply, 'census');
    const repo = RepoFullName.safeParse(`${params(req)['owner']}/${params(req)['name']}`);
    if (!repo.success) return bad(reply, 'owner/name is not a repository');
    const sha = query(req)['sha'] ?? '';
    if (!/^[0-9a-f]{40}$/.test(sha)) return bad(reply, 'sha must be a 40-hex commit');
    const r = await codeGraphAt(o.pool, repo.data, sha);
    if (r.state === 'not_indexed') {
      return fail(reply, knowledgeError('not_found', 'this repository has no index'));
    }
    if (r.state === 'stale_index') {
      return sendError(reply, 409, 'stale_index', 'the index is not at the requested commit');
    }
    return r.graph;
  });

  // ------------------------------------------------------------ Security only

  app.get('/v1/security/findings', async (req, reply) => {
    if (!allowed(req, 'security')) return forbid(reply, 'security');
    const q = query(req);
    const state = q['state'] === undefined ? undefined : FindingState.safeParse(q['state']);
    if (state !== undefined && !state.success) return bad(reply, 'state is not a finding state');
    const repo = q['repo'] === undefined ? undefined : RepoFullName.safeParse(q['repo']);
    if (repo !== undefined && !repo.success) return bad(reply, 'repo must be owner/name');
    return {
      findings: await listFindings(o.pool, {
        repo: repo?.data,
        state: state?.data,
      }),
    };
  });

  app.get('/v1/security/findings/:id', async (req, reply) => {
    if (!allowed(req, 'security')) return forbid(reply, 'security');
    const id = params(req)['id'] as string;
    if (!UUID.test(id)) return bad(reply, 'finding id must be a UUID');
    const f = await getFinding(o.pool, id);
    return f ? f : fail(reply, knowledgeError('not_found', 'no such finding'));
  });

  /**
   * Human-only state change. The caller (the bff, with the `security` scope) names the human it acts
   * for; that principal must be an active HUMAN in identity. A service principal, an unknown one, or
   * an identity service that cannot answer is refused. The change also names the decided, ledgered
   * security-card decision it rests on (`decision_ref`), verified against the ledger for exactly
   * this finding, state and human; without one nothing changes (PLAN M7.4).
   */
  app.post('/v1/security/findings/:id/state', async (req, reply) => {
    if (!allowed(req, 'security')) return forbid(reply, 'security');
    const id = params(req)['id'] as string;
    if (!UUID.test(id)) return bad(reply, 'finding id must be a UUID');
    const body = SetFindingStateRequest.safeParse(req.body);
    if (!body.success) return bad(reply, body.error.message);
    const r = await setFindingState(
      { pool: o.pool, clock, principals: o.principals, decisions: o.decisions },
      id,
      body.data,
    );
    return r.ok ? r.value : fail(reply, r.error);
  });

  return app;
}
