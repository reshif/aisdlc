import { describe, expect, it } from 'vitest';
import { AGENT_SPECS, agentDefinition, agentKeyRequest } from '../src/index.js';
import {
  agentEnabled,
  agentSettingsDefaults,
  agentSettingsFrom,
  coderLimitsOf,
  withAgentSettings,
} from '../src/settings.js';

// Per-agent settings (agents.config): the defaults are the contracts' values, a change reaches the key the
// gateway mints, and no setting reaches the tools or the data class.

const snap = (v: unknown, rejected: string[] = []) => ({
  rejected,
  get: (k: string) => (k === 'agents.config' ? v : undefined),
});

describe('agents.config', () => {
  it('defaults are every contract’s models and budget, all on, the coder at 40 turns / 1800 s / 600 s', () => {
    const d = agentSettingsDefaults();
    for (const s of AGENT_SPECS) {
      expect(d[s.agent_id]).toMatchObject({ enabled: true, models: s.models, budget: s.budget });
    }
    expect(coderLimitsOf(d)).toEqual({ max_turns: 40, run_time_s: 1800, test_time_s: 600 });
    expect(agentSettingsFrom(snap(undefined))).toEqual(d);
  });

  it('a change is in force; tools and data class stay the contract’s', () => {
    const t = agentSettingsFrom(
      snap({
        A1: { enabled: false },
        coder: {
          max_turns: 80,
          budget: { max_tokens: 10, max_cost_micro_usd: 20, ttl_seconds: 600 },
        },
      }),
    );
    if (!t) throw new Error('unreadable');
    expect(agentEnabled(t, 'A1')).toBe(false);
    expect(agentEnabled(t, 'A2')).toBe(true);
    expect(coderLimitsOf(t).max_turns).toBe(80);
    const coder = agentDefinition('coder');
    const def = withAgentSettings(coder, t.coder);
    const k = agentKeyRequest(def, {
      scope: { kind: 'unit', ref: 'i' },
      group: 'g',
      project_id: 'p1' as never,
      now: new Date('2026-11-13T00:00:00Z'),
    });
    expect(k.budget).toMatchObject({ max_tokens: 10, max_cost_micro_usd: 20 });
    expect(k.mint.expires_at).toBe('2026-11-13T00:10:00.000Z');
    expect(k.mint.tools).toEqual([...coder.contract.tools]);
    expect(k.mint.data_class_max).toBe(coder.contract.data_class_max);
  });

  it('an unreadable published value is null (nothing is dispatched)', () => {
    expect(agentSettingsFrom(snap({ A1: { enabled: 'no' } }))).toBeNull();
    expect(agentSettingsFrom(snap(undefined, ['agents.config']))).toBeNull();
  });
});
