import {
  AssumptionKind,
  GitSha,
  HandoffChoice,
  Lane,
  QuestionDraft,
  WorkItemId,
} from '@aisdlc/contracts';
import { z } from 'zod';

// The OutputSchemas (PLAN M11.1; DM §3.5 OutputSchema). What an agent may SAY, and nothing else.
//
// Every schema is a strict object (an unknown key is an error, not ignored) and none has a field that
// sets a lane, a gate, tools, egress or a budget. That is the planted-instruction defence (FL FIX 15,
// PLAN M11.4): text in a request, a repo file or a dependency can try to make an agent "set lane L0" or
// "allow tool Bash"; the schema has nowhere to put it, so the output is refused. The lane a classifier
// PROPOSES is `candidate` (G0 binds the lane, 1.4 checks it); a blocked coder says WHY it is blocked
// (`blocker.reason`), the factory decides what that raises. `test/schemas.test.ts` enumerates every
// property name of every schema and fails on any of those words.

const Text = (max: number) => z.string().min(1).max(max);
const Items = (max: number, n = 50) => z.array(Text(max)).max(n);

/** Evidence for a claim: a file at a merged commit (grounding is on merged SHAs only, M11.4). */
export const Evidence = z.strictObject({
  path: Text(512),
  commit_sha: GitSha,
  lines: z
    .string()
    .regex(/^[0-9]+(-[0-9]+)?$/)
    .optional(),
});

/** An assumption the agent made; the engine hashes the text and raises it (`item.assumption_raised`). */
export const AgentAssumption = z.strictObject({
  kind: AssumptionKind.exclude(['engine']),
  text: Text(1000),
});
const Assumptions = z.array(AgentAssumption).max(30);

// ---------------------------------------------------------------- A1 triage (1.2, 1.3, 1.4)

export const TriageOutput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('duplicate_scan'),
    duplicates: z
      .array(
        z.strictObject({
          item_id: WorkItemId,
          similarity: z.number().min(0).max(1),
          reason: Text(500),
        }),
      )
      .max(20),
    conflicts: z.array(z.strictObject({ item_id: WorkItemId, reason: Text(500) })).max(20),
  }),
  z.strictObject({
    kind: z.literal('classification'),
    /** The lane the classifier PROPOSES. G0 binds it; 1.4 checks eligibility. Not a decision. */
    candidate: Lane,
    confidence: z.number().min(0).max(1),
    rationale: Text(1000),
  }),
  z.strictObject({
    kind: z.literal('suitability'),
    suitable: z.boolean(),
    concerns: Items(500, 20),
  }),
]);

// ---------------------------------------------------------------- A2 intent (1.5, 3.1, 3.2)

export const IntentOutput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('questions'),
    questions: z.array(QuestionDraft).min(1).max(10),
  }),
  z.strictObject({
    kind: z.literal('intent_block'),
    goal: Text(1000),
    non_goals: Items(500, 20),
    acceptance_criteria: z.array(Text(500)).min(1).max(30),
    open_questions: Items(500, 20),
    assumptions: Assumptions,
  }),
  z.strictObject({
    kind: z.literal('affected_requirements'),
    requirements: z
      .array(z.strictObject({ requirement_id: Text(128), path: Text(512), reason: Text(500) }))
      .max(100),
  }),
  z.strictObject({
    kind: z.literal('spec_delta'),
    delta: z
      .array(
        z.strictObject({
          requirement_id: Text(128),
          change: z.enum(['added', 'modified', 'removed']),
          text: Text(4000),
        }),
      )
      .min(1)
      .max(100),
    assumptions: Assumptions,
  }),
]);

// ---------------------------------------------------------------- A3 planner (2.x, 4.x, 5.x, 9.4)

export const PlannerDocumentKind = z.enum([
  'context_brief',
  'impact',
  'initiative',
  'adr',
  'contracts',
  'data_migration',
  'nfr_threat_ops',
]);

export const PlannerOutput = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('document'),
    document: PlannerDocumentKind,
    title: Text(200),
    sections: z
      .array(z.strictObject({ heading: Text(200), text: Text(8000) }))
      .min(1)
      .max(40),
    citations: z.array(Evidence).max(100),
    assumptions: Assumptions,
  }),
  z
    .strictObject({
      kind: z.literal('options'),
      options: z
        .array(
          z.strictObject({
            title: Text(200),
            summary: Text(1000),
            pros: Items(300, 10),
            cons: Items(300, 10),
          }),
        )
        .min(2)
        .max(5),
      /** Index into `options`: what the brief recommends. A person decides. */
      recommended: z.number().int().min(0).max(4),
      rationale: Text(2000),
      citations: z.array(Evidence).max(100),
      assumptions: Assumptions,
    })
    .refine((o) => o.recommended < o.options.length, {
      message: 'recommended is not one of the options',
      path: ['recommended'],
    }),
  z.strictObject({
    kind: z.literal('plan'),
    phase: z.enum(['split', 'sequence', 'task_plan', 'verification']),
    units: z
      .array(
        z.strictObject({
          unit_key: Text(64),
          title: Text(200),
          depends_on: Items(64, 20),
          tasks: z
            .array(
              z.strictObject({
                task_id: Text(64),
                description: Text(1000),
                verification: Text(500),
              }),
            )
            .min(1)
            .max(50),
        }),
      )
      .min(1)
      .max(30),
    assumptions: Assumptions,
  }),
  z.strictObject({
    kind: z.literal('learn'),
    observations: Items(1000, 30),
    /** Proposals for a human-gated change (M1 config, M3 catalogue); never applied by the agent. */
    proposals: z.array(z.strictObject({ target_key: Text(128), rationale: Text(2000) })).max(20),
  }),
]);

