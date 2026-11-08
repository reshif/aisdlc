import { describe, expect, it } from 'vitest';
import {
  andThen,
  err,
  isErr,
  isOk,
  map,
  mapErr,
  ok,
  taggedError,
  unwrap,
  type Result,
} from '../src/index.js';

const NotFound = taggedError('NotFound');
const Invalid = taggedError('Invalid');

describe('Result', () => {
  it('maps and chains', () => {
    const r = andThen(
      map(ok(2), (n) => n * 3),
      (n) => (n > 5 ? ok(`big ${n}`) : err(Invalid())),
    );
    expect(r).toEqual(ok('big 6'));
    expect(isOk(r)).toBe(true);
  });

  it('short-circuits on error', () => {
    const e = err(NotFound()) as Result<number, ReturnType<typeof NotFound>>;
    expect(map(e, (n) => n + 1)).toBe(e);
    expect(andThen(e, () => ok(1))).toBe(e);
    expect(isErr(e)).toBe(true);
    expect(mapErr(e, (x) => x._tag)).toEqual(err('NotFound'));
    expect(() => unwrap(e)).toThrow();
    expect(unwrap(ok(1))).toBe(1);
  });
});

describe('taggedError', () => {
  it('builds tagged values with fields and a guard', () => {
    const e = NotFound({ id: 'x' });
    expect(e).toEqual({ _tag: 'NotFound', id: 'x' });
    expect(NotFound.is(e)).toBe(true);
    expect(NotFound.is(Invalid())).toBe(false);
    expect(NotFound.is(null)).toBe(false);
  });
});
