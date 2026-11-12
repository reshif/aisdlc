import {
  C3DecisionContent,
  ff2Of,
  serviceEnvId,
  type CardPayloadItem,
  type FullBaseline,
  type PrrAffirmedFull,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';
import { lintText } from '@aisdlc/text-lint';
import { ff1Of, type FullRefusal } from './baseline.js';

// What a person's card 3 approval becomes: the list payload of the ledger entry (SP-PROC-2). Every rule
// is checked before anything is written, and a refusal says which one:
//   - the baseline shown is the baseline recorded;
//   - FF1: the code graph is whole, the system map has its areas, and every area has a seed;
//   - every interview question is answered as text;
//   - every exam answer is graded; the score is MEASURED, never a gate (DEC-15(a): any score passes);
//   - every seed has a verdict, a correction only with `correct`; affirm and correct make it
//     `intended`, `keep_observed` leaves it `observed` (FF1 holds either way);
//   - every golden-task candidate is accepted or rejected;
//   - FF2 (L5 only): the services declared once each, their ServiceEnvs and the staging-separation attestation;
//     FF2 is met only for `yes` with a service in both staging and production (`ff2Of`); optional, unmet without;
//   - nothing a person typed holds a secret or a blocking lint finding (a corrected seed reaches agents
//     as data). Pure.

const refuse = (code: FullRefusal['code'], message: string): Result<never, FullRefusal> =>
  err({ code, message });

export interface C3Context {
  readonly baseline: FullBaseline;
  /** The project the ServiceEnvs belong to (absent: the baseline's repository names them). */
  readonly project_id?: string;
}

const hasSecret = (s: string): boolean => scanText(s).length > 0;

/** Exactly the ids wanted, each once. */
function coverage(
  want: readonly string[],
  given: readonly string[],
  what: string,
): FullRefusal | null {
  if (new Set(given).size !== given.length)
    return { code: 'invalid_input', message: `a ${what} is decided twice` };
  const extra = given.filter((g) => !want.includes(g));
  if (extra.length > 0)
    return { code: 'invalid_input', message: `not a ${what} on the card: ${extra.join(', ')}` };
  const missing = want.filter((w) => !given.includes(w));
  if (missing.length > 0) {
    return {
      code: 'refused',
      message: `every ${what} is decided: ${missing.length} are not (${missing.slice(0, 5).join(', ')})`,
    };
  }
  return null;
}

export function planC3(ctx: C3Context, content: unknown): Result<CardPayloadItem[], FullRefusal> {
  const p = C3DecisionContent.safeParse(content ?? {});
  if (!p.success) return refuse('invalid_input', p.error.message);
  const d = p.data;
  const b = ctx.baseline;
  if (d.baseline_hash !== b.baseline_hash) {
    return refuse('conflict', 'the baseline changed since you saw it: reopen the card');
  }
  const ff1 = ff1Of(b);
  if (ff1.state !== 'met') {
    return refuse(
      'refused',
      `FF1 is not met (${ff1.reasons.join(', ')}); card 3 cannot be approved: send it back`,
    );
  }

  // ---- the interview
  const q = coverage(
    b.intent_questions.map((x) => x.question_id),
    d.intent_answers.map((a) => a.question_id),
    'interview question',
  );
  if (q) return err(q);
  if (d.intent_answers.some((a) => hasSecret(a.answer))) {
    return refuse('refused', 'an answer holds a secret: it is never stored; remove it');
  }
  const answers = b.intent_questions.map((x) => {
    const a = d.intent_answers.find((y) => y.question_id === x.question_id) as { answer: string };
    return { question_id: x.question_id, answer: a.answer };
  });

  // ---- the exam (measured)
  const e = coverage(
    b.exam.map((x) => x.question_id),
    d.exam.map((x) => x.question_id),
    'exam answer',
  );
  if (e) return err(e);
  const grades = b.exam.map((x) => ({
    question_id: x.question_id,
    grade: (
      d.exam.find((y) => y.question_id === x.question_id) as {
        grade: 'correct' | 'incorrect' | 'unsure';
      }
    ).grade,
  }));
  const n = (g: string) => grades.filter((x) => x.grade === g).length;
  const correct = n('correct');
  const incorrect = n('incorrect');
  const graded = correct + incorrect;

  // ---- seeds
  const s = coverage(
    b.seeds.map((x) => x.seed_id),
    d.seeds.map((x) => x.seed_id),
    'seed',
  );
  if (s) return err(s);
  for (const x of d.seeds) {
    if (x.correction === undefined) continue;
    if (hasSecret(x.correction))
      return refuse('refused', 'a correction holds a secret: it is never stored; remove it');
    const blocking = lintText(x.correction).filter((f) => f.severity === 'blocking');
    if (blocking.length > 0) {
      return refuse(
        'refused',
        `a correction is not clean (${[...new Set(blocking.map((f) => f.rule))].join(', ')}): a spec reaches agents as data; rewrite it`,
      );
    }
  }
  const seedRows: CardPayloadItem[] = b.seeds.map((seed) => {
    const v = d.seeds.find((y) => y.seed_id === seed.seed_id) as (typeof d.seeds)[number];
    return {
      kind: 'seed_verdict',
      seed_id: seed.seed_id,
      area: seed.area,
      verdict: v.verdict,
      status: v.verdict === 'keep_observed' ? 'observed' : 'intended',
      text_sha256: (v.correction === undefined
        ? seed.text_sha256
        : sha256Hex(v.correction)) as never,
      ...(v.correction === undefined ? {} : { correction: v.correction }),
    };
  });
  const intended = seedRows.filter(
    (r) => r.kind === 'seed_verdict' && r.status === 'intended',
  ).length;

  // ---- golden-task candidates
  const g = coverage(
    b.golden_candidates.map((x) => x.candidate_id),
    d.golden.map((x) => x.candidate_id),
    'golden-task candidate',
  );
  if (g) return err(g);
  const accepted = b.golden_candidates
    .filter((c) => d.golden.find((y) => y.candidate_id === c.candidate_id)?.verdict === 'accept')
    .map((c) => c.candidate_id);
  const rejected = b.golden_candidates
    .map((c) => c.candidate_id)
    .filter((id) => !accepted.includes(id));

  // ---- FF2 (L5 only): the services, their environments and the staging-separation attestation
  const envRows: CardPayloadItem[] = [];
  if (d.service_envs !== undefined) {
    const decl = d.service_envs;
    const names = decl.services.map((x) => x.service);
    if (new Set(names).size !== names.length) {
      return refuse('invalid_input', 'a service is declared twice');
    }
    const project = ctx.project_id ?? b.repo;
    const envs = decl.services
      .flatMap((x) =>
        [...new Set(x.environments)].map((environment) => ({
          service_env_id: serviceEnvId(project, x.service, environment),
          service: x.service,
          environment,
        })),
      )
      .sort((a, z) => (a.service_env_id < z.service_env_id ? -1 : 1));
    envRows.push({
      kind: 'service_envs',
      envs,
      staging_separation: decl.staging_separation,
      ff2: ff2Of(decl).state,
      envs_hash: hashCanonical({ envs, staging_separation: decl.staging_separation }) as never,
    });
  }

  return ok([
    {
      kind: 'full_baseline',
      baseline_hash: b.baseline_hash,
      census_hash: b.census_hash,
      graph_hash: b.graph.graph_hash,
      map_hash: b.system_map.map_hash,
      oracle_lock_hash: b.oracle_lock.lock_hash,
      areas: b.system_map.areas.map((a) => a.area),
    },
    {
      kind: 'intent_answers',
      question_set: b.question_set,
      answers,
      answers_hash: hashCanonical(answers) as never,
    },
    {
      kind: 'exam_score',
      grades,
      questions: grades.length,
      correct,
      incorrect,
      unsure: n('unsure'),
      score_pct: graded === 0 ? null : Math.round((correct / graded) * 10000) / 100,
      exam_hash: hashCanonical({ exam: b.exam, grades }) as never,
    },
    ...seedRows,
    {
      kind: 'seeds_summary',
      total: seedRows.length,
      intended,
      observed: seedRows.length - intended,
      seeds_hash: hashCanonical({ seeds: b.seeds.map((x) => x.seed_id), rows: seedRows }) as never,
    },
    {
      kind: 'golden_selection',
      accepted,
      rejected,
      golden_hash: hashCanonical({
        candidates: b.golden_candidates.filter((c) => accepted.includes(c.candidate_id)),
      }) as never,
    },
    ...envRows,
  ] as CardPayloadItem[]);
}

/** The PRR's `affirmed.full` from a decided card 3 (OB §2.4). Hashes and counts only. */
export function affirmedFullFrom(
  payload: readonly CardPayloadItem[],
  o: { readonly decided_by: string },
): Result<PrrAffirmedFull, FullRefusal> {
  const base = payload.find((p) => p.kind === 'full_baseline');
  const intent = payload.find((p) => p.kind === 'intent_answers');
  const exam = payload.find((p) => p.kind === 'exam_score');
  const seeds = payload.find((p) => p.kind === 'seeds_summary');
  const golden = payload.find((p) => p.kind === 'golden_selection');
  const envs = payload.find((p) => p.kind === 'service_envs');
  if (
    base?.kind !== 'full_baseline' ||
    intent?.kind !== 'intent_answers' ||
    exam?.kind !== 'exam_score' ||
    seeds?.kind !== 'seeds_summary' ||
    golden?.kind !== 'golden_selection'
  ) {
    return refuse(
      'conflict',
      'the decided card 3 carries no baseline, interview, exam, seeds or golden tasks',
    );
  }
  return ok({
    baseline_hash: base.baseline_hash,
    graph_hash: base.graph_hash,
    map_hash: base.map_hash,
    areas: [...base.areas],
    intent: { answers_hash: intent.answers_hash, attested_by: o.decided_by as never },
    seeds: {
      total: seeds.total,
      intended: seeds.intended,
      observed: seeds.observed,
      seeds_hash: seeds.seeds_hash,
    },
    exam: {
      questions: exam.questions,
      correct: exam.correct,
      incorrect: exam.incorrect,
      unsure: exam.unsure,
      score_pct: exam.score_pct,
      exam_hash: exam.exam_hash,
    },
    golden: { accepted: golden.accepted.length, golden_hash: golden.golden_hash },
    oracle_lock_hash: base.oracle_lock_hash,
    ...(envs?.kind === 'service_envs'
      ? {
          service_envs: {
            envs: envs.envs,
            staging_separation: envs.staging_separation,
            ff2: envs.ff2,
            envs_hash: envs.envs_hash,
          },
        }
      : {}),
  });
}
