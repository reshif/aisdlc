import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GATE_CHECK_APP_PERMISSIONS } from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppKey } from '../src/index.js';
import { appJwt } from '../src/jwt.js';
import { mirrorRefIntoBareRepo } from '../src/fake-github-mirror.js';
import { buildTestbed, testbedSeed } from '../src/fake-github-testbed.js';
import { FakeGitHubServer, generateTestAppKey } from '../src/testing.js';

// The compose fake GitHub's pieces for the request-to-PR e2e: the Push Broker's OWN App (the main App stays read-only),
// the Git Data API's writes mirrored into the bare repository the git server serves (so S7 can fetch the agent branch),
// and a person (never the factory) marking the Draft PR ready and merging it once `aisdlc/gate` passed.

const REPO = 'reshif/asf-factory-testbed';
const dir = mkdtempSync(join(tmpdir(), 'aisdlc-fake-push-'));
const keyOf = (name: string) => {
  const k = generateTestAppKey();
  const p = join(dir, `${name}.pem`);
  writeFileSync(p, k.privatePem, { mode: 0o600 });
  return { ...k, key: AppKey.fromRef(`file:${p}`) };
};
const main = keyOf('main');
const push = keyOf('push');
const checks = keyOf('checks');
let head: string;
let bare: string;
let s: FakeGitHubServer;
const mirrored: string[] = [];

beforeAll(async () => {
  head = buildTestbed(join(dir, 'repos'), REPO);
  bare = join(dir, 'repos', `${REPO}.git`);
  s = await new FakeGitHubServer({
    appId: '111',
    appPublicKeyPem: main.publicPem,
    seed: testbedSeed({ repo: REPO, head, installationId: 1 }),
    pushApp: {
      appId: '555',
      appPublicKeyPem: push.publicPem,
      installationId: 5,
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
    },
    checksApp: {
      appId: '222',
      appPublicKeyPem: checks.publicPem,
      installationId: 2,
      permissions: { ...GATE_CHECK_APP_PERMISSIONS },
    },
    people: ['reshif'],
    requiredChecks: ['aisdlc/gate'],
    onRefChanged: (e) => {
      mirrorRefIntoBareRepo(bare, s.objects, e);
      mirrored.push(`${e.branch}@${e.sha}`);
    },
  }).start();
});
afterAll(async () => {
  await s.stop();
  rmSync(dir, { recursive: true, force: true });
});

const call = async (
  method: string,
  path: string,
  auth: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> => {
  const r = await fetch(`${s.baseUrl}${path}`, {
    method,
    headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: r.status, json: (await r.json()) as Record<string, unknown> };
};
const tokenOf = async (k: typeof main, appId: string, installation: number, perms: object) => {
  const r = await call(
    'POST',
    `/app/installations/${installation}/access_tokens`,
    appJwt(k.key, appId, new Date()),
    { permissions: perms },
  );
  return { status: r.status, token: String(r.json['token'] ?? '') };
};

describe('the compose fake GitHub for the request-to-PR e2e', () => {
  it('lets only the Push Broker App write, mirrors its branch into git, and lets a person merge after the gate', async () => {
    const write = { contents: 'write', pull_requests: 'write', metadata: 'read' };
    // the read App's installation holds no write
    expect((await tokenOf(main, '111', 1, write)).status).toBe(422);
    // the Push Broker's App cannot mint for another installation
    expect((await tokenOf(push, '555', 1, write)).status).toBe(404);
    const t = await tokenOf(push, '555', 5, write);
    expect(t.status).toBe(201);
    const base = `/repos/${REPO}`;
    const blob = await call('POST', `${base}/git/blobs`, t.token, {
      content: Buffer.from('export const bye = (n) => `bye ${n}`;\n').toString('base64'),
      encoding: 'base64',
    });
    expect(blob.status).toBe(201);
    const c0 = await call('GET', `${base}/git/commits/${head}`, t.token);
    const tree = await call('POST', `${base}/git/trees`, t.token, {
      base_tree: (c0.json['tree'] as { sha: string }).sha,
      tree: [{ path: 'src/bye.js', mode: '100644', type: 'blob', sha: blob.json['sha'] }],
    });
    expect(tree.status).toBe(201);
    const who = { name: 'aisdlc[bot]', email: 'aisdlc@users.noreply.github.com' };
    const commit = await call('POST', `${base}/git/commits`, t.token, {
      message: 'feat: bye\n\nAisdlc-Item: x\n',
      tree: tree.json['sha'],
      parents: [head],
      author: who,
      committer: who,
    });
    expect(commit.status).toBe(201);
    const sha = String(commit.json['sha']);
    const branch = 'agent/item-1/main';
    expect(
      (await call('POST', `${base}/git/refs`, t.token, { ref: `refs/heads/${branch}`, sha }))
        .status,
    ).toBe(201);
    // git now serves exactly that commit on the branch, with the file in it
    expect(mirrored).toEqual([`${branch}@${sha}`]);
    const git = (...a: string[]) =>
      execFileSync('git', ['--git-dir', bare, ...a], { encoding: 'utf8' }).trim();
    expect(git('rev-parse', `refs/heads/${branch}`)).toBe(sha);
    expect(git('show', `${sha}:src/bye.js`)).toBe('export const bye = (n) => `bye ${n}`;');
    expect(git('rev-parse', `${sha}^`)).toBe(head);
    git('fsck', '--no-dangling');

    const pr = await call('POST', `${base}/pulls`, t.token, {
      title: 'bye',
      head: branch,
      base: 'main',
      body: '',
      draft: true,
    });
    expect(pr.status).toBe(201);
    expect(pr.json['user']).toEqual({ login: 'aisdlc[bot]', type: 'Bot' });
    const n = Number(pr.json['number']);

    // a person: not a listed one, then the listed one, who cannot merge a draft or before the gate passed
    expect((await call('PUT', `${base}/pulls/${n}/merge`, 'ghp_fake_mallory')).status).toBe(401);
    expect((await call('PUT', `${base}/pulls/${n}/merge`, 'ghp_fake_reshif')).json['message']).toBe(
      'Pull Request is still a draft',
    );
    expect(
      (await call('POST', `${base}/pulls/${n}/ready_for_review`, 'ghp_fake_reshif')).status,
    ).toBe(200);
    const early = await call('PUT', `${base}/pulls/${n}/merge`, 'ghp_fake_reshif');
    expect(early.status).toBe(405);
    expect(early.json['message']).toMatch(/aisdlc\/gate/);
    // gate-check's App (the integration the rule names) writes the passing check run
    const ct = await tokenOf(checks, '222', 2, { checks: 'write' });
    expect(ct.status).toBe(201);
    expect(
      (
        await call('POST', `${base}/check-runs`, ct.token, {
          name: 'aisdlc/gate',
          head_sha: sha,
          status: 'completed',
          conclusion: 'success',
          output: { title: 'passed', summary: 'ok' },
        })
      ).status,
    ).toBe(201);
    const merged = await call('PUT', `${base}/pulls/${n}/merge`, 'ghp_fake_reshif');
    expect(merged.status).toBe(200);
    expect(merged.json['merged']).toBe(true);
    const after = await call('GET', `${base}/pulls/${n}`, t.token);
    expect(after.json['merged']).toBe(true);
    expect(after.json['merged_by']).toEqual({ login: 'reshif', type: 'User' });
    expect(after.json['merge_commit_sha']).toMatch(/^[0-9a-f]{40}$/);
  });
});
