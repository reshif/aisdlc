import { taggedError, type TaggedError } from '@aisdlc/kernel';

export type CoreErrorCode =
  | 'invalid_input'
  | 'not_found'
  /** The state of the aggregate does not allow this (an illegal transition, a repo of another project). */
  | 'conflict'
  /** The PDP, a rule of the catalogue or a port refuses; nothing was changed. */
  | 'refused'
  | 'forbidden'
  | 'unavailable'
  | 'database';

export const CoreError = taggedError('CoreError');
export type CoreError = TaggedError<
  'CoreError',
  { code: CoreErrorCode; message: string; detail?: unknown }
>;

export const coreError = (code: CoreErrorCode, message: string, detail?: unknown): CoreError =>
  CoreError({ code, message, ...(detail === undefined ? {} : { detail }) });

/** HTTP status of each code. */
export const CORE_STATUS: Readonly<Record<CoreErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  conflict: 409,
  refused: 422,
  forbidden: 403,
  unavailable: 503,
  database: 500,
};
