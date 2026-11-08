import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  type BundleManifest,
  type BundleRefs,
  type CodeHostNotOk,
  type GitSha,
  type RefEntry,
  type RepoFullName,
} from '@aisdlc/contracts';
import type { BundleResult } from '@aisdlc/ports';
import type { Git } from './git.js';
import { ScanFailure, firstLine } from './git.js';

// Bundle intake (PLAN M6.1; OB §6.5 "Bytes flow" step 3): the codehost's credential-free bundle is
// downloaded under a size cap, verified, and unpacked into a hardened bare mirror in the job's
// private directory. A bundle that fails any check is REFUSED (the job ends in `error`, saying why):
// nothing is partly accepted.

/** The bundle was refused. `reason` is for the job's `error`; it never carries repo content. */
export class IntakeRefused extends Error {
  override readonly name = 'IntakeRefused';
  constructor(
    readonly code:
      | 'source_not_ok'
      | 'too_large'
      | 'manifest_mismatch'
      | 'bundle_invalid'
      | 'head_mismatch'
      | 'refs_mismatch'
      | 'malformed_object'
      | 'timeout',
    message: string,
  ) {
    super(message);
  }
}

export interface IntakeRequest {
  readonly repo: RepoFullName;
  readonly refs: BundleRefs;
  readonly base_sha?: GitSha | undefined;
}

export interface Download {
  readonly bytes: number;
  readonly sha256: string;
}

/**
 * Streams the bundle to `file` while counting: the cap is enforced as bytes arrive (an overflow
 * stops the stream and refuses, it never truncates), and a sha256 is taken for the job's outputs.
 */
export async function downloadBundle(
  bundle: BundleResult,
  file: string,
  capBytes: number,
  signal: AbortSignal,
): Promise<Download> {
  const hash = createHash('sha256');
  let bytes = 0;
  const meter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > capBytes) {
        return cb(new IntakeRefused('too_large', `the bundle is over the ${capBytes}-byte cap`));
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });
  try {
    await pipeline(bundle.stream, meter, createWriteStream(file, { flags: 'wx', mode: 0o600 }), {
      signal,
    });
  } catch (e) {
    if (e instanceof IntakeRefused) throw e;
    if (signal.aborted) throw new IntakeRefused('timeout', 'the job time cap was reached');
    throw new IntakeRefused('source_not_ok', 'the bundle stream failed');
  } finally {
    bundle.dispose();
  }
  return { bytes, sha256: hash.digest('hex') };
}

export interface Mirror {
  /** The bare repository (`--git-dir`). */
  readonly dir: string;
  readonly base_sha: GitSha;
  readonly refs: readonly RefEntry[];
}

const REF_LINE = /^([0-9a-f]{40}) (\S+)$/;

/** `git bundle list-heads` as {name -> sha}, HEAD included. */
function parseHeads(text: string): Map<string, string> | null {
  const out = new Map<string, string>();
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const m = REF_LINE.exec(line.trim());
    if (!m) return null;
    out.set(m[2] as string, m[1] as string);
  }
  return out;
}

/**
 * Verifies the bundle and unpacks it into a bare mirror:
 *   - `git bundle verify` (complete history, valid format);
 *   - the bundle's HEAD is the manifest's `head_sha` (= `X-Base-Sha`) and is one of its refs;
 *   - the manifest's `ref_count` is the bundle's refs and `commit_count` is what the mirror holds;
 *   - `git fetch` from the bundle file with `transfer.fsckObjects=true` (a malformed object refuses
 *     the bundle), no checkout, no hooks, no tags auto-follow, no submodule recursion;
 *   - the refs now in the mirror are exactly the refs the bundle listed.
 */
