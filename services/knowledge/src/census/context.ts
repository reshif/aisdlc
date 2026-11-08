import {
  MAX_CENSUS_EVIDENCE,
  type CensusAttestations,
  type CensusEvidence,
  type CensusNaRule,
  type CensusObserved,
  type DetectorId,
  type DetectorsResult,
  type Fact,
  type IntakeResult,
  type Level,
  type RepoOwnerType,
  type RepoVisibility,
  type SignerMode,
} from '@aisdlc/contracts';

// What every census evaluator reads: the job's result, the detectors' facts, the attestations
// (everything absent is UNKNOWN), and a few helpers that keep "the detector did not run" apart
// from "the detector found nothing" (the second is a fact, the first is not).

export type FactOf<K extends Fact['kind']> = Extract<Fact, { kind: K }>;

export interface BlockerView {
  readonly status: 'met' | 'blocked' | 'unknown' | 'not_evaluated';
}

export class CensusContext {
  readonly d: DetectorsResult | null;
  readonly mode: SignerMode;
  readonly visibility: RepoVisibility | null;
  readonly ownerType: RepoOwnerType | null;

  constructor(
    readonly r: IntakeResult,
    readonly level: Level,
    readonly att: CensusAttestations,
  ) {
    this.d = r.detectors;
    this.mode = att.mode ?? 'solo';
    this.visibility = att.repo?.visibility ?? null;
    this.ownerType = att.repo?.owner_type ?? null;
  }

  /**
   * True when `id`'s facts can be trusted to be complete: the detectors ran, this one did not fail,
   * nothing unreadable cut a detector short, and the fact list was not truncated.
   */
  ok(id: DetectorId): boolean {
    const d = this.d;
    if (d === null) return false;
    if (d.facts_truncated) return false;
    return !d.errors.some((e) => e.detector === id || e.detector === null);
  }

  facts<K extends Fact['kind']>(kind: K): FactOf<K>[] {
    return (this.d?.facts ?? []).filter((f): f is FactOf<K> => f.kind === kind);
  }

  inventory(kind: string): FactOf<'instruction_file'> | undefined {
    return this.facts('instruction_file').find((f) => f.inventory === kind);
  }

  task(name: string): FactOf<'task_command'> | undefined {
    return this.facts('task_command').find((f) => f.name === name);
  }
}

export interface Evaluation {
  readonly observed: CensusObserved;
  readonly reasons: readonly string[];
  readonly evidence: readonly CensusEvidence[];
  /** A deterministic written N/A rule (the Census list is `CENSUS_NA_RULES`). */
  readonly na?: Exclude<CensusNaRule, 'NA-LEVEL'>;
}

export const pass = (
  evidence: readonly CensusEvidence[] = [],
  reasons: string[] = [],
): Evaluation => ({
  observed: 'pass',
  reasons,
  evidence,
});
export const fail = (reasons: string[], evidence: readonly CensusEvidence[] = []): Evaluation => ({
  observed: 'fail',
  reasons,
  evidence,
});
export const unknown = (reason: string, evidence: readonly CensusEvidence[] = []): Evaluation => ({
  observed: 'unknown',
  reasons: [reason],
  evidence,
});

export function factEvidence(f: Fact): CensusEvidence[] {
  return f.evidence.map((e) => ({
    source: 'detector' as const,
    ref: `fact:${f.kind}`,
    path: e.path,
    blob: e.blob,
    line: e.line,
  }));
}

export const ref = (source: CensusEvidence['source'], r: string): CensusEvidence => ({
  source,
  ref: r,
});

/** Deterministic and bounded: sorted, de-duplicated, at most `MAX_CENSUS_EVIDENCE`. */
export function tidyEvidence(items: readonly CensusEvidence[]): CensusEvidence[] {
  const key = (e: CensusEvidence): string =>
    `${e.source}\0${e.ref}\0${e.path ?? ''}\0${String(e.line ?? 0).padStart(9, '0')}\0${e.blob ?? ''}`;
  const seen = new Map<string, CensusEvidence>();
  for (const e of items) seen.set(key(e), e);
  return [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, MAX_CENSUS_EVIDENCE)
    .map(([, e]) => e);
}

export const uniqSorted = (xs: readonly string[]): string[] => [...new Set(xs)].sort();
