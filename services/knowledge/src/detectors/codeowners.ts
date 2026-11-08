import { CODEOWNERS_PATHS, PROTECTED_PATH_PROBES } from '@aisdlc/contracts';
import { ownerKey, parseCodeowners, ruleFor } from '@aisdlc/codeowners';
import { Collector, type Detector, type TreeReader } from './types.js';

// CODEOWNERS detector (PLAN M6.3; RS-CC-1, RS-CC-2): parses the file with the shared parser
// (`@aisdlc/codeowners`, the same one the codehost uses to feed the owner groups), reports errors
// and owners, and says whether the protected set (AGENTS.md, CLAUDE.md, CODEOWNERS, `.factory/**`,
// `.claude/**`, `.mcp.json`, workflows) has an owner. GitHub reads the first of `.github/`, the root
// and `docs/`; the others are reported as shadowed. Whether owners resolve to real users is a
// code-host question (`codeowners/errors`), not answered here.

export function codeownersDetector(): Detector {
  return {
    info: { id: 'codeowners', version: '1', criteria: ['RS-CC-1', 'RS-CC-2'] },
    async run(reader: TreeReader) {
      const c = new Collector('codeowners', reader);
      const present = CODEOWNERS_PATHS.filter((p) => reader.get(p));
      const first = present[0];
      if (!first) {
        c.add({
          kind: 'codeowners',
          detector: 'codeowners',
          evidence: [],
          state: 'absent',
          path: null,
          shadowed: [],
          rule_count: 0,
          errors: [],
          owners: [],
          protected_set: { covered: false, uncovered: [...PROTECTED_PATH_PROBES] },
        });
        return c.output();
      }
      const t = await c.text(first, 3 * 1024 * 1024 + 1);
      if (!t) {
        // Unreadable or over the 3 MiB GitHub limit: recorded as coverage; the fact says "present, not read".
        const file = reader.get(first);
        c.add({
          kind: 'codeowners',
          detector: 'codeowners',
          evidence: file ? [c.evidence(file)] : [],
          state: 'present',
          path: first,
          shadowed: present.slice(1),
          rule_count: 0,
          errors: [{ line: 1, message: 'the file could not be read or is over the size limit' }],
          owners: [],
          protected_set: { covered: false, uncovered: [...PROTECTED_PATH_PROBES] },
        });
        return c.output();
      }
      const parsed = parseCodeowners(t.text);
      const uncovered = PROTECTED_PATH_PROBES.filter((p) => {
        const r = ruleFor(parsed, p);
        return r === null || r.owners.length === 0;
      });
      c.add({
        kind: 'codeowners',
        detector: 'codeowners',
        evidence: [c.evidence(t.file, parsed.rules[0]?.line ?? 1)],
        state: 'present',
        path: first,
        shadowed: present.slice(1),
        rule_count: parsed.rules.length,
        errors: parsed.errors.slice(0, 50).map((e) => ({ line: e.line, message: e.message })),
        owners: parsed.owners.map(ownerKey),
        protected_set: { covered: uncovered.length === 0, uncovered: [...uncovered] },
      });
      return c.output();
    },
  };
}
