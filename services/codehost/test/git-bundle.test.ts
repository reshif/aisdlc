import { execFileSync, execSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BundleManifest, type BundleRefs } from '@aisdlc/contracts';
import { emptySeed, type BundleResult } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  GitHttpTestServer,
  createFixtureRepo,
  git,
  gitEnv,
  startTestCodeHost,
  type FixtureRepo,
  type TestCodeHost,
} from '../src/testing.js';

// The credential-free bundle (PLAN M5.3) against a real git smart-HTTP server that answers only a
// request carrying a token the broker minted, as a header, and with a wrapper in front of git that
// records what each git child saw (argv, environment, the temp directory).

const SERVER_ROOT = mkdtempSync(join(tmpdir(), 'aisdlc-gitroot-'));
const SCRATCH = mkdtempSync(join(tmpdir(), 'aisdlc-gitscratch-'));
const TMP_ROOT = join(SCRATCH, 'tmp');
const TOKEN_FILE = join(SCRATCH, 'token');
mkdirSync(TMP_ROOT);

/** Authorization headers the git server accepts: one per test host (each mints its own token). */
const accepted = new Set<string>();
let server: GitHttpTestServer;
let gh: TestCodeHost;
const repos: Record<string, FixtureRepo> = {};
const timings: string[] = [];
const hosts: TestCodeHost[] = [];

const bundleDirs = (): string[] =>
  readdirSync(TMP_ROOT).filter((n) => n.startsWith('aisdlc-bundle-'));

function seed() {
  return emptySeed({
    installation: {
      installation_id: 4242,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'read', metadata: 'read' },
      suspended: false,
    },
    repos: [
      { full_name: 'acme/app', default_branch: 'main', private: false, archived: false },
      { full_name: 'acme/priv', default_branch: 'trunk', private: true, archived: false },
      { full_name: 'acme/empty', default_branch: 'main', private: false, archived: false },
      { full_name: 'acme/big', default_branch: 'main', private: true, archived: false },
      { full_name: 'acme/huge', default_branch: 'main', private: true, archived: false },
    ],
  });
}

/** A test codehost over the fake GitHub, with git pointed at the test git server. Returns its token too. */
async function newHost(
  limits: { gitBin?: string; capBytes?: number; timeoutMs?: number } = {},
): Promise<{ host: TestCodeHost; token: string }> {
  const host = await startTestCodeHost({
    seed: seed(),
    git: {
      gitBaseUrl: server.baseUrl,
      tmpRoot: TMP_ROOT,
      extraEnv: { NO_PROXY: '127.0.0.1' },
      ...limits,
    },
  });
  hosts.push(host);
  const t = await host.broker.token('hub');
  if (!t.ok) throw new Error('no token');
  const token = t.value.secret.reveal();
  accepted.add(`Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`);
  writeFileSync(TOKEN_FILE, token);
  // The wrapper greps with -f so the token never sits in any process's argv (ps would see it).
  writeFileSync(
    `${TOKEN_FILE}.patterns`,
    `${token}\n${Buffer.from(`x-access-token:${token}`).toString('base64')}\n`,
  );
  return { host, token };
}

async function drain(r: BundleResult): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of r.stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

async function bundleOf(
  host: TestCodeHost,
  repo: string,
  refs: BundleRefs,
  base_sha?: string,
): Promise<{ result: BundleResult; bytes: Buffer; file: string }> {
  const r = await host.rest.bundle({
    repo,
    refs,
    ...(base_sha === undefined ? {} : { base_sha }),
  });
  if (r.state !== 'ok') throw new Error(`bundle ${repo}: ${r.state}/${r.reason}: ${r.message}`);
  const bytes = await drain(r.value);
  const file = join(
    SCRATCH,
    `${repo.replace('/', '_')}-${refs}-${Math.random().toString(36).slice(2)}.bundle`,
  );
  writeFileSync(file, bytes);
  return { result: r.value, bytes, file };
}

const listHeads = (file: string): string[] =>
  git(SCRATCH, 'bundle', 'list-heads', file)
    .split('\n')
    .map((l) => l.split(' ')[1] as string)
    .sort();

type WrapperMode = 'record' | 'hold' | 'hang' | 'bloat';

/**
 * A git that records what it was given and scans the temp directory for the token (patterns read
 * from a file with grep -f, so neither the script nor any argv holds it), and can stall: `hold` sleeps before a
 * fetch (a long-running child for `ps`), `hang` never finishes a fetch (and leaves a grandchild),
 * `bloat` sleeps after an all-refs fetch (the size guard sees the objects before git exits).
 */
