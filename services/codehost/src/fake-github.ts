import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceConfigError, requiredEnv, runService } from '@aisdlc/service-kit';
import { FakeGitHubServer } from './fake-github-server.js';
import {
  GATE_CHECK_APP_PERMISSIONS,
  GATE_RELAY_APP_PERMISSIONS,
  TRACKER_APP_PERMISSIONS,
} from '@aisdlc/contracts';
import { buildTestbed, testbedSeed } from './fake-github-testbed.js';
import { GitHttpTestServer } from './git-server-testing.js';
import { mirrorRefIntoBareRepo } from './fake-github-mirror.js';

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
//   FAKE_GITHUB_CHECKS_APP_ID, FAKE_GITHUB_CHECKS_INSTALLATION_ID, FAKE_GITHUB_CHECKS_APP_PUBLIC_KEY_FILE
//                                     (M14.5, optional) gate-check's own App on the same host: its key, its
//                                     installation, its grant (`checks: write`, pull requests read)
//   FAKE_GITHUB_GATE_CHECK_PORT       (M14.5, optional) a second API listener on 0.0.0.0 for gate-check, which runs
//                                     in its own container and reaches this one on the `gatecheck-github` network
//   FAKE_GITHUB_DEPLOY_APP_ID, FAKE_GITHUB_DEPLOY_INSTALLATION_ID, FAKE_GITHUB_DEPLOY_APP_PUBLIC_KEY_FILE
//                                     (M15.3, optional) gate-relay's own App: its key, its installation, its grant
//                                     (`deployments: write`, metadata read)
//   FAKE_GITHUB_GATE_RELAY_PORT       (M15.3, optional) a listener on 0.0.0.0 for gate-relay (`gaterelay-github`)
//   FAKE_GITHUB_TRACKER_APP_ID, _INSTALLATION_ID, _APP_PUBLIC_KEY_FILE, _LOGIN
//                                     (M16, optional) the issue twin's own App (`issues: write`, metadata read) and
//                                     the login its issues are authored by (`<slug>[bot]`)
//   FAKE_GITHUB_TRACKER_PORT          (M16, optional) another listener on 0.0.0.0; compose sets none: the codehost holds the tracker
//                                     App and reaches the fake on loopback (core-worker has no route out, 2026-11-12)
//   FAKE_GITHUB_PUSH_APP_ID, _INSTALLATION_ID, _APP_PUBLIC_KEY_FILE
//                                     (optional) the Push Broker's own App (`contents: write`, `pull_requests: write`, metadata
//                                     read; the main App stays read-only), and FAKE_GITHUB_PUSH_BROKER_PORT its listener on
//                                     0.0.0.0 (`pushbroker-github`). What its Git Data API writes is also written into the bare
//                                     repository (objects and the branch), so the git server serves the agent branches too
//   FAKE_GITHUB_PEOPLE                (optional) comma-separated logins that act with a personal token `ghp_fake_<login>`:
//                                     mark a PR ready and merge it (the e2e's human; the factory never merges)
//   FAKE_GITHUB_REQUIRED_CHECKS       (optional) comma-separated check names a person's merge needs `success` on the head
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

