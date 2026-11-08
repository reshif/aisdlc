import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, open, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  BUNDLE_DEFAULT_CAP_BYTES,
  BUNDLE_DEFAULT_TIMEOUT_MS,
  type BundleManifest,
  type BundleRefs,
  type CodeHostNotOk,
  type CodeHostRead,
  type GitSha,
  type RepoFullName,
} from '@aisdlc/contracts';
import type { Result } from '@aisdlc/kernel';
import { readOk, readUnknown, readUnreadable, type BundleResult } from '@aisdlc/ports';
import type { SecretValue } from './app-key.js';

// The credential-free bundle (PLAN M5.3; OB §5.3 item 3, §6.5 "Bytes flow", SP-PROC-4).
//
// The codehost is the only holder of a code-host credential. To give Knowledge and the probe
// sandbox the bytes of a repo without the credential it:
//   1. makes a private temp directory (mode 0700) and a bare repo in it;
//   2. fetches the refs it was asked for with `git fetch`, the installation token reaching git only
//      through GIT_CONFIG_COUNT / GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n in the child's environment
//      (an `http.<base>/.extraheader` entry scoped to the git base URL): never in a URL, an argv
//      entry, a file or the remote's config. The URL passed to git is `<base>/<owner>/<name>.git`;
//   3. writes `git bundle create -` to a file through a byte counter that stops it at the size cap
//      (an overflow is an error, or a recorded fallback to the default branch alone, never a
//      truncated bundle);
//   4. opens the bundle, removes the temp directory (so nothing is left on disk whatever happens
//      next) and returns the open file as a stream plus a manifest.
// Every git child runs in its own process group with a minimal environment; a call has one
// deadline, and when it passes the group is killed.

export interface GitBundleOptions {
  /** `git` unless a test puts a wrapper in front of it. */
  readonly gitBin?: string;
  /** Where repositories are cloned from: `https://github.com`. Plain http only for loopback tests. */
  readonly gitBaseUrl: string;
  /** The `hub` installation token, minted per call. */
  readonly token: () => Promise<Result<SecretValue, CodeHostNotOk>>;
  readonly capBytes?: number;
  readonly timeoutMs?: number;
  /** Parent of the per-call temp directory. Default the OS temp dir. */
  readonly tmpRoot?: string;
  /** Extra environment for git children (tests: proxy exceptions). Never a credential. */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /** One line per phase with timings. Never a token. */
  readonly log?: (line: string) => void;
}

export interface GitBundleRequest {
  readonly repo: RepoFullName;
  readonly default_branch: string;
  readonly is_private: boolean;
  readonly base_sha?: GitSha | undefined;
  readonly refs: BundleRefs;
}

/** Environment variables a git child may inherit: where binaries are, and how to reach the network. */
const INHERITED_ENV = [
  'PATH',
  'TZ',
  'HTTPS_PROXY',
  'https_proxy',
  'HTTP_PROXY',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'GIT_SSL_CAINFO',
] as const;

const STDERR_LIMIT = 8 * 1024;
const SIZE_POLL_MS = 500;
const STDOUT_LIMIT = 32 * 1024 * 1024;

class Stop extends Error {
  constructor(readonly outcome: CodeHostNotOk) {
    super(outcome.message);
  }
}

interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/** Sums file sizes under `dir` (best effort: a file that vanishes counts as 0). */
async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(p);
    else if (e.isFile())
      total += await stat(p).then(
        (s) => s.size,
        () => 0,
      );
  }
  return total;
}

