import { spawn } from 'node:child_process';
import { createWriteStream, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BundleRequest, BundleManifest } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { MAX_REPO_BYTES, MAX_REPO_FILES, type RepoFile } from '@aisdlc/ports';
import type { Readable } from 'node:stream';
import { buildSourceError, type BuildSourceError } from './source.js';

// The repo at the Unit's base commit (PLAN M13.3): from the credential-free `git bundle` the code host serves to the
// knowledge/census plane, read with a hardened git into a list of files. Everything in the bundle is data: no hook,
// filter, config or attribute of the repo is ever used (a bare repo of our own, a fresh HOME, no system or global
// config), symlinks and submodules are not part of a copy, and the sizes are capped before a byte is kept.

export interface BundleReads {
  bundle(req: BundleRequest): Promise<
    | {
        readonly state: 'ok';
        readonly value: {
          readonly manifest: BundleManifest;
          readonly stream: Readable;
          dispose(): void;
        };
      }
    | { readonly state: string }
  >;
}

const run = (
  git: string,
  args: string[],
  cwd: string,
  env: Record<string, string>,
  input?: Buffer,
  maxBytes = MAX_REPO_BYTES + 64 * 1024 * 1024,
): Promise<{ code: number; out: Buffer; err: Buffer }> =>
  new Promise((resolve, reject) => {
    const c = spawn(git, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks: Buffer[] = [];
    const errs: Buffer[] = [];
    c.stderr.on('data', (b: Buffer) => errs.push(b));
    let n = 0;
    c.stdout.on('data', (b: Buffer) => {
      n += b.length;
      if (n > maxBytes) {
        c.kill('SIGKILL');
        reject(new Error('git output over the cap'));
        return;
      }
      chunks.push(b);
    });
    c.on('error', reject);
    c.on('close', (code) =>
      resolve({ code: code ?? 1, out: Buffer.concat(chunks), err: Buffer.concat(errs) }),
    );
    c.stdin.on('error', () => undefined);
    c.stdin.end(input);
  });

export class GitBundleFiles {
  constructor(
    private readonly reads: BundleReads,
    private readonly o: { git?: string } = {},
  ) {}

  /**
   * The tree of `sha`: from the default branch's bundle when `sha` is its head (the base commit), otherwise from the
   * bundle of every branch (S7 reads a Unit head on `agent/<item>/<unit>`, which the default branch does not hold; the
   * host answers `head_moved` for it there). A commit in neither is `not_found`.
   */
  async files(repo: string, sha: string): Promise<Result<RepoFile[], BuildSourceError>> {
    if (!/^[0-9a-f]{40}$/.test(sha)) return err(buildSourceError('invalid', 'not a commit sha'));
    const first = await this.fromBundle(sha, {
      repo,
      base_sha: sha,
      refs: 'default_only',
    } as BundleRequest);
    if (first.ok || first.error.code === 'invalid') return first;
    return this.fromBundle(sha, { repo, refs: 'all' } as BundleRequest);
  }

  private async fromBundle(
    sha: string,
    req: BundleRequest,
  ): Promise<Result<RepoFile[], BuildSourceError>> {
    const r = await this.reads.bundle(req);
    if (r.state !== 'ok')
      return err(buildSourceError('unavailable', 'the code host gave no bundle'));
    const bundle = (r as { value: { stream: Readable; dispose(): void } }).value;
    const dir = mkdtempSync(join(tmpdir(), 'aisdlc-bundle-'));
    try {
      await pipeline(bundle.stream, createWriteStream(join(dir, 'repo.bundle')));
      return await this.read(dir, sha);
    } catch (e) {
      return err(
        buildSourceError(
          'unavailable',
          `the bundle could not be read: ${(e as Error).message}`.slice(0, 200),
        ),
      );
    } finally {
      bundle.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  /** Reads the tree of `sha` out of `<dir>/repo.bundle`. Exposed for a test that builds its own bundle. */
  async read(dir: string, sha: string): Promise<Result<RepoFile[], BuildSourceError>> {
    const git = this.o.git ?? 'git';
    const env = {
      PATH: process.env['PATH'] ?? '/usr/bin:/bin',
      HOME: dir,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_TERMINAL_PROMPT: '0',
      GIT_ATTR_NOSYSTEM: '1',
      // the only transport a bundle needs; nothing the repo says can start another
      GIT_ALLOW_PROTOCOL: 'file',
      LC_ALL: 'C',
    };
    const g = join(dir, 'g.git');
    const base = [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'core.fsmonitor=false',
      '-c',
      'transfer.fsckObjects=true',
    ];
    const sh = (args: string[], input?: Buffer) => run(git, [...base, ...args], dir, env, input);
    if ((await sh(['init', '--bare', '-q', g])).code !== 0)
      return err(buildSourceError('unavailable', 'git init failed'));
    const f = await sh([
      '--git-dir',
      g,
      '-c',
      'protocol.file.allow=never',
      'fetch',
      '-q',
      join(dir, 'repo.bundle'),
      '+refs/*:refs/*',
    ]);
    if (f.code !== 0)
      return err(
        buildSourceError(
          'invalid',
          `the bundle did not unpack (${f.err.toString().slice(0, 120)})`,
        ),
      );
    const has = await sh(['--git-dir', g, 'cat-file', '-e', `${sha}^{commit}`]);
    if (has.code !== 0)
      return err(buildSourceError('not_found', 'the commit is not in the bundle'));
    const ls = await sh(['--git-dir', g, 'ls-tree', '-r', '-z', '--full-tree', '-l', sha]);
    if (ls.code !== 0) return err(buildSourceError('invalid', 'the tree could not be listed'));
    const entries: Array<{ mode: string; oid: string; size: number; path: string }> = [];
    for (const line of ls.out.toString('utf8').split('\0')) {
      if (line === '') continue;
      const m = /^(\d+) (blob|commit|tree) ([0-9a-f]{40})\s+(\d+|-)\t([\s\S]+)$/.exec(line);
      if (!m) return err(buildSourceError('invalid', 'an unreadable tree entry'));
      // a copy has regular files only: no symlink (120000), no submodule (commit), nothing else
      if (m[1] !== '100644' && m[1] !== '100755') continue;
      entries.push({
        mode: m[1] as string,
        oid: m[3] as string,
        size: Number(m[4]),
        path: m[5] as string,
      });
    }
    if (entries.length > MAX_REPO_FILES)
      return err(buildSourceError('invalid', 'the repo has too many files'));
    if (entries.reduce((n, e) => n + e.size, 0) > MAX_REPO_BYTES)
      return err(buildSourceError('invalid', 'the repo is too large'));
    // one cat-file --batch for every blob
    const cat = await run(
      git,
      [...base, '--git-dir', g, 'cat-file', '--batch'],
      dir,
      env,
      Buffer.from(entries.map((e) => `${e.oid}\n`).join('')),
    );
    if (cat.code !== 0) return err(buildSourceError('invalid', 'the blobs could not be read'));
    const files: RepoFile[] = [];
    let at = 0;
    for (const e of entries) {
      const nl = cat.out.indexOf(0x0a, at);
      const head = cat.out.subarray(at, nl).toString('utf8').split(' ');
      const size = Number(head[2]);
      if (head[0] !== e.oid || head[1] !== 'blob' || !Number.isFinite(size))
        return err(buildSourceError('invalid', 'the blob stream is out of step'));
      files.push({
        path: e.path,
        content: new Uint8Array(cat.out.subarray(nl + 1, nl + 1 + size)),
        ...(e.mode === '100755' ? { executable: true } : {}),
      });
      at = nl + 1 + size + 1;
    }
    return ok(files);
  }
}
