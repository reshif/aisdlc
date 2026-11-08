import { describe, expect, it } from 'vitest';
import {
  ENTRY_CHANNEL_SOURCES,
  EntryChannelValues,
  ITEM_EVENT,
  ItemCommand,
  ItemEventPayloads,
  ItemEventTypeValues,
  OPEN_INTAKE_CHANNELS,
  SpawnLink,
  StageOutcome,
  StageRequest,
  TaintedText,
  itemStream,
} from '../../src/index.js';

describe('work lifecycle vocabulary (PLAN M9.1, M9.2)', () => {
  it('names a source for the channels the specs name, and opens only portal Ask and API', () => {
    expect(Object.keys(ENTRY_CHANNEL_SOURCES).sort()).toEqual([...EntryChannelValues].sort());
    expect(OPEN_INTAKE_CHANNELS.map((c) => ENTRY_CHANNEL_SOURCES[c])).toEqual([
      'portal_ask',
      'api',
    ]);
    expect(ENTRY_CHANNEL_SOURCES.N6).toBe('factory_proposed');
    expect(ENTRY_CHANNEL_SOURCES.N8).toBe('onboarding_hold');
  });

  it('has one payload schema for every item event, and the stream is item:<id>', () => {
    expect(Object.keys(ItemEventPayloads).sort()).toEqual([...ItemEventTypeValues].sort());
    expect(Object.values(ITEM_EVENT).every((t) => /^item\.[a-z_]+$/.test(t))).toBe(true);
    expect(itemStream('abc')).toBe('item:abc');
  });

  const taint = {
    text: 'hello',
    taint: 'untrusted',
    origin: 'request',
    provenance: {
      channel: 'N1',
      source: 'portal_ask',
      received_at: '2026-11-09T08:00:00.000Z',
      submitted_by: 'alice',
      raw_sha256: 'a'.repeat(64),
      normalised_sha256: 'b'.repeat(64),
    },
    flags: [{ rule: 'L-DIRECTIVE', line: 1 }],
  };

  it('text from outside is always marked untrusted and cannot be built without its provenance', () => {
    expect(TaintedText.safeParse(taint).success).toBe(true);
    expect(TaintedText.safeParse({ ...taint, taint: 'trusted' }).success).toBe(false);
    const noProv: Record<string, unknown> = { ...taint };
    delete noProv['provenance'];
    expect(TaintedText.safeParse(noProv).success).toBe(false);
    expect(TaintedText.safeParse({ ...taint, flags: [{ rule: 'L-NOPE', line: 1 }] }).success).toBe(
      false,
    );
    expect(TaintedText.safeParse({ ...taint, extra: 1 }).success).toBe(false);
  });

  it('a stage cannot say anything a real port could not, and is never handed request text', () => {
    expect(
      StageOutcome.safeParse({ outcome: 'completed', output_hash: 'a'.repeat(64) }).success,
    ).toBe(true);
    expect(
      StageOutcome.safeParse({ outcome: 'gate_needed', gate: 'G4', reason_code: 'x' }).success,
    ).toBe(false);
    expect(
      StageOutcome.safeParse({ outcome: 'gate_needed', gate: 'X3', reason_code: 'x' }).success,
    ).toBe(true);
    expect(StageOutcome.safeParse({ outcome: 'questions', questions: [] }).success).toBe(false);
    expect(Object.keys(StageRequest.shape).sort()).toEqual(
      [
        'approved_gates',
        'attempt',
        'catalogue_ref',
        'command_key',
        'item_id',
        'lane',
        'project_id',
        'repo',
        'step',
      ].sort(),
    );
  });

  it('every command has a key; a spawn edge is one of the NEW linked item edges', () => {
    expect(ItemCommand.safeParse({ type: 'check_eligibility', key: '', lane: 'L1' }).success).toBe(
      false,
    );
    const link = {
      item_id: '00000000-0000-4000-8000-000000000001',
      origin_item_id: '00000000-0000-4000-8000-000000000002',
      origin_seq: 3,
      index: 0,
      edge: 'B18',
      kind: 'rejected_rework',
      lane: 'L1',
      status: 'open',
    };
    expect(SpawnLink.safeParse(link).success).toBe(true);
    for (const edge of ['B16', 'B17', 'B19', 'B26', 'R4']) {
      expect(SpawnLink.safeParse({ ...link, edge }).success, edge).toBe(true);
    }
    for (const edge of ['B1', 'B22', 'R1'])
      expect(SpawnLink.safeParse({ ...link, edge }).success, edge).toBe(false);
  });
});
