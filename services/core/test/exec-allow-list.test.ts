import { ConfigRegistry } from '@aisdlc/config';
import { SANDBOX_EXEC_ALLOWED_REPOS_KEY } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { execAllowedReposFrom, registerCoreConfig } from '../src/settings.js';

// DEC-18 (decided 2026-11-09): container-class execution of repo code only for repos on the owner allow-list, which is
// config (factory layer, M1-gated). Empty by default; an unreadable value allows nothing.

describe('config sandbox.exec_allowed_repos', () => {
  const registry = registerCoreConfig(new ConfigRegistry());
  it('is registered, factory layer only (no project override), and empty by default', () => {
    expect(registry.get(SANDBOX_EXEC_ALLOWED_REPOS_KEY)).toMatchObject({
      overridable: false,
      default: [],
      kind: 'setting',
    });
  });
  it('takes owner/name entries only', () => {
    const def = registry.get(SANDBOX_EXEC_ALLOWED_REPOS_KEY);
    expect(def?.schema.safeParse(['acme/app', 'acme/testbed']).success).toBe(true);
    for (const bad of [['acme'], ['https://github.com/acme/app'], [''], 'acme/app', [1]]) {
      expect(def?.schema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it('reads as the list, as empty when unset, and as null (allow nothing) when the published value is rejected or malformed', () => {
    const reader = (rejected: string[], value: unknown) =>
      ({ current: () => ({ rejected, get: () => value }) }) as never;
    expect(execAllowedReposFrom(reader([], ['acme/app']))()).toEqual(['acme/app']);
    expect(execAllowedReposFrom(reader([], undefined))()).toEqual([]);
    expect(
      execAllowedReposFrom(reader([SANDBOX_EXEC_ALLOWED_REPOS_KEY], ['acme/app']))(),
    ).toBeNull();
    expect(execAllowedReposFrom(reader([], 'acme/app'))()).toBeNull();
  });
});
