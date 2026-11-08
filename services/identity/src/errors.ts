import { taggedError, type TaggedError } from '@aisdlc/kernel';

export type IdentityErrorCode =
  /** The input fails its contract or a rule of the catalogue. */
  | 'invalid_input'
  | 'not_found'
  /** Something else already holds the id, handle or external identity. */
  | 'already_exists'
  /** A concurrent writer got there first; retry. */
  | 'conflict'
  /** Bindings of a role slot, and the groups they use, change only through the role map. */
  | 'generated_only'
  | 'protected_group'
  | 'unknown_principal'
  /** A settings document, a port or a rule refuses; nothing was changed. */
  | 'refused'
  | 'unavailable'
  | 'ledger'
  | 'database';

export const IdentityError = taggedError('IdentityError');
export type IdentityError = TaggedError<
  'IdentityError',
  { code: IdentityErrorCode; message: string; detail?: unknown }
>;

export const identityError = (
  code: IdentityErrorCode,
  message: string,
  detail?: unknown,
): IdentityError => IdentityError({ code, message, ...(detail === undefined ? {} : { detail }) });

/** HTTP status of each code. */
export const IDENTITY_STATUS: Readonly<Record<IdentityErrorCode, number>> = {
  invalid_input: 400,
  not_found: 404,
  already_exists: 409,
  conflict: 409,
  generated_only: 409,
  protected_group: 409,
  unknown_principal: 422,
  refused: 422,
  unavailable: 503,
  ledger: 502,
  database: 500,
};
