import type { DesignFacts } from '@aisdlc/verify';

// S4's deterministic halves (PLAN M12.3): 4.2's contract checker and 4.5's constitution rules. Both are pure:
// the same design gives the same findings, with no model and no I/O.

export interface DesignFinding {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const f = (code: string, path: string, message: string): DesignFinding => ({ code, path, message });

// ---------------------------------------------------------------- 4.2 contracts

export interface ContractFile {
  readonly path?: unknown;
  readonly format?: unknown;
  readonly content?: unknown;
}

const JSON_TYPES = new Set(['null', 'boolean', 'object', 'array', 'number', 'integer', 'string']);
const MAX_DEPTH = 40;
const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];

/** A path inside the repo: relative, no `..`, no backslash, no NUL. */
const safePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length > 0 &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  !p.includes('\0') &&
  !p.split('/').includes('..');

/** Resolves a local `$ref` (`#/a/b`) against a document; remote references are refused. */
function resolves(doc: unknown, ref: string): boolean {
  if (ref === '#') return true;
  if (!ref.startsWith('#/')) return false;
  let at: unknown = doc;
  for (const raw of ref.slice(2).split('/')) {
    const seg = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!isObj(at) && !Array.isArray(at)) return false;
    at = (at as Obj)[seg];
    if (at === undefined) return false;
  }
  return true;
}

/** Walks a JSON Schema: the keywords that have a shape are checked for it (it is a syntax check, not a validator). */
function schemaFindings(doc: unknown, node: unknown, path: string, depth: number): DesignFinding[] {
  if (depth > MAX_DEPTH) return [f('too_deep', path, 'the schema nests too deeply')];
  if (typeof node === 'boolean') return [];
  if (!isObj(node)) return [f('not_a_schema', path, 'a schema is an object or a boolean')];
  const out: DesignFinding[] = [];
  const sub = (v: unknown, at: string) => out.push(...schemaFindings(doc, v, at, depth + 1));
  const t = node['type'];
  if (t !== undefined) {
    const types = Array.isArray(t) ? t : [t];
    if (types.length === 0 || types.some((x) => typeof x !== 'string' || !JSON_TYPES.has(x))) {
      out.push(
        f('bad_type', `${path}.type`, 'type is one of the JSON Schema types, or a list of them'),
      );
    }
  }
  for (const k of ['properties', 'patternProperties', '$defs', 'definitions']) {
    const v = node[k];
    if (v === undefined) continue;
    if (!isObj(v)) out.push(f('bad_keyword', `${path}.${k}`, `${k} is an object of schemas`));
    else for (const [name, s] of Object.entries(v)) sub(s, `${path}.${k}.${name}`);
  }
  const req = node['required'];
  if (req !== undefined) {
    if (
      !Array.isArray(req) ||
      req.some((x) => typeof x !== 'string') ||
      new Set(req).size !== req.length
    ) {
      out.push(
        f('bad_keyword', `${path}.required`, 'required is a list of distinct property names'),
      );
    } else if (isObj(node['properties']) && node['additionalProperties'] === undefined) {
      for (const r of req as string[]) {
        if (!(r in (node['properties'] as Obj))) {
          out.push(
            f('required_not_declared', `${path}.required`, `${r} is required but has no schema`),
          );
        }
      }
    }
  }
  const items = node['items'];
  if (items !== undefined) {
    if (Array.isArray(items)) items.forEach((x, i) => sub(x, `${path}.items[${i}]`));
    else sub(items, `${path}.items`);
  }
  if (node['additionalProperties'] !== undefined)
    sub(node['additionalProperties'], `${path}.additionalProperties`);
  for (const k of ['allOf', 'anyOf', 'oneOf']) {
    const v = node[k];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0)
      out.push(f('bad_keyword', `${path}.${k}`, `${k} is a non-empty list of schemas`));
    else v.forEach((x, i) => sub(x, `${path}.${k}[${i}]`));
  }
  if (node['not'] !== undefined) sub(node['not'], `${path}.not`);
  const en = node['enum'];
  if (en !== undefined && (!Array.isArray(en) || en.length === 0)) {
    out.push(f('bad_keyword', `${path}.enum`, 'enum is a non-empty list'));
  }
  for (const k of ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf']) {
    if (node[k] !== undefined && typeof node[k] !== 'number') {
      out.push(f('bad_keyword', `${path}.${k}`, `${k} is a number`));
    }
  }
  for (const k of [
    'minLength',
    'maxLength',
    'minItems',
    'maxItems',
    'minProperties',
    'maxProperties',
  ]) {
    const v = node[k];
    if (v !== undefined && !(typeof v === 'number' && Number.isInteger(v) && v >= 0)) {
      out.push(f('bad_keyword', `${path}.${k}`, `${k} is a non-negative integer`));
    }
  }
  const ref = node['$ref'];
  if (ref !== undefined) {
    if (typeof ref !== 'string' || !resolves(doc, ref)) {
      out.push(f('unresolved_ref', `${path}.$ref`, 'a $ref must point inside the same document'));
    }
  }
  return out;
}

