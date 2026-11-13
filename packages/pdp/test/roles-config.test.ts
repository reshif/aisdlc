import { ConfigRegistry } from '@aisdlc/config';
import { ACTION_CATALOGUE, PDP_CONFIG_KEY, ROLE_CATALOGUE } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ACCESS_ROLES_KEY,
  AccessRolesConfig,
  DEFAULT_ACCESS_ROLES,
  actionsOfPolicies,
  buildBundle,
  bundleForRoles,
  registerRolesConfig,
  verifyBundle,
} from '../src/index.js';

// Portal v2 (H11): roles and what they can do as a setting; the bundle is regenerated in the same revision, and a
// document whose bundle does not match its roles is refused.

const reg = () => registerRolesConfig(registerRolesConfig(new ConfigRegistry()));

describe('access.roles', () => {
  it('defaults to the code catalogue, has a JSON Schema, and makes the code bundle', () => {
    expect(DEFAULT_ACCESS_ROLES.roles).toEqual(ROLE_CATALOGUE);
    expect(reg().get(ACCESS_ROLES_KEY)?.default).toEqual(DEFAULT_ACCESS_ROLES);
    expect(() =>
      z.toJSONSchema(AccessRolesConfig, { target: 'draft-2020-12', io: 'input' }),
    ).not.toThrow();
    const code = buildBundle();
    expect(bundleForRoles(DEFAULT_ACCESS_ROLES).policies).toEqual(code.policies);
    // the default leaves the published bundle alone
    const r = reg();
    const doc = r.prepare({ [ACCESS_ROLES_KEY]: DEFAULT_ACCESS_ROLES }) as Record<string, unknown>;
    expect(doc[PDP_CONFIG_KEY]).toBeUndefined();
    expect(r.validate('factory', doc).ok).toBe(true);
  });

  it('a change of who holds an action regenerates the bundle at propose; the new grant is in it', () => {
    const action = Object.keys(ACTION_CATALOGUE)[0] as keyof typeof ACTION_CATALOGUE;
    const changed: AccessRolesConfig = {
      ...DEFAULT_ACCESS_ROLES,
      grants: { [action]: [{ kind: 'roles', roles: ['factory.auditor'] }] },
    };
    const r = reg();
    const doc = r.prepare({ [ACCESS_ROLES_KEY]: changed }) as Record<string, unknown>;
    const bundle = doc[PDP_CONFIG_KEY] as ReturnType<typeof buildBundle>;
    expect(verifyBundle(bundle).ok).toBe(true);
    expect(bundle.bundle_version).toMatch(/\.settings-[0-9a-f]{12}$/);
    expect(actionsOfPolicies(bundle.policies, 'factory.auditor')).toContain(action);
    expect(r.validate('factory', doc).ok).toBe(true);
  });

  it('refuses a bundle that is not the one the roles make, and roles without the factory admin', () => {
    const action = Object.keys(ACTION_CATALOGUE)[0] as keyof typeof ACTION_CATALOGUE;
    const changed: AccessRolesConfig = {
      ...DEFAULT_ACCESS_ROLES,
      grants: { [action]: [{ kind: 'roles', roles: ['factory.auditor'] }] },
    };
    const r = reg();
    const stale = r.validate('factory', {
      [ACCESS_ROLES_KEY]: changed,
      [PDP_CONFIG_KEY]: buildBundle(),
    });
    expect(!stale.ok && stale.error.message).toContain('pdp.bundle is not the bundle');
    expect(
      AccessRolesConfig.safeParse({
        roles: ROLE_CATALOGUE.filter((x) => x.role_id !== 'factory.admin'),
        grants: {},
      }).success,
    ).toBe(false);
    expect(
      AccessRolesConfig.safeParse({ roles: [...ROLE_CATALOGUE, ROLE_CATALOGUE[0]], grants: {} })
        .success,
    ).toBe(false);
  });
});
