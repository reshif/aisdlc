import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// P2-19, P3-1: WCAG 2.2 AA contrast as a property of the tokens (src/ui/tokens.css), for both themes. Every text
// token is at least 4.5:1 on every ground a component puts it on, every tinted ink on its tint, the ink on a gate and
// on an accent fill on that fill, and white on each lane fill. Components read only these tokens, so a token that
// passes here passes on every page; the axe crawl in the browser (docs/design/portal-review.md §12) checks the rest.

// the web project's root, or the repo's (jsdom's import.meta.url is not a file URL)
const TOKENS = ['src/ui/tokens.css', 'services/web/src/ui/tokens.css']
  .map((p) => join(process.cwd(), p))
  .find((p) => existsSync(p));
if (!TOKENS) throw new Error('tokens.css not found from the working directory');
const css = readFileSync(TOKENS, 'utf8');

function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no block ${selector}`);
  const body = css.slice(at, css.indexOf('}', at));
  return Object.fromEntries(
    [...body.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)].map((m) => [m[1], m[2]]),
  ) as Record<string, string>;
}

const lum = (hex: string): number => {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const l = c.map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * (l[0] as number) + 0.7152 * (l[1] as number) + 0.0722 * (l[2] as number);
};
const ratio = (a: string, b: string): number => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
};

const dark = block(":root[data-theme='dark']");
const THEMES = { dark, light: { ...dark, ...block(":root[data-theme='light']") } };
const TEXT = [
  '--fg',
  '--fg-2',
  '--muted',
  '--faint',
  '--hand',
  '--gate',
  '--back',
  '--quar',
  '--ok',
  '--warn',
  '--bad',
  '--agent',
  '--det',
  '--human',
];
const GROUNDS = ['--bg', '--panel', '--panel-2', '--panel-3', '--sunk'];
const TINTS = ['ok', 'warn', 'bad', 'info', 'agent', 'human', 'back'];
const LANES = ['--lane-l0', '--lane-l13', '--lane-l45', '--lane-l6', '--lane-l7', '--lane-l8'];

describe.each(Object.entries(THEMES))('the %s theme meets WCAG 2.2 AA', (_name, t) => {
  const get = (k: string): string => {
    const v = t[k];
    if (!v) throw new Error(`token ${k} is missing`);
    return v;
  };

  it('every text token on every ground: 4.5:1', () => {
    const fails: string[] = [];
    for (const f of TEXT) {
      for (const g of GROUNDS) {
        const r = ratio(get(f), get(g));
        if (r < 4.5) fails.push(`${f} on ${g}: ${r.toFixed(2)}`);
      }
    }
    expect(fails).toEqual([]);
  });

  it('every tinted ink on its tint, and the inks on the gate and accent fills: 4.5:1', () => {
    for (const k of TINTS)
      expect(ratio(get(`--${k}-fg`), get(`--${k}-bg`))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get('--gate-ink'), get('--gate'))).toBeGreaterThanOrEqual(4.5);
    expect(ratio(get('--hand-ink'), get('--hand'))).toBeGreaterThanOrEqual(4.5);
  });

  it('white on every lane fill: 4.5:1', () => {
    for (const l of LANES) expect(ratio('#ffffff', get(l))).toBeGreaterThanOrEqual(4.5);
  });
});
