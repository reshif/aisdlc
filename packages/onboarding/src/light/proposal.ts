import {
  INTENT_QUESTIONS,
  LIGHT_PROPOSAL_SCHEMA_ID,
  LIGHT_QUESTION_SET,
  LightProposal,
  PRACTICE_QUESTIONS,
  instructionTemplateHash,
  lightProposalHash,
  type Fact,
  type InstructionPath,
  type InstructionReview,
  type InstructionTemplate,
} from '@aisdlc/contracts';
import { cartographerClaims } from './claims.js';
import { reviewInstructionFile } from './review.js';

// Card 2's proposal (OB §6.2 row 0.2): the claims, the questions and the instruction reviews, built
// from the census facts and the instruction files as read at the census head. Pure and
// deterministic: the same inputs give the same proposal and the same `proposal_hash`.

export interface LightProposalInput {
  readonly s0_id: string;
  readonly repo: string;
  readonly census_hash: string;
  readonly baseline_sha: string;
  readonly facts: readonly Fact[];
  /** The instruction files at the census head: `null` when absent. */
  readonly files: Readonly<
    Record<InstructionPath, { readonly text: string; readonly blob_sha: string } | null>
  >;
  readonly template: InstructionTemplate;
}

export function buildLightProposal(i: LightProposalInput): LightProposal {
  const claims = cartographerClaims(i.facts);
  const reviews: InstructionReview[] = [];
  // AGENTS.md always: absent, the factory drafts it from the template (LF5 needs one affirmed).
  // CLAUDE.md only when the repo has one (the stub is the later X2 pull request's).
  for (const path of ['AGENTS.md', 'CLAUDE.md'] as const) {
    const source = i.files[path];
    if (path !== 'AGENTS.md' && source === null) continue;
    reviews.push(
      reviewInstructionFile({
        path,
        source,
        template: i.template,
        mode: 'source',
        facts: i.facts,
        proposed_by: 'factory',
      }),
    );
  }
  const body = {
    schema: LIGHT_PROPOSAL_SCHEMA_ID,
    s0_id: i.s0_id,
    repo: i.repo,
    census_hash: i.census_hash,
    baseline_sha: i.baseline_sha,
    template_hash: instructionTemplateHash(i.template),
    claims: claims.claims,
    claims_dropped: claims.dropped,
    claims_truncated: claims.truncated,
    question_set: LIGHT_QUESTION_SET,
    intent_questions: [...INTENT_QUESTIONS],
    practice_questions: [...PRACTICE_QUESTIONS],
    instructions: reviews,
  };
  return LightProposal.parse({ ...body, proposal_hash: lightProposalHash(body) });
}
