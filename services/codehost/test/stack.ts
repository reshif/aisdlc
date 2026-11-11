import { PrincipalId } from '@aisdlc/contracts';
import {
  emptySeed,
  type CodeHostSeed,
  type FakeRegisteredRepos,
  type PushGuardsPort,
} from '@aisdlc/ports';
import { contractSeed } from '@aisdlc/ports/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import {
  AllowListedCodeHost,
  createCodeHostApp,
  type CodeHostScope,
  type IdentityLinksPort,
} from '../src/index.js';
import { startTestCodeHost, type TestCodeHost } from '../src/testing.js';

export const SHA_HEAD = 'c'.repeat(40);

/** acme/app (default branch main) and acme/lib (trunk); CODEOWNERS on acme/app at the head. */
export function seedWithOwners(codeowners: string): CodeHostSeed {
  const base = contractSeed();
  return emptySeed({
    installation: base.installation,
    repos: base.repos,
    heads: [
      { repo: 'acme/app', branch: 'main', sha: SHA_HEAD },
      { repo: 'acme/lib', branch: 'trunk', sha: 'd'.repeat(40) },
    ],
    files: [
      { repo: 'acme/app', sha: SHA_HEAD, path: '.github/CODEOWNERS', content: codeowners },
      { repo: 'acme/app', sha: SHA_HEAD, path: 'README.md', content: '# hi\n' },
      { repo: 'acme/lib', sha: 'd'.repeat(40), path: 'CODEOWNERS', content: '* @libowner\n' },
    ],
    rules: base.rules,
    codeowners_errors: base.codeowners_errors,
    collaborators: base.collaborators,
  });
}

export const TOKENS = {
  census: 'census-token-'.padEnd(32, 'x'),
  posture: 'posture-token-'.padEnd(32, 'x'),
  sync: 'sync-token-'.padEnd(32, 'x'),
  all: 'all-token-'.padEnd(32, 'x'),
  none: 'none-token-'.padEnd(32, 'x'),
  push: 'push-token-'.padEnd(32, 'x'),
};

export interface Reply {
  status: number;
  text: string;
  headers: string;
  // Responses are asserted field by field; typing every body would only repeat the contracts.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  json: any;
}

export interface CodeHostTestApp {
  gh: TestCodeHost;
  host: AllowListedCodeHost;
  app: FastifyInstance;
  url: string;
  registered: FakeRegisteredRepos;
  /** Everything every response said (status line, headers, body): the text secrets must not be in. */
  outputs: string[];
  call(token: string | null, method: string, path: string, body?: unknown): Promise<Reply>;
  stop(): Promise<void>;
}

/** The real broker, transport, adapter, allow-list and Fastify app over the fake GitHub HTTP server. */
export async function startCodeHostApp(
  identity: IdentityLinksPort,
  seed: CodeHostSeed,
  registered: Array<{ project_id: string; repo: string }> = [
    { project_id: 'acme', repo: 'acme/app' },
  ],
  git?: NonNullable<Parameters<typeof startTestCodeHost>[0]>['git'],
  /** The Push Broker (M13.6): with guards the host runs in push mode and the `push` caller may use it. */
  guards?: PushGuardsPort,
): Promise<CodeHostTestApp> {
  const gh = await startTestCodeHost({
    seed,
    ...(git ? { git } : {}),
    ...(guards ? { guards, mode: 'push' as const } : {}),
  });
  gh.registered.set(registered as never);
  const host = new AllowListedCodeHost(gh.rest, gh.registered);
  const callers: Record<string, readonly CodeHostScope[]> = {
    census: ['census'],
    posture: ['posture'],
    sync: ['codeowners_sync'],
    all: ['census', 'posture', 'codeowners_sync'],
    none: [],
    push: ['push'],
  };
  const app = createCodeHostApp({
    host,
    identity,
    auth: new ServiceAuth(TOKENS),
    callers,
    broker: gh.broker,
    clock: gh.clock,
  });
  const url = await listen(app);
  const outputs: string[] = [];
  return {
    gh,
    host,
    app,
    url,
    registered: gh.registered,
    outputs,
    async call(token, method, path, body) {
      const res = await fetch(new URL(path, url), {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === 'string' ? body : JSON.stringify(body) }),
      });
      const text = await res.text();
      const headers = [...res.headers].map(([k, v]) => `${k}: ${v}`).join('\n');
      outputs.push(`${res.status}\n${headers}\n${text}`);
      let json: unknown;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        json = null;
      }
      return { status: res.status, text, headers, json };
    },
    async stop() {
      await app.close();
      await gh.stop();
    },
  };
}

export const principal = (s: string): PrincipalId => PrincipalId.parse(s);
