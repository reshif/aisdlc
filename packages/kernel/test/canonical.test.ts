import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { canonicalJson, CanonicalJsonError } from '../src/index.js';

describe('canonicalJson: RFC 8785 vectors', () => {
  // RFC 8785 Appendix B (IEEE 754 doubles given as hex bit patterns).
  const numbers: [bigint, string][] = [
    [0x0000000000000000n, '0'],
    [0x8000000000000000n, '0'],
    [0x0000000000000001n, '5e-324'],
    [0x8000000000000001n, '-5e-324'],
    [0x7fefffffffffffffn, '1.7976931348623157e+308'],
    [0xffefffffffffffffn, '-1.7976931348623157e+308'],
    [0x4340000000000000n, '9007199254740992'],
    [0xc340000000000000n, '-9007199254740992'],
    [0x4430000000000000n, '295147905179352830000'],
    [0x44b52d02c7e14af5n, '9.999999999999997e+22'],
    [0x44b52d02c7e14af6n, '1e+23'],
    [0x44b52d02c7e14af7n, '1.0000000000000001e+23'],
    [0x444b1ae4d6e2ef4en, '999999999999999700000'],
    [0x444b1ae4d6e2ef4fn, '999999999999999900000'],
    [0x444b1ae4d6e2ef50n, '1e+21'],
    [0x3eb0c6f7a0b5ed8cn, '9.999999999999997e-7'],
    [0x3eb0c6f7a0b5ed8dn, '0.000001'],
    [0x41b3de4355555553n, '333333333.3333332'],
    [0x41b3de4355555554n, '333333333.33333325'],
    [0x41b3de4355555555n, '333333333.3333333'],
    [0x41b3de4355555556n, '333333333.3333334'],
    [0x41b3de4355555557n, '333333333.33333343'],
    [0xbecbf647612f3696n, '-0.0000033333333333333333'],
    [0x43143ff3c1cb0959n, '1424953923781206.2'],
  ];
  it.each(numbers)('number bits %x serialises as %s', (bits, expected) => {
    const view = new DataView(new ArrayBuffer(8));
    view.setBigUint64(0, bits);
    expect(canonicalJson(view.getFloat64(0))).toBe(expected);
  });

  it('serialises the Section 3.2.4 structured example', () => {
    const input = {
      numbers: [333333333.3333333, 1e30, 4.5, 2e-3, 0.000000000000000000000000001],
      string: '€$\u000f\n' + "A'B" + '"' + '\\'.repeat(2) + '"/',
      literals: [null, true, false],
    };
    expect(canonicalJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],' +
        '"string":"€$\\u000f\\nA\'B\\"' +
        '\\'.repeat(4) +
        '\\"/"}',
    );
  });

  it('sorts keys by UTF-16 code units (Section 3.2.3 example)', () => {
    const input: Record<string, string> = {
      '€': 'Euro Sign',
      '\r': 'Carriage Return',
      דּ: 'Hebrew Letter Dalet With Dagesh',
      '1': 'One',
      '😀': 'Emoji: Grinning Face',
      '\u0080': 'Control',
      ö: 'Latin Small Letter O With Diaeresis',
    };
    const keys = ['\r', '1', '\u0080', '\u00f6', '\u20ac', '\ud83d\ude00', '\ufb33'];
    const expected = keys.map((k) => `${JSON.stringify(k)}:${JSON.stringify(input[k])}`);
    expect(canonicalJson(input)).toBe(`{${expected.join(',')}}`);
    // Surrogate pair sorts before U+FB33 although its code point is larger.
    expect(canonicalJson({ דּ: 1, '😀': 2 })).toBe('{"😀":2,"דּ":1}');
  });

  it('emits no whitespace and handles nesting', () => {
    expect(canonicalJson({ b: [1, { z: 1, a: [] }], a: {} })).toBe(
      '{"a":{},"b":[1,{"a":[],"z":1}]}',
    );
  });
});

describe('canonicalJson: rejection', () => {
  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['-Infinity', -Infinity],
    ['undefined', undefined],
    ['function', () => 1],
    ['bigint', 1n],
    ['symbol', Symbol('x')],
    ['Date', new Date(0)],
    ['Map', new Map()],
    ['nested undefined', { a: undefined }],
    ['sparse array', [1, , 3]], // eslint-disable-line no-sparse-arrays
  ])('rejects %s', (_name, value) => {
    expect(() => canonicalJson(value)).toThrow(CanonicalJsonError);
  });

  it('rejects cycles but allows shared (non-cyclic) references', () => {
    const a: Record<string, unknown> = {};
    a['self'] = a;
    expect(() => canonicalJson(a)).toThrow(/cycle/);
    const shared = { x: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"x":1},{"x":1}]');
  });
});

describe('canonicalJson: properties', () => {
  const json: fc.Arbitrary<unknown> = fc.jsonValue();

  function shuffleKeys(v: unknown, seed: number): unknown {
    if (Array.isArray(v)) return v.map((x) => shuffleKeys(x, seed));
    if (v !== null && typeof v === 'object') {
      const entries = Object.entries(v as Record<string, unknown>);
      const rotated = entries.map((_, i) => entries[(i + seed) % entries.length]!).reverse();
      return Object.fromEntries(rotated.map(([k, x]) => [k, shuffleKeys(x, seed)]));
    }
    return v;
  }

  it('is invariant under key insertion order', () => {
    fc.assert(
      fc.property(json, fc.nat(50), (v, seed) => {
        expect(canonicalJson(shuffleKeys(v, seed))).toBe(canonicalJson(v));
      }),
    );
  });

  it('round-trips through JSON.parse and is idempotent', () => {
    fc.assert(
      fc.property(json, (v) => {
        const c = canonicalJson(v);
        expect(canonicalJson(JSON.parse(c))).toBe(c);
      }),
    );
  });
});