/** A second App on the host from `<prefix>_APP_ID`, `_INSTALLATION_ID`, `_APP_PUBLIC_KEY_FILE`, or none. */
function secondApp(
  env: NodeJS.ProcessEnv,
  prefix: string,
  mainInstallation: number,
  permissions: Record<string, string>,
) {
  const id = env[`${prefix}_APP_ID`];
  if (!id) return undefined;
  const inst = Number(requiredEnv(env, `${prefix}_INSTALLATION_ID`));
  if (!Number.isInteger(inst) || inst < 1 || inst === mainInstallation) {
    throw new ServiceConfigError(
      `${prefix}_INSTALLATION_ID must be a positive integer other than the main installation`,
    );
  }
  let pem: string;
  try {
    pem = readFileSync(requiredEnv(env, `${prefix}_APP_PUBLIC_KEY_FILE`), 'utf8');
  } catch (cause) {
    throw new ServiceConfigError(`${prefix}_APP_PUBLIC_KEY_FILE is not readable`, { cause });
  }
  return { appId: id, appPublicKeyPem: pem, installationId: inst, permissions };
}

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
  const checksId = env['FAKE_GITHUB_CHECKS_APP_ID'];
  let checksApp:
    | {
        appId: string;
        appPublicKeyPem: string;
        installationId: number;
        permissions: Record<string, string>;
      }
    | undefined;
  if (checksId) {
    const inst = Number(requiredEnv(env, 'FAKE_GITHUB_CHECKS_INSTALLATION_ID'));
    if (!Number.isInteger(inst) || inst < 1 || inst === installationId) {
      throw new ServiceConfigError(
        'FAKE_GITHUB_CHECKS_INSTALLATION_ID must be a positive integer other than the main installation',
      );
    }
    let pem: string;
    try {
      pem = readFileSync(requiredEnv(env, 'FAKE_GITHUB_CHECKS_APP_PUBLIC_KEY_FILE'), 'utf8');
    } catch (cause) {
      throw new ServiceConfigError('FAKE_GITHUB_CHECKS_APP_PUBLIC_KEY_FILE is not readable', {
        cause,
      });
    }
    checksApp = {
      appId: checksId,
      appPublicKeyPem: pem,
      installationId: inst,
      permissions: { ...GATE_CHECK_APP_PERMISSIONS },
    };
  }
  const deployApp = secondApp(env, 'FAKE_GITHUB_DEPLOY', installationId, {
    ...GATE_RELAY_APP_PERMISSIONS,
  });
  if (deployApp && checksApp && deployApp.installationId === checksApp.installationId) {
    throw new ServiceConfigError('the deploy and checks Apps need installations of their own');
  }
  const tracker = secondApp(env, 'FAKE_GITHUB_TRACKER', installationId, {
    ...TRACKER_APP_PERMISSIONS,
  });
  const trackerApp = tracker
    ? { ...tracker, login: requiredEnv(env, 'FAKE_GITHUB_TRACKER_LOGIN') }
    : undefined;
  const others = [checksApp, deployApp].filter((a) => a !== undefined);
  if (trackerApp && others.some((a) => a.installationId === trackerApp.installationId)) {
    throw new ServiceConfigError('the tracker App needs an installation of its own');
  }
  const pushApp = secondApp(env, 'FAKE_GITHUB_PUSH', installationId, {
    contents: 'write',
    pull_requests: 'write',
    metadata: 'read',
  });
  if (
    pushApp &&
    [...others, ...(trackerApp ? [trackerApp] : [])].some(
      (a) => a.installationId === pushApp.installationId,
    )
  ) {
    throw new ServiceConfigError('the Push Broker App needs an installation of its own');
  }
  const list = (name: string): string[] =>
    (env[name] ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x !== '');
  const people = list('FAKE_GITHUB_PEOPLE');
  const requiredChecks = list('FAKE_GITHUB_REQUIRED_CHECKS');
  const gcPort = env['FAKE_GITHUB_GATE_CHECK_PORT'];
  const grPort = env['FAKE_GITHUB_GATE_RELAY_PORT'];
  const trPort = env['FAKE_GITHUB_TRACKER_PORT'];
  const pbPort = env['FAKE_GITHUB_PUSH_BROKER_PORT'];
  const doors = [
    ...(grPort ? [{ host: '0.0.0.0', port: port('FAKE_GITHUB_GATE_RELAY_PORT', 8356) }] : []),
    ...(trPort ? [{ host: '0.0.0.0', port: port('FAKE_GITHUB_TRACKER_PORT', 8357) }] : []),
    ...(pbPort ? [{ host: '0.0.0.0', port: port('FAKE_GITHUB_PUSH_BROKER_PORT', 8358) }] : []),
  ];
  // the api server is made below; the hook reads its objects when a branch moves
  let objectsOf: FakeGitHubServer | null = null;
  const api = await new FakeGitHubServer({
    appId: requiredEnv(env, 'FAKE_GITHUB_APP_ID'),
    appPublicKeyPem: publicKeyPem,
    seed: testbedSeed({
      repo,
      head,
      installationId,
      ...(checksApp ? { gateCheckAppId: Number(checksApp.appId) } : {}),
    }),
    listenHost: '127.0.0.1',
    listenPort: apiPort,
    ...(checksApp ? { checksApp } : {}),
    ...(deployApp ? { deployApp } : {}),
    ...(trackerApp ? { trackerApp } : {}),
    ...(pushApp ? { pushApp } : {}),
    ...(people.length > 0 ? { people } : {}),
    ...(requiredChecks.length > 0 ? { requiredChecks } : {}),
    onRefChanged: (e) => {
      if (objectsOf === null) return;
      mirrorRefIntoBareRepo(join(root, `${e.repo}.git`), objectsOf.objects, e);
      console.log(`fake-github: mirrored ${e.repo} ${e.branch} at ${e.sha} into git`);
    },
    ...(doors.length > 0 ? { extraListens: doors } : {}),
    ...(gcPort
      ? { extraListen: { host: '0.0.0.0', port: port('FAKE_GITHUB_GATE_CHECK_PORT', 8355) } }
      : {}),
    onRequest: (r) => console.log(`fake-github api ${JSON.stringify(r)}`),
  }).start();
  objectsOf = api;
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
