import { describe, expect, it } from 'vitest';
import {
  RULES,
  RULES_VERSION,
  makeCanary,
  redact,
  rulesVersion,
  scanText,
  shannonEntropy,
} from '../src/index.js';

describe('the shared ruleset', () => {
  it('has the rules the plan names, each with a description, keywords, and fixtures of both kinds', () => {
    const ids = RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of [
      'aws-access-key-id',
      'aws-secret-access-key',
      'github-token',
      'github-fine-grained-pat',
      'private-key-pem',
      'slack-token',
      'google-api-key',
      'stripe-key',
      'jwt',
      'generic-high-entropy-assignment',
      'aisdlc-canary',
    ]) {
      expect(ids).toContain(id);
    }
    for (const r of RULES) {
      expect(r.description.length, r.id).toBeGreaterThan(10);
      expect(r.regex.flags, r.id).toContain('g');
      expect(r.fixtures.positive().length, r.id).toBeGreaterThan(0);
      expect(r.fixtures.negative().length, r.id).toBeGreaterThan(0);
      for (const k of r.keywords) expect(k, r.id).toBe(k.toLowerCase());
    }
  });

  for (const rule of RULES) {
    describe(rule.id, () => {
      it('matches every positive fixture, and the whole fixture secret is what it reports', () => {
        for (const text of rule.fixtures.positive()) {
          const hits = scanText(text, [rule]);
          expect(hits.length, text.slice(0, 12)).toBeGreaterThan(0);
          expect(hits.every((h) => h.rule_id === rule.id)).toBe(true);
        }
      });
      it('matches no negative fixture', () => {
        for (const text of rule.fixtures.negative()) {
          expect(scanText(text, [rule]), text.slice(0, 12)).toEqual([]);
        }
      });
    });
  }

  it('reports the 1-based line of the secret, also inside a multi-line block', () => {
    const canary = makeCanary('line');
    expect(scanText(`a\nb\nx = ${canary}\n`)[0]?.line).toBe(3);
    const pem = RULES.find((r) => r.id === 'private-key-pem')?.fixtures.positive()[0] as string;
    const hits = scanText(
      `one\ntwo\n${pem}\n`,
      RULES.filter((r) => r.id === 'private-key-pem'),
    );
    expect(hits).toHaveLength(1);
    expect(hits[0]?.line).toBe(3);
  });

  it('redact drops the value and keeps nothing that reveals it', () => {
    const canary = makeCanary('redact');
    const m = scanText(`k=${canary}`)[0];
    expect(m?.value).toBe(canary);
    const r = redact(m as NonNullable<typeof m>);
    expect(JSON.stringify(r)).not.toContain(canary);
    expect(Object.keys(r).sort()).toEqual(['line', 'rule_id']);
  });

  it('the keyword prefilter keeps a rule from running on text without its keywords', () => {
    const rule = RULES.find((r) => r.id === 'aisdlc-canary');
    const evil = { ...(rule as NonNullable<typeof rule>), keywords: ['never-present-keyword'] };
    expect(scanText(`k=${makeCanary('p')}`, [evil])).toEqual([]);
  });

  it('applies the entropy floor and the allow list to the generic rule', () => {
    const generic = RULES.filter((r) => r.id === 'generic-high-entropy-assignment');
    expect(shannonEntropy('aaaaaaaa')).toBe(0);
    expect(shannonEntropy('abcd')).toBeCloseTo(2, 5);
    expect(scanText(`token = "${'ab'.repeat(12)}"`, generic)).toEqual([]);
    expect(scanText(`secret = "my-example-secret-value-1234"`, generic)).toEqual([]);
    expect(scanText(`secret = "dev-client-secret-0123456789"`, generic)).toEqual([]);
    expect(scanText(`token_ref: "file:/run/secrets/kms_notary"`, generic)).toEqual([]);
    expect(scanText(`${'sec'}ret = "${'q8Zr2Lx7Vm4Bn9Tc3Wk6'}"`, generic)).toHaveLength(1);
  });

  it('makeCanary is deterministic, distinct per seed, and matches only the canary rule', () => {
    expect(makeCanary('a')).toBe(makeCanary('a'));
    expect(makeCanary('a')).not.toBe(makeCanary('b'));
    const hits = scanText(makeCanary('only'));
    expect(hits.map((h) => h.rule_id)).toEqual(['aisdlc-canary']);
  });

  it('the rules version names the revision and changes with any edit to a rule', () => {
    expect(RULES_VERSION).toMatch(/^secrets-rules\/\d+:[0-9a-f]{12}$/);
    const edited = RULES.map((r, i) =>
      i === 0 ? { ...r, regex: new RegExp(`${r.regex.source}x?`, r.regex.flags) } : r,
    );
    expect(rulesVersion(edited)).not.toBe(RULES_VERSION);
    expect(rulesVersion()).toBe(RULES_VERSION);
  });

  it('is fast on hostile input: a long run of near-matches finishes quickly', () => {
    const pem = `-----BEGIN ${'RSA '}PRIVATE KEY-----${'x'.repeat(200_000)}`;
    const text = [pem, 'token="' + 'a'.repeat(100_000), 'aws' + ' '.repeat(100_000)].join('\n');
    const t = performance.now();
    scanText(text);
    expect(performance.now() - t).toBeLessThan(2000);
  });
});
