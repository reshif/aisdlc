import type { CoverageItem, GitSha, ScanCoverage, ScanError, ScanStatus } from '@aisdlc/contracts';
import { MAX_COVERAGE_ITEMS } from '@aisdlc/contracts';
import { RULES, scanText, type SecretRule } from '@aisdlc/secrets-rules';
import type { Fingerprinter } from './fingerprint.js';
import type { Git } from './git.js';
import { CatFile, NulSplitter, ScanFailure, firstLine, type CatResult } from './git.js';
import type { HeadEntry, Mirror } from './intake.js';

// The secret scan (PLAN M6.2; OB §5.3 items 1, 2, 4, 5): full history over every ref in the mirror
// plus the head tree, every blob once (deduplicated by blob id), through the one shared ruleset.
//
// FAIL CLOSED. Any git failure, parse error, unreadable object, timeout or fingerprint failure is
// `scan_status: error`; hitting the commit cap is `cap_reached` and `truncated`. The result is
// never an empty finding list standing in for "could not look". A value is redacted at the moment
// it is matched: only its HMAC leaves this function. Nothing is ever verified against a provider.

export interface ScanOptions {
  readonly commitCap: number;
  readonly maxFileBytes: number;
  readonly rules?: readonly SecretRule[];
  readonly rulesVersion: string;
  /** Blobs read in parallel through the pipelined cat-file. */
  readonly concurrency?: number;
}

export interface ScannedLocation {
  readonly blob_id: GitSha;
  readonly paths: string[];
  readonly line: number;
  readonly first_commit: GitSha | null;
}

/** A finding as the scan hands it on: a fingerprint, never a value. */
export interface ScannedFinding {
  readonly rule_id: string;
  readonly fingerprint: string;
  readonly first_commit: GitSha | null;
  readonly locations: ScannedLocation[];
}

export interface ScanOutcome {
  readonly status: ScanStatus;
  readonly error: ScanError | null;
  readonly coverage: ScanCoverage;
  readonly items: CoverageItem[];
  /** Counts by kind of every coverage item, listed or not. */
  readonly counts: Record<string, number>;
  readonly findings: ScannedFinding[];
}

interface BlobInfo {
  readonly id: string;
  readonly paths: string[];
  firstCommit: string | null;
  /** Position of the first commit in scan order (oldest first); Infinity when no commit holds it. */
  firstIndex: number;
  /**
   * Named only by `rev-list --objects` (which also lists commits and trees whatever the filter):
   * it is checked to be a blob and skipped if it is not. Blobs from the head tree and from the
   * commit walk are certain: another type there is a parse error.
   */
  candidate: boolean;
}

interface Candidate {
  readonly rule_id: string;
  readonly blob: BlobInfo;
  readonly line: number;
  readonly value: Buffer;
}

const MAX_PATHS = 5;
const MAX_LOCATIONS = 1000;
const LFS_POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:[0-9a-f]{64}\r?\nsize \d+\r?\n?/;
const LFS_MAX_BYTES = 1024;
const MAIN_META = /^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([A-Z])\d*$/;
const ZEROS = '0'.repeat(40);

function addPath(b: BlobInfo, path: string): void {
  if (b.paths.length < MAX_PATHS && !b.paths.includes(path)) b.paths.push(path);
}