function openapiFindings(doc: Obj, path: string): DesignFinding[] {
  const out: DesignFinding[] = [];
  if (typeof doc['openapi'] !== 'string' || !/^3\.[01]\.\d+$/.test(doc['openapi'])) {
    out.push(f('bad_openapi_version', `${path}.openapi`, 'openapi is a 3.0.x or 3.1.x version'));
  }
  const info = doc['info'];
  if (!isObj(info) || typeof info['title'] !== 'string' || typeof info['version'] !== 'string') {
    out.push(f('bad_info', `${path}.info`, 'info needs a title and a version'));
  }
  const paths = doc['paths'];
  if (!isObj(paths)) {
    out.push(f('bad_paths', `${path}.paths`, 'paths is an object'));
    return out;
  }
  for (const [route, item] of Object.entries(paths)) {
    const at = `${path}.paths[${route}]`;
    if (!route.startsWith('/')) out.push(f('bad_route', at, 'a path starts with /'));
    if (!isObj(item)) {
      out.push(f('bad_paths', at, 'a path item is an object'));
      continue;
    }
    for (const [m, op] of Object.entries(item)) {
      if (!HTTP_METHODS.includes(m)) continue;
      if (!isObj(op) || !isObj(op['responses']) || Object.keys(op['responses']).length === 0) {
        out.push(f('missing_responses', `${at}.${m}`, 'an operation declares its responses'));
      }
    }
  }
  const schemas = isObj(doc['components']) ? (doc['components'] as Obj)['schemas'] : undefined;
  if (isObj(schemas)) {
    for (const [name, s] of Object.entries(schemas)) {
      out.push(...schemaFindings(doc, s, `${path}.components.schemas.${name}`, 0));
    }
  }
  return out;
}

/**
 * 4.2: every contract file the design proposes must be what it says it is. `json_schema` and `openapi` are
 * parsed as JSON and their keywords checked for shape (a syntax and structure check, not a full validator:
 * no remote references are fetched). A path outside the repo, a duplicate path or text that does not parse
 * is a finding.
 */
export function checkContractFiles(files: readonly ContractFile[] | undefined): DesignFinding[] {
  const out: DesignFinding[] = [];
  const seen = new Set<string>();
  (files ?? []).forEach((file, i) => {
    const at = `contract_files[${i}]`;
    if (!safePath(file.path)) {
      out.push(f('bad_path', `${at}.path`, 'a contract path is inside the repository'));
    } else if (seen.has(file.path)) {
      out.push(f('duplicate_path', `${at}.path`, 'two contract files have one path'));
    } else seen.add(file.path);
    if (typeof file.content !== 'string') {
      out.push(f('not_text', `${at}.content`, 'a contract file has text content'));
      return;
    }
    let doc: unknown;
    try {
      doc = JSON.parse(file.content);
    } catch {
      out.push(f('parse_error', `${at}.content`, 'the contract does not parse as JSON'));
      return;
    }
    if (file.format === 'openapi') {
      if (!isObj(doc))
        out.push(f('not_a_document', `${at}.content`, 'an OpenAPI document is an object'));
      else out.push(...openapiFindings(doc, `${at}.content`));
    } else if (file.format === 'json_schema') {
      out.push(...schemaFindings(doc, doc, `${at}.content`, 0));
    } else out.push(f('unknown_format', `${at}.format`, 'the format is json_schema or openapi'));
  });
  return out;
}

// ---------------------------------------------------------------- 4.5 constitution

// The constitution's ONE rule evaluator moved to `@aisdlc/verify` (M14.3): 7.5 runs the same rules over the code.
export { evaluateConstitution, type ConstitutionFinding, type DesignFacts } from '@aisdlc/verify';

/** The facts of the design from its stored artefacts' content (each may be absent). */
export function designFactsOf(a: {
  contracts?: unknown;
  data_migration?: unknown;
  nfr_threat_ops?: unknown;
}): DesignFacts {
  const list = (v: unknown, k: string): unknown[] =>
    isObj(v) && Array.isArray(v[k]) ? (v[k] as unknown[]) : [];
  return {
    network_calls: [
      ...list(a.contracts, 'network_calls'),
      ...list(a.nfr_threat_ops, 'network_calls'),
    ].filter(isObj),
    migrations: list(a.data_migration, 'migrations').filter(isObj),
  };
}