function writeWrapper(mode: WrapperMode, log: string): string {
  const path = join(SCRATCH, `git-${mode}-${Math.random().toString(36).slice(2)}.sh`);
  const real = execSync('command -v git', { encoding: 'utf8' }).trim();
  writeFileSync(
    path,
    `#!/bin/sh
LOG='${log}'
PATTERNS='${TOKEN_FILE}.patterns'
sub="$1"
echo "ARGV: $*" >> "$LOG"
echo "TMPMODE: $(stat -c %a "$(dirname "$HOME")")" >> "$LOG"
echo "HOME: $HOME" >> "$LOG"
for v in $(env | grep -F -f "$PATTERNS" | cut -d= -f1); do echo "ENV_HAS_TOKEN: $v" >> "$LOG"; done
env | grep -E '^(GIT_TERMINAL_PROMPT|GIT_CONFIG_NOSYSTEM|GIT_CONFIG_GLOBAL|GIT_CONFIG_COUNT)=' >> "$LOG"
env | grep -E '^GIT_CONFIG_KEY_' >> "$LOG"
echo "ENV_NAMES: $(env | cut -d= -f1 | sort | tr '\\n' ' ')" >> "$LOG"
${mode === 'hold' ? `if [ "$sub" = fetch ]; then sleep 1.5; fi` : ''}
${mode === 'hang' ? `if [ "$sub" = fetch ]; then sleep 31.737 & wait; fi` : ''}
'${real}' "$@"
rc=$?
${mode === 'bloat' ? `if [ "$sub" = fetch ] && echo "$*" | grep -q 'refs/tags'; then sleep 20; fi` : ''}
if grep -rlaF -f "$PATTERNS" "$(dirname "$HOME")" > "$LOG.found" 2>/dev/null; then
  while read -r f; do echo "FOUND_IN: $f" >> "$LOG"; done < "$LOG.found"
fi
exit $rc
`,
  );
  chmodSync(path, 0o755);
  return path;
}

beforeAll(async () => {
  repos['acme/app'] = createFixtureRepo(SERVER_ROOT, {
    name: 'acme/app',
    commits: 3,
    branches: [{ name: 'feature/x' }, { name: 'dev' }],
    tags: ['v1'],
    annotatedTags: ['v2'],
    pulls: [
      { number: 1, branch: 'feature/x' },
      { number: 7, branch: 'dev' },
    ],
  });
  repos['acme/priv'] = createFixtureRepo(SERVER_ROOT, {
    name: 'acme/priv',
    default_branch: 'trunk',
    commits: 2,
    branches: [{ name: 'feature/y' }],
    tags: ['v1'],
    pulls: [{ number: 3, branch: 'feature/y' }],
  });
  repos['acme/empty'] = createFixtureRepo(SERVER_ROOT, { name: 'acme/empty', empty: true });
  repos['acme/big'] = createFixtureRepo(SERVER_ROOT, {
    name: 'acme/big',
    commits: 2,
    branches: [
      { name: 'blob1', padBytes: 250_000 },
      { name: 'blob2', padBytes: 250_000 },
    ],
    tags: ['t1'],
  });
  repos['acme/huge'] = createFixtureRepo(SERVER_ROOT, {
    name: 'acme/huge',
    commits: 3,
    padBytes: 200_000,
  });
  server = await new GitHttpTestServer({
    root: SERVER_ROOT,
    isAuthorized: (h) => h !== undefined && accepted.has(h),
  }).start();
  gh = (await newHost()).host;
}, 60_000);

afterAll(async () => {
  for (const h of hosts) await h.stop();
  await server.stop();
  rmSync(SERVER_ROOT, { recursive: true, force: true });
  rmSync(SCRATCH, { recursive: true, force: true });
});