export async function makeGitBundle(
  o: GitBundleOptions,
  req: GitBundleRequest,
): Promise<CodeHostRead<BundleResult>> {
  const cap = o.capBytes ?? BUNDLE_DEFAULT_CAP_BYTES;
  const timeoutMs = o.timeoutMs ?? BUNDLE_DEFAULT_TIMEOUT_MS;
  const started = performance.now();
  const ms = (since: number): number => Math.round(performance.now() - since);

  const tok = await o.token();
  if (!tok.ok) return tok.error;
  const secret = tok.value.reveal();
  const basic = Buffer.from(`x-access-token:${secret}`).toString('base64');
  /** Every spelling of the token that could appear in output. */
  const scrub = (text: string): string =>
    text.split(secret).join('[redacted]').split(basic).join('[redacted]');
  const log = (line: string): void => o.log?.(scrub(line));

  const base = o.gitBaseUrl.replace(/\/+$/, '');
  const baseUrl = new URL(base);
  const insecure = baseUrl.protocol === 'http:';
  if (
    baseUrl.protocol !== 'https:' &&
    !(insecure && ['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname))
  ) {
    return readUnreadable('refused', 'the git base URL must be https');
  }
  if (baseUrl.username !== '' || baseUrl.password !== '') {
    return readUnreadable('refused', 'the git base URL must not carry credentials');
  }
  const url = `${base}/${req.repo}.git`;
  const defaultRef = `refs/heads/${req.default_branch}`;

  let dir: string;
  try {
    dir = await mkdtemp(join(o.tmpRoot ?? tmpdir(), 'aisdlc-bundle-'));
  } catch {
    return readUnknown('server_error', 'a private work directory could not be made');
  }
  const home = join(dir, 'home');
  const gitDir = join(dir, 'repo.git');
  const outFile = join(dir, 'out.bundle');

  // One deadline for the whole call; every child is killed through it.
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const running = new Set<ChildProcess>();
  const killAll = (): void => {
    for (const c of running) killGroup(c);
  };
  deadline.signal.addEventListener('abort', killAll, { once: true });

  const baseEnv = (): Record<string, string> => {
    const env: Record<string, string> = {
      HOME: home,
      LANG: 'C',
      LC_ALL: 'C',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
    };
    for (const k of INHERITED_ENV) {
      const v = process.env[k];
      if (v !== undefined) env[k] = v;
    }
    Object.assign(env, o.extraEnv);
    // Hardening, as config in the environment (not argv, not a file): no hooks, no credential
    // helper, https only (plain http to loopback in tests), no redirects (the credential would go
    // with them), no automatic gc.
    const cfg: Array<[string, string]> = [
      ['core.hooksPath', '/dev/null'],
      ['credential.helper', ''],
      ['protocol.allow', 'never'],
      [insecure ? 'protocol.http.allow' : 'protocol.https.allow', 'always'],
      ['http.followRedirects', 'false'],
      ['gc.auto', '0'],
      ['core.fsmonitor', 'false'],
    ];
    return withConfig(env, cfg);
  };

  const run = (
    args: readonly string[],
    opts: { env?: Record<string, string>; stdoutTo?: string; cwd?: string } = {},
  ): Promise<RunResult> =>
    new Promise((resolve, reject) => {
      if (deadline.signal.aborted)
        return reject(new Stop(readUnknown('timeout', 'bundle timed out')));
      let child: ChildProcess;
      try {
        child = spawn(o.gitBin ?? 'git', [...args], {
          cwd: opts.cwd ?? gitDir,
          env: opts.env ?? baseEnv(),
          detached: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch {
        return reject(new Stop(readUnknown('server_error', 'git could not be run')));
      }
      running.add(child);
      let stdout = '';
      let stderr = '';
      let overflow = false;
      child.stderr?.on('data', (b: Buffer) => {
        if (stderr.length < STDERR_LIMIT) stderr += b.toString('utf8');
      });
      let sink: Promise<void> | null = null;
      if (opts.stdoutTo !== undefined && child.stdout) {
        // The size cap is enforced here, while the bytes are written.
        let written = 0;
        const counter = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            written += chunk.length;
            if (written > cap) {
              overflow = true;
              killGroup(child);
              return cb(new Error('over the size cap'));
            }
            cb(null, chunk);
          },
        });
        sink = pipeline(
          child.stdout,
          counter,
          createWriteStream(opts.stdoutTo, { flags: 'wx', mode: 0o600 }),
        ).catch((e: unknown) => {
          if (!overflow) throw e;
        });
      } else {
        child.stdout?.on('data', (b: Buffer) => {
          if (stdout.length < STDOUT_LIMIT) stdout += b.toString('utf8');
        });
      }
      child.once('error', () => {
        running.delete(child);
        reject(new Stop(readUnknown('server_error', 'git could not be run')));
      });
      child.once('close', (code) => {
        running.delete(child);
        const done = (): void => {
          if (deadline.signal.aborted) {
            return reject(new Stop(readUnknown('timeout', 'bundle timed out')));
          }
          if (overflow) {
            return reject(
              new Stop(readUnreadable('too_large', `the bundle is over the ${cap}-byte cap`)),
            );
          }
          resolve({ code, stdout, stderr: scrub(stderr) });
        };
        if (sink)
          sink.then(done, () =>
            reject(new Stop(readUnknown('server_error', 'writing the bundle failed'))),
          );
        else done();
      });
    });

  /** Runs git and requires exit 0. */
  const must = async (
    what: string,
    args: readonly string[],
    opts: Parameters<typeof run>[1] = {},
  ): Promise<RunResult> => {
    const r = await run(args, opts);
    if (r.code !== 0) throw new Stop(classifyGitFailure(what, r.stderr));
    return r;
  };

  const initRepo = async (): Promise<void> => {
    await rm(gitDir, { recursive: true, force: true });
    await must('init', ['init', '--bare', '--quiet', gitDir], { cwd: dir });
    await must('init', ['symbolic-ref', 'HEAD', defaultRef]);
  };

  /** `git fetch` of `refspecs`; the only call that carries the token. */
  const fetchRefs = async (refspecs: readonly string[], watch: boolean): Promise<void> => {
    const t = performance.now();
    const env = withConfig(baseEnv(), [
      [`http.${base}/.extraheader`, `Authorization: Basic ${basic}`],
    ]);
    let guard: NodeJS.Timeout | undefined;
    let tooBig = false;
    if (watch) {
      guard = setInterval(() => {
        void dirBytes(join(gitDir, 'objects')).then((n) => {
          if (n > cap * 2 && !tooBig) {
            tooBig = true;
            killAll();
          }
        });
      }, SIZE_POLL_MS);
    }
    try {
      const r = await run(
        [
          'fetch',
          '--quiet',
          '--no-tags',
          '--no-write-fetch-head',
          '--no-auto-gc',
          '--no-recurse-submodules',
          '--',
          url,
          ...refspecs,
        ],
        { env },
      );
      if (tooBig)
        throw new Stop(readUnreadable('too_large', 'fetching every ref is over the size cap'));
      if (r.code !== 0) throw new Stop(classifyGitFailure('fetch', r.stderr));
    } finally {
      if (guard) clearInterval(guard);
      log(`bundle ${req.repo}: fetch ${refspecs.length} refspec(s) took ${ms(t)} ms`);
    }
  };

  const allSpecs = [
    '+refs/heads/*:refs/heads/*',
    '+refs/tags/*:refs/tags/*',
    ...(req.is_private ? [] : ['+refs/pull/*/head:refs/pull/*/head']),
  ];
  const defaultSpec = [`+${defaultRef}:${defaultRef}`];
  const revArgs = (covered: BundleRefs): string[] =>
    covered === 'all'
      ? ['HEAD', '--branches', '--tags', ...(req.is_private ? [] : ['--glob=refs/pull/*/head'])]
      : ['HEAD', defaultRef];

  /** Writes the bundle of `covered` refs; `too_large` if it passes the cap. */
  const writeBundle = async (covered: BundleRefs): Promise<void> => {
    const t = performance.now();
    await rm(outFile, { force: true });
    try {
      const r = await run(['bundle', 'create', '-', ...revArgs(covered)], { stdoutTo: outFile });
      if (r.code !== 0) throw new Stop(classifyGitFailure('bundle', r.stderr));
    } finally {
      log(`bundle ${req.repo}: git bundle (${covered}) took ${ms(t)} ms`);
    }
  };

  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await mkdir(home, { mode: 0o700 });
    await initRepo();

    let covered: BundleRefs = req.refs;
    let fetchedAll = false;
    if (covered === 'all') {
      try {
        await fetchRefs(allSpecs, true);
        fetchedAll = true;
      } catch (e) {
        // All refs are too many bytes: record the narrower coverage and go on with the default branch.
        if (!(e instanceof Stop) || e.outcome.reason !== 'too_large') throw e;
        covered = 'default_only';
        log(`bundle ${req.repo}: all refs are over the cap, falling back to default_only`);
        await initRepo();
      }
    }
    if (covered === 'default_only' && !fetchedAll) await fetchRefs(defaultSpec, false);

    const head = await run(['rev-parse', '--verify', '--quiet', `${defaultRef}^{commit}`]);
    if (head.code !== 0) {
      throw new Stop(
        readUnreadable('not_found', `${req.repo} has no commits on ${req.default_branch}`),
      );
    }
    const headSha = head.stdout.trim();
    if (!/^[0-9a-f]{40}$/.test(headSha)) {
      throw new Stop(readUnknown('malformed', 'git did not give a commit id'));
    }
    if (req.base_sha !== undefined && req.base_sha !== headSha) {
      throw new Stop(
        readUnreadable('head_moved', `the default branch is no longer at ${req.base_sha}`),
      );
    }

    try {
      await writeBundle(covered);
    } catch (e) {
      if (!(e instanceof Stop) || e.outcome.reason !== 'too_large' || covered !== 'all') throw e;
      covered = 'default_only';
      log(`bundle ${req.repo}: the all-refs bundle is over the cap, falling back to default_only`);
      await writeBundle(covered);
    }

    const heads = await must('list-heads', ['bundle', 'list-heads', outFile]);
    const refCount = heads.stdout
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.endsWith(' HEAD')).length;
    const commits = await must('rev-list', ['rev-list', '--count', ...revArgs(covered)]);
    const commitCount = Number(commits.stdout.trim());
    fileHandle = await open(outFile, 'r');
    const bytes = (await fileHandle.stat()).size;
    if (!Number.isInteger(commitCount) || commitCount < 1 || refCount < 1 || bytes < 1) {
      throw new Stop(readUnknown('malformed', 'git described an empty bundle'));
    }
    const manifest: BundleManifest = {
      repo: req.repo,
      head_sha: headSha,
      refs_covered: covered,
      ref_count: refCount,
      commit_count: commitCount,
      bytes,
      duration_ms: ms(started),
    };
    log(
      `bundle ${req.repo}: ${covered}, ${refCount} refs, ${commitCount} commits, ${bytes} bytes, ${manifest.duration_ms} ms`,
    );
    // The open file outlives the directory: the bytes are read from the descriptor.
    const fh = fileHandle;
    fileHandle = undefined;
    const stream = fh.createReadStream({ autoClose: true });
    return readOk({ manifest, stream, dispose: () => void stream.destroy() });
  } catch (e) {
    if (e instanceof Stop) return e.outcome;
    return readUnknown('server_error', 'the bundle could not be made');
  } finally {
    clearTimeout(timer);
    killAll();
    await fileHandle?.close().catch(() => undefined);
    await Promise.all([...running].map((c) => waitExit(c)));
    await rm(dir, { recursive: true, force: true });
  }
}

