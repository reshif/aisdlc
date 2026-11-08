import { describe, expect, it } from 'vitest';
import {
  Autonomy,
  AutonomyValues,
  DataClassValues,
  ENTRY_CHANNEL_DESCRIPTIONS,
  EntryChannelValues,
  FLEET_REF,
  LANE_LABELS,
  LaneValues,
  LevelValues,
  Scope,
  ScopeKindValues,
  STEPS,
  StageIdValues,
  StepIdValues,
  TierValues,
  parseScopeKey,
  scopeKey,
} from '../src/index.js';

describe('enum values', () => {
  it('matches the specs', () => {
    expect(ScopeKindValues).toEqual([
      'enterprise',
      'org',
      'team',
      'project',
      'repo',
      'service_env',
      'environment',
      'lane',
      'session',
      'item',
      'role',
      'model',
      'release',
      'budget',
      'fleet',
    ]);
    expect(DataClassValues).toEqual(['D0', 'D1', 'D2', 'D3']);
    expect(TierValues).toEqual(['T0', 'T1', 'T2']);
    expect(LevelValues).toEqual(['census', 'light', 'full']);
    expect(AutonomyValues).toEqual(['A0', 'A1', 'A2', 'A3']);
    expect(LaneValues).toEqual(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']);
    expect(StageIdValues).toEqual([
      'S0',
      'S1',
      'S2',
      'S3',
      'S4',
      'S5',
      'S6',
      'S7',
      'S8',
      'S8a',
      'S8b',
      'S9',
    ]);
    expect(EntryChannelValues).toEqual(['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8']);
  });

  it('has the step ids of the flow, each with a stage and an actor', () => {
    expect(StepIdValues).toHaveLength(56);
    for (const id of StepIdValues) {
      expect(STEPS[id].stage).toBeDefined();
      expect(STEPS[id].actor).toBeDefined();
    }
    expect(Object.keys(STEPS).sort()).toEqual([...StepIdValues].sort());
  });

  it('labels lanes only where the specs do', () => {
    expect(LANE_LABELS.L0).toBe('hotfix');
    expect(LANE_LABELS.L7).toBe('spike');
    expect(LANE_LABELS.L8).toBe('human-led');
    expect(LANE_LABELS.L1).toBeNull();
    expect(LANE_LABELS.L3).toBeNull();
    expect(Object.keys(LANE_LABELS)).toEqual([...LaneValues]);
  });

  it('describes only the entry channels the specs describe', () => {
    const described = EntryChannelValues.filter((c) => ENTRY_CHANNEL_DESCRIPTIONS[c] !== null);
    expect(described).toEqual(['N6', 'N8']);
  });

  it('parses enums strictly', () => {
    expect(Autonomy.safeParse('A4').success).toBe(false);
    expect(Autonomy.safeParse('a1').success).toBe(false);
  });
});

describe('Scope', () => {
  it('round-trips key and parse for every kind', () => {
    for (const kind of ScopeKindValues) {
      const scope = Scope.parse(kind === 'fleet' ? { kind, ref: FLEET_REF } : { kind, ref: 'x:y' });
      const parsed = parseScopeKey(scopeKey(scope));
      expect(parsed).toEqual({ ok: true, value: scope });
    }
  });

  it('fixes the fleet ref and rejects empty refs, unknown kinds and extra keys', () => {
    expect(Scope.safeParse({ kind: 'fleet', ref: 'a' }).success).toBe(false);
    expect(Scope.safeParse({ kind: 'repo', ref: '' }).success).toBe(false);
    expect(Scope.safeParse({ kind: 'galaxy', ref: 'a' }).success).toBe(false);
    expect(Scope.safeParse({ kind: 'repo', ref: 'a', extra: 1 }).success).toBe(false);
    expect(scopeKey({ kind: 'fleet', ref: '*' })).toBe('fleet:*');
  });

  it('refuses malformed keys with a tagged error', () => {
    for (const bad of ['', 'repo', 'repo:', ':x', 'nope:x', 'fleet:x']) {
      const r = parseScopeKey(bad);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toEqual({ _tag: 'InvalidScopeKey', input: bad });
    }
  });
});
