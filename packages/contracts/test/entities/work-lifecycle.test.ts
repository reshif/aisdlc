import { describe, expect, it } from 'vitest';
import {
  AdmissionHold,
  Assumption,
  Handoff,
  HandoffChoice,
  HandoffCode,
  HoldReasonValues,
  SPAWN_RULES,
  SpawnEdge,
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
        'agent',
        'approved_gates',
        'attempt',
        'catalogue_ref',
        'command_key',
        'denied_gates',
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

describe('M9.3 and M9.4 vocabulary', () => {
  it('names a kind (and the lanes the flow names) for every edge that starts a NEW linked item', () => {
    expect(Object.keys(SPAWN_RULES).sort()).toEqual([
      'B16',
      'B17',
      'B18',
      'B19',
      'B26',
      'B6',
      'R4',
    ]);
    for (const e of Object.keys(SPAWN_RULES)) expect(SpawnEdge.safeParse(e).success, e).toBe(true);
    expect(SpawnEdge.safeParse('B7').success).toBe(false);
    expect(SPAWN_RULES.B6).toEqual({ kind: 'remediation', lanes: ['L2'] });
    expect(SPAWN_RULES.B16.lanes).toEqual(['L0', 'L1']);
    expect(SPAWN_RULES.B17.lanes).toEqual(['L0', 'L1']);
  });

  it('admission holds are H1-H3 and WIP, all of them hold reasons', () => {
    expect([...AdmissionHold.options]).toEqual(['H1', 'H2', 'H3', 'WIP']);
    for (const r of AdmissionHold.options) expect(HoldReasonValues).toContain(r);
  });

  it('a handoff has one id, the E4 gate instance and the pack are attributes, and its code is D1, D2, D3 or E4', () => {
    expect([...HandoffCode.options]).toEqual(['D1', 'D2', 'D3', 'E4']);
    expect([...HandoffChoice.options]).toContain('takeover');
    // `handoff_id` is the only id the handoff has of its own; the item is its parent, the gate instance an attribute
    const ids = Object.keys(Handoff.shape).filter((k) => k.endsWith('_id'));
    expect(ids.sort()).toEqual(['e4_gate_instance_id', 'handoff_id', 'item_id']);
    expect(Object.keys(Handoff.shape)).toContain('pack');
  });

  it('an assumption is one shape whatever raised it', () => {
    expect(Object.keys(Assumption.shape).sort()).toEqual(
      [
        'assumption_id',
        'item_id',
        'kind',
        'origin',
        'origin_run',
        'overridden_by',
        'raised_at',
        'state',
        'text_hash',
      ].sort(),
    );
  });

  it('a stage can report a hold, a back-edge or a trigger, and nothing else about them', () => {
    expect(StageOutcome.safeParse({ outcome: 'held', reason: 'H2' }).success).toBe(true);
    expect(StageOutcome.safeParse({ outcome: 'held', reason: 'kill' }).success).toBe(false);
    expect(
      StageOutcome.safeParse({ outcome: 'rework', edge: 'B7', reason_code: 'x', observed: 2.5 })
        .success,
    ).toBe(true);
    expect(
      StageOutcome.safeParse({ outcome: 'rework', edge: 'B99', reason_code: 'x' }).success,
    ).toBe(false);
    expect(
      StageOutcome.safeParse({ outcome: 'trigger', trigger: 'ET1', reason_code: 'x' }).success,
    ).toBe(true);
    expect(
      StageOutcome.safeParse({ outcome: 'gate_needed', gate: 'E6', reason_code: 'x' }).success,
    ).toBe(true);
  });
});
