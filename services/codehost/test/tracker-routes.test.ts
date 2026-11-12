import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISSUE_TWIN_LABEL, TRACKER_APP_PERMISSIONS } from '@aisdlc/contracts';
import {
  FakeGitHub,
  FakeRegisteredRepos,
  HttpIssueTracker,
  emptySeed,
  type IssueTrackerPort,
} from '@aisdlc/ports';
import { IT_REPO, issueTrackerContract, twinFile } from '@aisdlc/ports/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { describe, expect, it } from 'vitest';
import {
  AllowListedCodeHost,
  AppKey,
  GitHubIssueTracker,
  createCodeHostApp,
  trackerConfigFromEnv,
} from '../src/index.js';
import { FakeGitHubServer, generateTestAppKey } from '../src/testing.js';

// The issue twin's tracker behind the codehost (PLAN M16; user decision 2026-11-12: core-worker keeps NO route out).
// The codehost holds the tracker's OWN App and serves IssueTrackerPort's five operations under scope `tracker`, for
// registered repos only; core-worker calls them with `HttpIssueTracker`. The same contract suite as the in-memory fake
// and the GitHub adapter runs through the HTTP adapter, the codehost's routes and the GitHub adapter over the fake
// GitHub HTTP server.

const MAIN_APP = '123456';
const TRACKER_APP = '777001';
const TRACKER_LOGIN = 'aisdlc-tracker[bot]';
const TOKENS = {
  worker: 'core-worker-tracker-'.padEnd(32, 'x'),
  census: 'knowledge-census-'.padEnd(32, 'x'),
};

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-tracker-routes-'));
const main = generateTestAppKey();
const tk = generateTestAppKey();
const keyPath = join(dir, 'tracker.pem');
writeFileSync(keyPath, tk.privatePem, { mode: 0o600 });

