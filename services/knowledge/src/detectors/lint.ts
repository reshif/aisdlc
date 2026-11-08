import { createHash } from 'node:crypto';
import {
  AGENTS_NESTED_MAX_LINES,
  AGENTS_ROOT_MAX_LINES,
  LINT_RULES,
  type Fact,
  type LintRuleId,
  type LintSeverity,
} from '@aisdlc/contracts';
import { RULES, rulesVersion, scanText, type SecretRule } from '@aisdlc/secrets-rules';
import { isVendored } from './paths.js';
import { Collector, type Detector, type TreeFile, type TreeReader } from './types.js';

// Content lint (PLAN M6.4; OB §3.4 "must not contain", §4.1 item 5; fix 6 of §11).
//
// THE RULE: the lint runs on EVERY doc whose body exists. Repo front-matter is IGNORED ENTIRELY: a
// doc with `protected: true`, with no front-matter, with front-matter that does not parse, or with
// front-matter that is not a mapping is linted exactly the same, and its front-matter lines are
// linted as text like any other. Nothing in a repo file can switch the lint off, and nothing here
// parses front-matter for any decision. Claim and unknown text is linted before it is indexed:
// `lintText` is the function the claims step calls on each string.
//
// Each rule has an id, a severity (blocking or advisory) and an evidence line. A finding never
// quotes the text (a result must not carry repo text or a secret); `L-SECRET` findings also carry
// no value, and the detector counts them without listing where.

export interface LintFinding {
  readonly rule: LintRuleId;
  readonly severity: LintSeverity;
  /** 1-based line where the offending text starts. */
  readonly line: number;
}

export interface LintOptions {
  /** Hosts (and their subdomains) a doc may link to. Default `DEFAULT_URL_ALLOW_LIST`. */
  readonly urlAllowList?: readonly string[];
  /** Characters of one paragraph beyond which it is "long architecture prose". Default 600. */
  readonly longParagraphChars?: number;
  /** Secret rules, default the shared ruleset. */
  readonly secretRules?: readonly SecretRule[];
}

/** Reserved example hosts, the repo host and loopback: links that cannot lead an agent anywhere new. */
export const DEFAULT_URL_ALLOW_LIST: readonly string[] = [
  'github.com',
  'localhost',
  '127.0.0.1',
  'example.com',
  'example.org',
  'example.net',
];

export const LONG_PARAGRAPH_CHARS = 600;
/** Bump when a rule's meaning changes; the detector version embeds it. */
export const LINT_RULES_REVISION = 1;

const finding = (rule: LintRuleId, line: number): LintFinding => ({
  rule,
  severity: LINT_RULES[rule].severity,
  line,
});

/** Zero-width, soft-hyphen and bidi-control characters: invisible, so they cannot hide a phrase. */
const INVISIBLE = new RegExp(
  '[\\u00ad\\u061c\\u180e\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u206f\\ufeff]',
  'g',
);

