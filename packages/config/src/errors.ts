import { taggedError, type TaggedError } from '@aisdlc/kernel';
import type { DecisionError } from '@aisdlc/decisions';

export type ConfigErrorCode =
  | 'invalid_input'
  | 'unknown_key'
  | 'invalid_value'
  | 'not_overridable'
  | 'unchanged'
  | 'stale_parent'
  | 'revision_not_found'
  /** No decided approve of an M1 gate for exactly this hash: the publish is refused. */
  | 'not_decided'
  | 'decision'
  | 'database';

/** A refusal. Every error is a refusal, never a publish (AGENTS.md: fail closed). */
export const ConfigError = taggedError('ConfigError');
export type ConfigError = TaggedError<
  'ConfigError',
  { code: ConfigErrorCode; message: string; decision?: DecisionError }
>;

export const configError = (
  code: ConfigErrorCode,
  message: string,
  decision?: DecisionError,
): ConfigError => ConfigError({ code, message, ...(decision ? { decision } : {}) });
