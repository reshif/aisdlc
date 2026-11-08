// The CODEOWNERS parser, shared by the codehost (owner sync) and knowledge (detectors); one parser, never two.
import type { CodeownersOwner, CodeownersParseError } from '@aisdlc/contracts';

// A CODEOWNERS parser (GitHub syntax). Pure string processing: it never executes anything, never
// reads a file and never expands a pattern against a tree. It is the factory's own reading of the
// owners; GitHub's reading is `codeowners/errors`. Lines it cannot use are reported and skipped, as
// GitHub skips them.
//
// Syntax handled: blank lines and `#` comments (whole-line, or after the owners when `#` follows
// whitespace); `pattern owner...` with `\` escaping the next character of the pattern (so `\#` and
// `\ ` work); owners are `@login`, `@org/team` or an e-mail address; a pattern with no owners is
// legal (it clears ownership). Not supported by GitHub and so errors here: patterns starting with
// `!`, patterns with `[` or `]`, and section headers (`[Section]`, GitLab's).

export const MAX_CODEOWNERS_BYTES = 3 * 1024 * 1024;

const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;
const TEAM_SLUG = /^[A-Za-z0-9_.-]{1,100}$/;
const EMAIL = /^[^\s@,]{1,64}@[^\s@,]{1,255}\.[^\s@,]{2,63}$/;

export interface CodeownersRule {
  readonly line: number;
  readonly pattern: string;
  readonly owners: readonly CodeownersOwner[];
}

export interface ParsedCodeowners {
  /** The rules in file order. A later rule with the same pattern replaces an earlier one in `effective`. */
  readonly rules: readonly CodeownersRule[];
  /** The rules in force: the last rule of each distinct pattern. */
  readonly effective: readonly CodeownersRule[];
  /** Every distinct owner of the effective rules, users lower-cased, sorted. */
  readonly owners: readonly CodeownersOwner[];
  readonly errors: readonly CodeownersParseError[];
}

type Token = { text: string; raw: string };

/** Splits a line (comment removed) into pattern and owner tokens; `\x` keeps `x` in the token. */
function tokenize(line: string): { tokens: Token[]; bad: string | null } {
  const tokens: Token[] = [];
  let cur = '';
  let raw = '';
  let inTok = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i] as string;
    if (ch === '\\' && tokens.length === 0) {
      // Escapes apply to the pattern only (the first token).
      const next = line[i + 1];
      if (next === undefined) return { tokens, bad: 'a pattern ends with a lone backslash' };
      cur += next;
      raw += ch + next;
      inTok = true;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      if (inTok) {
        tokens.push({ text: cur, raw });
        cur = '';
        raw = '';
        inTok = false;
      }
      continue;
    }
    if (ch === '#' && !inTok) break; // a comment after the owners
    cur += ch;
    raw += ch;
    inTok = true;
  }
  if (inTok) tokens.push({ text: cur, raw });
  return { tokens, bad: null };
}

function parseOwner(token: string): CodeownersOwner | string {
  if (token.startsWith('@')) {
    const body = token.slice(1);
    const slash = body.indexOf('/');
    if (slash < 0) {
      return LOGIN.test(body)
        ? { kind: 'user', login: body.toLowerCase() }
        : `invalid owner ${token}`;
    }
    const org = body.slice(0, slash);
    const slug = body.slice(slash + 1);
    return LOGIN.test(org) && TEAM_SLUG.test(slug)
      ? { kind: 'team', org: org.toLowerCase(), slug: slug.toLowerCase() }
      : `invalid team ${token}`;
  }
  return EMAIL.test(token)
    ? { kind: 'email', email: token.toLowerCase() }
    : `invalid owner ${token}`;
}

export const ownerKey = (o: CodeownersOwner): string =>
  o.kind === 'user'
    ? `user:${o.login}`
    : o.kind === 'team'
      ? `team:${o.org}/${o.slug}`
      : `email:${o.email}`;

export function parseCodeowners(text: string): ParsedCodeowners {
  const errors: CodeownersParseError[] = [];
  if (Buffer.byteLength(text) > MAX_CODEOWNERS_BYTES) {
    return {
      rules: [],
      effective: [],
      owners: [],
      errors: [{ line: 1, message: 'file is larger than 3 MiB; GitHub ignores it' }],
    };
  }
  const rules: CodeownersRule[] = [];
  const lines = text.split(/\r\n|\n|\r/);
  lines.forEach((full, i) => {
    const line = i + 1;
    const trimmed = full.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const { tokens, bad } = tokenize(trimmed);
    if (bad) {
      errors.push({ line, message: bad });
      return;
    }
    const [patternTok, ...ownerToks] = tokens;
    if (!patternTok) return;
    const pattern = patternTok.text;
    if (pattern.startsWith('!')) {
      errors.push({ line, message: 'patterns starting with "!" are not supported' });
      return;
    }
    if (/[[\]]/.test(patternTok.raw.replace(/\\./g, ''))) {
      errors.push({
        line,
        message: 'character ranges ([ ]) and section headers are not supported',
      });
      return;
    }
    const owners: CodeownersOwner[] = [];
    for (const t of ownerToks) {
      const o = parseOwner(t.text);
      if (typeof o === 'string') {
        errors.push({ line, message: o.slice(0, 200) });
        return; // the whole line is skipped, as GitHub skips it
      }
      owners.push(o);
    }
    rules.push({ line, pattern, owners });
  });

  const last = new Map<string, CodeownersRule>();
  for (const r of rules) last.set(r.pattern, r);
  const effective = [...last.values()].sort((a, b) => a.line - b.line);
  const owners = new Map<string, CodeownersOwner>();
  for (const r of effective) for (const o of r.owners) owners.set(ownerKey(o), o);
  return {
    rules,
    effective,
    owners: [...owners.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, o]) => o),
    errors,
  };
}

// ---------------------------------------------------------------- Matching

const escapeRe = (s: string): string => s.replace(/[.+^${}()|[\]\\]/g, '\\$&');

/** A CODEOWNERS pattern as a regular expression over a repo-relative path (no leading slash). */
export function patternRegex(pattern: string): RegExp {
  let p = pattern;
  const dirOnly = p.endsWith('/');
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith('/') || p.includes('/');
  if (p.startsWith('/')) p = p.slice(1);
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i] as string;
    if (ch === '*') {
      if (p[i + 1] === '*') {
        // `**/` any directories (also none), `/**` everything inside, `**` anything.
        i += 1;
        if (p[i + 1] === '/') {
          i += 1;
          re += '(?:.*/)?';
        } else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else re += escapeRe(ch);
  }
  const last = p.split('/').pop() ?? '';
  const wildLast = /[*?]/.test(last) && !p.endsWith('/**');
  // A pattern naming a directory covers what is inside it, except where its last segment is a wildcard
  // (`docs/*` is the files directly in docs, as on GitHub).
  const inside = wildLast && !dirOnly ? '' : '(?:/.*)?';
  return new RegExp(`^${anchored ? '' : '(?:.*/)?'}${re}${inside}$`);
}

/**
 * The rule that owns `path`: the last rule in file order that matches (GitHub's precedence). `null`
 * when no rule matches. A matching rule with no owners is returned as is: the path is explicitly unowned.
 */
export function ruleFor(parsed: ParsedCodeowners, path: string): CodeownersRule | null {
  const p = path.replace(/^\/+/, '');
  let hit: CodeownersRule | null = null;
  for (const r of parsed.rules) if (patternRegex(r.pattern).test(p)) hit = r;
  return hit;
}
