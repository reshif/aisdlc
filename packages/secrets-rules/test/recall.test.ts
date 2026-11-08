import { describe, expect, it } from 'vitest';
import { RULES, scanText } from '../src/index.js';
import { benignCorpus, heldOutSet } from './heldout.js';

// Ruleset recall (PLAN M6.2b): every planted secret of the held-out set must be found BY THE RULE
// it was planted for, and a corpus of benign lookalikes must stay below a false-positive bound.

/** At most this share of the benign corpus may produce a finding (measured: see the table). */
const FALSE_POSITIVE_BOUND = 0.02;

describe('held-out recall', () => {
  const set = heldOutSet();

  it('plants at least one secret for every rule, and several for most', () => {
    const per = new Map<string, number>();
    for (const p of set) per.set(p.rule, (per.get(p.rule) ?? 0) + 1);
    for (const r of RULES) expect(per.get(r.id) ?? 0, r.id).toBeGreaterThanOrEqual(2);
    for (const id of per.keys()) expect(RULES.map((r) => r.id)).toContain(id);
  });

  it('is constructed at run time: the same on every run, and no value is in this file', () => {
    expect(heldOutSet().map((p) => p.text)).toEqual(set.map((p) => p.text));
  });

  it('reports recall per rule and finds 100% of the held-out set', () => {
    const rows: Array<{ rule: string; planted: number; found: number; recall: string }> = [];
    const missed: string[] = [];
    for (const rule of RULES) {
      const mine = set.filter((p) => p.rule === rule.id);
      let found = 0;
      for (const p of mine) {
        // The whole ruleset runs, as in a scan; the plant counts when ITS rule reports it.
        if (scanText(p.text).some((m) => m.rule_id === rule.id)) found++;
        else missed.push(`${rule.id}: ${p.label}`);
      }
      rows.push({
        rule: rule.id,
        planted: mine.length,
        found,
        recall: `${((100 * found) / Math.max(1, mine.length)).toFixed(1)}%`,
      });
    }
    const total = rows.reduce((n, r) => n + r.planted, 0);
    const hit = rows.reduce((n, r) => n + r.found, 0);
    console.log(
      `held-out recall (${hit}/${total}):\n` +
        rows.map((r) => `  ${r.rule.padEnd(34)} ${r.found}/${r.planted}  ${r.recall}`).join('\n'),
    );
    expect(missed).toEqual([]);
    expect(hit).toBe(total);
  });

  it('finds the word-like passwords the old placeholder skip let through', () => {
    const wordy = set.filter((p) => /^words/.test(p.label) || /words/.test(p.label));
    expect(wordy.length).toBeGreaterThanOrEqual(8);
    for (const p of wordy) expect(scanText(p.text).length, p.label).toBeGreaterThan(0);
  });
});

describe('false-positive corpus', () => {
  const corpus = benignCorpus();

  it('stays below the false-positive bound, and reports which lookalikes fire', () => {
    const fired = corpus.filter((b) => scanText(b.text).length > 0);
    const byKind = new Map<string, number>();
    for (const b of fired) byKind.set(b.kind, (byKind.get(b.kind) ?? 0) + 1);
    const rate = fired.length / corpus.length;
    console.log(
      `false positives: ${fired.length}/${corpus.length} (${(100 * rate).toFixed(2)}%), bound ${(100 * FALSE_POSITIVE_BOUND).toFixed(0)}%` +
        (fired.length > 0 ? `\n${[...byKind].map(([k, n]) => `  ${k}: ${n}`).join('\n')}` : ''),
    );
    expect(corpus.length).toBeGreaterThanOrEqual(150);
    expect(rate).toBeLessThanOrEqual(FALSE_POSITIVE_BOUND);
  });

  it('no benign lookalike of a provider-shaped rule fires (only the generic rules may)', () => {
    const generic = new Set(['generic-high-entropy-assignment', 'generic-unquoted-assignment']);
    for (const b of corpus)
      for (const m of scanText(b.text))
        expect(generic.has(m.rule_id), `${b.kind}: ${m.rule_id}`).toBe(true);
  });
});
