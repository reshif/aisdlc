import { KnowledgeJobState, type ProjectId } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';

// Core's two outbound dependencies, each behind a port with a deterministic fake (AGENTS.md):
//   KnowledgePort           the census-intake job API and the census of knowledge (step 0.1)
//   RoleMapReconcilerPort   identity's reconcile (a published role map becomes bindings)
// Both over HTTP with core's own service token. Neither ever throws: an answer that is not the
// expected one is an error with a kind, and the caller counts it as a machine failure or retries.

export type RemoteErrorKind =
  /** No answer: the service is down, the network failed, the call timed out, or the body was garbled. */
  | 'unreachable'
  /** An answer that says no: 4xx, or a service-side error the service itself reports. */
  | 'refused'
  /** An answer in a shape this client does not know. */
  | 'invalid';

export const RemoteError = taggedError('RemoteError');
export type RemoteError = TaggedError<'RemoteError', { kind: RemoteErrorKind; message: string }>;
export const remoteError = (kind: RemoteErrorKind, message: string): RemoteError =>
  RemoteError({ kind, message });

export interface RemoteOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const call = (o: RemoteOptions, method: 'GET' | 'POST', path: string, body?: unknown) =>
  callJson({
    baseUrl: o.baseUrl,
    token: o.token,
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    ...(o.timeoutMs ? { timeoutMs: o.timeoutMs } : {}),
  });

// ---------------------------------------------------------------- Knowledge

export type JobView = {
  readonly state: KnowledgeJobState;
  /** Why the job is `error` (a cause string of knowledge, never a repo value). */
  readonly error: string | null;
};

/** What step 0.1 needs of a census: which one, and whether a secret blocks the higher levels. */
export interface CensusSummary {
  readonly census_id: string;
  readonly census_hash: string;
  readonly job_id: string;
  /** B1: an open secret finding. */
  readonly b1_blocked: boolean;
  /** B1 or B2 is not met: an open secret, or a scan that did not complete (fail closed). */
  readonly secrets_not_met: boolean;
}

export interface KnowledgePort {
  startCensus(repo: string): Promise<Result<{ job_id: string }, RemoteError>>;
  job(jobId: string): Promise<Result<JobView, RemoteError>>;
  /** The newest census of the repo, or `null` when there is none. */
  latestCensus(repo: string): Promise<Result<CensusSummary | null, RemoteError>>;
}

const JobShape = z.looseObject({
  job_id: z.string().min(1),
  state: KnowledgeJobState,
  error: z.string().nullable().optional(),
});
const CensusShape = z.looseObject({
  census_id: z.string().min(1),
  census_hash: z.string().regex(/^[0-9a-f]{64}$/),
  job_id: z.string().min(1),
  census: z.looseObject({
    blockers: z.array(z.looseObject({ id: z.string(), status: z.string() })),
  }),
});

const failFor = (status: number, what: string): RemoteError =>
  remoteError(status >= 500 ? 'unreachable' : 'refused', `${what}: ${status}`);

/** `KnowledgePort` over knowledge's HTTP API (scope `census`). */
export class HttpKnowledge implements KnowledgePort {
  constructor(private readonly o: RemoteOptions) {}

  async startCensus(repo: string) {
    const r = await call(this.o, 'POST', '/v1/jobs/census-intake', { repo });
    if (!r.reached) return err(remoteError('unreachable', 'knowledge did not answer'));
    if (r.status !== 202 && r.status !== 200) return err(failFor(r.status, 'knowledge'));
    const p = JobShape.safeParse(r.json);
    return p.success
      ? ok({ job_id: p.data.job_id })
      : err(remoteError('invalid', 'knowledge answered with an unexpected shape'));
  }

  async job(jobId: string) {
    const r = await call(this.o, 'GET', `/v1/jobs/${encodeURIComponent(jobId)}`);
    if (!r.reached) return err(remoteError('unreachable', 'knowledge did not answer'));
    if (r.status !== 200) return err(failFor(r.status, 'knowledge'));
    const p = JobShape.safeParse(r.json);
    return p.success
      ? ok({ state: p.data.state, error: p.data.error ?? null })
      : err(remoteError('invalid', 'knowledge answered with an unexpected shape'));
  }

  async latestCensus(repo: string) {
    const r = await call(this.o, 'GET', `/v1/repos/${repo}/census/latest`);
    if (!r.reached) return err(remoteError('unreachable', 'knowledge did not answer'));
    if (r.status === 404) return ok(null);
    if (r.status !== 200) return err(failFor(r.status, 'knowledge'));
    const p = CensusShape.safeParse(r.json);
    if (!p.success)
      return err(remoteError('invalid', 'knowledge answered with an unexpected shape'));
    const status = (id: string) => p.data.census.blockers.find((b) => b.id === id)?.status;
    return ok({
      census_id: p.data.census_id,
      census_hash: p.data.census_hash,
      job_id: p.data.job_id,
      b1_blocked: status('B1') === 'blocked',
      // Unknown, absent and not evaluated are not met (fail closed).
      secrets_not_met: status('B1') !== 'met' || status('B2') !== 'met',
    });
  }
}

/**
 * Deterministic `KnowledgePort`. A started job stays `queued` until the test settles it
 * (`finish`, `fail`) or `auto` says what every new job does. `down` makes every call unreachable.
 */
