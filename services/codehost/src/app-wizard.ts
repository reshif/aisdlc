import { spawnSync } from 'node:child_process';
import { createPrivateKey, randomBytes, sign } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  comparePermissions,
  githubAppPermissions,
  jobsOfApp,
  type FactoryAppOptions,
  type GithubAppJob,
  type GithubAppKind,
} from '@aisdlc/contracts';
import { appJwt } from './jwt.js';

// The GitHub App setup wizard (`platform/compose/setup-github-apps`, docs/getting-started.md §4). It creates the two
// Apps of the default layout from GitHub App MANIFESTS, so nobody types a permission by hand:
//
//   factory      read + push (+ tracker issues, + gate-relay deployments when opted in); its one key becomes
//                secrets/github-app.pem and secrets/push-broker-app.pem (+ tracker-app.pem, gate-relay-app.pem)
//   gate-check   always separate (checks write, pull requests read): secrets/gate-check-app.pem
//
// A helper listens on 127.0.0.1 only, on a random port; every request carries the one-time `state` token of this run.
// The browser posts each manifest to github.com, GitHub sends it back with a code, the helper exchanges the code
// (`POST /app-manifests/{code}/conversions`), writes the key (mode 600; never printed, logged or kept in memory
// longer than the write) and the ids into .env, then sends the browser to the App's install page; the install's
// setup_url brings the installation id back, and the helper checks the installation through the API with an App JWT
// (exactly the permissions asked, `selected` repositories) before it writes that id. The factory never changes branch
// protection: requiring `aisdlc/gate` on the default branch stays the owner's step.

export interface WizardOptions {
  /** platform/compose: where `secrets/`, `.env` and `init-secrets` are. */
  readonly composeDir: string;
  readonly apiUrl: string;
  readonly webUrl: string;
  /** Create the Apps under this organisation instead of the signed-in user. */
  readonly org?: string | undefined;
  readonly factory: FactoryAppOptions;
  /** Which Apps to create (default both). */
  readonly kinds: readonly GithubAppKind[];
  /** Replace keys that are already real (the old Apps stay on GitHub: delete them there). */
  readonly rotate: boolean;
  /** The App name prefix (a short random suffix is added; GitHub names are unique and at most 34 characters). */
  readonly prefix: string;
  /** The Apps' homepage URL (required by GitHub; nothing is served there). */
  readonly homepageUrl: string;
  /** Run `./init-secrets` before and after (pub keys, ownership, mode). Default true. */
  readonly runInitSecrets?: boolean;
  readonly log: (line: string) => void;
  readonly fetch?: typeof fetch;
  readonly now?: () => Date;
}

export const DEFAULT_API_URL = 'https://api.github.com';
export const DEFAULT_WEB_URL = 'https://github.com';

/** The key files an App's key is written to, in `secrets/`. */
export function keyFilesOf(kind: GithubAppKind, o: FactoryAppOptions = {}): string[] {
  const byJob: Record<GithubAppJob, string[]> = {
    read: ['github-app.pem'],
    push: ['push-broker-app.pem'],
    tracker: ['tracker-app.pem'],
    'gate-relay': ['gate-relay-app.pem'],
    'gate-check': ['gate-check-app.pem'],
  };
  return jobsOfApp(kind, o).flatMap((j) => byJob[j]);
}

/** The marker `init-secrets` writes beside a throwaway key: a key without one is a real key. */
const FAKE_MARKER: Record<string, string> = {
  'github-app.pem': '.github-app-fake',
  'push-broker-app.pem': '.push-broker-app-fake',
  'tracker-app.pem': '.tracker-app-fake',
  'gate-relay-app.pem': '.gate-relay-app-fake',
  'gate-check-app.pem': '.gate-check-app-fake',
};

/** Key files that hold a real key (present, not empty, no throwaway marker): never overwritten without --rotate. */
export function realKeysAmong(secretsDir: string, files: readonly string[]): string[] {
  return files.filter((f) => {
    const p = join(secretsDir, f);
    if (!existsSync(p) || statSync(p).size === 0) return false;
    const marker = FAKE_MARKER[f];
    return marker === undefined || !existsSync(join(secretsDir, marker));
  });
}

