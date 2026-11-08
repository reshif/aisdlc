import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanText } from '../src/index.js';

// The repository holds no secret-shaped string: the whole tree (minus dependencies and build
// output) is run through the shared ruleset and must give zero findings. Fixtures are built at
// run time from parts for exactly this reason (and so push protection never trips).

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
      for (const m of scanText(text))
        findings.push(`${relative(root, file)}:${m.line} ${m.rule_id}`);
    }
    expect(files).toBeGreaterThan(100);
    expect(findings).toEqual([]);
  });
});