/** What a human would read: compatibility-folded, with zero-width and bidi-control characters gone. */
const plain = (s: string): string => s.normalize('NFKC').replace(INVISIBLE, '');
/** The same without markdown emphasis, so `ignore **previous** instructions` still reads as one phrase. */
const unmarked = (s: string): string => s.replace(/[*_`~]+/g, '');

const NEGATOR =
  /\b(?:never|not|no|don'?t|do not|doesn'?t|must not|mustn'?t|cannot|can'?t|won'?t|avoid|unless|forbidden|prohibited)\b/i;

interface LineRule {
  readonly rule: LintRuleId;
  readonly re: RegExp;
  /** A protective sentence ("never push to main") is not a directive: skip a hit that a negator precedes. */
  readonly negatable?: boolean;
}

const IDS = 'G[0-6](?:f|d|s|o)?|X[1-4]|E[1-6]|M[1-6]|Q1';
const LINE_RULES: readonly LineRule[] = [
  // tier, autonomy, lane, gate, budget statements
  {
    rule: 'L-TIER',
    re: /\btier\b[^\n.]{0,40}\bT[0-3]\b|\bT[0-3]\b[^\n.]{0,30}\btier\b|\btier\s+(?:floor|level)\b|\b(?:risk|inherent)\s+tier\b|^\s*tier\s*[:=]/i,
  },
  {
    rule: 'L-AUTONOMY',
    re: /\bautonomy\b[^\n.]{0,40}\bA[0-3]\b|\bA[0-3]\b[^\n.]{0,20}\bautonomy\b|\bautonomy\s*(?:level|cap|mode)?\s*[:=]|\b(?:full|high|maximum|max|unrestricted)\s+autonomy\b/i,
  },
  {
    rule: 'L-LANE',
    re: /\blane\b[^\n.]{0,25}\bL[0-8]\b|\bL[0-8]\b[^\n.]{0,15}\blane\b|^\s*lane\s*[:=]/i,
  },
  {
    rule: 'L-GATE',
    re: new RegExp(
      `\\bgates?\\b[^\\n.]{0,30}\\b(?:${IDS})\\b|\\b(?:${IDS})\\s+gate\\b|\\b(?:skip|bypass|waive|auto-?approve)\\b[^\\n.]{0,20}\\bgates?\\b|\\bgates?\\s+(?:is|are)?\\s*(?:off|disabled|not required|optional)\\b`,
      'i',
    ),
  },
  {
    rule: 'L-BUDGET',
    re: /\b(?:token|cost|spend|compute|usage|api)\s+budget\b|\bbudget\b[^\n.]{0,30}(?:\$\s?\d|\d+\s*(?:usd|tokens?|k\b|dollars))|\bmax[_ -]?(?:tokens|budget|cost)\b\s*[:=]|\bunlimited\s+(?:budget|tokens|spend)\b/i,
  },
  // tool, permission, MCP and egress grants
  {
    rule: 'L-GRANT',
    re: /\b(?:allowed|permitted|approved)[-_ ]?tools?\b|\b(?:you|agents?|the (?:ai|agent|assistant))\s+(?:may|can|are allowed to|have permission to|are permitted to|have access to)\b[^\n.]{0,60}\b(?:tools?|mcp|network|internet|shell|bash|sudo|credentials?|secrets?|production|prod|ssh|docker|egress)\b|\bmcp(?:Servers|[_ -]?servers?)\b|\bgrant(?:s|ed|ing)?\b[^\n.]{0,40}\b(?:access|permissions?|tools?|network|egress|write|admin)\b|\b(?:dangerously[-_ ]?skip[-_ ]?permissions|bypassPermissions|enableAllProjectMcpServers|--yolo)\b|\b(?:allow|permit|open|enable)\w*\b[^\n.]{0,20}\b(?:egress|outbound (?:network|traffic|access)|internet access|network access)\b|\bpermissions?\s*:\s*(?:write-all|admin|\*)\b/i,
    negatable: true,
  },
  // text addressed to the factory or the AI
  {
    rule: 'L-ADDRESS',
    re: /\b(?:the\s+)?(?:software\s+)?(?:factory|aisdlc)\b[^\n.]{0,20}\b(?:must|should|shall|will|may|can|needs? to|is (?:allowed|permitted|required|authori[sz]ed)|has to|have to|do not|don'?t|never|always|ignore|treat|trust)\b|\b(?:ai|a\.i\.|llm|language model|ai agents?|ai assistants?|coding assistants?)\b\s*[,:!-]?\s*(?:you\s+)?(?:must|should|shall|will|need to|have to|do not|don'?t|never|always|ignore|disregard|forget|stop|trust|obey|comply)\b|\b(?:hey|hello|hi|dear|attention|note to|message to|instructions? (?:to|for))\s*:?\s*(?:the\s+)?(?:ai|llm|assistant|agent|claude|gpt|chatgpt|copilot|gemini|factory)\b|\b(?:if you are|you are|you'?re)\s+(?:an?\s+)?(?:ai|llm|language model|large language model|assistant|ai assistant|ai agent|autonomous agent|coding agent)\b/i,
  },
  // directives that override instructions or skip safeguards
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:ignore|disregard|forget|override|discard)\b[^\n.]{0,25}\b(?:previous|prior|above|earlier|all|any|other|system|safety|security)\b[^\n.]{0,20}\b(?:instructions?|prompts?|rules?|guidelines?|polic(?:y|ies)|constraints?|restrictions?|guardrails?|checks?)\b/i,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:push|commit|merge|deploy|publish|force[- ]?push)\b[^\n.]{0,15}\b(?:directly\s+)?(?:to|into|on)\s+(?:the\s+)?(?:main|master|prod(?:uction)?|release|default)\b/i,
    negatable: true,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:skip|disable|bypass|omit|remove|delete|comment out|turn off|ignore)\b[^\n.]{0,15}\b(?:the\s+|all\s+|any\s+|failing\s+)?(?:tests?|test suite|ci|checks?|lint(?:ing)?|linters?|type[- ]?check(?:ing|s)?|reviews?|code review|approval|gate-?check|security (?:checks?|scans?)|hooks?|pre-commit)\b/i,
    negatable: true,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:merge|approve)\b[^\n.]{0,20}\b(?:without|bypassing|skipping)\b[^\n.]{0,15}\breview/i,
    negatable: true,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:you are now|from now on,? you|new (?:instructions?|system prompt)|system prompt|developer message|act as (?:root|admin|an? unrestricted)|jailbreak|DAN mode|developer mode)\b/i,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:do not|don'?t|never)\s+(?:tell|inform|notify|alert|mention|reveal|show)\b[^\n.]{0,20}\b(?:user|human|operator|reviewer|owner|maintainer)s?\b/i,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:exfiltrate|send|upload|post|leak)\b[^\n.]{0,30}\b(?:secrets?|credentials?|tokens?|env(?:ironment)? variables?|\.env|api keys?|private keys?|ssh keys?)\b[^\n.]{0,30}\b(?:to|at|via)\b/i,
    negatable: true,
  },
  {
    rule: 'L-DIRECTIVE',
    re: /\b(?:disable|turn off|remove|delete)\b[^\n.]{0,20}\b(?:branch protection|protect-main|secret scanning|code ?owners?|gate-?check)\b/i,
    negatable: true,
  },
  { rule: 'L-DIRECTIVE', re: /\brm\s+-[a-z]*r[a-z]*f?\s+(?:\/|~|\$HOME)(?:\s|$)/ },
  // pipe-to-shell
  {
    rule: 'L-PIPE-SH',
    re: /\b(?:curl|wget|fetch|iwr|invoke-webrequest|invoke-restmethod|irm)\b[^\n]{0,300}?\|\s*(?:sudo\s+(?:-\S+\s+)*)?(?:(?:ba|z|da|k|c|fi)?sh|python3?|perl|ruby|node|iex|source)\b/i,
  },
  {
    rule: 'L-PIPE-SH',
    re: /\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)|\beval\s+["'`]?\$\(\s*(?:curl|wget)|\bsource\s+<\(\s*(?:curl|wget)|\|\s*iex\b|\b(?:iex|invoke-expression)\b[^\n]{0,80}\b(?:iwr|irm|invoke-webrequest|downloadstring)\b/i,
  },
];

const URL_RE = /\b(?:https?|ftp|ssh|git|wss?):\/\/[^\s<>"'`)\]}]+/gi;

function hostAllowed(host: string, allow: readonly string[]): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return allow.some((a) => {
    const e = a.toLowerCase().replace(/^\*\./, '');
    return h === e || h.endsWith(`.${e}`);
  });
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

/**
 * Lints text. The text is a whole doc or one claim or unknown string; the findings are the same
 * either way. Pure: no front-matter handling, no I/O.
 */
export function lintText(text: string, opts: LintOptions = {}): LintFinding[] {
  const allow = opts.urlAllowList ?? DEFAULT_URL_ALLOW_LIST;
  const longChars = opts.longParagraphChars ?? LONG_PARAGRAPH_CHARS;
  const out = new Map<string, LintFinding>();
  const put = (f: LintFinding): void => {
    out.set(`${f.rule}\0${f.line}`, f);
  };

  const raw = text.split(/\r\n|\n|\r/);
  const lines = raw.map(plain);
  const marked = lines.map(unmarked);

  for (let i = 0; i < lines.length; i++) {
    const here = marked[i] as string;
    // The line alone, and the line joined to the next, so a phrase wrapped over two lines is seen.
    const next = i + 1 < lines.length ? `${here} ${(marked[i + 1] as string).trim()}` : null;
    for (const r of LINE_RULES) {
      for (const [s, startsHere] of [
        [here, true],
        [next, false],
      ] as const) {
        if (s === null || out.has(`${r.rule}\0${i + 1}`)) continue;
        const m = r.re.exec(s);
        if (!m) continue;
        if (!startsHere && m.index >= here.length) continue; // belongs to the next line's own pass
        if (
          r.negatable === true &&
          NEGATOR.test(s.slice(Math.max(0, m.index - 40), m.index + m[0].length))
        )
          continue;
        put(finding(r.rule, i + 1));
      }
    }
    for (const m of (lines[i] as string).matchAll(URL_RE)) {
      const host = hostOf(m[0]);
      if (host === null || !hostAllowed(host, allow)) put(finding('L-URL', i + 1));
    }
  }

  // Secrets: the shared ruleset over the text exactly as written (a secret is not a thing to normalise).
  for (const m of scanText(text, opts.secretRules ?? RULES)) put(finding('L-SECRET', m.line));

  // Long prose: a paragraph of ordinary text (not a heading, list, table, quote or code) over the limit.
  let inFence = false;
  let start = -1;
  let chars = 0;
  const flush = (): void => {
    if (start !== -1 && chars > longChars) put(finding('L-PROSE', start + 1));
    start = -1;
    chars = 0;
  };
  for (let i = 0; i < raw.length; i++) {
    const l = raw[i] as string;
    if (/^\s*(?:```|~~~)/.test(l)) {
      flush();
      inFence = !inFence;
      continue;
    }
    const prose =
      !inFence && l.trim() !== '' && !/^\s*(?:[-*+]\s|\d+[.)]\s|#|\||>|<|---|===)/.test(l);
    if (!prose) {
      flush();
      continue;
    }
    if (start === -1) start = i;
    chars += l.trim().length + 1;
  }
  flush();

  return [...out.values()].sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : 1));
}

/** Format checks for an AGENTS.md (OB §3.4: plain Markdown, ≤150 lines, no front-matter). Advisory. */
export function lintAgentsFormat(text: string, nested: boolean): LintFinding[] {
  const out: LintFinding[] = [];
  const lines = text === '' ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  if (lines > (nested ? AGENTS_NESTED_MAX_LINES : AGENTS_ROOT_MAX_LINES))
    out.push(finding('L-FMT-LINES', 1));
  if (/^(?:\uFEFF)?---\s*\r?\n/.test(text)) out.push(finding('L-FMT-FRONTMATTER', 1));
  return out;
}

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
