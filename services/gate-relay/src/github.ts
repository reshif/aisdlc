import {
  DeploymentState,
  GATE_RELAY_APP_PERMISSIONS,
  type CodeHostNotOk,
  type CodeHostRead,
} from '@aisdlc/contracts';
import type { AppKey } from '@aisdlc/codehost';
import { SecretValue, appJwt, notOkFromFetchError, notOkFromStatus } from '@aisdlc/codehost';
import { checkBaseUrl } from '@aisdlc/gate-check';
import { systemClock, type Clock } from '@aisdlc/kernel';
import {
  badDeploymentCreate,
  readOk,
  readUnknown,
  readUnreadable,
  tagOf,
  type DeploymentCreate,
  type DeploymentRead,
  type DeploymentStatusRead,
  type GateRelayHostPort,
} from '@aisdlc/ports';
import { ServiceConfigError } from '@aisdlc/service-kit';
import { z } from 'zod';

// gate-relay's GitHub adapter (PLAN M15.3): its OWN App (not the codehost's, not gate-check's), one installation token
// with exactly `GATE_RELAY_APP_PERMISSIONS` (deployments write, metadata read), and four requests it can make, by
// construction:
//
//   POST /app/installations/{id}/access_tokens        (the App JWT) the installation token
//   GET  /repos/{r}/deployments?sha=&environment=      a G5's deployment, if it was already made (exactly once)
//   POST /repos/{r}/deployments                        a deployment of the merged commit (ref = the sha, auto-merge
//                                                      off, required contexts as the environment's rules say)
//   GET  /repos/{r}/deployments/{id}/statuses          what the deploy system reported
//
// There is no other method, so nothing here can push, merge, approve, write a status or a check run, or change an
// environment. A token that comes back with more than was asked is discarded. The base URL is configuration (https,
// or plain http to loopback or a host the deployment names: the compose stack's fake GitHub); redirects are never
// followed; no error or log line carries a header, a body or the token.

export interface GitHubDeploymentsOptions {
  readonly baseUrl: string;
  readonly appId: string;
  readonly installationId: number;
  readonly appKey: AppKey;
  readonly plainHttpHosts?: readonly string[];
  readonly clock?: Clock;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  /** One line per request: `GET /repos/{r}/deployments -> 200`. Never a header, a body or a query value. */
  readonly log?: (line: string) => void;
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };
const READ_LIMIT = 8 * 1024 * 1024;

const MintResponse = z.looseObject({
  token: z.string().min(1),
  expires_at: z.iso.datetime({ offset: true }),
  permissions: z.record(z.string(), z.string()),
});
const Deployment = z.looseObject({
  id: z.number().int().min(1),
  sha: z.string().regex(/^[0-9a-f]{40}$/),
  environment: z.string(),
  payload: z.unknown().optional(),
  created_at: z.string(),
});
const Status = z.looseObject({
  id: z.number().int(),
  state: z.string(),
  created_at: z.string(),
});

const enc = (repo: string): string =>
  repo
    .split('/')
    .map((p) => encodeURIComponent(p))
    .join('/');

export class GitHubDeploymentsHost implements GateRelayHostPort {
  readonly app_id: number;
  private readonly base: URL;
  private readonly clock: Clock;
  private readonly f: typeof fetch;
  private token: { secret: SecretValue; expires_at: number } | null = null;
  /** Tokens minted (cache hits are not mints). */
  mints = 0;

  constructor(private readonly o: GitHubDeploymentsOptions) {
    this.base = checkBaseUrl(o.baseUrl, o.plainHttpHosts);
    const id = Number(o.appId);
    if (!Number.isInteger(id) || id < 1)
      throw new ServiceConfigError('the App id is a positive integer');
    this.app_id = id;
    this.clock = o.clock ?? systemClock;
    this.f = o.fetchImpl ?? fetch;
  }

  private url(path: string): string {
    return `${this.base.origin}${this.base.pathname.replace(/\/$/, '')}${path}`;
  }

