import { LineCounter, parseDocument, type Document } from 'yaml';
import { parse as parseToml } from 'smol-toml';

// Safe parsers for repo content (PLAN M6.3). Repo files are hostile input, so every parse has a
// size limit before it starts, and a failure is a value, never a throw and never a silent skip:
//   - YAML: the `yaml` package in the `core` schema (no custom tags: an unknown tag is a string with a
//     warning, nothing is constructed), YAML 1.2 (no `<<` merge keys), `maxAliasCount` (a billion-laughs
//     file stops at the alias limit), duplicate keys an error, no prototype keys. Anchors and aliases
//     beyond the limit refuse the file.
//   - JSON: JSON.parse after a size check; JSONC (comments, trailing commas: tsconfig, devcontainer,
//     VS Code files) is cleaned by a string-aware stripper first.
//   - TOML: smol-toml, a pure parser (TOML 1.0), no evaluation.
// Nothing here evaluates, includes, fetches or expands anything.

export const YAML_MAX_BYTES = 512 * 1024;
export const JSON_MAX_BYTES = 2 * 1024 * 1024;
export const TOML_MAX_BYTES = 512 * 1024;
export const YAML_MAX_ALIASES = 50;
const MAX_DEPTH = 64;

export type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  /** `limit:` prefix: over a parser limit (coverage `parse_limit`); else unparseable. */
  | { readonly ok: false; readonly why: string };

const bad = (why: string): { ok: false; why: string } => ({ ok: false, why });

/** Depth of a parsed value; a deeper tree is refused (a stack-exhaustion shape), cut off early. */
function tooDeep(v: unknown, depth = 0): boolean {
  if (depth > MAX_DEPTH) return true;
  if (Array.isArray(v)) return v.some((x) => tooDeep(x, depth + 1));
  if (v !== null && typeof v === 'object')
    return Object.values(v as Record<string, unknown>).some((x) => tooDeep(x, depth + 1));
  return false;
}

export function parseJson(text: string, maxBytes = JSON_MAX_BYTES): Parsed<unknown> {
  if (Buffer.byteLength(text) > maxBytes) return bad(`limit: JSON over ${maxBytes} bytes`);
  try {
    const v: unknown = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    return tooDeep(v) ? bad('limit: JSON nested deeper than 64 levels') : { ok: true, value: v };
  } catch {
    return bad('not valid JSON');
  }
}

/** Removes line and block comments and trailing commas, outside strings. Never evaluates. */
export function stripJsonc(text: string): string {
  let out = '';
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i] as string;
    if (ch === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === '/' && text[i + 1] === '/') {
      while (i < n && text[i] !== '\n') i++;
    } else if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? n : end + 2;
      // Keep the newlines, so line numbers stay true.
      out += text.slice(i, stop).replace(/[^\n]/g, ' ');
      i = stop;
    } else {
      out += ch;
      i++;
    }
  }
  // Trailing commas before } or ], outside strings (strings were copied whole above, so re-walk).
  let res = '';
  for (let k = 0; k < out.length; k++) {
    const c = out[k] as string;
    if (c === '"') {
      let j = k + 1;
      while (j < out.length && out[j] !== '"') j += out[j] === '\\' ? 2 : 1;
      res += out.slice(k, j + 1);
      k = j;
    } else if (c === ',') {
      let j = k + 1;
      while (j < out.length && /\s/.test(out[j] as string)) j++;
      if (out[j] === '}' || out[j] === ']') continue;
      res += c;
    } else res += c;
  }
  return res;
}

export function parseJsonc(text: string, maxBytes = JSON_MAX_BYTES): Parsed<unknown> {
  if (Buffer.byteLength(text) > maxBytes) return bad(`limit: JSON over ${maxBytes} bytes`);
  return parseJson(stripJsonc(text), maxBytes);
}

export function parseTomlSafe(
  text: string,
  maxBytes = TOML_MAX_BYTES,
): Parsed<Record<string, unknown>> {
  if (Buffer.byteLength(text) > maxBytes) return bad(`limit: TOML over ${maxBytes} bytes`);
  try {
    const v = parseToml(text) as Record<string, unknown>;
    return tooDeep(v) ? bad('limit: TOML nested deeper than 64 levels') : { ok: true, value: v };
  } catch {
    return bad('not valid TOML');
  }
}

export interface YamlDoc {
  readonly doc: Document.Parsed;
  readonly value: unknown;
  readonly lines: LineCounter;
}

export function parseYamlSafe(text: string, maxBytes = YAML_MAX_BYTES): Parsed<YamlDoc> {
  if (Buffer.byteLength(text) > maxBytes) return bad(`limit: YAML over ${maxBytes} bytes`);
  try {
    const lines = new LineCounter();
    const doc = parseDocument(text, {
      version: '1.2',
      schema: 'core',
      merge: false,
      customTags: [],
      uniqueKeys: true,
      prettyErrors: false,
      lineCounter: lines,
      strict: true,
    });
    if (doc.errors.length > 0) {
      const aliasy = doc.errors.some((e) => /alias/i.test(e.message));
      return bad(aliasy ? 'limit: YAML alias count over the limit' : 'not valid YAML');
    }
    let value: unknown;
    try {
      value = doc.toJS({ maxAliasCount: YAML_MAX_ALIASES });
    } catch (e) {
      const aliasy = e instanceof Error && /alias|excessive/i.test(e.message);
      return bad(aliasy ? 'limit: YAML alias expansion over the limit' : 'not valid YAML');
    }
    if (tooDeep(value)) return bad('limit: YAML nested deeper than 64 levels');
    return { ok: true, value: { doc, value: value ?? null, lines } };
  } catch {
    // RangeError on hostile nesting, or any parser failure: the file is unparseable, not trusted.
    return bad('not valid YAML');
  }
}

/** 1-based line of a YAML node (its first character), or 1. */
export function yamlLine(y: YamlDoc, node: unknown): number {
  const range = (node as { range?: [number, number, number] } | null | undefined)?.range;
  return range ? y.lines.linePos(range[0]).line : 1;
}
