import {
  INSTRUCTION_TEMPLATE_SCHEMA_ID,
  InstructionReview,
  instructionTemplateHash,
  type Fact,
  type InstructionBlocked,
  type InstructionLintFinding,
  type InstructionPath,
  type InstructionProposal,
  type InstructionRejectReason,
  type InstructionSection,
  type InstructionSectionKind,
  type InstructionTemplate,
  type PrincipalId,
  TASK_CONTRACT_NAMES,
} from '@aisdlc/contracts';
import { hashCanonical, sha256Hex } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';
import { lintAgentsFormat, lintText } from '@aisdlc/text-lint';

// DEC-11 (refined 2026-11-11): factory rules and defaults always win; a repo's AGENTS.md or
// CLAUDE.md can only add repo detail inside them. Each instruction file is split into its sections
// and each section is checked against the FACTORY TEMPLATE (config `onboarding.instruction_template`):
// what is taken (build and test commands, coding standards, architecture notes, conventions) and
// what never is (tools, permissions, network, rule-overrides, secrets, factory state). Rejection
// always wins over acceptance, and a section the template has no place for is not taken either.
// The proposed text is made of the accepted sections only, plus the sections the template requires
// and the file lacks, drafted from the census facts. Pure: no I/O, no clock.

export interface RawSection {
  readonly heading: string | null;
  /** 0: the preamble before the first heading; 1: `#`; 2: `##` (deeper headings stay in the body). */
  readonly level: 0 | 1 | 2;
  /** 1-based, inclusive. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

const HEADING = /^(#{1,2})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^\s*(?:```|~~~)/;

/** Splits Markdown into its `#`/`##` sections. A heading inside a code fence is not a heading. */
export function splitSections(text: string): RawSection[] {
  const lines = text.split(/\r\n|\n|\r/);
  if (lines.length > 0 && lines.at(-1) === '') lines.pop();
  const out: RawSection[] = [];
  let inFence = false;
  let cur: { heading: string | null; level: 0 | 1 | 2; start: number } = {
    heading: null,
    level: 0,
    start: 1,
  };
  const flush = (endExclusive: number): void => {
    const end = endExclusive - 1;
    if (end < cur.start) return;
    const body = lines.slice(cur.start - 1, end);
    if (cur.level === 0 && body.every((l) => l.trim() === '')) return;
    out.push({ ...cur, end, text: body.join('\n') });
  };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (FENCE.test(l)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = HEADING.exec(l);
    if (!m) continue;
    flush(i + 1);
    cur = {
      heading: (m[2] as string).slice(0, 200),
      level: (m[1] as string).length as 1 | 2,
      start: i + 1,
    };
  }
  flush(lines.length + 1);
  return out;
}

const words = (s: string): string[] =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .split(/[^a-z0-9-]+/)
    .filter((w) => w !== '');

/** What a human reads: compatibility-folded, lowercased, emphasis gone. */
const plainLower = (s: string): string =>
  s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[*_`~]+/g, '');

interface Classified {
  readonly kind: InstructionSectionKind | null;
  readonly reasons: InstructionRejectReason[];
  readonly lint_rules: InstructionLintFinding['rule'][];
  readonly secret: boolean;
}

function classify(
  s: RawSection,
  template: InstructionTemplate,
  fileLint: readonly InstructionLintFinding[],
): Classified {
  const reasons = new Set<InstructionRejectReason>();
  const secret = scanText(s.text).length > 0;
  if (secret) reasons.add('secrets');
  const lintRules = new Set<InstructionLintFinding['rule']>();
  for (const f of fileLint) {
    if (f.severity !== 'blocking' || f.line < s.start || f.line > s.end) continue;
    lintRules.add(f.rule);
    // Every blocking rule is mapped (the template's schema checks it); an unmapped one still rejects.
    reasons.add(template.lint_rejects[f.rule] ?? 'rule_override');
  }
  const hw = s.heading === null ? [] : words(s.heading);
  const body = plainLower(s.text);
  for (const r of template.rejected) {
    if (r.headings.some((k) => hw.includes(k)) || r.phrases.some((p) => body.includes(p))) {
      reasons.add(r.reason);
    }
  }
  const kind: InstructionSectionKind | null =
    s.level <= 1
      ? 'overview'
      : (template.accepted.find((a) => a.headings.some((k) => hw.includes(k)))?.kind ?? null);
  if (kind === null && reasons.size === 0) reasons.add('not_in_template');
  return {
    kind,
    reasons: [...reasons].sort(),
    lint_rules: [...lintRules].sort(),
    secret,
  };
}

const lintOf = (text: string): InstructionLintFinding[] =>
  [...lintText(text), ...lintAgentsFormat(text, false)]
    .map((f) => ({ rule: f.rule, severity: f.severity, line: f.line }))
    .sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

const lineCount = (t: string): number =>
  t === '' ? 0 : t.split('\n').length - (t.endsWith('\n') ? 1 : 0);

/** The facts the factory drafts a missing required section from (never repo prose). */
export interface DraftFacts {
  readonly facts: readonly Fact[];
}

/** A drafted section's body, or `null` when the facts give nothing to draft it from. */
export function draftSection(
  kind: 'commands' | 'boundaries' | 'knowledge',
  d: DraftFacts,
): string | null {
  if (kind === 'commands') {
    const found = TASK_CONTRACT_NAMES.flatMap((name) => {
      const f = d.facts.find(
        (x) => x.kind === 'task_command' && x.name === name && x.state === 'found',
      );
      return f?.kind === 'task_command' && f.invocation !== null ? [[name, f.invocation]] : [];
    });
    if (found.length === 0) return null;
    const hasCheck = found.some(([n]) => n === 'check');
    return [
      '## Commands',
      '',
      ...found.map(([n, inv]) => `- ${n}: \`${inv}\``),
      ...(hasCheck ? ['', 'Run `check` before you propose a change.'] : []),
    ].join('\n');
  }
  if (kind === 'boundaries') {
    return [
      '## Boundaries',
      '',
      '- Protected files change only through a reviewed pull request: AGENTS.md, CLAUDE.md, CODEOWNERS, `.factory/`, `.claude/`, `.mcp.json`.',
      '- The sensitive paths are listed in the readiness record; a change there needs a person.',
      '- Ask a person before anything irreversible: data migrations, deletions, releases.',
    ].join('\n');
  }
  const paths = d.facts.flatMap((f) =>
    f.kind === 'presence' &&
    f.state === 'present' &&
    ['readme', 'decision_records', 'runbooks', 'contributing'].includes(f.item)
      ? f.evidence.map((e) => e.path)
      : [],
  );
  const uniq = [...new Set(paths)].sort().slice(0, 20);
  if (uniq.length === 0) return null;
  return ['## Knowledge', '', ...uniq.map((p) => `- \`${p}\``)].join('\n');
}