  private async send(
    method: 'GET' | 'POST',
    template: string,
    url: string,
    authorization: string,
    body?: unknown,
  ): Promise<{ json: unknown } | CodeHostNotOk> {
    const what = `${method} ${template}`;
    let res: Response;
    try {
      res = await this.f(url, {
        method,
        redirect: 'manual',
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 15_000),
        headers: {
          accept: 'application/vnd.github+json',
          'x-github-api-version': '2022-11-28',
          authorization,
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (e) {
      this.o.log?.(`${what} -> 0`);
      return notOkFromFetchError(e, what);
    }
    this.o.log?.(`${what} -> ${res.status}`);
    const text = await res.text().catch(() => null);
    if (text === null || text.length > READ_LIMIT) {
      return readUnknown('malformed', `${what}: the answer could not be read`);
    }
    if (res.status < 200 || res.status >= 300)
      return notOkFromStatus(res.status, res.headers, what);
    try {
      return { json: text === '' ? null : JSON.parse(text) };
    } catch {
      return readUnknown('malformed', `${what}: not JSON`);
    }
  }

  /** The installation token, minted with exactly the App's permissions; one that carries more is discarded. */
  private async auth(): Promise<string | CodeHostNotOk> {
    const now = this.clock.now().getTime();
    if (this.token && this.token.expires_at - 120_000 > now) {
      return `Bearer ${this.token.secret.reveal()}`;
    }
    this.token = null;
    const jwt = appJwt(this.o.appKey, this.o.appId, this.clock.now());
    const r = await this.send(
      'POST',
      '/app/installations/{installation_id}/access_tokens',
      this.url(`/app/installations/${this.o.installationId}/access_tokens`),
      `Bearer ${jwt}`,
      { permissions: GATE_RELAY_APP_PERMISSIONS },
    );
    if ('state' in r) return r;
    const m = MintResponse.safeParse(r.json);
    if (!m.success) return readUnknown('malformed', 'the token answer has no usable token');
    for (const [name, level] of Object.entries(m.data.permissions)) {
      const asked = GATE_RELAY_APP_PERMISSIONS[name];
      if (asked === undefined || (LEVEL[level] ?? 99) > (LEVEL[asked] ?? 0)) {
        return readUnreadable('refused', `the token came back with more than was asked (${name})`);
      }
    }
    this.mints += 1;
    this.token = {
      secret: new SecretValue(m.data.token),
      expires_at: Date.parse(m.data.expires_at),
    };
    return `Bearer ${m.data.token}`;
  }

  private readOf(d: z.infer<typeof Deployment>): DeploymentRead {
    return {
      id: d.id,
      sha: d.sha,
      environment: d.environment,
      tag: tagOf(d.payload),
      created_at: d.created_at,
    };
  }

  async list_deployments(req: {
    repo: string;
    sha: string;
    environment: string;
  }): Promise<CodeHostRead<DeploymentRead[]>> {
    if (!/^[0-9a-f]{40}$/.test(req.sha)) return readUnreadable('refused', 'not a commit sha');
    const a = await this.auth();
    if (typeof a !== 'string') return a;
    const qs = new URLSearchParams({
      sha: req.sha,
      environment: req.environment,
      per_page: '100',
    }).toString();
    const r = await this.send(
      'GET',
      '/repos/{r}/deployments',
      `${this.url(`/repos/${enc(req.repo)}/deployments`)}?${qs}`,
      a,
    );
    if ('state' in r) return r;
    const list = z.array(Deployment).safeParse(r.json);
    if (!list.success) return readUnknown('malformed', 'the deployments have an unexpected shape');
    return readOk(
      list.data
        .filter((d) => d.sha === req.sha && d.environment === req.environment)
        .map((d) => this.readOf(d)),
    );
  }

  async create_deployment(req: DeploymentCreate): Promise<CodeHostRead<DeploymentRead>> {
    const bad = badDeploymentCreate(req);
    if (bad) return readUnreadable('refused', bad);
    const a = await this.auth();
    if (typeof a !== 'string') return a;
    const r = await this.send(
      'POST',
      '/repos/{r}/deployments',
      this.url(`/repos/${enc(req.repo)}/deployments`),
      a,
      {
        ref: req.sha,
        task: 'deploy',
        auto_merge: false,
        environment: req.environment,
        description: req.description,
        payload: req.tag,
        transient_environment: false,
      },
    );
    if ('state' in r) return r;
    const d = Deployment.safeParse(r.json);
    if (!d.success) return readUnknown('malformed', 'the deployment answer has no id');
    return readOk(this.readOf(d.data));
  }

  async deployment_statuses(req: {
    repo: string;
    deployment_id: number;
  }): Promise<CodeHostRead<DeploymentStatusRead[]>> {
    if (!Number.isInteger(req.deployment_id) || req.deployment_id < 1)
      return readUnreadable('refused', 'not a deployment id');
    const a = await this.auth();
    if (typeof a !== 'string') return a;
    const r = await this.send(
      'GET',
      '/repos/{r}/deployments/{id}/statuses',
      `${this.url(`/repos/${enc(req.repo)}/deployments/${req.deployment_id}/statuses`)}?per_page=100`,
      a,
    );
    if ('state' in r) return r;
    const list = z.array(Status).safeParse(r.json);
    if (!list.success) return readUnknown('malformed', 'the statuses have an unexpected shape');
    const out: DeploymentStatusRead[] = [];
    for (const x of list.data) {
      const st = DeploymentState.safeParse(x.state);
      // a state this build does not know is no verdict: it reads as pending, never as success
      out.push({ id: x.id, state: st.success ? st.data : 'pending', created_at: x.created_at });
    }
    return readOk(out);
  }
}
