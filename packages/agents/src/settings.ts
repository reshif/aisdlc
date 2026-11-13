import {
  AgentsSettingsConfig,
  DEFAULT_CODER_LIMITS,
  SETTINGS_KEYS,
  settingFrom,
  type AgentDefinition,
  type AgentId,
  type AgentSettingsRow,
  type SettingsSnapshot,
} from '@aisdlc/contracts';
import { AGENT_SPECS } from './spec-data.js';

// Per-agent settings (portal v2, H12-H14; config `agents.settings`, factory layer, M1-gated). The factory owner sets
// an agent on or off, its models, its key's budget and, for the coding agent, its turns and time limits. The default
// of every field is the agent CONTRACT's value (spec-data), so an unset key changes nothing. What a setting never
// reaches: the contract's tools and most sensitive data (no field for them), and anything a request, repo text or an
// agent's output says (only a published config revision is read). The key the gateway mints is still built by
// `agentKeyRequest`, from the definition `withAgentSettings` returns.

/** Today's values: every agent on, with its contract's models and budget; the coder with the coding port's limits. */
export function agentSettingsDefaults(): AgentsSettingsConfig {
  return Object.fromEntries(
    AGENT_SPECS.map((s) => [
      s.agent_id,
      {
        enabled: true,
        models: [...s.models],
        budget: { ...s.budget },
        ...(s.agent_id === 'coder' ? { ...DEFAULT_CODER_LIMITS } : {}),
      } satisfies AgentSettingsRow,
    ]),
  );
}

/**
 * The table in force from a config snapshot: the published value over the contract's values (per field). `null`:
 * the published value no longer fits its schema; the caller dispatches nothing (fail closed).
 */
export function agentSettingsFrom(
  c: SettingsSnapshot | null | undefined,
): AgentsSettingsConfig | null {
  const v = settingFrom(c, SETTINGS_KEYS.agents_settings, AgentsSettingsConfig, {});
  if (v === null) return null;
  const base = agentSettingsDefaults();
  const out: AgentsSettingsConfig = {};
  for (const id of Object.keys(base) as AgentId[]) {
    out[id] = { ...base[id], ...(v[id] ?? {}) };
  }
  return out;
}

/** Is the agent on? An agent the table does not name is on (the contract's default). */
export const agentEnabled = (table: AgentsSettingsConfig, id: AgentId): boolean =>
  table[id]?.enabled !== false;

/**
 * The definition with the factory's settings applied: models and budget from the row, everything else (tools, data
 * class, schemas, prompt) the contract's. No row: the definition unchanged.
 */
export function withAgentSettings(
  def: AgentDefinition,
  row: AgentSettingsRow | undefined,
): AgentDefinition {
  if (!row || (row.models === undefined && row.budget === undefined)) return def;
  return {
    ...def,
    contract: {
      ...def.contract,
      models: row.models ? [...row.models] : def.contract.models,
      budget: row.budget ? { ...row.budget } : def.contract.budget,
    },
  };
}

/** The coding session's limits in force (turns, run time, test time), from the coder's row. */
export function coderLimitsOf(table: AgentsSettingsConfig | null): {
  max_turns: number;
  run_time_s: number;
  test_time_s: number;
} {
  const r = table?.coder;
  return {
    max_turns: r?.max_turns ?? DEFAULT_CODER_LIMITS.max_turns,
    run_time_s: r?.run_time_s ?? DEFAULT_CODER_LIMITS.run_time_s,
    test_time_s: r?.test_time_s ?? DEFAULT_CODER_LIMITS.test_time_s,
  };
}
