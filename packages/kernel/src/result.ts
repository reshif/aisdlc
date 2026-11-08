export type Ok<T> = { readonly ok: true; readonly value: T };
export type Err<E> = { readonly ok: false; readonly error: E };
export type Result<T, E> = Ok<T> | Err<E>;

export const ok = <T>(value: T): Ok<T> => ({ ok: true, value });
export const err = <E>(error: E): Err<E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is Ok<T> => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is Err<E> => !r.ok;

export function map<T, U, E>(r: Result<T, E>, f: (t: T) => U): Result<U, E> {
  return r.ok ? ok(f(r.value)) : r;
}

export function mapErr<T, E, F>(r: Result<T, E>, f: (e: E) => F): Result<T, F> {
  return r.ok ? r : err(f(r.error));
}

export function andThen<T, U, E, F>(r: Result<T, E>, f: (t: T) => Result<U, F>): Result<U, E | F> {
  return r.ok ? f(r.value) : r;
}

/** Returns the value or throws the error. For tests and top-level scripts only. */
export function unwrap<T, E>(r: Result<T, E>): T {
  if (r.ok) return r.value;
  throw r.error instanceof Error ? r.error : new Error(`unwrap on Err: ${JSON.stringify(r.error)}`);
}

export type TaggedError<Tag extends string, Fields extends object = Record<never, never>> = {
  readonly _tag: Tag;
} & Readonly<Fields>;

/**
 * `const NotFound = taggedError('NotFound'); NotFound({ id })` gives `{ _tag: 'NotFound', id }`.
 * The returned factory also carries `.tag` and an `.is` type guard.
 */
export function taggedError<const Tag extends string>(tag: Tag) {
  const make = <Fields extends object = Record<never, never>>(
    fields?: Fields,
  ): TaggedError<Tag, Fields> => ({ ...fields, _tag: tag }) as TaggedError<Tag, Fields>;
  make.tag = tag;
  make.is = (value: unknown): value is TaggedError<Tag, Record<string, unknown>> =>
    typeof value === 'object' && value !== null && (value as { _tag?: unknown })._tag === tag;
  return make;
}
