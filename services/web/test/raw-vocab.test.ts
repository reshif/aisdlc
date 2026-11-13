import { GLOSSARY, type GlossaryFamily } from '@aisdlc/contracts';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// The glossary's lint (glossary.md §21, `no-raw-vocab`): a screen never renders a factory code as text. A code
// ("G4", "L3", "S6", "B13", "census", "PRR") in JSX text, in a string literal rendered as a child, or in a text
// attribute (title, aria-label, label, placeholder, alt) is refused: the screen calls `label('gate', 'G4')` or
// renders `<Term family="gate" value="G4" />`, which shows the plain words and, where the glossary keeps it, the
// code as a chip. Codes in expressions (`{gate}`, `data-gate={g}`) are not text and are not checked here.
//
// The v1 screens predate the glossary: their count is the baseline (`raw-vocab.baseline.json`), which may only go
// down. A new file starts at zero. When a squad rebuilds a screen and its count drops, the baseline is lowered with
// `RAW_VOCAB_WRITE_BASELINE=1 npx vitest run --project web raw-vocab`.

const ROOT = ['src', 'services/web/src']
  .map((p) => join(process.cwd(), p))
  .find((p) => existsSync(p));
if (!ROOT) throw new Error('services/web/src not found from the working directory');
const BASELINE = join(ROOT, '..', 'test', 'raw-vocab.baseline.json');

/** The families whose values are codes a person must not see as text (status words like "pending" are not). */
const CODE_FAMILIES: readonly GlossaryFamily[] = [
  'stage',
  'gate',
  'lane',
  'tier',
  'autonomy',
  'viewLevel',
  'dataClass',
  'backEdge',
  'handoff',
  'trigger',
  'relane',
  'card',
  'pillar',
  'lightFloor',
  'agent',
];
const EXTRA = ['H1', 'H2', 'H3', 'N8', 'PRR', 'census', 'SECT', 'SECR'];

const CODES = new Set<string>([
  ...CODE_FAMILIES.flatMap((f) => Object.keys(GLOSSARY[f])).filter((c) => /[A-Z0-9]/.test(c)),
  ...EXTRA,
]);
// words of the glossary that look like codes but are plain English in a sentence
for (const plain of ['coder', 'assistant']) CODES.delete(plain);
const TOKEN = new RegExp(
  `(?<![\\w.-])(${[...CODES].sort((a, b) => b.length - a.length).join('|')})(?![\\w-])`,
  'g',
);

const TEXT_ATTRS = new Set([
  'title',
  'aria-label',
  'label',
  'placeholder',
  'alt',
  'aria-description',
]);

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.tsx$/.test(n) ? [p] : [];
  });
}

export interface Hit {
  readonly line: number;
  readonly code: string;
  readonly text: string;
}

/** Every code rendered as text in one file. */
export function rawCodes(source: string, name = 'x.tsx'): Hit[] {
  const sf = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const hits: Hit[] = [];
  const check = (node: ts.Node, text: string) => {
    for (const m of text.matchAll(TOKEN)) {
      hits.push({
        line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        code: m[1] as string,
        text: text.trim().slice(0, 60),
      });
    }
  };
  const visit = (node: ts.Node) => {
    if (ts.isJsxText(node)) check(node, node.getText(sf));
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const p = node.parent;
      const rendered =
        (ts.isJsxExpression(p) && (ts.isJsxElement(p.parent) || ts.isJsxFragment(p.parent))) ||
        (ts.isJsxAttribute(p) && TEXT_ATTRS.has(p.name.getText(sf))) ||
        (ts.isJsxExpression(p) &&
          ts.isJsxAttribute(p.parent) &&
          TEXT_ATTRS.has(p.parent.name.getText(sf)));
      if (rendered) check(node, node.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}

const scan = (): Record<string, number> =>
  Object.fromEntries(
    files(ROOT)
      .map((f) => [relative(ROOT, f), rawCodes(readFileSync(f, 'utf8'), f).length] as const)
      .filter(([, n]) => n > 0)
      .sort(([a], [b]) => a.localeCompare(b)),
  );

describe('no raw codes on screen (glossary §21)', () => {
  it('finds a code in JSX text, a rendered string and a text attribute, and nothing else', () => {
    const src = `
      const a = <p>Waiting at G4 since L3</p>;
      const b = <span>{'census'}</span>;
      const c = <button title="Approve G3">x</button>;
      const d = <Pill label={'S6'} />;
      const ok1 = <p>{gate}</p>;
      const ok2 = <span data-gate="G4" className="L3">Code review</span>;
      const ok3 = label('gate', 'G4');
      const ok4 = <p>Item PAY-42, commit 3f2a91c, version 1.4.0, G4x</p>;
    `;
    expect(rawCodes(src).map((h) => h.code)).toEqual(['G4', 'L3', 'census', 'G3', 'S6']);
  });

  it('the v1 screens do not gain a code, and the v2 library and shell have none', () => {
    const now = scan();
    if (process.env['RAW_VOCAB_WRITE_BASELINE'] === '1') {
      writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
    }
    const base = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>;
    const worse = Object.entries(now)
      .filter(([f, n]) => n > (base[f] ?? 0))
      .map(([f, n]) => `${f}: ${n} raw codes (baseline ${base[f] ?? 0})`);
    expect(worse).toEqual([]);
    const better = Object.entries(base)
      .filter(([f, n]) => (now[f] ?? 0) < n)
      .map(([f, n]) => `${f}: ${now[f] ?? 0} (baseline ${n}): lower the baseline`);
    expect(better).toEqual([]);
    for (const f of Object.keys(now)) {
      expect(f.startsWith('ui/') || f.startsWith('shell/') || f.startsWith('design/'), f).toBe(
        false,
      );
    }
  });
});