/** Runs `fn` over `items` with at most `n` in flight; the first failure stops the rest. */
async function pool<T>(
  items: readonly T[],
  n: number,
  signal: AbortSignal,
  fn: (t: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  let failed: unknown = null;
  const worker = async (): Promise<void> => {
    while (failed === null && i < items.length) {
      if (signal.aborted) throw new ScanFailure('timeout', 'the job time cap was reached');
      const item = items[i++] as T;
      try {
        await fn(item);
      } catch (e) {
        failed ??= e;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  if (failed !== null) throw failed;
}

export async function scanMirror(
  git: Git,
  mirror: Mirror,
  headTree: readonly HeadEntry[],
  refsCovered: ScanCoverage['refs_covered'],
  fingerprinter: Fingerprinter,
  opts: ScanOptions,
  signal: AbortSignal,
): Promise<ScanOutcome> {
  const rules = opts.rules ?? RULES;
  const blobs = new Map<string, BlobInfo>();
  const submodules = new Map<string, CoverageItem>();
  const items = new Map<string, CoverageItem>();
  const candidates: Candidate[] = [];
  let commitsScanned = 0;
  let blobsScanned = 0;
  let capReached = false;
  let incomplete = false;
  let error: ScanError | null = null;
  let findings: ScannedFinding[] = [];

  const addItem = (i: CoverageItem): void => {
    items.set(`${i.kind}\0${i.object ?? ''}\0${i.path ?? ''}`, i);
  };
  const touch = (
    id: string,
    path: string,
    commit: string | null,
    index: number,
    candidate = false,
  ): void => {
    let b = blobs.get(id);
    if (!b) {
      b = { id, paths: [], firstCommit: null, firstIndex: Number.POSITIVE_INFINITY, candidate };
      blobs.set(id, b);
    }
    if (!candidate) b.candidate = false;
    addPath(b, path);
    if (commit !== null && b.firstCommit === null) {
      b.firstCommit = commit;
      b.firstIndex = index;
    }
  };
  const addSubmodule = (path: string, sha: string): void => {
    submodules.set(`${path}\0${sha}`, {
      kind: 'submodule',
      path,
      object: /^[0-9a-f]{40}$/.test(sha) ? (sha as GitSha) : null,
      reason: 'submodule entry listed, its content is another repository and is not scanned',
    });
  };

  const cats: CatFile[] = [];
  try {
    // 1. The head tree: every blob at the head is scanned even if the commit walk is cut short.
    for (const e of headTree) {
      if (e.type === 'commit' || e.mode === '160000') addSubmodule(e.path, e.sha);
      else if (e.type === 'blob') touch(e.sha, e.path, null, Number.POSITIVE_INFINITY);
    }

    // 2. History over every ref, oldest first: the first commit that holds each blob.
    const log = git.start(
      [
        'log',
        '--all',
        '--reverse',
        '--topo-order',
        '-m',
        '--root',
        '--raw',
        '--no-abbrev',
        '--no-renames',
        '--no-textconv',
        '--no-ext-diff',
        '-z',
        `--max-count=${opts.commitCap + 1}`,
        '--format=%x01%H',
      ],
      { gitDir: mirror.dir },
    );
    log.stdin?.end();
    let logErr = '';
    log.stderr?.on('data', (b: Buffer) => {
      if (logErr.length < 8192) logErr += b.toString('utf8');
    });
    let current: { sha: string; index: number } | null = null;
    let meta: { newMode: string; newSha: string; status: string } | null = null;
    let parseError: string | null = null;
    let commitNo = 0;
    const split = new NulSplitter();
    const onToken = (raw: Buffer): void => {
      if (parseError !== null) return;
      const t = raw.toString('utf8').replace(/^\n+/, '');
      if (t === '') return;
      if (t.startsWith('\u0001')) {
        const sha = t.slice(1).trim();
        if (!/^[0-9a-f]{40}$/.test(sha) || meta !== null) {
          parseError = 'git log gave a commit header of an unexpected shape';
          return;
        }
        commitNo++;
        if (commitNo > opts.commitCap) {
          capReached = true;
          current = null;
          return;
        }
        current = { sha, index: commitNo - 1 };
        commitsScanned = commitNo;
        return;
      }
      if (t.startsWith(':')) {
        const m = MAIN_META.exec(t);
        if (!m || meta !== null) {
          parseError = 'git log gave a change record of an unexpected shape';
          return;
        }
        meta = { newMode: m[2] as string, newSha: m[4] as string, status: m[5] as string };
        return;
      }
      // A path token, belonging to the record before it.
      if (meta === null) {
        parseError = 'git log gave a path with no change record';
        return;
      }
      const m = meta;
      meta = null;
      if (current === null || m.status === 'D' || m.newSha === ZEROS) return;
      if (m.newMode === '160000') addSubmodule(t, m.newSha);
      else touch(m.newSha, t, current.sha, current.index);
    };
    const logDone = new Promise<number>((resolve, reject) => {
      log.stdout?.on('data', (b: Buffer) => split.push(b, onToken));
      log.once('error', () => reject(new ScanFailure('git_failed', 'git could not be run')));
      log.once('close', (code) => resolve(code ?? -1));
    });
    const code = await logDone;
    if (signal.aborted) throw new ScanFailure('timeout', 'the job time cap was reached');
    if (code !== 0)
      throw new ScanFailure('git_failed', `git log exited ${code}: ${firstLine(logErr)}`);
    if (parseError !== null) throw new ScanFailure('parse_failed', parseError);
    if (split.rest().toString('utf8').trim() !== '' || meta !== null) {
      throw new ScanFailure('parse_failed', 'git log ended in the middle of a record');
    }
    if (capReached) {
      incomplete = true;
      addItem({
        kind: 'commit_cap',
        path: null,
        object: null,
        reason: `history has more than ${opts.commitCap} commits: the newest ${opts.commitCap} were scanned, the older ones were not`,
      });
    }

    // 3. Everything else reachable from a ref (a tag on a blob, a merge's hidden entries): complete
    //    only when the commit walk was; a capped walk must not read all of history.
    if (!capReached) {
      const objs = await git.must(
        'rev-list',
        ['rev-list', '--objects', '--all', '--filter=object:type=blob'],
        { gitDir: mirror.dir },
      );
      for (const line of objs.stdout.toString('utf8').split('\n')) {
        if (line === '') continue;
        const sp = line.indexOf(' ');
        const id = sp === -1 ? line : line.slice(0, sp);
        if (!/^[0-9a-f]{40}$/.test(id))
          throw new ScanFailure(
            'parse_failed',
            'git rev-list gave an object line of an unexpected shape',
          );
        if (!blobs.has(id))
          touch(
            id,
            sp === -1 ? `(unnamed ${id.slice(0, 12)})` : line.slice(sp + 1),
            null,
            Number.POSITIVE_INFINITY,
            true,
          );
      }
    }

    // 4. Read every blob once: size first (an oversize file is a coverage item, not a skip), then
    //    the content, then the rules.
    const check = new CatFile(git, mirror.dir, 'batch-check');
    const read = new CatFile(git, mirror.dir, 'batch');
    cats.push(check, read);
    const all = [...blobs.values()];
    await pool(all, opts.concurrency ?? 64, signal, async (b) => {
      const info: CatResult = await check.request(b.id);
      if (info.missing)
        throw new ScanFailure(
          'unreadable_object',
          'an object reachable from a ref is missing',
          b.id,
        );
      if (info.type !== 'blob' && b.candidate) return;
      if (info.type !== 'blob')
        throw new ScanFailure('parse_failed', 'a blob id names another kind of object', b.id);
      if (info.missing === false && info.size > opts.maxFileBytes) {
        addItem({
          kind: 'file_over_cap',
          path: b.paths[0] ?? null,
          object: b.id as GitSha,
          reason: `${info.size} bytes is over the per-file cap of ${opts.maxFileBytes}: not scanned`,
        });
        return;
      }
      const got = await read.request(b.id);
      if (got.missing || got.content === null)
        throw new ScanFailure('unreadable_object', 'an object could not be read', b.id);
      const content = got.content;
      if (content.length <= LFS_MAX_BYTES && LFS_POINTER.test(content.toString('latin1'))) {
        addItem({
          kind: 'lfs_pointer',
          path: b.paths[0] ?? null,
          object: b.id as GitSha,
          reason: 'Git LFS pointer: the object it names is not in the bundle and is not scanned',
        });
        return;
      }
      blobsScanned++;
      // latin1 maps each byte to one character, so offsets, lines and values stay byte-exact.
      for (const m of scanText(content.toString('latin1'), rules)) {
        candidates.push({
          rule_id: m.rule_id,
          blob: b,
          line: m.line,
          value: Buffer.from(m.value, 'latin1'),
        });
      }
    });
  } catch (e) {
    incomplete = true;
    const f =
      e instanceof ScanFailure
        ? e
        : signal.aborted
          ? new ScanFailure('timeout', 'the job time cap was reached')
          : new ScanFailure('git_failed', 'the scan failed');
    error = { code: f.code, message: f.message.slice(0, 500) };
    if (f.code === 'timeout') {
      addItem({
        kind: 'time_cap',
        path: null,
        object: null,
        reason: 'the job time cap was reached: the scan is incomplete',
      });
    } else if (f.code === 'unreadable_object') {
      const b = f.object === null ? undefined : blobs.get(f.object);
      addItem({
        kind: 'unreadable_object',
        path: b?.paths[0] ?? null,
        object: f.object !== null && /^[0-9a-f]{40}$/.test(f.object) ? (f.object as GitSha) : null,
        reason: 'git could not read this object: the scan is incomplete',
      });
    }
  } finally {
    await Promise.all(cats.map((c) => c.close()));
  }

  // 5. Fingerprints, one batch of calls to kms-local. Whatever was found before a failure is still
  //    reported, unless a fingerprint cannot be made (then it cannot be reported at all).
  if (candidates.length > 0) {
    try {
      const macs = await fingerprinter.fingerprints(candidates.map((c) => c.value));
      const byKey = new Map<string, ScannedFinding & { locations: ScannedLocation[] }>();
      const seen = new Set<string>();
      candidates.forEach((c, i) => {
        const fingerprint = macs[i] as string;
        const key = `${c.rule_id}\0${fingerprint}`;
        let f = byKey.get(key);
        if (!f) {
          f = { rule_id: c.rule_id, fingerprint, first_commit: null, locations: [] };
          byKey.set(key, f);
        }
        const lk = `${key}\0${c.blob.id}\0${c.line}`;
        if (seen.has(lk) || f.locations.length >= MAX_LOCATIONS) return;
        seen.add(lk);
        f.locations.push({
          blob_id: c.blob.id as GitSha,
          paths: [...c.blob.paths],
          line: c.line,
          first_commit: (c.blob.firstCommit as GitSha | null) ?? null,
        });
      });
      findings = [...byKey.values()]
        .map((f) => {
          const firsts = f.locations
            .map((l) => ({ l, idx: blobs.get(l.blob_id)?.firstIndex ?? Number.POSITIVE_INFINITY }))
            .filter((x) => x.l.first_commit !== null)
            .sort((a, b) => a.idx - b.idx);
          return { ...f, first_commit: firsts[0]?.l.first_commit ?? null };
        })
        .sort((a, b) => (a.rule_id + a.fingerprint < b.rule_id + b.fingerprint ? -1 : 1));
    } catch (e) {
      incomplete = true;
      const f =
        e instanceof ScanFailure
          ? e
          : new ScanFailure('fingerprint_unavailable', 'fingerprints could not be made');
      error ??= { code: f.code, message: f.message.slice(0, 500) };
      findings = [];
    }
  }

  for (const s of submodules.values()) addItem(s);
  const list = [...items.values()].sort((a, b) =>
    `${a.kind}\0${a.path ?? ''}\0${a.object ?? ''}` <
    `${b.kind}\0${b.path ?? ''}\0${b.object ?? ''}`
      ? -1
      : 1,
  );
  const counts: Record<string, number> = {};
  for (const i of list) counts[i.kind] = (counts[i.kind] ?? 0) + 1;
  let listed = list;
  if (list.length > MAX_COVERAGE_ITEMS) {
    listed = [
      ...list.slice(0, MAX_COVERAGE_ITEMS - 1),
      {
        kind: 'list_truncated',
        path: null,
        object: null,
        reason: `${list.length - (MAX_COVERAGE_ITEMS - 1)} more coverage items exist; counts are complete`,
      },
    ];
    counts['list_truncated'] = 1;
  }

  return {
    status: error === null ? 'ok' : 'error',
    error,
    coverage: {
      refs_covered: refsCovered,
      ref_count: mirror.refs.length,
      commits_scanned: commitsScanned,
      blobs_scanned: blobsScanned,
      truncated: incomplete,
      cap_reached: capReached,
      lfs_unscanned: counts['lfs_pointer'] ?? 0,
      submodules_listed: counts['submodule'] ?? 0,
      rules_version: opts.rulesVersion,
    },
    items: listed,
    counts,
    findings,
  };
}
