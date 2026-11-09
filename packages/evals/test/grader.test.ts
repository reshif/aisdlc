import { describe, expect, it } from 'vitest';
import { grade, isSubset, matchesSchema, unsupportedKeywords, valueAt } from '../src/grader.js';

const out = {
  kind: 'review',
  verdict: 'findings',
  findings: [
    { severity: 'high', rule_id: 'C-4', message: 'Reads a secret from the environment.' },
    { severity: 'low', rule_id: 'C-9', message: 'Long line.' },
  ],
};

describe('graders', () => {
  it('exact: canonical equality, key order free', () => {
    expect(grade({ a: 1, b: [2] }, { type: 'exact', value: { b: [2], a: 1 } })).toBe(true);
    expect(grade({ a: 1 }, { type: 'exact', value: { a: 1, b: 2 } })).toBe(false);
  });

  it('json_subset: keys of the expected are in the output; arrays match element-wise in any position', () => {
    expect(isSubset({ verdict: 'findings' }, out)).toBe(true);
    expect(isSubset({ findings: [{ rule_id: 'C-9' }] }, out)).toBe(true);
    expect(isSubset({ findings: [{ rule_id: 'C-1' }] }, out)).toBe(false);
    expect(isSubset({ verdict: 'pass' }, out)).toBe(false);
    expect(isSubset({ missing: 1 }, out)).toBe(false);
    expect(isSubset({ findings: [] }, { findings: [1] })).toBe(true);
  });

  it('regex: on a path or on the canonical JSON; fails on a missing path or a bad pattern', () => {
    expect(grade(out, { type: 'regex', pattern: 'secret', path: 'findings.0.message' })).toBe(true);
    expect(grade(out, { type: 'regex', pattern: 'secret', path: 'findings.1.message' })).toBe(
      false,
    );
    expect(grade(out, { type: 'regex', pattern: '"verdict":"findings"' })).toBe(true);
    expect(grade(out, { type: 'regex', pattern: 'x', path: 'nope.nope' })).toBe(false);
    expect(
      grade(out, { type: 'regex', pattern: 'SECRET', flags: 'i', path: 'findings.0.message' }),
    ).toBe(true);
    expect(grade(out, { type: 'regex', pattern: '(', path: 'verdict' })).toBe(false);
  });

  it('schema: a JSON Schema subset, and an unknown keyword fails closed', () => {
    const s = {
      type: 'object',
      required: ['kind', 'findings'],
      properties: {
        kind: { const: 'review' },
        findings: { type: 'array', minItems: 1, items: { type: 'object', required: ['severity'] } },
      },
      additionalProperties: true,
    };
    expect(matchesSchema(out, s)).toBe(true);
    expect(matchesSchema({ ...out, findings: [] }, s)).toBe(false);
    expect(matchesSchema({ kind: 'x', findings: [{ severity: 1 }] }, s)).toBe(false);
    expect(matchesSchema(out, { ...s, additionalProperties: false })).toBe(false);
    expect(matchesSchema(1.5, { type: 'integer' })).toBe(false);
    expect(matchesSchema(3, { type: 'number', minimum: 4 })).toBe(false);
    expect(matchesSchema('abc', { type: 'string', pattern: '^a', maxLength: 3 })).toBe(true);
    expect(
      unsupportedKeywords({ type: 'object', oneOf: [], properties: { a: { format: 'x' } } }),
    ).toEqual(['oneOf', 'format']);
    expect(matchesSchema(out, { type: 'object', oneOf: [] })).toBe(false);
  });

  it('valueAt walks objects and arrays and nothing else (no prototype)', () => {
    expect(valueAt(out, 'findings.1.rule_id')).toBe('C-9');
    expect(valueAt(out, 'constructor')).toBeUndefined();
    expect(valueAt('str', 'length')).toBeUndefined();
  });
});