const seed = () =>
  emptySeed({
    installation: {
      installation_id: 11,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [
      { full_name: IT_REPO, default_branch: 'main', private: true, archived: false },
      { full_name: 'acme/other', default_branch: 'main', private: true, archived: false },
    ],
    heads: [{ repo: IT_REPO, branch: 'main', sha: 'c'.repeat(40) }],
  });

async function stack(o: { tracker?: boolean } = {}) {
  const gh = await new FakeGitHubServer({
    appId: MAIN_APP,
    appPublicKeyPem: main.publicPem,
    seed: seed(),
    trackerApp: {
      appId: TRACKER_APP,
      appPublicKeyPem: tk.publicPem,
      installationId: 33,
      permissions: { ...TRACKER_APP_PERMISSIONS },
      login: TRACKER_LOGIN,
    },
  }).start();
  const tracker = new GitHubIssueTracker({
    baseUrl: gh.baseUrl,
    appId: TRACKER_APP,
    installationId: 33,
    appKey: AppKey.fromRef(`file:${keyPath}`),
    login: TRACKER_LOGIN,
  });
  const registered = new FakeRegisteredRepos().add('acme', IT_REPO as never);
  const app = createCodeHostApp({
    host: new AllowListedCodeHost(new FakeGitHub(seed()), registered),
    identity: { links: async () => ({ ok: true, value: [] }) } as never,
    auth: new ServiceAuth({ worker: TOKENS.worker, census: TOKENS.census }),
    callers: { worker: ['tracker'], census: ['census'] },
    ...(o.tracker === false ? {} : { tracker }),
  });
  const url = await listen(app);
  const http = (token: string): IssueTrackerPort =>
    new HttpIssueTracker({ baseUrl: url, token, login: TRACKER_LOGIN });
  return {
    gh,
    url,
    http,
    stop: async () => {
      await app.close();
      await gh.stop();
    },
  };
}

issueTrackerContract('HttpIssueTracker over the codehost’s tracker routes', async () => {
  const s = await stack();
  return {
    tracker: s.http(TOKENS.worker),
    // a caller of the codehost without the `tracker` scope (knowledge's census token)
    other: s.http(TOKENS.census),
    personOpens: async (o) => s.gh.openIssue(IT_REPO, o),
    personCloses: async (n, by) => void s.gh.closeIssueAs(IT_REPO, n, by),
    removeIssue: async (n) => void s.gh.removeIssue(IT_REPO, n),
    comments: async (n) =>
      s.gh.issueOf(IT_REPO, n).comments.map((c) => ({ by: c.by, body: c.body })),
    breakHost: () => void s.gh.answerWith(503),
    unbreak: () => void s.gh.answerNormally(),
    close: () => s.stop(),
  };
});

const call = async (url: string, token: string, method: string, path: string, body?: unknown) => {
  const r = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};

describe('the tracker routes on the codehost', () => {
  it('scope tracker only; a registered repo only; a body with anything but a twin’s fields is refused before GitHub', async () => {
    const s = await stack();
    try {
      const path = `/v1/tracker/repos/${IT_REPO}/issues`;
      expect((await call(s.url, TOKENS.census, 'GET', `${path}?label=x`)).status).toBe(403);
      const other = await call(
        s.url,
        TOKENS.worker,
        'GET',
        '/v1/tracker/repos/acme/other/issues?label=x',
      );
      expect(other).toMatchObject({ status: 403, json: { reason: 'repo_not_allowed' } });
      const extra = await call(s.url, TOKENS.worker, 'POST', path, {
        ...twinFile(),
        assignees: ['x'],
      });
      expect(extra.status).toBe(400);
      expect(s.gh.requests.filter((r) => r.method !== 'GET')).toEqual([]);
      // the twin is filed with the tracker's OWN App token, never the codehost App's
      const ok = await call(s.url, TOKENS.worker, 'POST', path, {
        title: twinFile().title,
        body: twinFile().body,
        labels: twinFile().labels,
      });
      expect(ok).toMatchObject({ status: 200, json: { state: 'ok' } });
      expect(s.gh.issued.map((t) => [t.app_id, t.permissions])).toEqual([
        [Number(TRACKER_APP), TRACKER_APP_PERMISSIONS],
      ]);
      const listed = await s.http(TOKENS.worker).list_labelled({
        repo: IT_REPO as never,
        label: ISSUE_TWIN_LABEL,
      });
      expect(listed.state === 'ok' && listed.value).toHaveLength(1);
    } finally {
      await s.stop();
    }
  });

  it('without a tracker App the routes answer not_implemented, never a value', async () => {
    const s = await stack({ tracker: false });
    try {
      const r = await s.http(TOKENS.worker).file_issue(twinFile());
      expect(r).toMatchObject({ state: 'unreadable', reason: 'not_implemented' });
    } finally {
      await s.stop();
    }
  });

  it('the config: off when no App id; its own file: key, never the codehost App’s; https or loopback only', () => {
    expect(trackerConfigFromEnv({})).toBeNull();
    const env = {
      CODEHOST_TRACKER_APP_ID: '777001',
      CODEHOST_TRACKER_INSTALLATION_ID: '33',
      CODEHOST_TRACKER_APP_KEY_REF: 'file:/run/secrets/tracker-app.pem',
      CODEHOST_TRACKER_LOGIN: TRACKER_LOGIN,
    };
    expect(trackerConfigFromEnv(env)).toEqual({
      appId: '777001',
      installationId: 33,
      appKeyRef: 'file:/run/secrets/tracker-app.pem',
      login: TRACKER_LOGIN,
      apiUrl: 'https://api.github.com',
    });
    expect(() =>
      trackerConfigFromEnv({
        ...env,
        CODEHOST_GITHUB_APP_KEY_REF: env.CODEHOST_TRACKER_APP_KEY_REF,
      }),
    ).toThrow(/own key/);
    expect(() => trackerConfigFromEnv({ ...env, CODEHOST_TRACKER_APP_KEY_REF: 'env:K' })).toThrow();
    expect(() =>
      trackerConfigFromEnv({ ...env, CODEHOST_TRACKER_API_URL: 'http://evil.example' }),
    ).toThrow();
  });
});
