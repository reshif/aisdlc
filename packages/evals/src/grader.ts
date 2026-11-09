import type { EvalGrader } from '@aisdlc/contracts';
import { canonicalJson } from '@aisdlc/kernel';

// Deterministic graders (PLAN M11.3; an LLM judge is out of scope). They run AFTER `validateOutput`
// accepted the output, on the parsed JSON. A grader that cannot decide says no (fail closed).

const isObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v);

const same = (a: unknown, b: unknown): boolean => {
  try {
    return canonicalJson(a) === canonicalJson(b);
  } catch {
    return false;
  }
};

/** `findings.0.message` -> the value at that path, or `undefined`. */
export function valueAt(v: unknown, path: string | undefined): unknown {
  if (path === undefined) return v;
  let cur: unknown = v;
  for (const part of path.split('.')) {
    if (Array.isArray(cur)) cur = cur[Number(part)];
    else if (isObject(cur)) cur = Object.hasOwn(cur, part) ? cur[part] : undefined;
    else return undefined;
  }
  return cur;
}

/** Every key of `exp` is in `act` with a matching value; each element of an expected array matches some element. */
export function isSubset(exp: unknown, act: unknown): boolean {
  if (Array.isArray(exp)) {
    return Array.isArray(act) && exp.every((e) => act.some((a) => isSubset(e, a)));
  }
  if (isObject(exp)) {
    return (
      isObject(act) &&
      Object.entries(exp).every(([k, v]) => Object.hasOwn(act, k) && isSubset(v, act[k]))
    );
  }
  return same(exp, act);
}

const SCHEMA_KEYWORDS = new Set([
  'type',
  'enum',
  'const',
  'required',
  'properties',
  'additionalProperties',
  'items',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'minimum',
  'maximum',
  'pattern',
  'anyOf',
  'description',
  'title',
]);

/** The keywords of a schema this grader does not know (it would silently not check them). */
export function unsupportedKeywords(schema: unknown, out: string[] = []): string[] {
  if (!isObject(schema)) return out;
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYWORDS.has(k)) out.push(k);
    else if (k === 'properties' && isObject(v))
      for (const s of Object.values(v)) unsupportedKeywords(s, out);
    else if (k === 'items' || k === 'additionalProperties') unsupportedKeywords(v, out);
    else if (k === 'anyOf' && Array.isArray(v)) for (const s of v) unsupportedKeywords(s, out);
  }
  return out;
}

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

/** A JSON Schema subset (see `unsupportedKeywords`). An unknown keyword fails the check. */
export function matchesSchema(v: unknown, schema: unknown): boolean {
  if (schema === true) return true;
  if (!isObject(schema)) return false;
  if (unsupportedKeywords(schema).length > 0) return false;
  const s = schema;
  if (s['type'] !== undefined) {
    const want = Array.isArray(s['type']) ? (s['type'] as unknown[]) : [s['type']];
    const t = typeOf(v);
    if (!want.some((w) => w === t || (w === 'number' && t === 'integer'))) return false;
  }
  if (Array.isArray(s['enum']) && !s['enum'].some((e) => same(e, v))) return false;
  if (Object.hasOwn(s, 'const') && !same(s['const'], v)) return false;
  if (Array.isArray(s['anyOf']) && !s['anyOf'].some((x) => matchesSchema(v, x))) return false;
  if (typeof v === 'string') {
    if (typeof s['minLength'] === 'number' && v.length < s['minLength']) return false;
    if (typeof s['maxLength'] === 'number' && v.length > s['maxLength']) return false;
    if (typeof s['pattern'] === 'string' && !new RegExp(s['pattern']).test(v)) return false;
  }
  if (typeof v === 'number') {
    if (typeof s['minimum'] === 'number' && v < s['minimum']) return false;
    if (typeof s['maximum'] === 'number' && v > s['maximum']) return false;
  }
  if (Array.isArray(v)) {
    if (typeof s['minItems'] === 'number' && v.length < s['minItems']) return false;
    if (typeof s['maxItems'] === 'number' && v.length > s['maxItems']) return false;
    if (s['items'] !== undefined && !v.every((x) => matchesSchema(x, s['items']))) return false;
  }
  if (isObject(v)) {
    const props = isObject(s['properties']) ? s['properties'] : {};
    if (
      Array.isArray(s['required']) &&
      !s['required'].every((r) => typeof r === 'string' && Object.hasOwn(v, r))
    ) {
      return false;
    }
    for (const [k, sub] of Object.entries(props)) {
      if (Object.hasOwn(v, k) && !matchesSchema(v[k], sub)) return false;
    }
    if (
      s['additionalProperties'] === false &&
      Object.keys(v).some((k) => !Object.hasOwn(props, k))
    ) {
      return false;
    }
    if (isObject(s['additionalProperties'])) {
      for (const [k, x] of Object.entries(v)) {
        if (!Object.hasOwn(props, k) && !matchesSchema(x, s['additionalProperties'])) return false;
      }
    }
  }
  return true;
}

/** Does `output` (already validated against the agent's OutputSchema) satisfy the case's grader? */
export function grade(output: unknown, grader: EvalGrader): boolean {
  try {
    switch (grader.type) {
      case 'exact':
        return same(grader.value, output);
      case 'json_subset':
        return isSubset(grader.value, output);
      case 'schema':
        return matchesSchema(output, grader.schema);
      case 'regex': {
        const target = valueAt(output, grader.path);
        if (target === undefined) return false;
        const text = typeof target === 'string' ? target : canonicalJson(target);
        return new RegExp(grader.pattern, grader.flags ?? '').test(text);
      }
    }
  } catch {
    return false;
  }
}