/** Environment with `GIT_CONFIG_COUNT` entries added after any already present. */
function withConfig(
  env: Record<string, string>,
  entries: ReadonlyArray<readonly [string, string]>,
): Record<string, string> {
  const out = { ...env };
  let n = Number(out['GIT_CONFIG_COUNT'] ?? 0);
  for (const [k, v] of entries) {
    out[`GIT_CONFIG_KEY_${n}`] = k;
    out[`GIT_CONFIG_VALUE_${n}`] = v;
    n += 1;
  }
  out['GIT_CONFIG_COUNT'] = String(n);
  return out;
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  try {
    // A negative pid is the process group the child leads (it was spawned `detached`).
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    child.once('close', () => resolve());
  });
}

/** What a failed git means for the caller. The text is git's own, already scrubbed of the token. */
function classifyGitFailure(what: string, stderr: string): CodeHostNotOk {
  const first = stderr.trim().split('\n')[0]?.slice(0, 200) ?? '';
  if (/\b(401|Authentication failed|could not read Username)\b/i.test(stderr)) {
    return readUnreadable('unauthenticated', `git ${what}: authentication failed`);
  }
  if (/\b403\b/.test(stderr)) return readUnreadable('forbidden', `git ${what}: 403`);
  if (/\b404\b|not found|does not appear to be a git repository/i.test(stderr)) {
    return readUnreadable('not_found', `git ${what}: repository not found`);
  }
  if (
    /Could not resolve host|Failed to connect|Connection (refused|reset|timed out)|unable to access/i.test(
      stderr,
    )
  ) {
    return readUnknown('network', `git ${what}: the request failed`);
  }
  return readUnknown('server_error', `git ${what} failed${first ? `: ${first}` : ''}`);
}
