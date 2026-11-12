import {
  C2DecisionContent,
  LF6_MIN_AFFIRMED_OR_UNKNOWN,
  instructionsBoundHash,
  type CardPayloadItem,
  type InstructionPath,
  type InstructionReview,
  type LightProposal,
  type LightQuestion,
  type ProjectReadinessRecord,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';

// What a person's card 2 approval becomes: the list payload of the ledger entry (SP-PROC-2). Every
// rule is checked before anything is written, and a refusal says which one:
//   - the proposal shown is the proposal recorded;
//   - every claim has a verdict, a correction only with `correct` (LF6: at least 90% affirmed or
//     `unknown`);
//   - every intent and practices question is answered as text, and the practices are attested;
//   - AGENTS.md is affirmed (LF5), each file at the text hash shown, none blocked;
//   - nothing a person typed holds a secret (the shared ruleset; no override: the record copy is
//     served to every agent).
// The D37 step-up was checked by the caller against `boundHashOf(content)`; its proof's hash is
// `step_up_ref`. Pure.

export type LightRefusal = {
  readonly code: 'invalid_input' | 'refused' | 'conflict';
  readonly message: string;
};
const refuse = (code: LightRefusal['code'], message: string): Result<never, LightRefusal> =>
  err({ code, message });

export interface C2Context {
  readonly proposal: LightProposal;
  /** The current review of each file: the proposal's, or the latest edit made on the card. */
  readonly reviews: ReadonlyMap<InstructionPath, InstructionReview>;
}

/** The hash the step-up proof must be bound to for this decision (DEC-11(c-i)). */
export function boundHashOf(content: C2DecisionContent): string {
  return instructionsBoundHash(content.instructions);
}

/** The hash a step-up binds to when every file that can be affirmed now is affirmed (the default). */
export function defaultBoundHash(ctx: C2Context): string | null {
  const files = [...ctx.reviews.values()].flatMap((r) =>
    r.proposed.blocked === null && r.proposed.text_sha256 !== null
      ? [{ path: r.path, text_sha256: r.proposed.text_sha256 }]
      : [],
  );
  return files.length === 0 ? null : instructionsBoundHash(files);
}

const hasSecret = (s: string): boolean => scanText(s).length > 0;

function answersOf(
  questions: readonly LightQuestion[],
  given: ReadonlyArray<{ question_id: string; answer: string }>,
  what: string,
): Result<Array<{ question_id: string; answer: string }>, LightRefusal> {
  const want = questions.map((q) => q.question_id);
  const ids = given.map((a) => a.question_id);
  if (new Set(ids).size !== ids.length)
    return refuse('invalid_input', `a ${what} question is answered twice`);
  const missing = want.filter((q) => !ids.includes(q));
  if (missing.length > 0)
    return refuse('refused', `every ${what} question is answered: ${missing.join(', ')}`);
  const extra = ids.filter((q) => !want.includes(q));
  if (extra.length > 0)
    return refuse('invalid_input', `not a ${what} question: ${extra.join(', ')}`);
  if (given.some((a) => hasSecret(a.answer))) {
    return refuse('refused', `a ${what} answer holds a secret: it is never stored; remove it`);
  }
  return ok(
    want.map(
      (q) => given.find((a) => a.question_id === q) as { question_id: string; answer: string },
    ),
  );
}

export function planC2(
  ctx: C2Context,
  content: unknown,
  o: { readonly step_up_ref: string },
): Result<CardPayloadItem[], LightRefusal> {
  const p = C2DecisionContent.safeParse(content ?? {});
  if (!p.success) return refuse('invalid_input', p.error.message);
  const d = p.data;
  const proposal = ctx.proposal;
  if (d.proposal_hash !== proposal.proposal_hash) {
    return refuse('conflict', 'the proposal changed since you saw it: reopen the card');
  }

  // ---- claims (LF6)
  const want = proposal.claims.map((c) => c.claim_id);
  const ids = d.claims.map((c) => c.claim_id);
  if (new Set(ids).size !== ids.length) return refuse('invalid_input', 'a claim is decided twice');
  const missing = want.filter((c) => !ids.includes(c));
  if (missing.length > 0)
    return refuse('refused', `every claim has a verdict: ${missing.length} have none`);
  if (ids.some((c) => !want.includes(c)))
    return refuse('invalid_input', 'a verdict for a claim not on the card');
  if (d.claims.some((c) => c.correction !== undefined && hasSecret(c.correction))) {
    return refuse('refused', 'a correction holds a secret: it is never stored; remove it');
  }
  const total = want.length;
  const count = (v: string) => d.claims.filter((c) => c.verdict === v).length;
  const affirmed = count('affirm');
  const corrected = count('correct');
  const unknown = count('unknown');
  if (total === 0) {
    return refuse(
      'refused',
      'LF6: the shallow code map has no claims to affirm; Light cannot be signed on it',
    );
  }
  const share = (affirmed + unknown) / total;
  if (share < LF6_MIN_AFFIRMED_OR_UNKNOWN) {
    return refuse(
      'refused',
      `LF6: ${Math.round(share * 100)}% of the claims are affirmed or unknown, at least ${LF6_MIN_AFFIRMED_OR_UNKNOWN * 100}% are needed: send the card back so the map is redone`,
    );
  }
  const verdicts = want.map((id) => {
    const v = d.claims.find((c) => c.claim_id === id) as (typeof d.claims)[number];
    return {
      kind: 'claim_verdict' as const,
      claim_id: id,
      verdict: v.verdict,
      ...(v.correction === undefined ? {} : { correction: v.correction }),
    };
  });

  // ---- intent and practices
  const intent = answersOf(proposal.intent_questions, d.intent_answers, 'intent');
  if (!intent.ok) return intent;
  const practices = answersOf(proposal.practice_questions, d.practices.answers, 'practices');
  if (!practices.ok) return practices;

  // ---- instruction text (LF5)
  const paths = d.instructions.map((x) => x.path);
  if (new Set(paths).size !== paths.length)
    return refuse('invalid_input', 'a file is affirmed twice');
  if (!paths.includes('AGENTS.md'))
    return refuse('refused', 'LF5: AGENTS.md is affirmed on card 2');
  const bound = boundHashOf(d);
  const affirmations: CardPayloadItem[] = [];
  for (const x of [...d.instructions].sort((a, b) => (a.path < b.path ? -1 : 1))) {
    const r = ctx.reviews.get(x.path);
    if (!r) return refuse('invalid_input', `${x.path} is not on the card`);
    if (r.proposed.blocked !== null || r.proposed.text_sha256 === null) {
      return refuse(
        'refused',
        `${x.path} cannot be affirmed: ${r.proposed.blocked ?? 'no text'} (edit the text on the card)`,
      );
    }
    if (r.proposed.text_sha256 !== x.text_sha256) {
      return refuse('conflict', `${x.path} changed since you saw it: reopen the card`);
    }
    affirmations.push({
      kind: 'instruction_affirmation',
      area: r.area,
      path: r.path,
      text_sha256: r.proposed.text_sha256,
      source_blob_sha: r.source_blob_sha,
      lint_report_hash: r.proposed.lint_report_hash,
      bound_hash: bound as never,
      step_up_ref: o.step_up_ref as never,
    });
  }

  return ok([
    {
      kind: 'light_proposal',
      proposal_hash: proposal.proposal_hash,
      census_hash: proposal.census_hash,
      template_hash: proposal.template_hash,
    },
    ...verdicts,
    {
      kind: 'claims_summary',
      total_high_impact: total,
      affirmed,
      corrected,
      unknown,
      pct: Math.round(share * 10000) / 100,
      claims_hash: hashCanonical({ claims: proposal.claims, verdicts }) as never,
    },
    {
      kind: 'intent_answers',
      question_set: proposal.question_set,
      answers: intent.value,
      answers_hash: hashCanonical(intent.value) as never,
    },
    {
      kind: 'practices_attestation',
      question_set: proposal.question_set,
      answers: practices.value,
      answers_hash: hashCanonical(practices.value) as never,
    },
    ...affirmations,
  ] as CardPayloadItem[]);
}

/**
 * The PRR's `affirmed` block from a decided card 2 (OB §3.2: `affirmed.instructions`, `claims`,
 * `intent`). `sod_waiver` is the card's ledger entry's; `operations` is attested on card 4.
 */
export function affirmedFromC2(
  payload: readonly CardPayloadItem[],
  o: { readonly decided_by: string; readonly sod_waiver: boolean },
): Result<ProjectReadinessRecord['affirmed'], LightRefusal> {
  const summary = payload.find((p) => p.kind === 'claims_summary');
  const intent = payload.find((p) => p.kind === 'intent_answers');
  const files = payload.flatMap((p) => (p.kind === 'instruction_affirmation' ? [p] : []));
  if (
    summary?.kind !== 'claims_summary' ||
    intent?.kind !== 'intent_answers' ||
    files.length === 0
  ) {
    return refuse('conflict', 'the decided card 2 carries no claims, intent or instruction text');
  }
  return ok({
    instructions: files.map((f) => ({
      area: f.area,
      path: f.path,
      text_sha256: f.text_sha256,
      ...(f.source_blob_sha === null ? {} : { source_blob_sha: f.source_blob_sha }),
      lint_report_hash: f.lint_report_hash,
      step_up_ref: f.step_up_ref,
      sod_waiver: o.sod_waiver,
    })),
    claims: {
      total_high_impact: summary.total_high_impact,
      affirmed: summary.affirmed,
      corrected: summary.corrected,
      unknown: summary.unknown,
      pct: summary.pct,
      claims_hash: summary.claims_hash,
    },
    intent: { answers_hash: intent.answers_hash, attested_by: o.decided_by as never },
    operations: null,
  });
}
