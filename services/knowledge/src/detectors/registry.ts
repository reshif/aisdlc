import { createHash } from 'node:crypto';
import {
  DetectorsResult,
  LINT_RULES,
  MAX_FACTS,
  type CoverageItem,
  type DetectorInfo,
  type DetectorsError,
  type Fact,
} from '@aisdlc/contracts';
import { RULES, type SecretRule } from '@aisdlc/secrets-rules';
import { ScanFailure } from '../git.js';
import { codeownersDetector } from './codeowners.js';
import { inventoryDetector } from './inventory.js';
import { DEFAULT_URL_ALLOW_LIST, lintDetector } from './lint.js';
import { lockfileDetector } from './lockfiles.js';
import { stackDetector } from './stack.js';
import { taskContractDetector } from './task-contract.js';
import { blastRadiusDetector, dataClassDetector, deriveTier, exposureDetector } from './tier.js';
import type { Detector, DetectorOutput, TreeReader } from './types.js';
import { b5Detector, b6Detector } from './workflows.js';

// The detector registry (PLAN M6.3): the ONE list of detectors, their versions, and the runner that
// turns a tree reader into a `DetectorsResult`. `detector_set_version` is a hash over every
// detector's id and version, pinned in the PRR (`PrrPins.detector_set`).

/** Bumped by hand when the way facts are combined (tier floor, B5/B6 status, caps) changes. */
export const DETECTOR_SET_REVISION = 1;

export interface DetectorOptions {
  /** Hosts a doc may link to without an L-URL finding. */
  readonly urlAllowList?: readonly string[];
  readonly secretRules?: readonly SecretRule[];
}

export function buildDetectors(opts: DetectorOptions = {}): Detector[] {
  return [
    stackDetector(),
    taskContractDetector(),
    lockfileDetector(),
    codeownersDetector(),
    dataClassDetector(),
    exposureDetector(),
    blastRadiusDetector(),
    inventoryDetector(),
    b5Detector(),
    b6Detector(),
    lintDetector({
      urlAllowList: opts.urlAllowList ?? DEFAULT_URL_ALLOW_LIST,
      secretRules: opts.secretRules ?? RULES,
    }),
  ];
}

/** `detectors/<revision>:<12 hex over every detector's id, version and criteria, in id order>`. */
export function detectorSetVersion(detectors: readonly Detector[]): string {
  const h = createHash('sha256')
    .update(
      JSON.stringify(
        detectors
          .map((d) => d.info)
          .sort((a, b) => (a.id < b.id ? -1 : 1))
          .map((i) => [i.id, i.version, i.criteria]),
      ),
    )
    .digest('hex')
    .slice(0, 12);
  return `detectors/${DETECTOR_SET_REVISION}:${h}`;
}

export interface DetectorRun {
  readonly result: DetectorsResult;
  /** Coverage items (unreadable, over-limit, unparseable) for the job's list. */
  readonly coverage: CoverageItem[];
}

const FACT_PRIORITY: Record<Fact['kind'], number> = {
  tier_signal: 0,
  workflow_finding: 1,
  apply_on_merge: 2,
  instruction_file: 3,
  codeowners: 4,
  task_command: 5,
  lockfile: 6,
  stack: 7,
  lint_finding: 8,
};

/**
 * Runs every detector in order. A detector that throws is recorded (`status: error`, its facts
 * absent, never "none found"); the job deadline stops the run with a `timeout` error. A blob git
 * cannot read (a coverage item) also makes the status `error`: the facts are then incomplete.
 */
