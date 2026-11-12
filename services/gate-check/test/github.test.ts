import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppKey } from '@aisdlc/codehost';
import { FakeGitHubServer, generateTestAppKey } from '@aisdlc/codehost/testing';
import { GATE_CHECK_APP_PERMISSIONS, GATE_CHECK_NAME } from '@aisdlc/contracts';
import { emptySeed } from '@aisdlc/ports';
import { GC_HEAD_A, GC_REPO, gateCheckHostContract } from '@aisdlc/ports/testing';
import { ServiceConfigError } from '@aisdlc/service-kit';
import { describe, expect, it } from 'vitest';
import { GitHubChecksHost, checkBaseUrl } from '../src/github.js';

// gate-check's GitHub adapter over the in-repo fake GitHub HTTP server, which here knows TWO Apps: the codehost's (the
// Push Broker's: contents and pull requests write, no checks) and gate-check's own (checks write, pull requests
// read), each with its own key, installation and tokens. The same contract suite as the in-memory fake.

const MAIN_APP = '123456';
const CHECKS_APP = '654321';

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-gc-keys-'));
const keyRef = (name: string, pem: string): string => {
  const p = join(dir, `${name}.pem`);
  writeFileSync(p, pem, { mode: 0o600 });
  return `file:${p}`;
};
const main = generateTestAppKey();
const checks = generateTestAppKey();
const mainKey = AppKey.fromRef(keyRef('main', main.privatePem));
const checksKey = AppKey.fromRef(keyRef('checks', checks.privatePem));

const seed = () =>
  emptySeed({
    installation: {
      installation_id: 11,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: GC_REPO, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: GC_REPO, branch: 'main', sha: 'c'.repeat(40) }],
  });

async function serve(): Promise<FakeGitHubServer> {
  return new FakeGitHubServer({
    appId: MAIN_APP,
    appPublicKeyPem: main.publicPem,
    seed: seed(),
    checksApp: {
      appId: CHECKS_APP,
      appPublicKeyPem: checks.publicPem,
      installationId: 22,
      permissions: { ...GATE_CHECK_APP_PERMISSIONS },
    },
  }).start();
}

gateCheckHostContract('GitHubChecksHost over the fake GitHub HTTP server', async () => {
  const s = await serve();
  return {
    checks: new GitHubChecksHost({
      baseUrl: s.baseUrl,
      appId: CHECKS_APP,
      installationId: 22,
      appKey: checksKey,
    }),
    // the Push Broker's App asking for a checks token: its installation holds no checks permission
    other: new GitHubChecksHost({
      baseUrl: s.baseUrl,
      appId: MAIN_APP,
      installationId: 11,
      appKey: mainKey,
    }),
    openPull: async (o) => s.openPull(GC_REPO, o),
    pushToPull: async (n, sha) => void s.pushToPull(GC_REPO, n, sha),
    landPull: async (n, by) => void s.landPull(GC_REPO, n, by),
    breakHost: () => void s.answerWith(503),
    unbreak: () => void s.answerNormally(),
    close: () => s.stop(),
  };
});

describe('gate-check’s own App on the host', () => {
  it('its token carries exactly checks write, pull requests read, metadata read; its runs carry its App id', async () => {
    const s = await serve();
    try {
      const h = new GitHubChecksHost({
        baseUrl: s.baseUrl,
        appId: CHECKS_APP,
        installationId: 22,
        appKey: checksKey,
      });
      s.openPull(GC_REPO, { head_ref: 'f', head_sha: GC_HEAD_A, author: 'octo' });
      const w = await h.write_check_run({
        repo: GC_REPO,
        head_sha: GC_HEAD_A,
        name: GATE_CHECK_NAME,
        status: 'completed',
        conclusion: 'action_required',
        external_id: 'x',
        title: 't',
        summary: 's',
      });
      expect(w.state).toBe('ok');
      expect(s.issued.map((t) => [t.app_id, t.permissions])).toEqual([
        [Number(CHECKS_APP), GATE_CHECK_APP_PERMISSIONS],
      ]);
      expect(s.checkRuns.map((r) => r.app_id)).toEqual([Number(CHECKS_APP)]);
      // the requests it made: the mint and the five routes, nothing else
      const paths = s.requests.map((r) => `${r.method} ${r.path}`);
      expect(paths).toEqual([
        'POST /app/installations/22/access_tokens',
        `POST /repos/${GC_REPO}/check-runs`,
      ]);
      // the token is never in a request log
      expect(s.allText()).not.toContain(s.issued[0]?.token);
      // the Push Broker's App JWT cannot mint for gate-check's installation
      const wrong = new GitHubChecksHost({
        baseUrl: s.baseUrl,
        appId: MAIN_APP,
        installationId: 22,
        appKey: mainKey,
      });
      expect((await wrong.list_pulls({ repo: GC_REPO, state: 'open' })).state).toBe('unreadable');
    } finally {
      await s.stop();
    }
  });

  it('a token that comes back with more than was asked is not used', async () => {
    const s = await serve();
    try {
      s.overshareOnMint({ contents: 'write' });
      const h = new GitHubChecksHost({
        baseUrl: s.baseUrl,
        appId: CHECKS_APP,
        installationId: 22,
        appKey: checksKey,
      });
      const r = await h.list_pulls({ repo: GC_REPO, state: 'open' });
      expect(r.state === 'unreadable' && r.reason).toBe('refused');
      expect(s.apiRequests).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it('the base URL is https, or plain http to loopback or a named fake host only', () => {
    expect(checkBaseUrl('https://api.github.com').host).toBe('api.github.com');
    expect(checkBaseUrl('http://127.0.0.1:8353').port).toBe('8353');
    expect(checkBaseUrl('http://codehost:8355', ['codehost']).hostname).toBe('codehost');
    for (const bad of ['http://evil.example', 'ftp://x', 'https://u:p@api.github.com', 'nope']) {
      expect(() => checkBaseUrl(bad), bad).toThrow(ServiceConfigError);
    }
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
