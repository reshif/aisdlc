import {
  AssumptionKind,
  CardKind,
  Citation,
  GitSha,
  ProposalActionId,
  HandoffChoice,
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
// SETS nothing: a classifier says what the work is (`work_type`, `size`, `risk`) and the factory derives the lane from the catalogue (G0 binds it, 1.4 checks it); a blocked coder says WHY it is blocked
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

/** What kind of work a request is, as far as lane choice goes (the catalogue's labelled lanes, and ordinary change). */
export const ClassifiedWorkType = z.enum([
  'hotfix',
  'remediation',
  'change',
  'initiative',
  'spike',
]);

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
    // 1.3 says WHAT the work is; the factory derives the lane from these facts by the catalogue's rules
    // (`laneForClassification` in core): the classifier has no field that names a lane. G0 binds the
    // lane the factory proposed; 1.4 checks eligibility.
    work_type: ClassifiedWorkType,
    size: z.enum(['small', 'standard']),
    risk: z.enum(['standard', 'elevated']),
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
    /**
     * 2.1: the points where the intent is ambiguous. Any makes the step raise B2 (back to 1.5, G1 again);
     * absent or empty: the intent is clear. The agent says WHAT is unclear; the factory decides what follows.
     */
    ambiguity: Items(500, 10).optional(),
    /**
     * 4.2 (contracts): the contract files the design proposes. A deterministic checker parses each one
     * (JSON Schema or OpenAPI, as JSON) before the artefact is stored; one that does not parse is refused.
     */
    contract_files: z
      .array(
        z.strictObject({
          path: Text(512),
          format: z.enum(['json_schema', 'openapi']),
          content: Text(100_000),
        }),
      )
      .max(20)
      .optional(),
    /**
     * 4.3 (data and migration): each migration and whether it can be undone. The constitution check (4.5)
     * reads these: a migration that is not reversible must say so (`irreversible_flagged`).
     */
    migrations: z
      .array(
        z.strictObject({
          name: Text(200),
          reversible: z.boolean(),
          irreversible_flagged: z.boolean().optional(),
          note: Text(1000).optional(),
        }),
      )
      .max(50)
      .optional(),
    /**
     * 4.2 and 4.4: the network calls the design adds (a host and why). The constitution check reads these: one
     * the constitution does not allow needs an `approval_ref` (who approved it, as the project names it).
     */
    network_calls: z
      .array(
        z.strictObject({
          host: Text(253),
          purpose: Text(500),
          approval_ref: Text(200).optional(),
        }),
      )
      .max(50)
      .optional(),
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
      /**
       * 2.3: whether the work is as large as its lane is made for (`matches`, the default) or smaller
       * (`smaller`: R2, which a person decides at E1). The agent never names a lane: which one is the
       * factory's (the next rung down the ladder).
       */
      sizing: z.enum(['matches', 'smaller']).optional(),
    })
    .refine((o) => o.recommended < o.options.length, {
      message: 'recommended is not one of the options',
      path: ['recommended'],
    }),
  // ---- S5 (M12.4): one kind per step of the plan, so each answer is checked for what that step is
  // 5.1: the DAG. `unit_key`s are the ids, `depends_on` the edges; the factory refuses a cycle, a dangling
  // edge, a duplicate id and a Unit with no scope.
  z.strictObject({
    kind: z.literal('plan_split'),
    units: z
      .array(
        z.strictObject({
          unit_key: Text(64),
          title: Text(200),
          paths: z.array(Text(512)).min(1).max(50),
          size: z.enum(['small', 'medium', 'large']),
          depends_on: Items(64, 20),
        }),
      )
      .min(1)
      .max(30),
    assumptions: Assumptions,
  }),
  // 5.2: the order Units are built in: every Unit once, a Unit after everything it depends on
  z.strictObject({
    kind: z.literal('plan_sequence'),
    order: z.array(Text(64)).min(1).max(30),
    rationale: Text(2000),
    assumptions: Assumptions,
  }),
  // 5.3: the task plan of each Unit (the artefact is rendered as `plan.md`)
  z.strictObject({
    kind: z.literal('plan_tasks'),
    units: z
      .array(
        z.strictObject({
          unit_key: Text(64),
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
  // 5.4: which oracle specs of G2 each Unit is verified by
  z.strictObject({
    kind: z.literal('plan_verification'),
    bindings: z
      .array(
        z.strictObject({
          unit_key: Text(64),
          oracle_ids: z.array(Text(64)).min(1).max(100),
        }),
      )
      .min(1)
      .max(30),
    assumptions: Assumptions,
  }),
  // 5.6: what the plan asks of people and capacity; the factory bounds it before it is used
  z.strictObject({
    kind: z.literal('plan_capacity'),
    max_parallel_units: z.number().int().min(1).max(30),
    review_minutes: z
      .array(z.strictObject({ unit_key: Text(64), minutes: z.number().int().min(1).max(10_000) }))
      .max(30),
    rationale: Text(2000),
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

// ---------------------------------------------------------------- the assistant (M18, no step)

/**
 * What the onboarding assistant and "Ask the factory" may say: an answer (or the model's own refusal), every sentence
 * of it cited, the actions it suggests as ids from a closed list with the target they are about (the FACTORY makes the
 * button, the route and the PDP action from them, and only for a target the context carried), and drafts the person
 * may put on a card themselves. Nothing here decides, writes or names a route.
 */
export const AssistantOutput = z.strictObject({
  kind: z.enum(['answer', 'refusal']),
  text: Text(4000),
  citations: z.array(Citation).max(20),
  proposals: z
    .array(
      z.strictObject({
        action: ProposalActionId,
        /** The id of the card, S0 record, item or project the action is about. */
        target: z
          .string()
          .min(1)
          .max(128)
          .regex(/^[A-Za-z0-9_.-]+$/),
        label: Text(80),
      }),
    )
    .max(5),
  drafts: z
    .array(z.strictObject({ title: Text(120), text: Text(4000), card: CardKind.nullable() }))
    .max(3),
  /** What the agent noticed: an instruction in repo text, a question outside the person's view, a secret asked for. */
  noticed: z.array(z.enum(['planted_instruction', 'outside_view', 'secret_requested'])).max(3),
});

// ---------------------------------------------------------------- the onboarding agent (portal v2, no step)

/** The kinds of fix the onboarding agent may propose; the FACTORY decides which paths each may write. */
export const OnboardingFixKind = z.enum([
  'codeowners',
  'agents_md',
  'claude_md',
  'protect_main_ruleset',
  'test_command',
]);
export type OnboardingFixKind = z.infer<typeof OnboardingFixKind>;

/** What the onboarding agent learned, by topic (the live checklist of the onboarding page). */
export const OnboardingTopic = z.enum([
  'owners',
  'tests',
  'branch_protection',
  'app_permissions',
  'secrets',
  'instructions',
  'code_map',
]);
export type OnboardingTopic = z.infer<typeof OnboardingTopic>;

/**
 * What the onboarding agent may say about a repo it reads at onboarding (intent §4): what it learned per topic, its
 * claims (each with evidence at the census commit), the fixes it proposes (files for a draft PR, or the steps a person
 * takes on GitHub), its questions, and its suggestion for the gaps of card 1. It decides nothing: the factory checks
 * every file path against the fix's kind, scans every file for secrets, and a person signs off. No field sets a
 * level, a tier above the floor, a gate, tools, egress or a budget.
 */
export const OnboardingOutput = z.strictObject({
  kind: z.literal('onboarding'),
  summary: Text(2000),
  learned: z
    .array(
      z.strictObject({
        topic: OnboardingTopic,
        status: z.enum(['ok', 'needs_fix', 'unknown']),
        text: Text(1000),
        evidence: z.array(Evidence).max(10),
      }),
    )
    .max(20),
  claims: z
    .array(
      z.strictObject({
        claim_id: Text(64),
        text: Text(1000),
        confidence: z.enum(['low', 'medium', 'high']),
        evidence: z.array(Evidence).min(1).max(10),
      }),
    )
    .max(50),
  fixes: z
    .array(
      z.strictObject({
        fix_id: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[a-z0-9_-]+$/),
        fix_kind: OnboardingFixKind,
        title: Text(200),
        why: Text(1000),
        /** The files of the draft PR; empty when only a person can fix it (on GitHub). */
        files: z.array(z.strictObject({ path: Text(300), content: Text(20_000) })).max(3),
        /** What a person does on GitHub, step by step (protect-main cannot be a PR: the App never holds administration). */
        manual_steps: Items(500, 10),
      }),
    )
    .max(8),
  questions: Items(500, 10),
  /** The disposition the agent suggests for each census gap; the person adjusts it in the summary. */
  gap_suggestions: z
    .array(
      z.strictObject({
        gap_id: Text(128),
        disposition: z.enum(['file_issue', 'track_only', 'waive']),
        why: Text(500),
      }),
    )
    .max(200),
});

// ---------------------------------------------------------------- the onboarder (onboarding console, no step)

/**
 * What the onboarder says at the end of a turn, after its tool calls: its words to the person, each statement about
 * the repo cited (a file at the census commit with lines from an excerpt it was served, or a record reference the
 * context carried), and whether it waits for the person. Its proposals and acts are TOOL CALLS (the factory validates
 * and records them), never fields here. No field sets a lane, a gate, tools, egress or a budget.
 */
export const OnboarderTurnOutput = z.strictObject({
  kind: z.literal('turn'),
  text: Text(4000),
  citations: z.array(Citation).max(20),
  /** `await_person`: it needs the person's answer or decision; `done`: nothing is left for it to do; `working`: it will continue by itself when something changes. */
  next: z.enum(['await_person', 'working', 'done']),
  /** What it noticed: an instruction in repo text, a request for a secret. */
  noticed: z.array(z.enum(['planted_instruction', 'secret_requested'])).max(2),
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
  'assistant.v1': AssistantOutput,
  'onboarding.v1': OnboardingOutput,
  'onboarder.v1': OnboarderTurnOutput,
} as const;
export type OutputSchemaId = keyof typeof OUTPUT_SCHEMAS;
