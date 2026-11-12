import {
  S0_EVENT,
  S0FullProposedPayload,
  ServiceEnvironment,
  StagingSeparation,
  s0Stream,
  type FullBaseline,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { buildFullBaseline, ff1Of, type C3Context } from '@aisdlc/onboarding';
import { scanText } from '@aisdlc/secrets-rules';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx } from '../journal.js';
import { openS0 } from '../s0.js';
import type { CardDeps } from './model.js';
import type { LoadedS0, OnboardingCard } from './read.js';

// Card 3, the Full step 0.3 (PLAN M17; OB §6.2 row 0.3; FF1; DEC-15(a)): the I/O half. Before the card
// opens, the factory builds the Full baseline from knowledge's code graph at the census head and the census
// detector facts, and RECORDS it on the S0 stream (record-first, DEC-12(a)): the card is about the recorded
// copy. It is secret-scanned before it is stored (a hit stores nothing). Card 3 is decided by the slot that
// decides intent and specs (G2's: `intent`), never by the bootstrap grant (PLAN §7a: never card 3).

/** The baseline recorded for the n-th raising of card 3, if any. */
export function fullBaselineOf(loaded: LoadedS0, occurrence: number): FullBaseline | null {
  for (const e of loaded.events) {
    if (e.type !== S0_EVENT.full_proposed) continue;
    const p = S0FullProposedPayload.parse(e.payload);
    if (p.occurrence === occurrence) return p.baseline;
  }
  return null;
}

const hasSecret = (v: unknown): boolean => scanText(JSON.stringify(v)).length > 0;

/**
 * Builds and records card 3's baseline for this raising, once (a repeat returns the recorded one). Fails
 * closed: no census, a census that moved, no detector facts, no code graph or one at another commit, an
 * empty graph: nothing is recorded and the card does not open (the next sync tries again).
 */
export async function ensureFullBaseline(
  deps: CardDeps,
  loaded: LoadedS0,
  occurrence: number,
): Promise<Result<FullBaseline, CoreError>> {
  const prior = fullBaselineOf(loaded, occurrence);
  if (prior) return ok(prior);
  const { s0 } = loaded;
  if (!s0.census) return err(coreError('conflict', 'the census is not ready'));
  const latest = await deps.knowledge.census(s0.repo);
  if (!latest.ok) return err(coreError('unavailable', `knowledge: ${latest.error.message}`));
  if (latest.value === null || latest.value.census_hash !== s0.census.census_hash) {
    return err(coreError('conflict', 'the census moved on since 0.1; the record needs a new one'));
  }
  const sha = latest.value.census.baseline_sha;
  const facts = await deps.knowledge.detectorFacts(s0.census.job_id);
  if (!facts.ok) return err(coreError('unavailable', `knowledge: ${facts.error.message}`));
  if (facts.value === null) {
    return err(coreError('unavailable', 'the census job recorded no detector facts'));
  }
  const graph = await deps.knowledge.codeGraph(s0.repo, sha);
  if (!graph.ok) return err(coreError('unavailable', `knowledge: ${graph.error.message}`));
  if (graph.value === null) {
    return err(coreError('unavailable', 'knowledge holds no code graph for the census head'));
  }
  const built = buildFullBaseline({
    s0_id: s0.record.s0_id,
    repo: s0.repo,
    census_hash: s0.census.census_hash,
    baseline_sha: sha,
    graph: graph.value,
    facts: facts.value,
  });
  if (!built.ok) return err(coreError(built.error.code, built.error.message));
  // Secret-scanned before it is stored: the builder keeps only clean text; this is the last check.
  if (hasSecret(built.value)) {
    return err(coreError('refused', 'the baseline would hold a secret; nothing was recorded'));
  }
  const baseline = built.value;
  return inCoreTx<FullBaseline>(deps, async (j) => {
    const opened = await openS0(j, s0.record.s0_id);
    if (!opened.ok) return opened;
    for (const e of await j.events(s0Stream(s0.record.s0_id))) {
      if (e.type !== S0_EVENT.full_proposed) continue;
      const p = S0FullProposedPayload.parse(e.payload);
      if (p.occurrence === occurrence) return ok(p.baseline);
    }
    const w = await j.emit(
      s0Stream(s0.record.s0_id),
      S0_EVENT.full_proposed,
      S0FullProposedPayload.parse({ occurrence, baseline }),
      'system.cards',
    );
    return w.ok ? ok(baseline) : w;
  });
}

export interface C3Ctx extends C3Context {
  readonly occurrence: number;
}

export function c3Context(loaded: LoadedS0, card: OnboardingCard): Result<C3Ctx, CoreError> {
  const baseline = fullBaselineOf(loaded, card.occurrence);
  if (!baseline) return err(coreError('conflict', 'card 3 has no recorded baseline'));
  return ok({ baseline, occurrence: card.occurrence, project_id: loaded.s0.record.project_id });
}

/**
 * What the person is shown: the system map, the seeds with their evidence, the exam (the factory's answers
 * to grade), the golden-task candidates after the exclusion manifest, the oracle-lock proposal, the
 * interview, and FF1. Pure; its hash is the evidence a decision is bound to.
 */
export function c3View(c: C3Ctx, s0: LoadedS0['s0']): Record<string, unknown> {
  const b = c.baseline;
  return {
    card: 'C3',
    repo: s0.repo,
    baseline: {
      baseline_hash: b.baseline_hash,
      census_hash: b.census_hash,
      baseline_sha: b.baseline_sha,
      graph: b.graph,
    },
    ff1: ff1Of(b),
    system_map: b.system_map,
    seeds: b.seeds,
    seeds_dropped: b.seeds_dropped,
    seed_verdicts: ['affirm', 'correct', 'keep_observed'],
    exam: b.exam,
    exam_grades: ['correct', 'incorrect', 'unsure'],
    exclusion: b.exclusion,
    golden_candidates: b.golden_candidates,
    golden_verdicts: ['accept', 'reject'],
    // FF2 (L5 only): the services and environments, and whether staging is separated from production
    service_envs: {
      environments: ServiceEnvironment.options,
      staging_separation: StagingSeparation.options,
      rule: 'L5 opens only when staging separation is attested yes and a service runs in both staging and production',
    },
    oracle_lock: b.oracle_lock,
    intent_questions: b.intent_questions,
    rules: {
      exam: 'the exam is measured, never a gate: any score can be approved',
      seeds:
        'a seed stays observed until you affirm it; affirmed or corrected, it becomes intended',
      oracle_lock: 'the oracle lock is a proposal here; it reaches the repository only through X2',
      data: 'seeds and corrections reach agents as data, never as instructions',
    },
  };
}
