import { agentSettingsFrom, coderLimitsOf } from '@aisdlc/agents';
import type { ConfigReader } from '@aisdlc/config';
import {
  AgentsSettingsConfig,
  DEFAULT_PLANNING_SIZE_SHARE,
  PlanningSizeShareConfig,
  SETTINGS_KEYS,
  settingFrom,
} from '@aisdlc/contracts';

// Portal v2: core's readers of the settings that were constants (screen map §5). Each is read on every use from the
// config reader's snapshot, so a published revision is in force without a restart. Fail closed: a published value
// that no longer reads is `null` where the caller refuses (agents, the 5.5 envelope).

/** `agents.settings` (H12-H14): the table in force, the contracts' values where unset; `null`: unreadable. */
export const agentSettingsOf =
  (reader: ConfigReader): (() => AgentsSettingsConfig | null) =>
  () =>
    agentSettingsFrom(reader.current());

/** The coding session's turns and times (H13) from the coder's row; unreadable: the defaults (nothing is dispatched then). */
export const coderLimitsFrom = (reader: ConfigReader) => () =>
  coderLimitsOf(agentSettingsFrom(reader.current()));

/** The coder's model when the factory set one (H12), else `fallback` (the deployment's route). */
export const coderModelFrom =
  (reader: ConfigReader, fallback: string): (() => string) =>
  () => {
    const t = settingFrom(
      reader.current(),
      SETTINGS_KEYS.agents_settings,
      AgentsSettingsConfig,
      {},
    );
    return t?.coder?.models?.[0] ?? fallback;
  };

/** `planning.size_share` (H15); `null`: unreadable (5.5 makes no envelope). */
export const sizeShareFrom =
  (reader: ConfigReader): (() => PlanningSizeShareConfig | null) =>
  () =>
    settingFrom(
      reader.current(),
      SETTINGS_KEYS.planning_size_share,
      PlanningSizeShareConfig,
      DEFAULT_PLANNING_SIZE_SHARE,
    );
