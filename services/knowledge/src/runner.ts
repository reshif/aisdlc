import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  KNOWLEDGE_DEFAULTS,
  type CoverageKind,
  type KnowledgeJob,
  type KnowledgeJobId,
  type StartCensusIntakeRequest,
} from '@aisdlc/contracts';
import { BUNDLE_DEFAULT_CAP_BYTES, type CensusAttestations, type Level } from '@aisdlc/contracts';
import { CATALOGUE, type CatalogueData } from '@aisdlc/catalogue';
import { assembleCensus } from './census/index.js';
import { systemClock, type Result } from '@aisdlc/kernel';
import { rulesVersion, RULES, type SecretRule } from '@aisdlc/secrets-rules';
import type { KnowledgeError } from './errors.js';
import type { Fingerprinter } from './fingerprint.js';
import { Git, ScanFailure } from './git.js';
import type { BundleSource } from './http-bundle.js';
import {
  IntakeRefused,
  buildMirror,
  downloadBundle,
  readHeadTree,
  sourceRefusal,
} from './intake.js';
import { mergeCoverage } from './coverage.js';
import {
  GitTreeReader,
  buildDetectors,
  defaultBranchOf,
  runDetectors,
  type DetectorRun,
} from './detectors/index.js';
import { indexRepo } from './search.js';
import { scanMirror } from './scan.js';
import { enqueueJob, failJob, finishJob, markRunning, type StoreDeps } from './store.js';

export interface RunnerOptions extends StoreDeps {
  readonly source: BundleSource;
  readonly fingerprinter: Fingerprinter;
  /** Where job workspaces are made (mode 0700). Default `<tmp>/aisdlc-knowledge`. */
  readonly workRoot?: string;
  readonly gitBin?: string;
  readonly bundleCapBytes?: number;
  readonly maxFileBytes?: number;
  readonly commitCap?: number;
  readonly jobTimeoutMs?: number;
  readonly maxConcurrent?: number;
  readonly rules?: readonly SecretRule[];
  /** Hosts a doc may link to without a content-lint finding (default: the repo host, loopback, reserved example hosts). */
  readonly urlAllowList?: readonly string[];
  /** The catalogue the census is assembled against (default: the one this build carries). */
  readonly catalogue?: CatalogueData;
  /** The level the census is assembled for (default `census`: step 0.1 of every onboarding). */
  readonly censusLevel?: Level;
  /**
   * What the code host and the owner attested for a repo (B4, CF1, CF4, card 1); a seam for M7. An
   * absent answer, or a refusal, leaves every one of those facts unknown, which counts as unmet.
   */
  readonly attestations?: (repo: string) => Promise<CensusAttestations | undefined>;
  readonly log?: (line: string) => void;
  /** Test seam: called with the mirror directory after it is built, before the scan. */
  readonly afterMirror?: (mirrorDir: string) => Promise<void> | void;
}

const WORK_PREFIX = 'job-';

/**
 * Runs census-intake jobs in this process, each in a private workspace that is removed when the job
 * ends however it ends. A job is a record stream `kjob:<id>` (queued, running, done | error). The
 * intake (download, verify, mirror) and the scan share one deadline: past it every git child is
 * killed; a scan cut off is `scan_status: error` with a `time_cap` coverage item, an intake cut off
 * is a job `error`. Nothing here ever runs content from the repo.
 */
export class JobRunner {
  private readonly queue: Array<{ id: KnowledgeJobId; req: StartCensusIntakeRequest }> = [];
  private running = 0;
  private readonly waiters: Array<() => void> = [];
  readonly workRoot: string;

  constructor(private readonly o: RunnerOptions) {
    this.workRoot = o.workRoot ?? join(tmpdir(), 'aisdlc-knowledge');
  }

  private log(line: string): void {
    this.o.log?.(line);
  }

  /** Creates the job (`queued`) and schedules it. Returns at once. */
  async start(req: StartCensusIntakeRequest): Promise<Result<KnowledgeJob, KnowledgeError>> {
    const job = await enqueueJob(this.o, req);
    if (!job.ok) return job;
    this.queue.push({ id: job.value.job_id, req });
    setImmediate(() => this.pump());
    return job;
  }

