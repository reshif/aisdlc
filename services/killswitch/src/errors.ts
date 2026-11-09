import { taggedError, type TaggedError } from '@aisdlc/kernel';

export type KillswitchErrorCode =
  'invalid_request' | 'unauthenticated' | 'forbidden' | 'not_found' | 'conflict' | 'unavailable';

export const KillswitchError = taggedError('KillswitchError');
export type KillswitchError = TaggedError<
  'KillswitchError',
  { code: KillswitchErrorCode; message: string; reasons?: readonly string[] }
>;
export const killswitchError = (
  code: KillswitchErrorCode,
  message: string,
  reasons?: readonly string[],
): KillswitchError =>
  KillswitchError({ code, message, ...(reasons === undefined ? {} : { reasons }) });

export const KILLSWITCH_STATUS: Readonly<Record<KillswitchErrorCode, number>> = {
  invalid_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  unavailable: 503,
};
