import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RULES, scanText } from '../src/index.js';

// The repository holds no secret-shaped string: the whole tree (minus dependencies and build
// output) is run through the shared ruleset and must give zero findings. Fixtures are built at
// run time from parts for exactly this reason (and so push protection never trips).

// The generic (key-name plus value) rules are excluded for fixture paths ONLY: tests and test
// support files legitimately hold fake passwords and secret references. Every provider-shaped rule
// still runs there, and every rule runs everywhere else. The rules themselves carry no skip for
// word-like values, so scanned repos are not weakened (PLAN M6.2b).
const GENERIC = new Set(['generic-high-entropy-assignment', 'generic-unquoted-assignment']);
const FIXTURE_PATH = /(?:^|\/)(?:test|tests|fixtures)\/|(?:^|\/)testing\.ts$|\.test\.ts$/;
const NON_GENERIC = RULES.filter((r) => !GENERIC.has(r.id));
// Fixture paths also build throwaway connection strings (`postgres://u:pw@localhost/db`), and the CI
// workflow's service container has a throwaway database password: `url-credentials` is excluded for
// those paths only, everywhere else it runs.
const CI_PATH = /^\.github\/workflows\//;
const NON_URL = RULES.filter((r) => r.id !== 'url-credentials');
const NON_GENERIC_NON_URL = NON_GENERIC.filter((r) => r.id !== 'url-credentials');
const rulesFor = (rel: string) =>
  FIXTURE_PATH.test(rel) ? NON_GENERIC_NON_URL : CI_PATH.test(rel) ? NON_URL : RULES;

const root = join(import.meta.dirname, '..', '..', '..');
const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'coverage',
  '.cache',
  '.pgdata',
  '.tmp',
  '.vitest',
  'tmp',
]);

function* walk(dir: string): Generator<string> {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name)) yield* walk(join(dir, e.name));
    } else if (e.isFile()) yield join(dir, e.name);
  }
}

describe('repo self-test', () => {
  it('names the generic rules the exclusion covers, and they exist', () => {
    for (const id of GENERIC) expect(RULES.map((r) => r.id)).toContain(id);
  });

  it('the ruleset finds nothing anywhere in the repository tree', () => {
    const findings: string[] = [];
    let files = 0;
    for (const file of walk(root)) {
      if (statSync(file).size > 8 * 1024 * 1024) {
        findings.push(`${relative(root, file)}: too large to scan`);
        continue;
      }
      files++;
      // latin1 maps every byte to one character, so binary files are scanned too.
      const text = readFileSync(file, 'latin1');
      // The report names the file, the rule and the line, never the value.
      const rel = relative(root, file);
      for (const m of scanText(text, rulesFor(rel))) findings.push(`${rel}:${m.line} ${m.rule_id}`);
    }
    expect(files).toBeGreaterThan(100);
    expect(findings).toEqual([]);
  });
});