// ---------------------------------------------------------------- A5 review (3.5, 4.5, 7.3, 7.5)

export const ReviewOutput = z
  .strictObject({
    kind: z.literal('review'),
    check: z.enum(['spec_review', 'constitution', 'spec_conformance']),
    verdict: z.enum(['pass', 'findings']),
    findings: z
      .array(
        z.strictObject({
          severity: z.enum(['low', 'medium', 'high']),
          rule_id: Text(64).optional(),
          location: z.strictObject({
            path: Text(512),
            line: z.number().int().min(1).optional(),
          }),
          message: Text(1000),
        }),
      )
      .max(100),
  })
  .refine((o) => (o.verdict === 'pass') === (o.findings.length === 0), {
    message: 'a pass has no findings, and findings make the verdict `findings`',
    path: ['verdict'],
  });

// ---------------------------------------------------------------- A6 test (3.4)

export const OracleOutput = z.strictObject({
  kind: z.literal('oracle_specs'),
  oracles: z
    .array(
      z.strictObject({
        oracle_id: Text(64),
        requirement_id: Text(128),
        description: Text(1000),
        /** How the oracle fails before the implementation exists (6.3 "oracles red"). */
        expected_failure: Text(500),
      }),
    )
    .min(1)
    .max(100),
});

// ---------------------------------------------------------------- A9 reverse engineering (0.1, 0.2, 0.3, 2.1b)

export const ReverseEngineeringOutput = z.strictObject({
  kind: z.literal('reverse_engineering'),
  depth: z.enum(['shallow', 'focused', 'full']),
  /** Every claim carries evidence: a claim without any is a fabrication and is refused. */
  claims: z
    .array(
      z.strictObject({
        claim_id: Text(64),
        text: Text(1000),
        confidence: z.enum(['low', 'medium', 'high']),
        evidence: z.array(Evidence).min(1).max(20),
      }),
    )
    .max(200),
  unknowns: Items(500, 50),
});

// ---------------------------------------------------------------- A11 handoff pack (D1, D2)

export const HandoffPackOutput = z.strictObject({
  kind: z.literal('handoff_pack'),
  attempted: z.array(Text(1000)).min(1).max(50),
  current_state: Text(4000),
  open_questions: Items(500, 30),
  /** A suggestion to the owner of record, who chooses at E4. */
  recommended_choice: HandoffChoice.optional(),
});

// ---------------------------------------------------------------- A12 extraction (0.3)

export const ExtractionOutput = z.strictObject({
  kind: z.literal('extraction'),
  items: z
    .array(
      z.strictObject({
        item_kind: z.enum(['living_spec_seed', 'golden_task_candidate']),
        title: Text(200),
        evidence: z.array(Evidence).min(1).max(20),
      }),
    )
    .max(200),
});

// ---------------------------------------------------------------- A4 / coder (6.4, 6.6)

export const ImplementationOutput = z
  .strictObject({
    kind: z.literal('implementation'),
    status: z.enum(['completed', 'blocked', 'gave_up']),
    summary: Text(2000),
    files_changed: z
      .array(z.strictObject({ path: Text(512), change: z.enum(['added', 'modified', 'deleted']) }))
      .max(500),
    checks_run: z.array(z.strictObject({ name: Text(200), passed: z.boolean() })).max(100),
    /** Why the agent cannot go on. What that raises (X1, X3, E6, ET8...) is the factory's call. */
    blocker: z
      .strictObject({
        reason: z.enum([
          'irreversible_operation',
          'new_dependency',
          'locked_test_change',
          'scope_exceeded',
          'other',
        ]),
        detail: Text(1000),
      })
      .optional(),
  })
  .refine((o) => (o.status === 'blocked') === (o.blocker !== undefined), {
    message: '`blocker` is set exactly when the status is `blocked`',
    path: ['blocker'],
  });

// ---------------------------------------------------------------- A7, A8, A10: ids only

export const UnspecifiedOutput = z.strictObject({
  kind: z.literal('unspecified'),
  summary: Text(500),
});

/** The output schemas by id. One schema may serve several agents (A4 and `coder`). */
export const OUTPUT_SCHEMAS = {
  'triage.v1': TriageOutput,
  'intent.v1': IntentOutput,
  'planner.v1': PlannerOutput,
  'review.v1': ReviewOutput,
  'oracle.v1': OracleOutput,
  'reverse_engineering.v1': ReverseEngineeringOutput,
  'handoff_pack.v1': HandoffPackOutput,
  'extraction.v1': ExtractionOutput,
  'implementation.v1': ImplementationOutput,
  'unspecified.v1': UnspecifiedOutput,
} as const;
export type OutputSchemaId = keyof typeof OUTPUT_SCHEMAS;