export interface ReviewInput {
  readonly path: InstructionPath;
  readonly area?: string;
  /** The file as read at the census head; `null` when it is absent. */
  readonly source: { readonly text: string; readonly blob_sha: string } | null;
  readonly template: InstructionTemplate;
  /**
   * `source`: the factory reviews the repo file and proposes its accepted sections (plus drafts).
   * `edit`: a person wrote the text on the card; it is affirmable only if every section is taken.
   */
  readonly mode: 'source' | 'edit';
  readonly facts: readonly Fact[];
  readonly proposed_by: 'factory' | PrincipalId;
}

function proposalOf(text: string, template: InstructionTemplate): InstructionProposal {
  const secretHits = scanText(text).length;
  const lint = lintOf(text);
  const lines = lineCount(text);
  let blocked: InstructionBlocked | null = null;
  if (secretHits > 0) blocked = 'secret';
  else if (text.trim() === '') blocked = 'empty';
  else if (lint.some((f) => f.severity === 'blocking') || lines > template.max_lines) {
    blocked = 'not_clean';
  }
  const stored = blocked === 'secret' ? null : text;
  return {
    text: stored,
    text_sha256: stored === null ? null : (sha256Hex(stored) as never),
    lines,
    lint,
    lint_report_hash: hashCanonical(lint) as never,
    secret_hits: secretHits,
    blocked,
  };
}