export class FakeKnowledge implements KnowledgePort {
  readonly started: string[] = [];
  readonly jobs = new Map<
    string,
    { repo: string; state: KnowledgeJobState; error: string | null }
  >();
  private readonly censuses = new Map<string, CensusSummary>();
  down = false;
  /** What a new job becomes at once: `queued` (the test settles it), `done` or `error`. */
  auto: 'queued' | 'done' | 'error' = 'queued';
  private n = 0;

  /** The census every job of `repo` produces when it finishes. */
  censusFor(
    repo: string,
    o: { b1_blocked?: boolean; secrets_not_met?: boolean } = {},
  ): (jobId: string) => CensusSummary {
    return (jobId) => ({
      census_id: `census:${repo.toLowerCase().replace('/', '.')}:${'a'.repeat(40)}`,
      census_hash: 'b'.repeat(64),
      job_id: jobId,
      b1_blocked: o.b1_blocked ?? false,
      secrets_not_met: o.secrets_not_met ?? o.b1_blocked ?? false,
    });
  }
  private makeCensus: ((repo: string, jobId: string) => CensusSummary) | null = null;
  withCensus(f: (repo: string, jobId: string) => CensusSummary): this {
    this.makeCensus = f;
    return this;
  }

  async startCensus(repo: string) {
    if (this.down) return err(remoteError('unreachable', 'knowledge is down'));
    this.n += 1;
    const job_id = `job-${this.n}`;
    this.started.push(repo);
    this.jobs.set(job_id, { repo, state: 'queued', error: null });
    if (this.auto === 'done') this.finish(job_id);
    if (this.auto === 'error') this.fail(job_id, 'source_not_ok: unknown');
    return ok({ job_id });
  }

  /** Makes `repo`'s newest census this one, whatever job made it. */
  setCensus(repo: string, census: CensusSummary): void {
    this.censuses.set(repo.toLowerCase(), census);
  }

  finish(jobId: string): void {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    j.state = 'done';
    const make = this.makeCensus ?? ((repo: string, id: string) => this.censusFor(repo)(id));
    this.censuses.set(j.repo.toLowerCase(), make(j.repo, jobId));
  }

  fail(jobId: string, error: string): void {
    const j = this.jobs.get(jobId);
    if (!j) throw new Error(`no job ${jobId}`);
    j.state = 'error';
    j.error = error;
  }

  async job(jobId: string) {
    if (this.down) return err(remoteError('unreachable', 'knowledge is down'));
    const j = this.jobs.get(jobId);
    return j ? ok({ state: j.state, error: j.error }) : err(remoteError('refused', 'no such job'));
  }

  async latestCensus(repo: string) {
    if (this.down) return err(remoteError('unreachable', 'knowledge is down'));
    return ok(this.censuses.get(repo.toLowerCase()) ?? null);
  }
}

// ---------------------------------------------------------------- Identity

export interface ReconcileReceipt {
  /** Journal events identity wrote; 0 when the project already matched its role map. */
  readonly events: number;
}

export interface RoleMapReconcilerPort {
  /**
   * Asks identity to make the project's bindings equal what its settings imply. `config_rev` is the
   * published revision, `m_gate_ref` the ledger entry of the M1 decision that approved it.
   * Idempotent on identity's side.
   */
  reconcile(
    project: ProjectId,
    o: { config_rev: string; m_gate_ref: string },
  ): Promise<Result<ReconcileReceipt, RemoteError>>;
}

/** `RoleMapReconcilerPort` over identity's `POST /v1/projects/:id/reconcile` (scope `reconcile`). */
export class HttpRoleMapReconciler implements RoleMapReconcilerPort {
  constructor(private readonly o: RemoteOptions) {}

  async reconcile(project: ProjectId, body: { config_rev: string; m_gate_ref: string }) {
    const r = await call(
      this.o,
      'POST',
      `/v1/projects/${encodeURIComponent(project)}/reconcile`,
      body,
    );
    if (!r.reached) return err(remoteError('unreachable', 'identity did not answer'));
    if (r.status !== 200) {
      const detail = z
        .looseObject({ error: z.looseObject({ code: z.string().optional() }) })
        .safeParse(r.json);
      return err(
        failFor(
          r.status,
          `identity${detail.success ? ` ${detail.data.error.code ?? ''}` : ''}`.trim(),
        ),
      );
    }
    const p = z.looseObject({ events: z.number().int().min(0) }).safeParse(r.json);
    return p.success
      ? ok({ events: p.data.events })
      : err(remoteError('invalid', 'identity answered with an unexpected shape'));
  }
}

/** Deterministic `RoleMapReconcilerPort`: records the calls, and fails while `down` or `refuse` is set. */
export class FakeRoleMapReconciler implements RoleMapReconcilerPort {
  readonly calls: Array<{ project: string; config_rev: string; m_gate_ref: string }> = [];
  down = false;
  refuse = false;

  async reconcile(project: ProjectId, o: { config_rev: string; m_gate_ref: string }) {
    if (this.down) return err(remoteError('unreachable', 'identity is down'));
    if (this.refuse) return err(remoteError('refused', 'identity refused'));
    this.calls.push({ project, ...o });
    return ok({ events: 1 });
  }
}
