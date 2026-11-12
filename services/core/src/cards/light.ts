import {
  DEFAULT_INSTRUCTION_TEMPLATE,
  INSTRUCTION_TEMPLATE_CONFIG_KEY,
  InstructionTemplate,
  LF6_MIN_AFFIRMED_OR_UNKNOWN,
  S0_EVENT,
  S0InstructionEditedPayload,
  S0LightProposedPayload,
  s0Stream,
  type InstructionPath,
  type InstructionReview,
  type LightProposal,
  type PrincipalId,
} from '@aisdlc/contracts';
import type { ConfigReader } from '@aisdlc/config';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  buildLightProposal,
  defaultBoundHash,
  lf3Of,
  reviewInstructionFile,
  type C2Context,
} from '@aisdlc/onboarding';
import { scanText } from '@aisdlc/secrets-rules';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx } from '../journal.js';
import { openS0 } from '../s0.js';
import { SLOT_OF_CARD, decisionsFor, type CardDeps } from './model.js';
import { lf4Of } from './floors.js';
import { latestProbe } from './probe.js';
import type { LoadedS0, OnboardingCard } from './read.js';

// Card 2, the Light step 0.2 (PLAN M16; OB §4, §6.2 row 0.2; DEC-11 refined, DEC-12(a)): the I/O
// half. Before the card opens, the factory builds its proposal (the static cartographer's claims,
// the questions, the template review of AGENTS.md and CLAUDE.md as read at the census head) and
// RECORDS it on the S0 stream (record-first): the card is about the recorded copy, never the repo
// file, and agents later receive the record copy. Everything stored is secret-scanned first: a hit
// stores nothing. A person may edit a file's proposed text on the card (an edit is recorded the
// same way); an edit changes the card's evidence, so a decision prepared before it is refused: text
// is never affirmed in the session that proposed it.

/** The factory template from the config reader. A published value that no longer fits reads `null` (unknown: card 2 cannot open). */
export function instructionTemplateFrom(reader: ConfigReader): () => InstructionTemplate | null {
  return () => {
    const c = reader.current();
    if (c.rejected.includes(INSTRUCTION_TEMPLATE_CONFIG_KEY)) return null;
    const v = c.get(INSTRUCTION_TEMPLATE_CONFIG_KEY);
    if (v === undefined) return DEFAULT_INSTRUCTION_TEMPLATE;
    const p = InstructionTemplate.safeParse(v);
    return p.success ? p.data : null;
  };
}

const templateOf = (deps: CardDeps): InstructionTemplate | null =>
  deps.instructionTemplate ? deps.instructionTemplate() : DEFAULT_INSTRUCTION_TEMPLATE;

/** The proposal recorded for the n-th raising of card 2, if any. */
export function lightProposalOf(loaded: LoadedS0, occurrence: number): LightProposal | null {
  for (const e of loaded.events) {
    if (e.type !== S0_EVENT.light_proposed) continue;
    const p = S0LightProposedPayload.parse(e.payload);
    if (p.occurrence === occurrence) return p.proposal;
  }
  return null;
}

/** The current review of each file of a raising: the proposal's, then every edit in record order. */
export function reviewsOf(
  loaded: LoadedS0,
  occurrence: number,
  proposal: LightProposal,
): Map<InstructionPath, InstructionReview> {
  const out = new Map<InstructionPath, InstructionReview>(
    proposal.instructions.map((r) => [r.path, r]),
  );
  for (const e of loaded.events) {
    if (e.type !== S0_EVENT.instruction_edited) continue;
    const p = S0InstructionEditedPayload.parse(e.payload);
    if (p.occurrence === occurrence && p.proposal_hash === proposal.proposal_hash) {
      out.set(p.path, p.review);
    }
  }
  return out;
}

const hasSecret = (v: unknown): boolean => scanText(JSON.stringify(v)).length > 0;

/**
 * Builds and records card 2's proposal for this raising, once (a repeat returns the recorded one).
 * Fails closed: no census, a census that moved, no detector facts, an unreadable instruction file
 * or template: nothing is recorded and the card does not open (the next sync tries again).
 */