  /** Resolves when nothing is queued or running (tests, shutdown). */
  idle(): Promise<void> {
    if (this.queue.length === 0 && this.running === 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private pump(): void {
    const max = this.o.maxConcurrent ?? 2;
    while (this.running < max && this.queue.length > 0) {
      const next = this.queue.shift();
      if (!next) break;
      this.running++;
      void this.run(next.id, next.req)
        .catch((e: unknown) =>
          this.log(
            `knowledge: job ${next.id}: unexpected ${e instanceof Error ? e.name : 'failure'}`,
          ),
        )
        .finally(() => {
          this.running--;
          this.pump();
          if (this.queue.length === 0 && this.running === 0)
            for (const w of this.waiters.splice(0)) w();
        });
    }
  }

  /**
   * On start: a job the previous process left `queued` or `running` can never finish, so it is
   * `error` (fail closed, never resumed on guesswork), and every workspace left on disk is removed.
   */
  async recover(): Promise<number> {
    const r = await this.o.pool.query<{ job_id: string; state: string }>(
      `SELECT job_id, state FROM knowledge.knowledge_job WHERE state IN ('queued', 'running')`,
    );
    for (const row of r.rows) {
      await failJob(
        this.o,
        row.job_id as KnowledgeJobId,
        row.state === 'queued' ? 1 : 2,
        'interrupted by a restart',
      );
    }
    try {
      for (const name of await readdir(this.workRoot)) {
        if (name.startsWith(WORK_PREFIX))
          await rm(join(this.workRoot, name), { recursive: true, force: true });
      }
    } catch {
      /* no work root yet */
    }
    return r.rows.length;
  }

  private async run(id: KnowledgeJobId, req: StartCensusIntakeRequest): Promise<void> {
    const o = this.o;
    const t0 = performance.now();
    await mkdir(this.workRoot, { recursive: true, mode: 0o700 });
    const dir = await mkdtemp(join(this.workRoot, `${WORK_PREFIX}${id}-`));
    const home = join(dir, 'home');
    await mkdir(home, { mode: 0o700 });
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), o.jobTimeoutMs ?? KNOWLEDGE_DEFAULTS.job_timeout_ms);
    const git = new Git({ ...(o.gitBin ? { gitBin: o.gitBin } : {}), home, signal: ac.signal });
    let seq: 1 | 2 = 1;
    try {
      await markRunning(o, id);
      seq = 2;
      const refs = req.refs ?? 'all';
      const cap = o.bundleCapBytes ?? BUNDLE_DEFAULT_CAP_BYTES;

      const src = await o.source.bundle({
        repo: req.repo,
        refs,
        ...(req.base_sha ? { base_sha: req.base_sha } : {}),
      });
      if (src.state !== 'ok') throw sourceRefusal(src);
      const { manifest } = src.value;
      if (manifest.repo.toLowerCase() !== req.repo.toLowerCase()) {
        src.value.dispose();
        throw new IntakeRefused('manifest_mismatch', 'the manifest is for another repository');
      }
      if (req.base_sha !== undefined && manifest.head_sha !== req.base_sha) {
        src.value.dispose();
        throw new IntakeRefused(
          'head_mismatch',
          'the bundle does not end at the requested base sha',
        );
      }
      if (manifest.bytes > cap) {
        src.value.dispose();
        throw new IntakeRefused(
          'too_large',
          `the manifest says ${manifest.bytes} bytes, over the ${cap}-byte cap`,
        );
      }
      const file = join(dir, 'bundle.bundle');
      const download = await downloadBundle(src.value, file, cap, ac.signal);
      const mirror = await buildMirror(git, dir, file, manifest, download);
      const headTree = await readHeadTree(git, mirror);
      await o.afterMirror?.(mirror.dir);
      this.log(
        `knowledge: job ${id}: mirror of ${req.repo} ready after ${Math.round(performance.now() - t0)} ms`,
      );

      const rules = o.rules ?? RULES;
      const scan = await scanMirror(
        git,
        mirror,
        headTree,
        manifest.refs_covered,
        o.fingerprinter,
        {
          commitCap: o.commitCap ?? KNOWLEDGE_DEFAULTS.commit_cap,
          maxFileBytes: o.maxFileBytes ?? KNOWLEDGE_DEFAULTS.max_file_bytes,
          rulesVersion: rulesVersion(rules),
          rules,
        },
        ac.signal,
      );

      // The detectors (M6.3) and the content lint (M6.4) read the head tree through the same hardened
      // object reader. A failed detector is recorded in its result, never an empty "found nothing".
      const reader = new GitTreeReader(
        git,
        mirror,
        headTree,
        o.maxFileBytes ?? KNOWLEDGE_DEFAULTS.max_file_bytes,
        defaultBranchOf(mirror),
      );
      let detected: DetectorRun;
      try {
        detected = await runDetectors(
          reader,
          buildDetectors({
            ...(o.urlAllowList ? { urlAllowList: o.urlAllowList } : {}),
            secretRules: rules,
          }),
          ac.signal,
        );
        // M12.1: the head tree's text, for the read-only `KnowledgeSearch`. A failure here never fails the job.
        try {
          const ix = await indexRepo(o.pool, {
            repo: req.repo,
            commit_sha: mirror.base_sha,
            job_id: id,
            reader,
            now: (o.clock ?? systemClock).now(),
            rules,
            signal: ac.signal,
          });
          this.log(
            `knowledge: job ${id}: indexed ${ix.files} files for search (${ix.skipped} skipped)`,
          );
        } catch (e) {
          this.log(`knowledge: job ${id}: search index not built (${describeError(e)})`);
        }
      } finally {
        await reader.close();
      }
      const coverage = mergeCoverage(scan.items, scan.counts, detected.coverage);
      const files = headTree.filter((e) => e.type === 'blob');
      // Attestations are read before the job's transaction; a failing source means "nothing attested".
      const attested = await (o.attestations?.(req.repo) ?? Promise.resolve(undefined)).catch(
        () => undefined,
      );
      const catalogue = o.catalogue ?? CATALOGUE;
      const job = await finishJob(
        o,
        id,
        {
          base: {
            repo: req.repo,
            base_sha: mirror.base_sha,
            manifest,
            bundle_sha256: download.sha256 as never,
            bundle_bytes: download.bytes,
            refs: [...mirror.refs],
            head_tree: { files: files.length, bytes: files.reduce((n, e) => n + (e.size ?? 0), 0) },
            coverage_items: coverage.items,
            coverage_counts: coverage.counts as Partial<Record<CoverageKind, number>>,
            scan_status: scan.status,
            scan_error: scan.error,
            scan_coverage: scan.coverage,
            detectors: detected.result,
          },
          findings: scan.findings,
        },
        (result) => assembleCensus(result, catalogue, o.censusLevel ?? 'census', attested ?? {}),
      );
      this.log(
        `knowledge: job ${id}: done in ${Math.round(performance.now() - t0)} ms (scan ${job.result?.scan_status}, ` +
          `${scan.coverage.commits_scanned} commits, ${scan.coverage.blobs_scanned} blobs)`,
      );
    } catch (e) {
      const reason =
        e instanceof IntakeRefused
          ? `${e.code}: ${e.message}`
          : e instanceof ScanFailure
            ? `${e.code}: ${e.message}`
            : ac.signal.aborted
              ? 'timeout: the job time cap was reached'
              : 'internal error';
      this.log(
        `knowledge: job ${id}: error (${reason.split(':')[0]})` +
          (reason === 'internal error' ? `: ${describeError(e)}` : ''),
      );
      await failJob(o, id, seq, reason).catch(() => undefined);
    } finally {
      clearTimeout(timer);
      git.killAll();
      await drain(git);
      await rm(dir, { recursive: true, force: true });
    }
  }
}

/** Waits (briefly) for killed children to be reaped, so a job leaves no process behind. */
async function drain(git: Git): Promise<void> {
  for (let i = 0; i < 100 && git.liveCount() > 0; i++) await new Promise((r) => setTimeout(r, 20));
}

/** An error for the service log: its name and a bounded message with anything hash-shaped removed. */
function describeError(e: unknown): string {
  const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
  return msg.replace(/[0-9a-f]{40,64}/gi, '[hex]').slice(0, 1500);
}