describe('bundle of all refs', () => {
  it('is a valid git bundle with every branch, tag and (public repo) pull ref, ending at the default head', async () => {
    const { result, bytes, file } = await bundleOf(gh, 'acme/app', 'all');
    const app = repos['acme/app'] as FixtureRepo;
    const m = BundleManifest.parse(result.manifest);
    expect(m).toMatchObject({
      repo: 'acme/app',
      head_sha: app.head,
      refs_covered: 'all',
      ref_count: 7,
      commit_count: 5,
      bytes: bytes.length,
    });
    expect(listHeads(file)).toEqual(
      [
        'HEAD',
        'refs/heads/dev',
        'refs/heads/feature/x',
        'refs/heads/main',
        'refs/pull/1/head',
        'refs/pull/7/head',
        'refs/tags/v1',
        'refs/tags/v2',
      ].sort(),
    );
    const heads = git(SCRATCH, 'bundle', 'list-heads', file);
    expect(heads).toContain(`${app.head} HEAD`);
    expect(heads).toContain(`${app.refs['refs/tags/v2']} refs/tags/v2`);
    // `git bundle verify` in a repo that has none of it: a complete bundle has no prerequisites.
    const empty = mkdtempSync(join(SCRATCH, 'verify-'));
    git(empty, 'init', '--quiet');
    expect(git(empty, 'bundle', 'verify', file)).toContain('records a complete history');
    // And it clones into the same history.
    const clone = join(SCRATCH, 'clone-app');
    execFileSync('git', ['clone', '--quiet', file, clone], { env: gitEnv() });
    expect(git(clone, 'rev-parse', 'HEAD')).toBe(app.head);
    const phases = gh.bundleLogs.filter((l) => l.includes('took')).slice(-2);
    timings.push(
      `acme/app  all          refs=${m.ref_count} commits=${m.commit_count} bytes=${m.bytes} total=${m.duration_ms} ms (${phases.map((p) => p.replace('bundle acme/app: ', '')).join('; ')})`,
    );
  });

  it('leaves out refs/pull/* of a private repo', async () => {
    const { result, file } = await bundleOf(gh, 'acme/priv', 'all');
    expect(result.manifest).toMatchObject({
      head_sha: repos['acme/priv']?.head,
      refs_covered: 'all',
    });
    expect(listHeads(file)).toEqual([
      'HEAD',
      'refs/heads/feature/y',
      'refs/heads/trunk',
      'refs/tags/v1',
    ]);
  });

  it('refs: default_only is recorded as such and holds the default branch only', async () => {
    const { result, file } = await bundleOf(gh, 'acme/app', 'default_only');
    expect(result.manifest).toMatchObject({
      refs_covered: 'default_only',
      ref_count: 1,
      commit_count: 3,
    });
    expect(listHeads(file)).toEqual(['HEAD', 'refs/heads/main']);
    timings.push(
      `acme/app  default_only refs=1 commits=3 bytes=${result.manifest.bytes} total=${result.manifest.duration_ms} ms`,
    );
  });

  it('a base_sha that is the head is accepted, another is head_moved', async () => {
    const app = repos['acme/app'] as FixtureRepo;
    await bundleOf(gh, 'acme/app', 'default_only', app.head);
    const r = await gh.rest.bundle({ repo: 'acme/app', refs: 'all', base_sha: 'f'.repeat(40) });
    expect(r).toMatchObject({ state: 'unreadable', reason: 'head_moved' });
    expect(bundleDirs()).toEqual([]);
  });

  it('a repo without commits is not_found, one the installation lacks is not_found', async () => {
    expect(await gh.rest.bundle({ repo: 'acme/empty', refs: 'all' })).toMatchObject({
      state: 'unreadable',
      reason: 'not_found',
    });
    expect(await gh.rest.bundle({ repo: 'acme/ghost', refs: 'all' })).toMatchObject({
      state: 'unreadable',
      reason: 'not_found',
    });
    expect(bundleDirs()).toEqual([]);
  });

  it('a token the git server does not accept is unauthenticated, and leaves nothing', async () => {
    accepted.clear();
    const r = await gh.rest.bundle({ repo: 'acme/app', refs: 'all' });
    expect(r).toMatchObject({ state: 'unreadable', reason: 'unauthenticated' });
    expect(bundleDirs()).toEqual([]);
    const t = await gh.broker.token('hub');
    if (t.ok) {
      accepted.add(
        `Basic ${Buffer.from(`x-access-token:${t.value.secret.reveal()}`).toString('base64')}`,
      );
    }
  });

  it('only reads: ref discovery and upload-pack, never a push', () => {
    const paths = server.requests.map((r) => `${r.method} ${r.path.replace(/^.*\.git/, '')}`);
    expect(new Set(paths)).toEqual(new Set(['GET /info/refs', 'POST /git-upload-pack']));
    expect(server.pushAttempts).toBe(0);
    // Requests without the header were refused before any git data (only the unauthenticated test).
    expect(server.requests.filter((r) => !r.authorized).every((r) => r.method === 'GET')).toBe(
      true,
    );
  });
});