export async function runDetectors(
  reader: TreeReader,
  detectors: readonly Detector[],
  signal?: AbortSignal,
): Promise<DetectorRun> {
  const facts: Fact[] = [];
  const coverage = new Map<string, CoverageItem>();
  const errors: DetectorsError[] = [];
  const stats: Record<string, number> = {};
  const sumStat = (k: string, v: number): void => {
    stats[k] = (stats[k] ?? 0) + v;
  };

  for (const d of detectors) {
    if (signal?.aborted) {
      errors.push({
        detector: d.info.id,
        code: 'timeout',
        message: 'the job time cap was reached before this detector ran',
      });
      continue;
    }
    let out: DetectorOutput;
    try {
      out = await d.run(reader);
    } catch (e) {
      const code =
        e instanceof ScanFailure
          ? e.code === 'timeout' || e.code === 'unreadable_object' || e.code === 'parse_failed'
            ? e.code
            : 'git_failed'
          : signal?.aborted
            ? 'timeout'
            : 'detector_failed';
      errors.push({
        detector: d.info.id,
        code,
        message: `the ${d.info.id} detector failed (${code})`,
      });
      continue;
    }
    facts.push(...out.facts);
    for (const item of out.coverage)
      coverage.set(`${item.kind}\0${item.object ?? ''}\0${item.path ?? ''}`, item);
    for (const [k, v] of Object.entries(out.stats)) {
      // The b5 and b6 detectors both load the workflows: the larger of the two counts, not the sum.
      if (k === 'workflows_unanalysed') stats[k] = Math.max(stats[k] ?? 0, v);
      else sumStat(`${d.info.id}:${k}`, v);
    }
  }
  if ([...coverage.values()].some((i) => i.kind === 'unreadable_object'))
    errors.push({
      detector: null,
      code: 'unreadable_object',
      message: 'git could not read an object a detector needed: its facts are incomplete',
    });

  // Deterministic order: by kind priority, then the order the detectors produced them.
  const ordered = facts
    .map((f, i) => [f, i] as const)
    .sort((a, b) => FACT_PRIORITY[a[0].kind] - FACT_PRIORITY[b[0].kind] || a[1] - b[1])
    .map(([f]) => f);
  const counts: Record<string, number> = {};
  for (const f of ordered) counts[f.kind] = (counts[f.kind] ?? 0) + 1;
  const truncated = ordered.length > MAX_FACTS;
  const listed = truncated ? ordered.slice(0, MAX_FACTS) : ordered;
  if (truncated)
    coverage.set('list_truncated\0\0', {
      kind: 'list_truncated',
      path: null,
      object: null,
      reason: `${ordered.length - MAX_FACTS} more detector facts exist; fact_counts are complete`,
    });

  const red = ordered.filter((f) => f.kind === 'workflow_finding' && f.severity === 'red').length;
  const amber = ordered.filter(
    (f) => f.kind === 'workflow_finding' && f.severity === 'amber',
  ).length;
  const aom = ordered.filter((f) => f.kind === 'apply_on_merge');
  const byRule: Record<string, number> = {};
  for (const [k, v] of Object.entries(stats)) {
    const m = /^content_lint:rule:(.+)$/.exec(k);
    if (m) byRule[m[1] as string] = v;
  }
  const lintBlocking = Object.entries(byRule)
    .filter(([r]) => severityOf(r) === 'blocking')
    .reduce((n, [, v]) => n + v, 0);
  const lintAdvisory = Object.entries(byRule)
    .filter(([r]) => severityOf(r) === 'advisory')
    .reduce((n, [, v]) => n + v, 0);
  const unanalysed = stats['workflows_unanalysed'] ?? 0;
  const b5Failed = errors.some((e) => e.detector === 'b5_workflows' || e.detector === null);

  const info: DetectorInfo[] = detectors.map((d) => d.info);
  const result = DetectorsResult.parse({
    detector_set_version: detectorSetVersion(detectors),
    detectors: info,
    status: errors.length === 0 ? 'ok' : 'error',
    errors,
    default_branch: reader.defaultBranch,
    facts: listed,
    fact_counts: counts,
    facts_truncated: truncated,
    tier: deriveTier(ordered),
    b5: {
      status: red > 0 ? 'blocked' : unanalysed > 0 || b5Failed ? 'unknown' : 'met',
      red,
      amber,
      workflows_unanalysed: unanalysed,
    },
    b6: {
      detected: aom.length > 0,
      high: aom.filter((f) => f.kind === 'apply_on_merge' && f.confidence === 'high').length,
      medium: aom.filter((f) => f.kind === 'apply_on_merge' && f.confidence === 'medium').length,
    },
    lint: {
      docs_linted: stats['content_lint:docs_linted'] ?? 0,
      blocking: lintBlocking,
      advisory: lintAdvisory,
      by_rule: byRule,
    },
  });
  return { result, coverage: [...coverage.values()] };
}

function severityOf(rule: string): 'blocking' | 'advisory' | null {
  return (
    (LINT_RULES as Record<string, { severity: 'blocking' | 'advisory' }>)[rule]?.severity ?? null
  );
}
