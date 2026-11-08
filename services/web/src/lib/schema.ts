// A validator for the JSON Schema a card sends with its decision form (2020-12 as `z.toJSONSchema`
// writes it for the contracts: type, properties, required, additionalProperties, propertyNames,
// const, enum, pattern, length and size limits, items, oneOf and anyOf). It is written out here and
// not taken from a library because the usual validators compile schemas with `new Function`, which
// the portal's content security policy (default-src 'self') forbids. The server validates the same
// content again with the same contracts; this only tells the person early and in words.

export type JsonSchema = {
  readonly [key: string]: unknown;
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const typeOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;

function matchesType(t: string, v: unknown): boolean {
  if (t === 'number') return typeof v === 'number' && Number.isFinite(v);
  if (t === 'integer') return typeof v === 'number' && Number.isInteger(v);
  return typeOf(v) === t;
}

const where = (path: string): string => (path === '' ? 'the decision' : path);

function check(schema: JsonSchema, value: unknown, path: string, out: string[]): void {
  const types = schema['type'];
  if (typeof types === 'string' || Array.isArray(types)) {
    const list = (Array.isArray(types) ? types : [types]) as string[];
    if (!list.some((t) => matchesType(t, value))) {
      out.push(`${where(path)} must be ${list.join(' or ')}`);
      return;
    }
  }
  if ('const' in schema && JSON.stringify(schema['const']) !== JSON.stringify(value)) {
    out.push(`${where(path)} must be ${JSON.stringify(schema['const'])}`);
    return;
  }
  const options = schema['enum'];
  if (Array.isArray(options) && !options.some((o) => JSON.stringify(o) === JSON.stringify(value))) {
    out.push(`${where(path)} must be one of ${options.map((o) => JSON.stringify(o)).join(', ')}`);
    return;
  }
  if (typeof value === 'string') {
    const min = schema['minLength'];
    const max = schema['maxLength'];
    const pattern = schema['pattern'];
    if (typeof min === 'number' && value.length < min) {
      out.push(`${where(path)} must not be empty`);
    }
    if (typeof max === 'number' && value.length > max) {
      out.push(`${where(path)} is too long (at most ${max} characters)`);
    }
    if (typeof pattern === 'string' && !new RegExp(pattern).test(value)) {
      out.push(`${where(path)} has a form that is not allowed`);
    }
    if (schema['format'] === 'date-time' && Number.isNaN(Date.parse(value))) {
      out.push(`${where(path)} must be a date and time`);
    }
  }
  if (typeof value === 'number') {
    const min = schema['minimum'];
    const max = schema['maximum'];
    if (typeof min === 'number' && value < min) out.push(`${where(path)} must be at least ${min}`);
    if (typeof max === 'number' && value > max) out.push(`${where(path)} must be at most ${max}`);
  }
  if (Array.isArray(value)) {
    const min = schema['minItems'];
    const max = schema['maxItems'];
    if (typeof min === 'number' && value.length < min) {
      out.push(`${where(path)} needs at least ${min} ${min === 1 ? 'entry' : 'entries'}`);
    }
    if (typeof max === 'number' && value.length > max) {
      out.push(`${where(path)} has too many entries (at most ${max})`);
    }
    const items = schema['items'];
    if (isObject(items)) value.forEach((x, i) => check(items, x, `${path}[${i}]`, out));
  }
  if (isObject(value)) {
    const props = isObject(schema['properties']) ? schema['properties'] : {};
    const required = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    for (const k of required) {
      if (!(k in value) || value[k] === undefined) {
        out.push(`${path === '' ? k : `${path}.${k}`} is required`);
      }
    }
    const extra = schema['additionalProperties'];
    const names = schema['propertyNames'];
    for (const [k, v] of Object.entries(value)) {
      if (v === undefined) continue;
      const at = path === '' ? k : `${path}.${k}`;
      if (isObject(names)) check(names, k, `${at} (name)`, out);
      const known = props[k];
      if (isObject(known)) check(known, v, at, out);
      else if (extra === false) out.push(`${at} is not something this decision takes`);
      else if (isObject(extra)) check(extra, v, at, out);
    }
  }
  const one = schema['oneOf'];
  if (Array.isArray(one)) {
    const hits = one.filter((s) => {
      const sub: string[] = [];
      check(s as JsonSchema, value, path, sub);
      return sub.length === 0;
    }).length;
    if (hits !== 1) out.push(`${where(path)} does not fit any of the allowed forms`);
  }
  const any = schema['anyOf'];
  if (Array.isArray(any)) {
    const hit = any.some((s) => {
      const sub: string[] = [];
      check(s as JsonSchema, value, path, sub);
      return sub.length === 0;
    });
    if (!hit) out.push(`${where(path)} does not fit any of the allowed forms`);
  }
  const all = schema['allOf'];
  if (Array.isArray(all)) for (const s of all) check(s as JsonSchema, value, path, out);
}

/** The reasons `value` does not fit `schema`, in plain words; empty when it does. */
export function validateAgainst(schema: JsonSchema, value: unknown): string[] {
  const out: string[] = [];
  check(schema, value, '', out);
  return out;
}