describe('no credential anywhere', () => {
  it('reaches git only as an env-configured header; not in a bundle, manifest, log, argv, file or the temp dir', async () => {
    const log = join(SCRATCH, 'wrapper-hold.log');
    const { host, token } = await newHost({ gitBin: writeWrapper('hold', log) });
    const b64 = Buffer.from(`x-access-token:${token}`).toString('base64');

    // Poll `ps` while the bundle runs.
    const argvSeen = new Set<string>();
    const poll = setInterval(() => {
      try {
        for (const l of execSync('ps -eww -o args=', { encoding: 'utf8' }).split('\n')) {
          argvSeen.add(l);
        }
      } catch {
        /* ps raced a process exit */
      }
    }, 100);
    let during: string[] = [];
    const watch = setInterval(() => {
      during = [...new Set([...during, ...bundleDirs()])];
    }, 100);
    const { result, bytes } = await bundleOf(host, 'acme/app', 'all');
    clearInterval(poll);
    clearInterval(watch);
    const record = readFileSync(log, 'utf8');
    const forms = [token, b64];

    // The bundle, the manifest, every log line the code wrote.
    for (const s of forms) {
      expect(bytes.includes(s), 'bundle bytes').toBe(false);
      expect(JSON.stringify(result.manifest).includes(s), 'manifest').toBe(false);
      expect(host.bundleLogs.join('\n').includes(s), 'bundle log').toBe(false);
      expect(host.logs.join('\n').includes(s), 'transport log').toBe(false);
      // No process had it in argv while the bundle ran (the hold keeps a git child alive ~1.5 s).
      expect(
        [...argvSeen].some((l) => l.includes(s)),
        'ps argv',
      ).toBe(false);
      expect(record.replace(/^ENV_HAS_TOKEN.*$/gm, '').includes(s), 'wrapper record').toBe(false);
    }
    expect([...argvSeen].some((l) => l.includes('fetch --quiet --no-tags'))).toBe(true);
    expect(during.length).toBe(1); // one private directory for the call
    // The temp directory (mode 0700) never held it, checked after every git step; it is gone after.
    expect(record).not.toMatch(/FOUND_IN:/);
    expect(record).toMatch(/TMPMODE: 700/);
    expect(bundleDirs()).toEqual([]);

    // In git's environment it is a GIT_CONFIG_VALUE_n of the fetch, and nowhere else.
    const steps = record.split('ARGV: ').slice(1);
    const fetches = steps.filter((s) => s.startsWith('fetch '));
    expect(fetches.length).toBe(1);
    expect(fetches[0]).toMatch(/^ENV_HAS_TOKEN: GIT_CONFIG_VALUE_\d+$/m);
    expect((fetches[0]?.match(/ENV_HAS_TOKEN/g) ?? []).length).toBe(1);
    for (const step of steps.filter((s) => !s.startsWith('fetch '))) {
      expect(step, step.split(' ')[0]).not.toMatch(/ENV_HAS_TOKEN/);
    }
  }, 60_000);

  it('hardens git: no prompts, no system or global config, no hooks, no helper, https only, a private HOME', async () => {
    const log = join(SCRATCH, 'wrapper-record.log');
    const { host } = await newHost({ gitBin: writeWrapper('record', log) });
    await bundleOf(host, 'acme/app', 'all');
    const record = readFileSync(log, 'utf8');
    const fetch = record.split('ARGV: ').find((s) => s.startsWith('fetch ')) as string;
    expect(fetch).toContain('GIT_TERMINAL_PROMPT=0');
    expect(fetch).toContain('GIT_CONFIG_NOSYSTEM=1');
    expect(fetch).toContain('GIT_CONFIG_GLOBAL=/dev/null');
    expect(fetch).toMatch(/HOME: .*aisdlc-bundle-[^/]+\/home/);
    expect(fetch).toMatch(/GIT_CONFIG_KEY_\d+=core\.hooksPath/);
    expect(fetch).toMatch(/GIT_CONFIG_KEY_\d+=credential\.helper/);
    expect(fetch).toMatch(/GIT_CONFIG_KEY_\d+=protocol\.allow/);
    expect(fetch).toMatch(/GIT_CONFIG_KEY_\d+=http\.followRedirects/);
    expect(fetch).toMatch(/GIT_CONFIG_KEY_\d+=http\.http:\/\/127\.0\.0\.1:\d+\/\.extraheader/);
    // Nothing of the caller's environment reaches git except PATH and network settings.
    const names = (/ENV_NAMES: (.*)/.exec(fetch)?.[1] ?? '').split(' ');
    for (const secret of [
      'GH_TOKEN',
      'GITHUB_TOKEN',
      'AWS_SECRET_ACCESS_KEY',
      'SSH_AUTH_SOCK',
      'GIT_ASKPASS',
      'GIT_DIR',
    ]) {
      expect(names).not.toContain(secret);
    }
    // Arguments name no token and no `-c`: configuration is in the environment only.
    expect(fetch.split('\n')[0]).not.toMatch(/ -c /);
    expect(fetch.split('\n')[0]).toContain(`${server.baseUrl}/acme/app.git`);
  });

  it('the fetch URL is the plain repo URL, with no userinfo', async () => {
    expect(server.requests.every((r) => /^\/acme\/[a-z]+\.git\//.test(r.path))).toBe(true);
  });
});

describe('limits', () => {
  it('all refs over the size cap fall back to default_only, recorded, and the bundle is whole', async () => {
    const { host } = await newHost({ capBytes: 300_000 });
    const { result, file } = await bundleOf(host, 'acme/big', 'all');
    expect(result.manifest).toMatchObject({ refs_covered: 'default_only', ref_count: 1 });
    expect(result.manifest.bytes).toBeLessThanOrEqual(300_000);
    expect(listHeads(file)).toEqual(['HEAD', 'refs/heads/main']);
    const empty = mkdtempSync(join(SCRATCH, 'verify-'));
    git(empty, 'init', '--quiet');
    expect(git(empty, 'bundle', 'verify', file)).toContain('records a complete history');
    expect(host.bundleLogs.some((l) => l.includes('falling back to default_only'))).toBe(true);
    expect(bundleDirs()).toEqual([]);
    // With room for all refs, the same repo bundles all of them.
    const wide = await newHost({ capBytes: 10_000_000 });
    const all = await bundleOf(wide.host, 'acme/big', 'all');
    expect(all.result.manifest).toMatchObject({ refs_covered: 'all', ref_count: 4 });
    timings.push(
      `acme/big  all (cap 10 MB) refs=4 bytes=${all.result.manifest.bytes} total=${all.result.manifest.duration_ms} ms; cap 300 kB -> default_only bytes=${result.manifest.bytes}`,
    );
  });

  it('the size guard stops an all-refs fetch that is far over the cap, then falls back', async () => {
    const log = join(SCRATCH, 'wrapper-bloat.log');
    const { host } = await newHost({ gitBin: writeWrapper('bloat', log), capBytes: 100_000 });
    const t0 = Date.now();
    const { result } = await bundleOf(host, 'acme/big', 'all');
    expect(result.manifest.refs_covered).toBe('default_only');
    expect(Date.now() - t0).toBeLessThan(15_000); // not the wrapper's 20 s
    expect(host.bundleLogs.some((l) => l.includes('falling back'))).toBe(true);
    expect(bundleDirs()).toEqual([]);
  }, 30_000);

  it('a default branch alone over the cap is an error result: no truncated bundle, no temp dir', async () => {
    const { host } = await newHost({ capBytes: 100_000 });
    const r = await host.rest.bundle({ repo: 'acme/huge', refs: 'all' });
    expect(r).toMatchObject({ state: 'unreadable', reason: 'too_large' });
    expect(r.state).not.toBe('ok');
    const d = await host.rest.bundle({ repo: 'acme/huge', refs: 'default_only' });
    expect(d).toMatchObject({ state: 'unreadable', reason: 'too_large' });
    expect(bundleDirs()).toEqual([]);
  });

  it('a call over its timeout is unknown/timeout, kills the whole git process group, and leaves no temp dir', async () => {
    const log = join(SCRATCH, 'wrapper-hang.log');
    const { host } = await newHost({ gitBin: writeWrapper('hang', log), timeoutMs: 1500 });
    const t0 = Date.now();
    const r = await host.rest.bundle({ repo: 'acme/app', refs: 'all' });
    const took = Date.now() - t0;
    expect(r).toMatchObject({ state: 'unknown', reason: 'timeout' });
    expect(took).toBeGreaterThanOrEqual(1400);
    expect(took).toBeLessThan(6000);
    expect(bundleDirs()).toEqual([]);
    // The `sleep 31.737` grandchild of the wrapper was in git's group and died with it.
    const left = execSync("ps -eww -o args= | grep -F 'sleep 31.737' | grep -v grep || true", {
      encoding: 'utf8',
    });
    expect(left.trim()).toBe('');
    timings.push(`timeout 1500 ms honoured: returned after ${took} ms`);
  }, 30_000);
});

describe('SP-PROC-4: size and time are measured', () => {
  it('prints the timings of the bundles made above (fixture repos, loopback git)', () => {
    expect(timings.length).toBeGreaterThanOrEqual(4);
    console.log(`SP-PROC-4 bundle timings (fixture repos, loopback git):\n${timings.join('\n')}`);
  });
});
