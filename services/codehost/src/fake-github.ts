import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceConfigError, requiredEnv, runService } from '@aisdlc/service-kit';
import { FakeGitHubServer } from './fake-github-server.js';
import { buildTestbed, testbedSeed } from './fake-github-testbed.js';
import { GitHttpTestServer } from './git-server-testing.js';

// The compose stack's stand-in for github.com (PLAN M8.0, profile `fake-github`): the in-repo fake
// GitHub REST server and a real git smart-HTTP server in front of one seeded repository, as one
// process. It is NOT a service of the factory: it is the other side of the codehost's only egress,
// so the whole stack can run with no GitHub credential, and the request log it prints is the
// evidence that the factory only ever read.
//
//   FAKE_GITHUB_APP_ID, FAKE_GITHUB_INSTALLATION_ID
//   FAKE_GITHUB_APP_PUBLIC_KEY_FILE   PEM of the App's PUBLIC key (the server verifies the App JWT)
//   FAKE_GITHUB_REPO                  owner/name of the seeded repository (default reshif/asf-factory-testbed)
//   FAKE_GITHUB_API_PORT (8353), FAKE_GITHUB_GIT_PORT (8354); both listen on 127.0.0.1 only, which
//   is where the codehost accepts a plain-http GitHub (it carries credentials), so this container
//   shares the codehost's network namespace
//   FAKE_GITHUB_DIR                   where the bare repository is built (default a temp dir)
//
// Each request is one stdout line: `fake-github api {"method":"GET","path":...}` or `fake-github git ...`.

const port = (name: string, dflt: number): number => {
  const raw = process.env[name];
  const n = raw === undefined || raw === '' ? dflt : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65_535) {
    throw new ServiceConfigError(`${name} must be a port`);
  }
  return n;
};

await runService('fake-github', async () => {
  const env = process.env;
  const repo = env['FAKE_GITHUB_REPO'] || 'reshif/asf-factory-testbed';
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new ServiceConfigError('FAKE_GITHUB_REPO is not owner/name');
  const installationId = Number(requiredEnv(env, 'FAKE_GITHUB_INSTALLATION_ID'));
  if (!Number.isInteger(installationId) || installationId < 1) {
    throw new ServiceConfigError('FAKE_GITHUB_INSTALLATION_ID must be a positive integer');
  }
  let publicKeyPem: string;
  try {
    publicKeyPem = readFileSync(requiredEnv(env, 'FAKE_GITHUB_APP_PUBLIC_KEY_FILE'), 'utf8');
  } catch (cause) {
    throw new ServiceConfigError('FAKE_GITHUB_APP_PUBLIC_KEY_FILE is not readable', { cause });
  }
  const apiPort = port('FAKE_GITHUB_API_PORT', 8353);
  const gitPort = port('FAKE_GITHUB_GIT_PORT', 8354);
  const root = env['FAKE_GITHUB_DIR'] || mkdtempSync(join(tmpdir(), 'aisdlc-fake-github-'));
  const head = buildTestbed(root, repo);
  const api = await new FakeGitHubServer({
    appId: requiredEnv(env, 'FAKE_GITHUB_APP_ID'),
    appPublicKeyPem: publicKeyPem,
    seed: testbedSeed({ repo, head, installationId }),
    listenHost: '127.0.0.1',
    listenPort: apiPort,
    onRequest: (r) => console.log(`fake-github api ${JSON.stringify(r)}`),
  }).start();
  // The git server accepts exactly the installation tokens the REST side issued (Basic
  // `x-access-token:<token>`, the form the codehost sends) and refuses every push.
  const git_ = await new GitHttpTestServer({
    root,
    host: '127.0.0.1',
    port: gitPort,
    isAuthorized: (h) => {
      const m = /^Basic (\S+)$/.exec(h ?? '');
      if (!m) return false;
      const [user, token] = Buffer.from(m[1] as string, 'base64')
        .toString()
        .split(':');
      return user === 'x-access-token' && api.issued.some((t) => t.token === token);
    },
    onRequest: (r) => console.log(`fake-github git ${JSON.stringify(r)}`),
  }).start();
  console.log(`fake-github: ${repo} at ${head}; git on ${git_.baseUrl}`);
  return {
    url: api.baseUrl,
    close: async () => {
      await git_.stop();
      await api.stop();
      if (!env['FAKE_GITHUB_DIR']) rmSync(root, { recursive: true, force: true });
    },
  };
});
