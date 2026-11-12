import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppKey } from '@aisdlc/codehost';
import { FakeGitHubServer, generateTestAppKey } from '@aisdlc/codehost/testing';
import { GATE_CHECK_APP_PERMISSIONS, GATE_RELAY_APP_PERMISSIONS } from '@aisdlc/contracts';
import { emptySeed } from '@aisdlc/ports';
import { GR_REPO, gateRelayHostContract, grCreate } from '@aisdlc/ports/testing';
import { describe, expect, it } from 'vitest';
import { GitHubDeploymentsHost } from '../src/github.js';

// gate-relay's GitHub adapter over the in-repo fake GitHub HTTP server, which here knows THREE Apps: the codehost's
// (the Push Broker's: contents and pull requests write, no deployments), gate-check's (checks write) and gate-relay's
// own (deployments write), each with its own key, installation and tokens. The same contract suite as the in-memory
// fake.

const MAIN_APP = '123456';
const CHECKS_APP = '654321';
const DEPLOY_APP = '765432';

const dir = mkdtempSync(join(tmpdir(), 'aisdlc-gr-keys-'));
const keyRef = (name: string, pem: string): string => {
  const p = join(dir, `${name}.pem`);
  writeFileSync(p, pem, { mode: 0o600 });
  return `file:${p}`;
};
const main = generateTestAppKey();
const checks = generateTestAppKey();
const deploys = generateTestAppKey();
const mainKey = AppKey.fromRef(keyRef('main', main.privatePem));
const checksKey = AppKey.fromRef(keyRef('checks', checks.privatePem));
const deployKey = AppKey.fromRef(keyRef('deploys', deploys.privatePem));

const seed = () =>
  emptySeed({
    installation: {
      installation_id: 11,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: GR_REPO, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: GR_REPO, branch: 'main', sha: 'c'.repeat(40) }],
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
    deployApp: {
      appId: DEPLOY_APP,
      appPublicKeyPem: deploys.publicPem,
      installationId: 33,
      permissions: { ...GATE_RELAY_APP_PERMISSIONS },
    },
  }).start();
}

const host = (s: FakeGitHubServer, appId: string, installationId: number, appKey: AppKey) =>
  new GitHubDeploymentsHost({ baseUrl: s.baseUrl, appId, installationId, appKey });

gateRelayHostContract('GitHubDeploymentsHost over the fake GitHub HTTP server', async () => {
  const s = await serve();
  return {
    deploys: host(s, DEPLOY_APP, 33, deployKey),
    // the other Apps asking for a deployments token: their installations hold no deployments permission
    push: host(s, MAIN_APP, 11, mainKey),
    checks: host(s, CHECKS_APP, 22, checksKey),
    setStatus: async (id, state) => void s.setDeploymentStatus(GR_REPO, id, state),
    breakHost: () => void s.answerWith(503),
    unbreak: () => void s.answerNormally(),
    close: () => s.stop(),
  };
});

describe('gate-relay’s own App on the host', () => {
  it('its token carries exactly deployments write and metadata read; its deployments carry its App id', async () => {
    const s = await serve();
    try {
      const h = host(s, DEPLOY_APP, 33, deployKey);
      const r = await h.create_deployment(grCreate());
      expect(r.state).toBe('ok');
      expect(s.issued.map((t) => [t.app_id, t.permissions])).toEqual([
        [Number(DEPLOY_APP), GATE_RELAY_APP_PERMISSIONS],
      ]);
      expect(s.deployments.map((d) => [d.app_id, d.sha, d.ref])).toEqual([
        [Number(DEPLOY_APP), grCreate().sha, grCreate().sha],
      ]);
      expect(s.requests.map((x) => `${x.method} ${x.path}`)).toEqual([
        'POST /app/installations/33/access_tokens',
        `POST /repos/${GR_REPO}/deployments`,
      ]);
      expect(s.allText()).not.toContain(s.issued[0]?.token);
      // another App's JWT cannot mint for gate-relay's installation
      const wrong = host(s, MAIN_APP, 33, mainKey);
      expect(
        (
          await wrong.list_deployments({
            repo: GR_REPO,
            sha: grCreate().sha,
            environment: 'production',
          })
        ).state,
      ).toBe('unreadable');
    } finally {
      await s.stop();
    }
  });

  it('a token that comes back with more than was asked is not used', async () => {
    const s = await serve();
    try {
      s.overshareOnMint({ contents: 'write' });
      const r = await host(s, DEPLOY_APP, 33, deployKey).create_deployment(grCreate());
      expect(r.state === 'unreadable' && r.reason).toBe('refused');
      expect(s.apiRequests).toEqual([]);
      expect(s.deployments).toEqual([]);
    } finally {
      await s.stop();
    }
  });
});

process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