export async function buildMirror(
  git: Git,
  jobDir: string,
  bundleFile: string,
  manifest: BundleManifest,
  download: Download,
): Promise<Mirror> {
  const dir = join(jobDir, 'mirror.git');
  await mkdir(dir, { mode: 0o700 });
  await git.must('init', ['init', '--bare', '--quiet', dir]);

  const verify = await git.run(['bundle', 'verify', bundleFile], { gitDir: dir });
  if (verify.code !== 0) {
    throw new IntakeRefused(
      'bundle_invalid',
      `git bundle verify failed: ${firstLine(verify.stderr)}`,
    );
  }
  const heads = parseHeads(
    (
      await git.must('list-heads', ['bundle', 'list-heads', bundleFile], { gitDir: dir })
    ).stdout.toString('utf8'),
  );
  if (heads === null)
    throw new IntakeRefused('bundle_invalid', 'the bundle lists refs in a shape git does not use');
  const headSha = heads.get('HEAD');
  if (headSha === undefined) throw new IntakeRefused('head_mismatch', 'the bundle has no HEAD');
  if (headSha !== manifest.head_sha) {
    throw new IntakeRefused(
      'head_mismatch',
      'the head in the bundle is not the base sha the codehost reported',
    );
  }
  const named = [...heads].filter(([n]) => n !== 'HEAD');
  if (named.some(([n]) => !n.startsWith('refs/'))) {
    throw new IntakeRefused('bundle_invalid', 'the bundle holds a ref outside refs/');
  }
  if (!named.some(([n, sha]) => n.startsWith('refs/heads/') && sha === headSha)) {
    throw new IntakeRefused('head_mismatch', 'the bundle HEAD is not the tip of any branch in it');
  }
  if (named.length !== manifest.ref_count) {
    throw new IntakeRefused(
      'manifest_mismatch',
      `the manifest says ${manifest.ref_count} refs, the bundle has ${named.length}`,
    );
  }
  if (manifest.bytes !== download.bytes) {
    throw new IntakeRefused(
      'manifest_mismatch',
      `the manifest says ${manifest.bytes} bytes, ${download.bytes} arrived`,
    );
  }
  if (manifest.refs_covered === 'default_only' && named.length !== 1) {
    throw new IntakeRefused(
      'manifest_mismatch',
      'default_only coverage, but the bundle holds more than one ref',
    );
  }

  const fetch = await git.run(
    [
      'fetch',
      '--quiet',
      '--no-tags',
      '--no-write-fetch-head',
      '--no-auto-gc',
      '--no-recurse-submodules',
      '--',
      bundleFile,
      '+refs/*:refs/*',
    ],
    { gitDir: dir, allowFile: true },
  );
  if (fetch.code !== 0) {
    const bad = /fsck|malformed|bad object|invalid|broken|zero-padded|duplicate/i.test(
      fetch.stderr,
    );
    throw new IntakeRefused(
      bad ? 'malformed_object' : 'bundle_invalid',
      `git fetch from the bundle failed: ${firstLine(fetch.stderr)}`,
    );
  }

  // `git fetch` from a bundle does not check the objects it unpacks, whatever transfer.fsckObjects
  // says, so the mirror is checked as a whole: every object's hash, its shape, and connectivity.
  // A malformed or missing object refuses the bundle.
  const fsck = await git.run(['fsck', '--strict', '--no-dangling', '--no-progress'], {
    gitDir: dir,
  });
  if (fsck.code !== 0) {
    throw new IntakeRefused('malformed_object', `git fsck failed: ${firstLine(fsck.stderr)}`);
  }

  const listed = await git.must(
    'for-each-ref',
    ['for-each-ref', '--format=%(objectname) %(refname)'],
    { gitDir: dir },
  );
  const refs: RefEntry[] = [];
  for (const line of listed.stdout.toString('utf8').split('\n')) {
    if (line === '') continue;
    const m = REF_LINE.exec(line);
    if (!m)
      throw new ScanFailure('parse_failed', 'git for-each-ref gave a line of an unexpected shape');
    refs.push({ name: m[2] as string, sha: m[1] as GitSha });
  }
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const same = refs.length === named.length && refs.every((r) => heads.get(r.name) === r.sha);
  if (!same)
    throw new IntakeRefused(
      'refs_mismatch',
      'the refs in the mirror are not the refs the bundle listed',
    );

  const count = await git.must('rev-list', ['rev-list', '--count', '--all'], { gitDir: dir });
  if (Number(count.stdout.toString('utf8').trim()) !== manifest.commit_count) {
    throw new IntakeRefused(
      'manifest_mismatch',
      'the manifest commit_count is not the number of commits in the bundle',
    );
  }
  const tip = await git.run(['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`], {
    gitDir: dir,
  });
  if (tip.code !== 0)
    throw new IntakeRefused('head_mismatch', 'the base sha is not a commit in the bundle');

  return { dir, base_sha: headSha as GitSha, refs };
}

export interface HeadEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
  readonly size: number | null;
  readonly path: string;
}

/** `git ls-tree -r -z --long <commit>`: the head tree, never checked out. */
export async function readHeadTree(git: Git, mirror: Mirror): Promise<HeadEntry[]> {
  const r = await git.must('ls-tree', ['ls-tree', '-r', '-z', '--long', mirror.base_sha], {
    gitDir: mirror.dir,
  });
  const out: HeadEntry[] = [];
  for (const rec of r.stdout.toString('utf8').split('\0')) {
    if (rec === '') continue;
    const tab = rec.indexOf('\t');
    const m = /^(\d{6}) (blob|tree|commit) ([0-9a-f]{40}) +(\d+|-)$/.exec(rec.slice(0, tab));
    if (tab === -1 || !m)
      throw new ScanFailure('parse_failed', 'git ls-tree gave a record of an unexpected shape');
    out.push({
      mode: m[1] as string,
      type: m[2] as string,
      sha: m[3] as string,
      size: m[4] === '-' ? null : Number(m[4]),
      path: rec.slice(tab + 1),
    });
  }
  return out;
}

/** The refusal of a source that did not give a bundle. */
export const sourceRefusal = (r: CodeHostNotOk): IntakeRefused =>
  new IntakeRefused('source_not_ok', `the codehost did not give a bundle: ${r.reason}`);
