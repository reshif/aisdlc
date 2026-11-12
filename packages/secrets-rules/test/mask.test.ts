import { describe, expect, it } from 'vitest';
import { RULES, maskSecrets, scanText } from '../src/index.js';

describe('maskSecrets', () => {
  it('replaces every value a rule finds with its mark and counts per rule, never keeping the value', () => {
    const rule = RULES.find((r) => r.id === 'github-token');
    const token = rule?.fixtures.positive()[0] ?? '';
    expect(token.length).toBeGreaterThan(10);
    const text = `my webhook fails with ${token}\nand again ${token}`;
    const m = maskSecrets(text);
    expect(m.text).not.toContain(token);
    expect(m.text).toContain('[REDACTED:');
    expect(m.redactions.reduce((n, r) => n + r.count, 0)).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(m.redactions)).not.toContain(token);
    expect(scanText(m.text)).toEqual([]);
  });

  it('leaves text without a secret as it is', () => {
    expect(maskSecrets('why is card 4 waiting?')).toEqual({
      text: 'why is card 4 waiting?',
      redactions: [],
    });
  });
});
