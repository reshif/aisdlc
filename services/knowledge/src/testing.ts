import { execFileSync } from 'node:child_process';
import {
  createReadStream,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { git, gitEnv } from '@aisdlc/codehost/testing';
import {
  type BundleManifest,
  type BundleRequest,
  type CodeHostRead,
  type GitSha,
  type KnowledgeJob,
} from '@aisdlc/contracts';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { readOk, type BundleResult } from '@aisdlc/ports';
import { migrateRecord } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { createKnowledgeApp, type KnowledgeScope } from './app.js';
import { kmsFingerprinter } from './fingerprint.js';
import type { BundleSource } from './http-bundle.js';
import { migrateKnowledge } from './migrations.js';
import { FakeDecisionVerifier } from './decision-ref.js';
import { FakePrincipalDirectory } from './principals.js';
import { JobRunner, type RunnerOptions } from './runner.js';
import { getJob } from './store.js';
import { Readable } from 'node:stream';
import { Git } from './git.js';
import type { Mirror } from './intake.js';
import { readHeadTree } from './intake.js';
import {
  GitTreeReader,
  buildDetectors,
  defaultBranchOf,
  runDetectors,
  type DetectorOptions,
  type DetectorRun,
} from './detectors/index.js';

// Test infrastructure for knowledge: fixture repositories built with real git, real bundles of them,
// a bundle source that serves a file, and a full stack (real Postgres, real kms-local, the real
// runner and HTTP app). The only fakes are behind ports (the bundle source, the principal directory).

export { git, gitEnv };

/** A working repository built with real git. Every commit has a fixed identity and date. */
export class FixtureRepo {
  readonly dir: string;
  private n = 0;
  private readonly gitlinks = new Map<string, string>();

  constructor(
    readonly root: string,
    name = 'repo',
    readonly defaultBranch = 'main',
  ) {
    this.dir = join(root, name);
    mkdirSync(this.dir, { recursive: true });
    git(this.dir, 'init', '--quiet', `--initial-branch=${defaultBranch}`);
    git(this.dir, 'config', 'core.hooksPath', '/dev/null');
  }

  git(...args: string[]): string {
    return git(this.dir, ...args);
  }

  write(rel: string, content: string | Buffer): this {
    const p = join(this.dir, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, content);
    return this;
  }

  remove(rel: string): this {
    this.git('rm', '--quiet', '-f', rel);
    return this;
  }

  /** `git add -A` and commit; returns the commit id. Dates advance one minute per commit. */
  commit(message: string): GitSha {
    this.n += 1;
    const date = new Date(Date.UTC(2026, 0, 1, 0, this.n)).toISOString();
    execFileSync('git', ['add', '-A'], { cwd: this.dir, env: gitEnv() });
    // `add -A` drops a gitlink with no checkout behind it, so the entries are put back each time.
    for (const [path, sha] of this.gitlinks) {
      this.git('update-index', '--add', '--cacheinfo', `160000,${sha},${path}`);
    }
    execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', message], {
      cwd: this.dir,
      env: gitEnv({ GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date }),
    });
    return this.head();
  }

  head(): GitSha {
    return this.git('rev-parse', 'HEAD') as GitSha;
  }

  checkout(branch: string, create = false): this {
    this.git('checkout', '--quiet', ...(create ? ['-b'] : []), branch);
    return this;
  }

  tag(name: string): this {
    this.git('tag', name);
    return this;
  }

  /** A gitlink (submodule) entry at `path` pointing at a commit that is not in this repository. */
  addSubmodule(path: string, sha = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'): this {
    this.gitlinks.set(path, sha);
    return this;
  }

  /**
   * `git bundle create` of the refs the codehost would put in it, and the manifest it would send
   * (`head_sha` is the default branch's head, `ref_count` the refs in the bundle without HEAD).
   */
  bundle(
    file: string,
    refs: 'all' | 'default_only' = 'all',
  ): { file: string; manifest: BundleManifest } {
    const revs =
      refs === 'all'
        ? ['HEAD', '--branches', '--tags', '--glob=refs/pull/*/head']
        : ['HEAD', `refs/heads/${this.defaultBranch}`];
    mkdirSync(dirname(file), { recursive: true });
    this.git('bundle', 'create', file, ...revs);
    const heads = this.git('bundle', 'list-heads', file)
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.endsWith(' HEAD'));
    return {
      file,
      manifest: {
        repo: 'acme/app',
        head_sha: this.head(),
        refs_covered: refs,
        ref_count: heads.length,
        commit_count: Number(this.git('rev-list', '--count', ...revs)),
        bytes: statSync(file).size,
        duration_ms: 1,
      },
    };
  }
}