export async function ensureLightProposal(
  deps: CardDeps,
  loaded: LoadedS0,
  occurrence: number,
): Promise<Result<LightProposal, CoreError>> {
  const prior = lightProposalOf(loaded, occurrence);
  if (prior) return ok(prior);
  const { s0 } = loaded;
  if (!s0.census) return err(coreError('conflict', 'the census is not ready'));
  const template = templateOf(deps);
  if (!template) {
    return err(coreError('unavailable', 'the factory instruction template does not read'));
  }
  const latest = await deps.knowledge.census(s0.repo);
  if (!latest.ok) return err(coreError('unavailable', `knowledge: ${latest.error.message}`));
  if (latest.value === null || latest.value.census_hash !== s0.census.census_hash) {
    return err(coreError('conflict', 'the census moved on since 0.1; the record needs a new one'));
  }
  const facts = await deps.knowledge.detectorFacts(s0.census.job_id);
  if (!facts.ok) return err(coreError('unavailable', `knowledge: ${facts.error.message}`));
  if (facts.value === null) {
    return err(coreError('unavailable', 'the census job recorded no detector facts'));
  }
  const sha = latest.value.census.baseline_sha;
  const files: Record<InstructionPath, { text: string; blob_sha: string } | null> = {
    'AGENTS.md': null,
    'CLAUDE.md': null,
  };
  for (const path of ['AGENTS.md', 'CLAUDE.md'] as const) {
    const r = await deps.source.read_at_sha({ repo: s0.repo, sha, path });
    if (r.state !== 'ok') return err(coreError('unavailable', `the code host: ${path} ${r.state}`));
    files[path] = r.value === null ? null : { text: r.value.content, blob_sha: r.value.blob_sha };
  }
  const proposal = buildLightProposal({
    s0_id: s0.record.s0_id,
    repo: s0.repo,
    census_hash: s0.census.census_hash,
    baseline_sha: sha,
    facts: facts.value,
    files,
    template,
  });
  // Secret-scanned before it is stored (OB §4.1 item 4): the builder keeps no section with a
  // secret; this is the last check over everything that would enter the record.
  if (hasSecret(proposal)) {
    return err(coreError('refused', 'the proposal would hold a secret; nothing was recorded'));
  }
  return inCoreTx<LightProposal>(deps, async (j) => {
    const opened = await openS0(j, s0.record.s0_id);
    if (!opened.ok) return opened;
    const events = await j.events(s0Stream(s0.record.s0_id));
    for (const e of events) {
      if (e.type !== S0_EVENT.light_proposed) continue;
      const p = S0LightProposedPayload.parse(e.payload);
      if (p.occurrence === occurrence) return ok(p.proposal);
    }
    const w = await j.emit(
      s0Stream(s0.record.s0_id),
      S0_EVENT.light_proposed,
      S0LightProposedPayload.parse({ occurrence, proposal }),
      'system.cards',
    );
    return w.ok ? ok(proposal) : w;
  });
}

export interface C2Ctx extends C2Context {
  readonly occurrence: number;
  /** LF4 (M16): the harness inventory and the isolation test for the worker image in use; shown, not decided here. */
  readonly lf4: {
    readonly state: 'met' | 'unmet' | 'unknown';
    readonly reasons: readonly string[];
  };
  /** How many edits the raising has had (part of the evidence: an edit changes it). */
  readonly edits: number;
}

/** Card 2's context: the recorded proposal, the current reviews, and the probe recorded at its census head (M16). */
export async function loadC2Context(
  deps: Pick<CardDeps, 'pool' | 'knowledge' | 'lightTests'>,
  loaded: LoadedS0,
  card: OnboardingCard,
): Promise<Result<C2Ctx, CoreError>> {
  const proposal = lightProposalOf(loaded, card.occurrence);
  if (!proposal) return err(coreError('conflict', 'card 2 has no recorded proposal'));
  const probe = await latestProbe(deps.pool, loaded.s0.record.s0_id, {
    census_hash: proposal.census_hash,
    baseline_sha: proposal.baseline_sha,
  });
  const lf4 = loaded.s0.census
    ? await lf4Of(deps, loaded.s0.census.job_id)
    : { state: 'unknown' as const, reasons: ['census_not_ready'] };
  return c2Context(
    loaded,
    card,
    probe === null ? null : { result: probe.result, result_hash: probe.result_hash },
    lf4,
  );
}

export function c2Context(
  loaded: LoadedS0,
  card: OnboardingCard,
  probe: C2Context['probe'] = null,
  lf4: C2Ctx['lf4'] = { state: 'unknown', reasons: ['isolation_test_not_run'] },
): Result<C2Ctx, CoreError> {
  const proposal = lightProposalOf(loaded, card.occurrence);
  if (!proposal) return err(coreError('conflict', 'card 2 has no recorded proposal'));
  const edits = loaded.events.filter(
    (e) =>
      e.type === S0_EVENT.instruction_edited &&
      S0InstructionEditedPayload.parse(e.payload).occurrence === card.occurrence,
  ).length;
  return ok({
    proposal,
    reviews: reviewsOf(loaded, card.occurrence, proposal),
    probe,
    occurrence: card.occurrence,
    edits,
    lf4,
  });
}

/**
 * What the person is shown: the claims with their evidence, the questions, each file's sections as
 * accepted, rejected (with the reason) or drafted, the proposed text and its lint, and what the
 * D37 step-up binds to. Pure; its hash is the evidence a decision is bound to.
 */
