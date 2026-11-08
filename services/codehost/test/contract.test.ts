import { AppKey, GitHubRestCodeHost, GitHubTransport, TokenBroker } from '../src/index.js';
import { codeHostContract, codeHostLiveContract } from '@aisdlc/ports/testing';
import { restHarness } from '../src/testing.js';
import { z } from 'zod';

// The CodeHostPort contract (PLAN M5.1) against the REST adapter over the in-repo fake GitHub HTTP
// server: the same suite the in-memory FakeGitHub passes in @aisdlc/ports.
codeHostContract('GitHubRestCodeHost over the fake GitHub HTTP server', restHarness);

// The same port against the real App, read-only. Skipped unless CODEHOST_LIVE_CONTRACT is set to
//   {"app_id":"123","installation_id":456,"key_ref":"file:/path/app.pem","repo":"owner/name","api_url":"https://api.github.com"}
// (secrets are references; `api_url` is optional). It makes GET requests only.
const LIVE = process.env['CODEHOST_LIVE_CONTRACT'];
codeHostLiveContract(
  'the real GitHub App',
  async () => {
    const cfg = z
      .strictObject({
        app_id: z.string(),
        installation_id: z.number().int(),
        key_ref: z.string(),
        repo: z.string(),
        api_url: z.string().optional(),
      })
      .parse(JSON.parse(LIVE ?? '{}'));
    const baseUrl = cfg.api_url ?? 'https://api.github.com';
    const broker = new TokenBroker({
      appKey: AppKey.fromRef(cfg.key_ref),
      appId: cfg.app_id,
      installationId: cfg.installation_id,
      baseUrl,
      mode: 'census',
    });
    const log: Array<{ method: 'GET'; path: string }> = [];
    const transport = new GitHubTransport({
      baseUrl,
      broker,
      mode: 'census',
      log: (l) => {
        const m = /^(GET) (\S+)/.exec(l);
        if (m) log.push({ method: 'GET', path: m[2] as string });
      },
    });
    return {
      port: new GitHubRestCodeHost({ transport, installationId: cfg.installation_id }),
      repo: cfg.repo,
      requests: () => log,
    };
  },
  { skip: LIVE === undefined || LIVE === '' },
);