/** A directory that is removed with `dispose`. */
export function scratchDir(prefix = 'aisdlc-knowledge-test-'): { dir: string; dispose(): void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, dispose: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A `BundleSource` that serves a bundle file and a manifest, which a test can make lie. */
export class FileBundleSource implements BundleSource {
  readonly requests: BundleRequest[] = [];
  constructor(
    public file: string,
    public manifest: BundleManifest,
  ) {}

  set(file: string, manifest: BundleManifest): this {
    this.file = file;
    this.manifest = manifest;
    return this;
  }

  async bundle(req: BundleRequest): Promise<CodeHostRead<BundleResult>> {
    this.requests.push(req);
    const stream = Readable.from(createReadStream(this.file));
    return readOk({ manifest: this.manifest, stream, dispose: () => void stream.destroy() });
  }
}

export interface KnowledgeStack {
  readonly db: TestDatabase;
  readonly kms: TestKms;
  readonly runner: JobRunner;
  readonly app: FastifyInstance;
  readonly url: string;
  readonly source: FileBundleSource;
  readonly principals: FakePrincipalDirectory;
  /** What the state API asks of the ledger: accepts every reference unless a test says otherwise. */
  readonly decisions: FakeDecisionVerifier;
  readonly workRoot: string;
  readonly tokens: { census: string; security: string; both: string; none: string };
  call(
    token: string | null,
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
  ): Promise<{ status: number; text: string; json: unknown }>;
  /** Starts a census-intake job through the runner and waits for it to finish. */
  runJob(refs?: 'all' | 'default_only'): Promise<KnowledgeJob>;
  stop(): Promise<void>;
}

export interface StackOptions extends Partial<
  Omit<RunnerOptions, 'pool' | 'source' | 'fingerprinter'>
> {
  readonly source: FileBundleSource;
}

export async function startKnowledgeStack(opts: StackOptions): Promise<KnowledgeStack> {
  const kms = await startTestKms();
  const db = await createTestDatabase();
  const scratch = scratchDir('aisdlc-knowledge-stack-');
  const workRoot = join(scratch.dir, 'work');
  try {
    await migrateRecord(db.pool);
    await migrateKnowledge(db.pool);
    const { source, ...rest } = opts;
    const runner = new JobRunner({
      pool: db.pool,
      source,
      fingerprinter: kmsFingerprinter(kms.custodyFor('knowledge')),
      workRoot,
      log: (l) => {
        if (process.env['KNOWLEDGE_TEST_LOG']) console.log(l);
      },
      ...rest,
    });
    const principals = new FakePrincipalDirectory();
    const decisions = new FakeDecisionVerifier();
    const tokens = {
      census: 'census-token-'.padEnd(32, 'x'),
      security: 'security-token-'.padEnd(32, 'x'),
      both: 'both-token-'.padEnd(32, 'x'),
      none: 'none-token-'.padEnd(32, 'x'),
    };
    const callers: Record<string, readonly KnowledgeScope[]> = {
      census: ['census'],
      security: ['security'],
      both: ['census', 'security'],
      none: [],
    };
    const app = createKnowledgeApp({
      pool: db.pool,
      auth: new ServiceAuth(tokens),
      callers,
      runner,
      principals,
      decisions,
    });
    const url = await listen(app);
    const call: KnowledgeStack['call'] = async (token, method, path, body) => {
      const res = await fetch(new URL(path, url), {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text === '' ? null : JSON.parse(text);
      } catch {
        /* not JSON */
      }
      return { status: res.status, text, json };
    };
    return {
      db,
      kms,
      runner,
      app,
      url,
      source,
      principals,
      decisions,
      workRoot,
      tokens,
      call,
      async runJob(refs = 'all') {
        const r = await runner.start({ repo: 'acme/app', refs });
        if (!r.ok) throw new Error(r.error.message);
        await runner.idle();
        const job = await getJob(db.pool, r.value.job_id);
        if (!job) throw new Error('job vanished');
        return job;
      },
      async stop() {
        await app.close();
        await runner.idle();
        await db.drop();
        await kms.stop();
        scratch.dispose();
      },
    };
  } catch (e) {
    await db.drop().catch(() => undefined);
    await kms.stop().catch(() => undefined);
    scratch.dispose();
    throw e;
  }
}

/** The HMAC key kms-local holds, read from its key directory, for tests that check a fingerprint independently. */
export function kmsHmacKeyOf(kms: TestKms): Buffer {
  const j = JSON.parse(readFileSync(join(kms.dir, 'dev_fingerprint-hmac.key.json'), 'utf8')) as {
    k: string;
  };
  return Buffer.from(j.k, 'base64url');
}

export interface OpenedFixture {
  readonly reader: GitTreeReader;
  readonly git: Git;
  readonly mirror: Mirror;
  dispose(): Promise<void>;
}

/**
 * A fixture repository fetched into a hardened bare mirror through the same git runner the service
 * uses, and a tree reader over its head: what a detector sees in a job, without the bundle and the
 * database. `dispose` closes the object readers and removes the mirror.
 */
export async function openFixture(
  repo: FixtureRepo,
  opts: { maxFileBytes?: number } = {},
): Promise<OpenedFixture> {
  const scratch = scratchDir('aisdlc-knowledge-fixture-');
  const home = join(scratch.dir, 'home');
  mkdirSync(home);
  const ac = new AbortController();
  const g = new Git({ home, signal: ac.signal });
  const dir = join(scratch.dir, 'mirror.git');
  mkdirSync(dir);
  await g.must('init', ['init', '--bare', '--quiet', dir]);
  await g.must(
    'fetch',
    ['fetch', '--quiet', '--no-tags', '--', repo.dir, '+refs/heads/*:refs/heads/*'],
    { gitDir: dir, allowFile: true },
  );
  const head = repo.head();
  const mirror: Mirror = {
    dir,
    base_sha: head,
    refs: [{ name: `refs/heads/${repo.defaultBranch}`, sha: head }],
  };
  const tree = await readHeadTree(g, mirror);
  const reader = new GitTreeReader(
    g,
    mirror,
    tree,
    opts.maxFileBytes ?? 5 * 1024 * 1024,
    defaultBranchOf(mirror),
  );
  return {
    reader,
    git: g,
    mirror,
    async dispose() {
      await reader.close();
      g.killAll();
      scratch.dispose();
    },
  };
}

/** Commits nothing: runs the whole detector set over a fixture repository's head. */
export async function detect(
  repo: FixtureRepo,
  opts: DetectorOptions & { maxFileBytes?: number } = {},
): Promise<DetectorRun> {
  const f = await openFixture(
    repo,
    opts.maxFileBytes === undefined ? {} : { maxFileBytes: opts.maxFileBytes },
  );
  try {
    return await runDetectors(f.reader, buildDetectors(opts));
  } finally {
    await f.dispose();
  }
}
