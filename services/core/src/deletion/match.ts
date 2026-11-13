// What "names a needle" means for a deletion (docs/specs/deletion.md §3): a string that IS the needle, or of which the
// needle is a whole segment between `:` and `/` (`acme-web`, `acme-web/L3`, `project:acme-web`, `acme/app`), case
// insensitive. Never a substring: the slug `web` does not hit `webhook` or `acme-web`. The same rule is spelled twice,
// as a Postgres regex (`~*`, for stream names and columns) and as a SQL/JSON path filter (every string of a JSON tree).

/** The characters an id the factory mints or accepts can have (ids, slugs, principal ids, owner/name). */
const NEEDLE_RE = /^[A-Za-z0-9_.@/:-]+$/;

export const isNeedle = (s: string): boolean => s.length >= 2 && NEEDLE_RE.test(s);

const reEscape = (s: string): string => s.replace(/[.]/g, '\\.');

/** How many needles one regex carries (Postgres' regex compiler has limits; more needles, more regexes). */
const CHUNK = 64;

/** The needles as Postgres regexes, for `col ~* ANY($n::text[])`. Throws on a needle with other characters. */
export function needleRegexes(needles: Iterable<string>): string[] {
  const list = [...new Set(needles)].sort();
  for (const n of list)
    if (!isNeedle(n)) throw new Error(`not a deletion needle: ${JSON.stringify(n)}`);
  const out: string[] = [];
  for (let i = 0; i < list.length; i += CHUNK) {
    const alt = list
      .slice(i, i + CHUNK)
      .map(reEscape)
      .join('|');
    // `[/:]`, never `[:/]`: `[:` opens a POSIX class name.
    out.push(`(^|[/:])(${alt})($|[/:])`);
  }
  return out;
}

/** The needles as one SQL/JSON path: true when any string of the tree names one (use with `silent => true`). */
export function needlePath(needles: Iterable<string>): string {
  const lit = (re: string) => `"${re.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  const filters = needleRegexes(needles).map((re) => `@ like_regex ${lit(re)} flag "i"`);
  return filters.length === 0 ? '$ ? (false)' : `$.** ? (${filters.join(' || ')})`;
}

/** Does `s` name one of the needles (the same rule in TypeScript, for checks that need no database)? */
export function namesNeedle(s: string, needles: Iterable<string>): boolean {
  return needleRegexes(needles).some((re) => new RegExp(re, 'i').test(s));
}
