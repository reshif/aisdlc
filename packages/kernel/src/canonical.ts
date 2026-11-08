/**
 * RFC 8785 JSON Canonicalization Scheme (JCS).
 *
 * Accepts only JSON-representable values: null, boolean, finite number, string, arrays and plain
 * objects. Everything else (undefined, functions, symbols, bigint, NaN/Infinity, cycles,
 * non-plain objects) is rejected with a CanonicalJsonError. Fails closed.
 */
export class CanonicalJsonError extends Error {
  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${message} at ${path}`);
    this.name = 'CanonicalJsonError';
  }
}

export function canonicalJson(value: unknown): string {
  return serialize(value, '$', new Set<object>());
}

function serialize(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new CanonicalJsonError('non-finite number', path);
      // ECMAScript Number::toString is exactly the serialisation RFC 8785 §3.2.2.3 requires.
      // String(-0) is "0", as required.
      return String(value);
    case 'string':
      // JSON.stringify is well-formed (escapes lone surrogates) and uses the minimal escapes
      // RFC 8785 §3.2.2.2 requires.
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
    case 'bigint':
      throw new CanonicalJsonError(`unsupported type ${typeof value}`, path);
    case 'object':
      break;
  }
  const obj = value as object;
  if (ancestors.has(obj)) throw new CanonicalJsonError('cycle detected', path);
  ancestors.add(obj);
  try {
    if (Array.isArray(obj)) {
      const parts: string[] = [];
      for (let i = 0; i < obj.length; i++) {
        if (!(i in obj)) throw new CanonicalJsonError('sparse array hole', `${path}[${i}]`);
        parts.push(serialize(obj[i], `${path}[${i}]`, ancestors));
      }
      return `[${parts.join(',')}]`;
    }
    const proto = Object.getPrototypeOf(obj) as unknown;
    if (proto !== Object.prototype && proto !== null) {
      throw new CanonicalJsonError('non-plain object', path);
    }
    const record = obj as Record<string, unknown>;
    // Default sort compares UTF-16 code units, as RFC 8785 §3.2.3 requires.
    const keys = Object.keys(record).sort();
    const parts = keys.map(
      (k) => `${JSON.stringify(k)}:${serialize(record[k], `${path}.${k}`, ancestors)}`,
    );
    return `{${parts.join(',')}}`;
  } finally {
    ancestors.delete(obj);
  }
}
