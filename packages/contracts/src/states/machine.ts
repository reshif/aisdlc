import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

/** Refusal of a transition that is not an edge of the machine. Unknown means refused. */
export const InvalidTransition = taggedError('InvalidTransition');
export type InvalidTransition = TaggedError<
  'InvalidTransition',
  { readonly machine: string; readonly from: string; readonly to: string }
>;

/** `Record<From, readonly To[]>`: every state must have a row, an empty row marks a terminal. */
export type TransitionTable<S extends string> = Readonly<Record<S, readonly S[]>>;

export type Machine<S extends string> = {
  readonly name: string;
  readonly table: TransitionTable<S>;
  readonly terminals: readonly S[];
  canTransition(from: S, to: S): boolean;
  assertTransition(from: S, to: S): Result<S, InvalidTransition>;
};

/**
 * Builds the two checks over a table. Fail closed: a pair not in the table, or a value that is not
 * a state at all (data from outside), is refused.
 */
export function defineMachine<S extends string>(
  name: string,
  table: TransitionTable<S>,
): Machine<S> {
  const rows: Readonly<Record<string, readonly string[]>> = table;
  // hasOwn: a state name like `__proto__` or `constructor` must not read through the prototype.
  const canTransition = (from: S, to: S): boolean =>
    Object.hasOwn(rows, from) && (rows[from]?.includes(to) ?? false);
  return {
    name,
    table,
    terminals: (Object.keys(table) as S[]).filter((s) => table[s].length === 0),
    canTransition,
    assertTransition: (from, to) =>
      canTransition(from, to) ? ok(to) : err(InvalidTransition({ machine: name, from, to })),
  };
}