/**
 * Reviews one instruction file against the template. The review never holds a section that has a
 * secret (its heading is dropped too) and never holds the source text: only hashes, verdicts and
 * line ranges, and the proposed text, which is secret-scanned (a hit stores no text at all).
 */
export function reviewInstructionFile(i: ReviewInput): InstructionReview {
  if (i.template.schema !== INSTRUCTION_TEMPLATE_SCHEMA_ID) {
    throw new Error('unknown instruction template schema');
  }
  const raw = i.source === null ? [] : splitSections(i.source.text);
  const fileLint = i.source === null ? [] : lintOf(i.source.text);
  const sections: InstructionSection[] = [];
  const kept: string[] = [];
  const accepted = new Set<InstructionSectionKind>();
  raw.forEach((s, index) => {
    const c = classify(s, i.template, fileLint);
    const verdict = c.reasons.length > 0 ? 'rejected' : 'accepted';
    if (verdict === 'accepted') {
      kept.push(s.text);
      if (c.kind) accepted.add(c.kind);
    }
    sections.push({
      index,
      heading: c.secret ? null : s.heading,
      level: s.level,
      kind: c.kind,
      verdict,
      reasons: c.reasons,
      lint_rules: c.lint_rules,
      line_start: s.start,
      line_end: s.end,
      text_sha256: sha256Hex(s.text) as never,
    });
  });
  const missing = i.template.required.filter((k) => !accepted.has(k));
  let text: string;
  if (i.mode === 'edit') {
    text = i.source?.text ?? '';
    // An edit is the person's own text: what they affirm is exactly it, so one section the
    // template does not take makes the whole text not clean (nothing is silently dropped).
    if (sections.some((s) => s.verdict === 'rejected')) {
      const p = proposalOf(text, i.template);
      return InstructionReview.parse({
        path: i.path,
        area: i.area ?? '.',
        state: 'data',
        source_blob_sha: null,
        source_text_sha256: sha256Hex(text),
        template_hash: instructionTemplateHash(i.template),
        sections,
        missing_required: missing,
        proposed: { ...p, blocked: p.blocked ?? 'not_clean' },
        proposed_by: i.proposed_by,
      });
    }
  } else {
    const drafted: Array<{ kind: InstructionSectionKind; body: string }> = [];
    for (const k of missing) {
      const body = draftSection(k, { facts: i.facts });
      if (body !== null) drafted.push({ kind: k, body });
    }
    const parts = [...kept, ...drafted.map((d) => d.body)].map((p) => p.replace(/\s+$/, ''));
    text = parts.length === 0 ? '' : `${parts.join('\n\n')}\n`;
    // The drafted sections are listed after the source's, with their lines in the proposed text.
    let line = kept.reduce((n, p) => n + lineCount(`${p.replace(/\s+$/, '')}\n`) + 1, 1);
    for (const d of drafted) {
      const n = lineCount(`${d.body}\n`);
      sections.push({
        index: sections.length,
        heading: d.body.split('\n')[0]?.replace(/^##\s+/, '') ?? null,
        level: 2,
        kind: d.kind,
        verdict: 'drafted',
        reasons: [],
        lint_rules: [],
        line_start: line,
        line_end: line + n - 1,
        text_sha256: sha256Hex(d.body) as never,
      });
      line += n + 1;
    }
  }
  return InstructionReview.parse({
    path: i.path,
    area: i.area ?? '.',
    state: i.source === null ? 'absent' : 'data',
    source_blob_sha: i.mode === 'source' ? (i.source?.blob_sha ?? null) : null,
    source_text_sha256: i.source === null ? null : sha256Hex(i.source.text),
    template_hash: instructionTemplateHash(i.template),
    sections,
    missing_required: missing,
    proposed: proposalOf(text, i.template),
    proposed_by: i.proposed_by,
  });
}
