import { describe, expect, it } from 'vitest';
import {
  ACTION_IDS,
  AskRequest,
  AssistantBudgetGroupId,
  Citation,
  ProposalButton,
  REFUSAL_TEXT,
  RefusalCodeValues,
  ThreadSubject,
  TurnRecordedPayload,
  pdpResource,
} from '../../src/index.js';

const SHA = 'a'.repeat(40);
const H = 'b'.repeat(64);
const UUID = '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b';

describe('conversation vocabulary (PLAN M18)', () => {
  it('a file citation names a path, a commit and an ordered line range', () => {
    const ok = { kind: 'file', path: 'AGENTS.md', commit_sha: SHA, line_from: 4, line_to: 9 };
    expect(Citation.safeParse(ok).success).toBe(true);
    expect(Citation.safeParse({ ...ok, line_to: 3 }).success).toBe(false);
    expect(Citation.safeParse({ ...ok, commit_sha: 'main' }).success).toBe(false);
    expect(Citation.safeParse({ ...ok, path: 'a\nb' }).success).toBe(false);
    expect(Citation.safeParse({ kind: 'record', ref: `card:${UUID}` }).success).toBe(true);
    expect(Citation.safeParse({ kind: 'record', ref: 'https://example.com' }).success).toBe(false);
    expect(Citation.safeParse({ kind: 'ledger', ref: `ledger:${UUID}` }).success).toBe(true);
  });

  it('a proposal button carries a catalogue action and a normal route, nothing a model could run', () => {
    const b = {
      action_id: 'recheck_controls',
      label: 'Re-check the controls',
      kind: 'call',
      route: { method: 'POST', path: `/api/cards/${UUID}/recheck` },
      pdp_action: 'card.decide',
      resource: pdpResource.card('acme', UUID),
    };
    expect(ProposalButton.safeParse(b).success).toBe(true);
    expect(ProposalButton.safeParse({ ...b, pdp_action: 'card.approve' }).success).toBe(false);
    expect(ProposalButton.safeParse({ ...b, action_id: 'approve_card' }).success).toBe(false);
    expect(
      ProposalButton.safeParse({ ...b, route: { method: 'DELETE', path: '/api/x' } }).success,
    ).toBe(false);
    expect(
      ProposalButton.safeParse({ ...b, route: { method: 'POST', path: 'https://x/y' } }).success,
    ).toBe(false);
    expect(ACTION_IDS).toContain('card.decide');
  });

  it('a turn event carries hashes and refs, never the text', () => {
    const e = {
      thread_id: UUID,
      seq: 1,
      role: 'person',
      kind: 'message',
      payload: { payload_id: UUID, sha256: H, redactions: [] },
      citations: [],
      proposals: [],
      drafts: [],
      flags: [],
      refusal: null,
      grounding_sha: null,
      ask_id: null,
    };
    expect(TurnRecordedPayload.safeParse(e).success).toBe(true);
    expect(TurnRecordedPayload.safeParse({ ...e, text: 'hello' }).success).toBe(false);
  });

  it('a subject is an S0 record or a project; an ask names a thread or a subject, not both', () => {
    expect(ThreadSubject.safeParse({ kind: 's0', s0_id: UUID, project_id: 'acme' }).success).toBe(
      true,
    );
    const base = { text: 'why?', on_behalf_of: 'alice', viewer_data_class: 'D1' };
    expect(AskRequest.safeParse({ ...base, thread_id: UUID }).success).toBe(true);
    expect(
      AskRequest.safeParse({ ...base, subject: { kind: 'project', project_id: 'acme' } }).success,
    ).toBe(true);
    expect(AskRequest.safeParse(base).success).toBe(false);
    expect(
      AskRequest.safeParse({
        ...base,
        thread_id: UUID,
        subject: { kind: 'project', project_id: 'acme' },
      }).success,
    ).toBe(false);
  });

  it('the day budget group names no principal, and every refusal has its fixed text', () => {
    const group = `assistant_user_day:${'c'.repeat(24)}:2026-11-12`;
    expect(AssistantBudgetGroupId.safeParse(group).success).toBe(true);
    expect(AssistantBudgetGroupId.safeParse('assistant_user_day:alice:2026-11-12').success).toBe(
      false,
    );
    for (const c of RefusalCodeValues) expect(REFUSAL_TEXT[c].length).toBeGreaterThan(10);
  });
});