export function c2View(c: C2Ctx, s0: LoadedS0['s0']): Record<string, unknown> {
  const p = c.proposal;
  return {
    card: 'C2',
    repo: s0.repo,
    proposal: {
      proposal_hash: p.proposal_hash,
      census_hash: p.census_hash,
      baseline_sha: p.baseline_sha,
      template_hash: p.template_hash,
    },
    claims: p.claims,
    claims_dropped: p.claims_dropped,
    claims_truncated: p.claims_truncated,
    verdicts: ['affirm', 'correct', 'unknown'],
    lf6: { min_affirmed_or_unknown_pct: LF6_MIN_AFFIRMED_OR_UNKNOWN * 100 },
    intent_questions: p.intent_questions,
    practice_questions: p.practice_questions,
    instructions: [...c.reviews.values()].map((r) => ({
      path: r.path,
      area: r.area,
      state: r.state,
      source_blob_sha: r.source_blob_sha,
      proposed_by: r.proposed_by,
      sections: r.sections,
      missing_required: r.missing_required,
      proposed: r.proposed,
      affirmable: r.proposed.blocked === null && r.proposed.text_sha256 !== null,
      required: r.path === 'AGENTS.md',
    })),
    edits: c.edits,
    // LF3 (M16): card 2 cannot be approved until the probe passed at this census head (no waiver)
    probe: probeViewOf(c),
    step_up: {
      required: true,
      bound_hash: defaultBoundHash(c),
      binds: 'the affirmed files and their text hashes',
    },
    rules: {
      factory_wins:
        'factory rules and defaults always win; repo text only adds repo detail inside them',
      guidance: 'affirmed text reaches agents as fenced guidance, never as control',
      session: 'an edit changes this card: a decision prepared before it is refused',
    },
  };
}

/** What card 2 shows of the probe: LF3 and LF8 at the proposal's head, and the result's facts (never a value). */
export function probeViewOf(c: C2Ctx): Record<string, unknown> {
  const head = { census_hash: c.proposal.census_hash, baseline_sha: c.proposal.baseline_sha };
  const r = c.probe?.result ?? null;
  return {
    lf3: lf3Of(r, head),
    lf4: c.lf4,
    lf8:
      r === null
        ? { state: 'unknown', reasons: ['egress_not_declared'] }
        : r.egress.unserved.length > 0
          ? { state: 'unmet', reasons: r.egress.unserved.map((e) => `mirror_does_not_serve:${e}`) }
          : { state: 'met', reasons: [] },
    result:
      r === null
        ? null
        : {
            probe_id: r.probe_id,
            result_hash: c.probe?.result_hash ?? null,
            outcome: r.outcome,
            detail: r.detail,
            image: r.image,
            setup: r.setup,
            test: r.test,
            tests: r.tests,
            peers: r.session?.peers ?? [],
            egress: r.egress,
            out_scan: r.out_scan,
            recorded_at: r.recorded_at,
          },
  };
}

/**
 * A person edits one file's proposed text on card 2. They must hold the slot that decides card 2.
 * The text is secret-scanned BEFORE anything is stored (a hit is refused and nothing is recorded,
 * with no override), reviewed against the factory template as the person's own text, and recorded.
 */
export async function editInstructionText(
  deps: CardDeps,
  loaded: LoadedS0,
  card: OnboardingCard,
  input: {
    principal: PrincipalId;
    path: InstructionPath;
    text: string;
    base_text_sha256: string | null;
  },
): Promise<Result<InstructionReview, CoreError>> {
  const ctx = c2Context(loaded, card);
  if (!ctx.ok) return ctx;
  const holders = await decisionsFor(deps, loaded.s0.record.s0_id).eligibility.holders(
    card.state.open.project_id,
    SLOT_OF_CARD.C2,
  );
  if (!holders.ok) return err(coreError('unavailable', holders.error.message));
  if (!holders.value.includes(input.principal)) {
    return err(
      coreError('forbidden', `${input.principal} does not hold the slot that decides card 2`),
    );
  }
  if (scanText(input.text).length > 0) {
    return err(
      coreError(
        'refused',
        'the text holds a secret: nothing was stored. Remove it and rotate the secret',
      ),
    );
  }
  const current = ctx.value.reviews.get(input.path) ?? null;
  const base = current?.proposed.text_sha256 ?? null;
  if (input.base_text_sha256 !== base) {
    return err(coreError('conflict', `${input.path} changed since you saw it: reopen the card`));
  }
  const template = templateOf(deps);
  if (!template)
    return err(coreError('unavailable', 'the factory instruction template does not read'));
  const review = reviewInstructionFile({
    path: input.path,
    source: { text: input.text, blob_sha: '0'.repeat(40) },
    template,
    mode: 'edit',
    facts: [],
    proposed_by: input.principal,
  });
  if (review.proposed.text_sha256 === base) {
    return err(coreError('conflict', 'the text is unchanged'));
  }
  if (hasSecret(review)) return err(coreError('refused', 'the review would hold a secret'));
  const s0Id = loaded.s0.record.s0_id;
  const w = await inCoreTx(deps, async (j) => {
    const opened = await openS0(j, s0Id);
    if (!opened.ok) return opened;
    return j.emit(
      s0Stream(s0Id),
      S0_EVENT.instruction_edited,
      S0InstructionEditedPayload.parse({
        occurrence: card.occurrence,
        proposal_hash: ctx.value.proposal.proposal_hash,
        path: input.path,
        replaces: base,
        review,
      }),
      input.principal,
    );
  });
  return w.ok ? ok(review) : w;
}