/** The .env lines an App sets once it exists (ids, logins) and once its installation is checked. */
export function envForApp(
  kind: GithubAppKind,
  o: FactoryAppOptions,
  app: { id: number; slug: string },
  installationId: number | null,
  realGitHub: boolean,
): Record<string, string> {
  const inst = installationId === null ? 'REPLACE_ME' : String(installationId);
  const out: Record<string, string> = {};
  const bot = `${app.slug}[bot]`;
  const put = (prefix: string, url?: string) => {
    out[`${prefix}_APP_ID`] = String(app.id);
    out[`${prefix}_INSTALLATION_ID`] = inst;
    if (realGitHub && url !== undefined) out[url] = '';
  };
  if (kind === 'gate-check') {
    put('GATE_CHECK', 'GATE_CHECK_GITHUB_API_URL');
    return out;
  }
  put('GITHUB');
  if (realGitHub) {
    out['CODEHOST_GITHUB_API_URL'] = '';
    out['CODEHOST_GIT_URL'] = '';
  }
  put('PUSH_BROKER', 'PUSH_BROKER_GITHUB_API_URL');
  out['PUSH_BROKER_LOGIN'] = bot;
  // gate-check recognises agent PRs by the bot that authors them: the factory App's
  out['GATE_CHECK_PUSH_BROKER_LOGIN'] = bot;
  if (o.tracker === true) {
    put('TRACKER', 'TRACKER_GITHUB_API_URL');
    out['TRACKER_LOGIN'] = bot;
  } else if (realGitHub) {
    // no tracker App: the issue_twin loop does not run (a throwaway key's id must not reach github.com)
    out['TRACKER_APP_ID'] = '';
    out['TRACKER_LOGIN'] = '';
  }
  if (o.gateRelay === true) put('GATE_RELAY', 'GATE_RELAY_GITHUB_API_URL');
  return out;
}

