import { taggedError, type TaggedError } from '@aisdlc/kernel';

export type EvalStoreErrorCode =
  /** `AISDLC_EVAL_STORE` is not set or the path does not exist: there is no store (fail closed). */
  | 'missing'
  /** The path is inside this repository or a git worktree. */
  | 'inside_repo'
  | 'unsigned'
  | 'bad_signature'
  /** A file differs from the manifest, or the manifest lists a file that is gone. */
  | 'tampered'
  /** A file is in the store and not in the manifest. */
  | 'unlisted_file'
  | 'bad_key'
  | 'invalid'
  | 'not_found'
  | 'exists'
  | 'custody'
  | 'io';

export const EvalStoreError = taggedError('EvalStoreError');
export type EvalStoreError = TaggedError<
  'EvalStoreError',
  { code: EvalStoreErrorCode; message: string }
>;
export const storeError = (code: EvalStoreErrorCode, message: string): EvalStoreError =>
  EvalStoreError({ code, message });
