import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ISSUE_TWIN_LABEL, TRACKER_APP_PERMISSIONS } from '@aisdlc/contracts';
import { emptySeed } from '@aisdlc/ports';
import { IT_REPO, issueTrackerContract, twinFile } from '@aisdlc/ports/testing';
import { ServiceConfigError } from '@aisdlc/service-kit';
import { describe, expect, it } from 'vitest';
import { AppKey, GitHubIssueTracker, trackerBaseUrl } from '../src/index.js';
import { FakeGitHubServer, generateTestAppKey } from '../src/testing.js';

// The issue tracker's GitHub adapter over the in-repo fake GitHub HTTP server, which here knows TWO Apps: the
// codehost's (the Push Broker's: contents and pull requests write, no issues) and the tracker's own (issues write,
// metadata read), each with its own key, installation and tokens. The same contract suite as the in-memory fake.

const MAIN_APP = '123456';
const TRACKER_APP = '777001';
const TRACKER_LOGIN = 'aisdlc-tracker[bot]';

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-tracker-keys-'));
const keyRef = (name: string, pem: string): string => {
  const p = join(dir, `${name}.pem`);
  writeFileSync(p, pem, { mode: 0o600 });
  return `file:${p}`;
};
const main = generateTestAppKey();
const tracker = generateTestAppKey();
const mainKey = AppKey.fromRef(keyRef('main', main.privatePem));
const trackerKey = AppKey.fromRef(keyRef('tracker', tracker.privatePem));

const seed = () =>
  emptySeed({
    installation: {
      installation_id: 11,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: IT_REPO, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: IT_REPO, branch: 'main', sha: 'c'.repeat(40) }],
  });

async function serve(): Promise<FakeGitHubServer> {
  return new FakeGitHubServer({
    appId: MAIN_APP,
    appPublicKeyPem: main.publicPem,
    seed: seed(),
    trackerApp: {
      appId: TRACKER_APP,
      appPublicKeyPem: tracker.publicPem,
      installationId: 33,
      permissions: { ...TRACKER_APP_PERMISSIONS },
      login: TRACKER_LOGIN,
    },
  }).start();
}

const trackerOf = (
  s: FakeGitHubServer,
  over: Partial<{ appId: string; installationId: number; appKey: AppKey }> = {},
) =>
  new GitHubIssueTracker({
    baseUrl: s.baseUrl,
    appId: TRACKER_APP,
    installationId: 33,
    appKey: trackerKey,
    login: TRACKER_LOGIN,
    ...over,
  });

issueTrackerContract('GitHubIssueTracker over the fake GitHub HTTP server', async () => {
  const s = await serve();
  return {
    tracker: trackerOf(s),
    // the Push Broker's App asking for an issues token: its installation holds no issues permission
    other: trackerOf(s, { appId: MAIN_APP, installationId: 11, appKey: mainKey }),
    personOpens: async (o) => s.openIssue(IT_REPO, o),
    personCloses: async (n, by) => void s.closeIssueAs(IT_REPO, n, by),
    removeIssue: async (n) => void s.removeIssue(IT_REPO, n),
    comments: async (n) => s.issueOf(IT_REPO, n).comments.map((c) => ({ by: c.by, body: c.body })),
    breakHost: () => void s.answerWith(503),
    unbreak: () => void s.answerNormally(),
    close: () => s.stop(),
  };
});

describe('the tracker’s own App on the host', () => {
  it('its token carries exactly issues write and metadata read; it sends only the fields of a twin and a close', async () => {
    const s = await serve();
    try {
      const t = trackerOf(s);
      const n = await t.file_issue(twinFile());
      expect(n.state).toBe('ok');
      const number = n.state === 'ok' ? n.value.number : 0;
      expect((await t.close_issue({ repo: IT_REPO, number })).state).toBe('ok');
      expect(s.issued.map((x) => [x.app_id, x.permissions])).toEqual([
        [Number(TRACKER_APP), TRACKER_APP_PERMISSIONS],
      ]);
      expect(s.issueWrites).toEqual([
        { method: 'POST', path: 'issues', keys: ['body', 'labels', 'title'] },
        { method: 'PATCH', path: `issues/${number}`, keys: ['state', 'state_reason'] },
      ]);
      expect(s.issueOf(IT_REPO, number).user).toEqual({ login: TRACKER_LOGIN, type: 'Bot' });
      // the token is never in a request log
      expect(s.allText()).not.toContain(s.issued[0]?.token);
      // the requests it made: the mint, the file, the read before the close, the close
      expect(s.requests.map((r) => `${r.method} ${r.path}`)).toEqual([
        'POST /app/installations/33/access_tokens',
        `POST /repos/${IT_REPO}/issues`,
        `GET /repos/${IT_REPO}/issues/${number}`,
        `PATCH /repos/${IT_REPO}/issues/${number}`,
      ]);
      // the Push Broker's App JWT cannot mint for the tracker's installation
      const wrong = trackerOf(s, { appId: MAIN_APP, appKey: mainKey });
      expect((await wrong.list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL })).state).toBe(
        'unreadable',
      );
    } finally {
      await s.stop();
    }
  });

  it('a transferred issue reads as not found (redirects are never followed)', async () => {
    const s = await serve();
    try {
      const t = trackerOf(s);
      const n = await t.file_issue(twinFile());
      const number = n.state === 'ok' ? n.value.number : 0;
      s.removeIssue(IT_REPO, number, 'transferred');
      const r = await t.read_issue({ repo: IT_REPO, number });
      expect(r.state === 'unreadable' && r.reason).toBe('not_found');
    } finally {
      await s.stop();
    }
  });

  it('a token that comes back with more than was asked is not used', async () => {
    const s = await serve();
    try {
      s.overshareOnMint({ contents: 'write' });
      const r = await trackerOf(s).list_labelled({ repo: IT_REPO, label: ISSUE_TWIN_LABEL });
      expect(r.state === 'unreadable' && r.reason).toBe('refused');
      expect(s.apiRequests).toEqual([]);
    } finally {
      await s.stop();
    }
  });

  it('the base URL is https, or plain http to loopback or a named fake host; the login is a GitHub login', () => {
    expect(trackerBaseUrl('https://api.github.com').host).toBe('api.github.com');
    expect(trackerBaseUrl('http://codehost:8355', ['codehost']).hostname).toBe('codehost');
    for (const bad of ['http://evil.example', 'https://u:p@api.github.com', 'nope']) {
      expect(() => trackerBaseUrl(bad), bad).toThrow(ServiceConfigError);
    }
    expect(
      () =>
        new GitHubIssueTracker({
          baseUrl: 'https://api.github.com',
          appId: TRACKER_APP,
          installationId: 1,
          appKey: trackerKey,
          login: 'not a login',
        }),
    ).toThrow(ServiceConfigError);
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