/** Sets `KEY=value` lines of an env file in place (appending the ones it lacks); every other line is kept. */
export function setEnvValues(file: string, values: Readonly<Record<string, string>>): void {
  const lines = existsSync(file) ? readFileSync(file, 'utf8').split('\n') : [];
  if (lines.at(-1) === '') lines.pop();
  const left = new Map(Object.entries(values));
  for (const [k, v] of Object.entries(values)) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(k) || /[\n\r]/.test(v)) throw new Error(`bad .env entry ${k}`);
  }
  const out = lines.map((line) => {
    const m = /^([A-Z][A-Z0-9_]*)=/.exec(line);
    const key = m?.[1];
    if (key === undefined || !left.has(key)) return line;
    const v = left.get(key) as string;
    left.delete(key);
    return `${key}=${v}`;
  });
  if (left.size > 0) out.push('# Written by ./setup-github-apps.');
  for (const [k, v] of left) out.push(`${k}=${v}`);
  writeFileSync(file, `${out.join('\n')}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
}

/** Reads `KEY=value` lines of an env file (no interpolation, no quotes). */
export function readEnvValues(file: string): Record<string, string> {
  if (!existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line);
    if (m) out[m[1] as string] = m[2] as string;
  }
  return out;
}

/** The manifest of one App (https://docs.github.com/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). */
export function manifestFor(
  kind: GithubAppKind,
  o: { name: string; homepageUrl: string; helperUrl: string; factory: FactoryAppOptions },
): Record<string, unknown> {
  return {
    name: o.name,
    url: o.homepageUrl,
    // the factory polls (packages/loops/src/code-host-polls.ts): no webhook, no events
    hook_attributes: { url: o.homepageUrl, active: false },
    redirect_url: `${o.helperUrl}/created/${kind}`,
    setup_url: `${o.helperUrl}/installed/${kind}`,
    // back to the helper after the person changes the installation (e.g. to selected repositories), to check again
    setup_on_update: true,
    public: false,
    request_oauth_on_install: false,
    default_permissions: githubAppPermissions(kind, o.factory),
    default_events: [],
  };
}

export interface AppOutcome {
  readonly kind: GithubAppKind;
  readonly appId: number;
  readonly slug: string;
  readonly installationId: number;
  readonly repositories: readonly string[];
}

interface JobState {
  name: string;
  app?: { id: number; slug: string; key: string };
  installationId?: number;
  verified?: AppOutcome;
  problem?: string;
}

const escapeHtml = (s: string): string =>
  s.replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string,
  );

const LABEL: Record<GithubAppKind, string> = {
  factory: 'factory App (read + push)',
  'gate-check': 'gate-check App (aisdlc/gate)',
};

export interface Wizard {
  /** The URL to open (it carries the run's token). */
  readonly url: string;
  /** Settles when every App asked for is created, installed and checked. */
  readonly done: Promise<readonly AppOutcome[]>;
  stop(): Promise<void>;
}

export async function startWizard(o: WizardOptions): Promise<Wizard> {
  const doFetch = o.fetch ?? fetch;
  const now = o.now ?? (() => new Date());
  const secretsDir = join(o.composeDir, 'secrets');
  const envFile = join(o.composeDir, '.env');
  const realGitHub = o.apiUrl === DEFAULT_API_URL;
  const initSecrets = (): void => {
    if (o.runInitSecrets === false) return;
    const r = spawnSync('./init-secrets', [], { cwd: o.composeDir, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`./init-secrets failed: ${(r.stderr ?? '').trim()}`);
    const last = (r.stdout ?? '').trim().split('\n').at(-1);
    if (last) o.log(`  ${last}`);
  };

  // 1. the stack's files exist (secrets/, .env), and no real key would be overwritten
  initSecrets();
  const files = o.kinds.flatMap((k) => keyFilesOf(k, o.factory));
  const real = realKeysAmong(secretsDir, files);
  if (real.length > 0 && !o.rotate) {
    throw new Error(
      `secrets/${real.join(', secrets/')} already hold a real key. Run with --rotate to replace ` +
        '(and delete the old App on GitHub), or --only to create the other App.',
    );
  }

  const state = randomBytes(24).toString('base64url');
  const suffix = randomBytes(3).toString('hex');
  const jobs = new Map<GithubAppKind, JobState>(
    o.kinds.map((k) => [
      k,
      { name: `${o.prefix}-${k === 'factory' ? 'factory' : 'gate-check'}-${suffix}`.slice(0, 34) },
    ]),
  );
  let settle: (v: readonly AppOutcome[]) => void = () => {};
  const done = new Promise<readonly AppOutcome[]>((resolve) => (settle = resolve));
  let helperUrl = '';

  const api = async (
    path: string,
    init: { method?: string; auth?: string; body?: unknown } = {},
  ): Promise<{ status: number; json: unknown }> => {
    const r = await doFetch(`${o.apiUrl}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
        'user-agent': 'aisdlc-setup-github-apps',
        ...(init.auth ? { authorization: `Bearer ${init.auth}` } : {}),
        ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      redirect: 'error',
    });
    const text = await r.text();
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json };
  };

  const jwtOf = (job: JobState): string => {
    const app = job.app as NonNullable<JobState['app']>;
    const key = createPrivateKey(app.key);
    return appJwt(
      { signRs256: (data: string) => sign('RSA-SHA256', Buffer.from(data), key) },
      String(app.id),
      now(),
    );
  };

  /** The code's conversion: the App's id, slug and key; the key is written and the ids go to .env. */
  const created = async (kind: GithubAppKind, code: string): Promise<string> => {
    const job = jobs.get(kind) as JobState;
    if (job.app) return 'this App was already created in this run';
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(code)) return 'GitHub sent no usable code';
    const r = await api(`/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
    });
    const b = r.json as {
      id?: unknown;
      slug?: unknown;
      pem?: unknown;
      permissions?: unknown;
    } | null;
    if (
      r.status !== 201 ||
      !b ||
      typeof b.id !== 'number' ||
      typeof b.slug !== 'string' ||
      !/^[a-z0-9-]{1,64}$/.test(b.slug) ||
      typeof b.pem !== 'string'
    ) {
      return `GitHub did not convert the manifest (HTTP ${r.status}); start again`;
    }
    try {
      createPrivateKey(b.pem);
    } catch {
      return 'GitHub sent no readable private key';
    }
    const want = githubAppPermissions(kind, o.factory);
    const got = (b.permissions ?? {}) as Record<string, string>;
    const cmp = comparePermissions(got, want);
    if (!cmp.ok) {
      return `GitHub made the App with other permissions (missing ${cmp.missing.join(', ') || 'none'}, extra ${cmp.extra.join(', ') || 'none'}); delete App ${b.slug} on GitHub and start again`;
    }
    // the key: refuse a real one again (another run may have written it meanwhile), then write every file mode 600
    const targets = keyFilesOf(kind, o.factory);
    const nowReal = realKeysAmong(secretsDir, targets);
    if (nowReal.length > 0 && !o.rotate) {
      return `secrets/${nowReal.join(', ')} now hold a real key; delete App ${b.slug} on GitHub, or run with --rotate`;
    }
    for (const f of targets) {
      const p = join(secretsDir, f);
      rmSync(p, { force: true });
      writeFileSync(p, b.pem, { mode: 0o600, flag: 'wx' });
      chmodSync(p, 0o600);
      const marker = FAKE_MARKER[f];
      if (marker) rmSync(join(secretsDir, marker), { force: true });
    }
    job.app = { id: b.id, slug: b.slug, key: b.pem };
    setEnvValues(envFile, envForApp(kind, o.factory, job.app, null, realGitHub));
    o.log(
      `  ${kind}: App ${b.slug} (App ID ${b.id}); key written to secrets/${targets.join(', secrets/')} (mode 600)`,
    );
    return '';
  };

  /** The installation, checked with an App JWT: exactly the permissions asked, selected repositories. */
  const check = async (kind: GithubAppKind, installationId: number): Promise<string> => {
    const job = jobs.get(kind) as JobState;
    if (!job.app) return 'the App is not created yet';
    job.installationId = installationId;
    const jwt = jwtOf(job);
    const r = await api(`/app/installations/${installationId}`, { auth: jwt });
    const i = r.json as {
      app_id?: unknown;
      permissions?: unknown;
      repository_selection?: unknown;
      suspended_at?: unknown;
    } | null;
    if (r.status !== 200 || !i)
      return `GitHub did not show installation ${installationId} (HTTP ${r.status})`;
    if (i.app_id !== job.app.id)
      return `installation ${installationId} is not of App ${job.app.slug}`;
    const cmp = comparePermissions(
      (i.permissions ?? {}) as Record<string, string>,
      githubAppPermissions(kind, o.factory),
    );
    const problems: string[] = [];
    if (!cmp.ok) {
      problems.push(
        `its permissions are not exactly the App's: missing ${cmp.missing.join(', ') || 'none'}; extra ${cmp.extra.join(', ') || 'none'}${cmp.forbidden.length > 0 ? `; forbidden ${cmp.forbidden.join(', ')}` : ''}. Accept the App's permissions on the installation page (or set them back on the App's settings page)`,
      );
    }
    if (i.repository_selection !== 'selected') {
      problems.push(
        'it can see ALL repositories. On GitHub: Settings › Applications › Installed GitHub Apps › Configure › Only select repositories › the testbed only',
      );
    }
    if (i.suspended_at !== null && i.suspended_at !== undefined) problems.push('it is suspended');
    if (problems.length > 0) return `installation ${installationId}: ${problems.join('. ')}`;
    // the repositories it can see, for the owner's eye (a token with metadata read only)
    let repositories: string[] = [];
    const t = await api(`/app/installations/${installationId}/access_tokens`, {
      method: 'POST',
      auth: jwt,
      body: { permissions: { metadata: 'read' } },
    });
    const token = (t.json as { token?: unknown } | null)?.token;
    if (t.status === 201 && typeof token === 'string') {
      const l = await api('/installation/repositories?per_page=100', { auth: token });
      const repos = (l.json as { repositories?: Array<{ full_name?: unknown }> } | null)
        ?.repositories;
      repositories = (repos ?? [])
        .map((x) => x.full_name)
        .filter((x): x is string => typeof x === 'string');
    }
    setEnvValues(envFile, envForApp(kind, o.factory, job.app, installationId, realGitHub));
    job.verified = {
      kind,
      appId: job.app.id,
      slug: job.app.slug,
      installationId,
      repositories,
    };
    job.problem = '';
    o.log(
      `  ${kind}: installation ${installationId} checked (permissions exact, selected repositories: ${repositories.join(', ') || 'none listed'})`,
    );
    return '';
  };

  const finishIfDone = (): void => {
    const all = [...jobs.values()];
    if (all.every((j) => j.verified)) {
      for (const j of all) if (j.app) j.app.key = ''; // nothing of the key is kept
      try {
        initSecrets(); // public halves, ownership, mode
      } catch (e) {
        o.log(`  ${(e as Error).message}`);
      }
      settle(all.map((j) => j.verified as AppOutcome));
    }
  };

  const page = (): string => {
    const createUrl = o.org
      ? `${o.webUrl}/organizations/${encodeURIComponent(o.org)}/settings/apps/new`
      : `${o.webUrl}/settings/apps/new`;
    const rows = [...jobs.entries()].map(([kind, j]) => {
      const perms = Object.entries(githubAppPermissions(kind, o.factory))
        .map(([n, l]) => `${n}: ${l}`)
        .join(', ');
      let body: string;
      if (j.verified) {
        body = `<p class="ok">Done: App <b>${escapeHtml(j.verified.slug)}</b> (App ID ${j.verified.appId}), installation ${j.verified.installationId}, repositories: ${escapeHtml(j.verified.repositories.join(', ') || 'none listed')}.</p>`;
      } else if (j.app) {
        const install = `${o.webUrl}/apps/${encodeURIComponent(j.app.slug)}/installations/new?state=${encodeURIComponent(state)}`;
        body =
          (j.problem ? `<p class="bad">${escapeHtml(j.problem)}</p>` : '') +
          `<p>App <b>${escapeHtml(j.app.slug)}</b> exists. <a href="${escapeHtml(install)}">Install it</a> on <b>your testbed repository only</b> (Only select repositories).</p>` +
          (j.installationId !== undefined
            ? `<p><a href="/recheck/${kind}?state=${encodeURIComponent(state)}">Check installation ${j.installationId} again</a></p>`
            : '');
      } else {
        const manifest = JSON.stringify(
          manifestFor(kind, {
            name: j.name,
            homepageUrl: o.homepageUrl,
            helperUrl,
            factory: o.factory,
          }),
        );
        body =
          (j.problem ? `<p class="bad">${escapeHtml(j.problem)}</p>` : '') +
          `<form method="post" action="${escapeHtml(`${createUrl}?state=${encodeURIComponent(state)}`)}">` +
          `<input type="hidden" name="manifest" value="${escapeHtml(manifest)}">` +
          `<button type="submit" data-kind="${kind}">Create ${escapeHtml(LABEL[kind])}</button></form>` +
          `<p class="small">Name ${escapeHtml(j.name)}; private; webhook off; no events; permissions ${escapeHtml(perms)}.</p>`;
      }
      return `<section><h2>${escapeHtml(LABEL[kind])}</h2>${body}</section>`;
    });
    const finished = [...jobs.values()].every((j) => j.verified);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>AISDLC GitHub Apps</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1b1f24;background:#fff}section{border:1px solid #d0d7de;border-radius:8px;padding:0 1rem 1rem;margin:1rem 0}.ok{color:#116329}.bad{color:#a40e26}.small{font-size:13px;color:#57606a}button{font:inherit;padding:.4rem .9rem;cursor:pointer}</style></head>
<body><h1>AISDLC GitHub Apps</h1><p>Two Apps: the factory's (reads and pushes agent branches) and gate-check's (writes only the check <code>aisdlc/gate</code>). The private keys go straight into <code>secrets/</code>; this page never shows them.</p>
${rows.join('\n')}
${finished ? '<p class="ok"><b>All done.</b> You can close this tab. Next: require the check <code>aisdlc/gate</code> from the gate-check App on the default branch (the factory never changes branch protection), then start the stack.</p>' : ''}
</body></html>`;
  };

  const send = (res: ServerResponse, status: number, html: string): void => {
    res.writeHead(status, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-frame-options': 'DENY',
    });
    res.end(html);
  };
  const redirect = (res: ServerResponse, to: string): void => {
    res.writeHead(302, {
      location: to,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
    });
    res.end();
  };

  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const given = url.searchParams.get('state') ?? url.searchParams.get('t');
    if (req.method !== 'GET') return send(res, 405, 'method not allowed');
    if (given !== state)
      return send(res, 403, 'This link is not from this run of setup-github-apps.');
    const home = `/?t=${encodeURIComponent(state)}`;
    if (url.pathname === '/') return send(res, 200, page());
    const m = /^\/(created|installed|recheck)\/(factory|gate-check)$/.exec(url.pathname);
    const kind = m?.[2] as GithubAppKind | undefined;
    const job = kind === undefined ? undefined : jobs.get(kind);
    if (!m || !kind || !job) return send(res, 404, 'not found');
    if (m[1] === 'created') {
      job.problem = await created(kind, url.searchParams.get('code') ?? '');
      if (job.problem !== '' || !job.app) return redirect(res, home);
      return redirect(
        res,
        `${o.webUrl}/apps/${encodeURIComponent(job.app.slug)}/installations/new?state=${encodeURIComponent(state)}`,
      );
    }
    const raw =
      m[1] === 'recheck'
        ? String(job.installationId ?? '')
        : url.searchParams.get('installation_id');
    const installationId = Number(raw);
    if (!Number.isInteger(installationId) || installationId < 1) {
      job.problem = 'GitHub sent no installation id';
      return redirect(res, home);
    }
    job.problem = await check(kind, installationId);
    redirect(res, home);
    finishIfDone();
  };

  const server: Server = createServer((req, res) => {
    handle(req, res).catch((e: unknown) => {
      // a fixed text: an error here never echoes what GitHub sent
      o.log(`  error: ${(e as Error).name}`);
      if (!res.headersSent) send(res, 500, 'setup-github-apps: something failed; see the terminal');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  helperUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: `${helperUrl}/?t=${encodeURIComponent(state)}`,
    done,
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
