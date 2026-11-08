import {
  ACTION_IDS,
  PDP_POLICY_VERSION,
  ROLE_CATALOGUE,
  ROLES_VERSION,
  policyBundleHash,
  roleGrants,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_VERSION,
  CROSS_CUTTING_POLICY_IDS,
  buildBundle,
  generatePolicies,
  generateSchema,
  validateBundleText,
  verifyBundle,
  cedarVersion,
} from '../src/index.js';

const policiesText = (p: Record<string, string>): string =>
  `${Object.keys(p)
    .sort()
    .map((k) => p[k])
    .join('\n\n')}\n`;

describe('generation from the catalogues', () => {
  it('is deterministic: same inputs, same bytes, same hash', () => {
    const a = buildBundle();
    const b = buildBundle();
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(a.bundle_hash).toBe(policyBundleHash(a));
    expect(a.bundle_version).toBe(BUNDLE_VERSION);
    expect(BUNDLE_VERSION).toBe(`pdp-${PDP_POLICY_VERSION}.roles-${ROLES_VERSION}`);
  });

  it('has one permit per (role, granted action) and exactly three hand-written policies', () => {
    const p = generatePolicies();
    const roleIds = Object.keys(p).filter((k) => k.startsWith('role/'));
    const expected = ROLE_CATALOGUE.flatMap((r) =>
      roleGrants(r).map((g) => `role/${r.role_id}/${g.action}`),
    );
    expect(roleIds.sort()).toEqual(expected.sort());
    expect(
      Object.keys(p)
        .filter((k) => !k.startsWith('role/'))
        .sort(),
    ).toEqual(Object.values(CROSS_CUTTING_POLICY_IDS).sort());
    // Every catalogue action is granted to somebody, and every role holds something.
    for (const a of ACTION_IDS) expect(expected.some((e) => e.endsWith(`/${a}`))).toBe(true);
    for (const r of ROLE_CATALOGUE) expect(roleGrants(r).length).toBeGreaterThan(0);
  });

  it('validates under Cedar strict mode against its own schema', () => {
    const b = buildBundle();
    expect(validateBundleText(b)).toEqual([]);
    expect(verifyBundle(b).ok).toBe(true);
    expect(cedarVersion()).toMatch(/^\d+\.\d+/);
  });

  it('a policy the schema does not allow fails validation', () => {
    const b = buildBundle();
    const bad = {
      ...b,
      policies: {
        ...b.policies,
        bad: 'permit (principal, action == Action::"project.view", resource is Gate);',
      },
    };
    expect(validateBundleText(bad).join(' ')).toMatch(/bad/);
  });

  // Stale-file check: `npm run gen -w @aisdlc/pdp` rewrites both files (vitest -u). They are the
  // reviewable form of what the bundle contains.
  it('matches the committed schema and policies', async () => {
    const b = buildBundle();
    await expect(b.schema).toMatchFileSnapshot('../generated/policy.cedarschema');
    await expect(policiesText(b.policies)).toMatchFileSnapshot('../generated/policies.cedar');
    await expect(`${b.bundle_version}\n${b.bundle_hash}\n`).toMatchFileSnapshot(
      '../generated/bundle.txt',
    );
  });

  it('changes the hash when the catalogue changes', () => {
    const fewer = buildBundle({ catalogue: ROLE_CATALOGUE.slice(1) });
    expect(fewer.bundle_hash).not.toBe(buildBundle().bundle_hash);
    expect(generateSchema()).toContain('action "gate.decide"');
  });
});
