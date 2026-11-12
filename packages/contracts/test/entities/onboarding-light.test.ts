import { describe, expect, it } from 'vitest';
import {
  C2DecisionContent,
  CardPayloadItem,
  DEFAULT_INSTRUCTION_TEMPLATE,
  INTENT_QUESTIONS,
  InstructionProposal,
  InstructionTemplate,
  PRACTICE_QUESTIONS,
  cardPayloadItemKey,
  instructionsBoundHash,
} from '../../src/index.js';

// Card 2's vocabulary (PLAN M16, DEC-11 refined).

const H = 'a'.repeat(64);

describe('card 2 contracts', () => {
  it('the default factory template is valid; the questions are about fifteen intent and a short practices set', () => {
    expect(InstructionTemplate.safeParse(DEFAULT_INSTRUCTION_TEMPLATE).success).toBe(true);
    expect(INTENT_QUESTIONS).toHaveLength(15);
    expect(new Set(INTENT_QUESTIONS.map((q) => q.question_id)).size).toBe(15);
    expect(PRACTICE_QUESTIONS.length).toBeGreaterThan(0);
  });

  it('a proposal with a secret stores no text, and a text always has its hash', () => {
    const base = { lines: 1, lint: [], lint_report_hash: H, blocked: null };
    expect(
      InstructionProposal.safeParse({ ...base, text: 'x', text_sha256: H, secret_hits: 1 }).success,
    ).toBe(false);
    expect(
      InstructionProposal.safeParse({
        ...base,
        text: null,
        text_sha256: null,
        secret_hits: 1,
        blocked: 'secret',
      }).success,
    ).toBe(true);
    expect(
      InstructionProposal.safeParse({ ...base, text: 'x', text_sha256: null, secret_hits: 0 })
        .success,
    ).toBe(false);
  });

  it('a correction goes with `correct` only; at least one file is affirmed', () => {
    const ok = {
      proposal_hash: H,
      claims: [{ claim_id: 'cl-1', verdict: 'correct', correction: 'it is pnpm' }],
      intent_answers: [],
      practices: { attested: true, answers: [] },
      instructions: [{ path: 'AGENTS.md', text_sha256: H }],
    };
    expect(C2DecisionContent.safeParse(ok).success).toBe(true);
    expect(
      C2DecisionContent.safeParse({ ...ok, claims: [{ claim_id: 'cl-1', verdict: 'correct' }] })
        .success,
    ).toBe(false);
    expect(
      C2DecisionContent.safeParse({
        ...ok,
        claims: [{ claim_id: 'cl-1', verdict: 'affirm', correction: 'x' }],
      }).success,
    ).toBe(false);
    expect(C2DecisionContent.safeParse({ ...ok, instructions: [] }).success).toBe(false);
  });

  it('the step-up binds to the affirmed files whatever their order; one affirmation row per path', () => {
    const a = { path: 'AGENTS.md', text_sha256: H };
    const c = { path: 'CLAUDE.md', text_sha256: 'b'.repeat(64) };
    expect(instructionsBoundHash([a, c])).toBe(instructionsBoundHash([c, a]));
    expect(instructionsBoundHash([a])).not.toBe(instructionsBoundHash([a, c]));
    const row = CardPayloadItem.parse({
      kind: 'instruction_affirmation',
      area: '.',
      path: 'AGENTS.md',
      text_sha256: H,
      source_blob_sha: null,
      lint_report_hash: H,
      bound_hash: H,
      step_up_ref: H,
    });
    expect(cardPayloadItemKey(row)).toBe('instruction:AGENTS.md');
  });
});
