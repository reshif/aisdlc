import { createHash } from 'node:crypto';
import type { Fact } from '@aisdlc/contracts';
import { RULES, rulesVersion, type SecretRule } from '@aisdlc/secrets-rules';
import {
  DEFAULT_URL_ALLOW_LIST,
  LINT_RULES_REVISION,
  lintAgentsFormat,
  lintText,
  type LintOptions,
} from '@aisdlc/text-lint';
import { isVendored } from './paths.js';
import { Collector, type Detector, type TreeFile, type TreeReader } from './types.js';

// The content-lint DETECTOR (PLAN M6.4). The rules themselves are `@aisdlc/text-lint`, the one
// ruleset shared with the work engine's request-text scan (M9.1); this file walks a repo's
// instruction docs and the knowledge pack with it. The names below are re-exported so the
// knowledge package's own imports are unchanged.
export {
  DEFAULT_URL_ALLOW_LIST,
  LINT_RULES_REVISION,
  LONG_PARAGRAPH_CHARS,
  lintAgentsFormat,
  lintText,
  type LintFinding,
  type LintOptions,
} from '@aisdlc/text-lint';

// ---------------------------------------------------------------- the detector

const INSTRUCTION_DOC =
  /(?:^|\/)(?:AGENTS(?:\.override)?|CLAUDE(?:\.local)?|GEMINI)\.md$|^\.github\/(?:copilot-instructions\.md|instructions\/.+\.md|prompts\/.+\.md|agents\/.+\.md|chatmodes\/.+\.md)$|(?:^|\/)\.cursorrules$|(?:^|\/)\.windsurfrules$|(?:^|\/)\.cursor\/rules\/.+|(?:^|\/)\.claude\/.+\.md$|(?:^|\/)\.windsurf\/rules\/.+/;
/** The knowledge pack in the repo: docs, claims and unknowns, whatever their front-matter says. */
const PACK_DOC = /^\.factory\/knowledge\/.+\.(?:md|markdown|txt|ya?ml)$/;
export const MAX_LINT_DOCS = 300;
export const LINT_DOC_LIMIT = 1024 * 1024;
const MAX_LINT_FACTS = 1000;

export function lintDetectorVersion(
  urlAllowList: readonly string[],
  rules: readonly SecretRule[],
): string {
  const h = createHash('sha256')
    .update(JSON.stringify([...urlAllowList].sort()))
    .digest('hex')
    .slice(0, 8);
  return `${LINT_RULES_REVISION}/${rulesVersion(rules)}/urls:${h}`;
}

export function lintDetector(opts: LintOptions = {}): Detector {
  const urls = opts.urlAllowList ?? DEFAULT_URL_ALLOW_LIST;
  const rules = opts.secretRules ?? RULES;
  return {
    info: {
      id: 'content_lint',
      version: lintDetectorVersion(urls, rules),
      criteria: ['RS-AI-3'],
    },
    async run(reader: TreeReader) {
      const c = new Collector('content_lint', reader);
      const docs: TreeFile[] = reader.files.filter(
        (f) => !isVendored(f.path) && (INSTRUCTION_DOC.test(f.path) || PACK_DOC.test(f.path)),
      );
      let docsLinted = 0;
      const byRule: Record<string, number> = {};
      let listed = 0;
      for (const [n, f] of docs.entries()) {
        if (n >= MAX_LINT_DOCS) {
          c.capped('documents to lint', MAX_LINT_DOCS);
          break;
        }
        // A doc whose body cannot be read is a coverage item, never a doc skipped quietly.
        const t = await c.text(f.path, LINT_DOC_LIMIT);
        if (!t) continue; // (a symlink has no body of its own; its target is a doc in the tree)
        docsLinted++;
        const findings = [...lintText(t.text, opts)];
        if (/(?:^|\/)AGENTS(?:\.override)?\.md$/.test(f.path))
          findings.push(...lintAgentsFormat(t.text, f.path.includes('/')));
        for (const x of findings) {
          byRule[x.rule] = (byRule[x.rule] ?? 0) + 1;
          // Counts only where secrets are concerned: where a secret is is not for the census to read.
          if (x.rule === 'L-SECRET') continue;
          if (listed >= MAX_LINT_FACTS) continue;
          listed++;
          const fact: Fact = {
            kind: 'lint_finding',
            detector: 'content_lint',
            rule: x.rule,
            severity: x.severity,
            path: f.path,
            evidence: [c.evidence(t.file, x.line)],
          };
          c.add(fact);
        }
      }
      if (listed >= MAX_LINT_FACTS) c.capped('lint findings listed', MAX_LINT_FACTS);
      c.stats['docs_linted'] = docsLinted;
      for (const [k, v] of Object.entries(byRule)) c.stats[`rule:${k}`] = v;
      return c.output();
    },
  };
}
