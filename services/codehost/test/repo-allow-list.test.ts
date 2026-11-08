import { FakeGitHub, FakeRegisteredRepos } from '@aisdlc/ports';
import { SHA_A, contractSeed } from '@aisdlc/ports/testing';
import { describe, expect, it } from 'vitest';
import { AllowListedCodeHost } from '../src/repo-allow-list.js';

const setup = (rows: Array<{ project_id: string; repo: string }>) => {
  const fake = new FakeGitHub(contractSeed());
  const reg = new FakeRegisteredRepos().set(rows as never);
  return { fake, reg, host: new AllowListedCodeHost(fake, reg) };
};

describe('AllowListedCodeHost (installation repos ∩ repos with an S0 record)', () => {
  it('lists only repos that are both installed and registered', async () => {
    const { host } = setup([
      { project_id: 'p1', repo: 'ACME/App' }, // case-insensitive
      { project_id: 'p2', repo: 'acme/not-installed' },
    ]);
    const r = await host.list_repos();
    expect(r.state === 'ok' && r.value.map((x) => x.full_name)).toEqual(['acme/app']);
  });

  it('an installed repo without an S0 record is repo_not_allowed on every method, with no request for it', async () => {
    const { host, fake } = setup([{ project_id: 'p1', repo: 'acme/app' }]);
    const reads = [
      await host.read_at_sha({ repo: 'acme/lib', sha: SHA_A, path: 'README.md' }),
      await host.branch_head({ repo: 'acme/lib', branch: 'trunk' }),
      await host.rules_for_branch({ repo: 'acme/lib', branch: 'trunk' }),
      await host.codeowners({ repo: 'acme/lib', sha: SHA_A }),
      await host.codeowners_errors({ repo: 'acme/lib' }),
      await host.collaborators({ repo: 'acme/lib' }),
      await host.bundle({ repo: 'acme/lib', base_sha: SHA_A, refs: 'all' }),
      await host.apply_patch({
        repo: 'acme/lib',
        branch: 'agent/x/y',
        base_sha: SHA_A,
        patch: '',
        message: 'm',
      }),
      await host.pr_status({ repo: 'acme/lib', number: 1 }),
    ];
    for (const r of reads)
      expect(r).toMatchObject({ state: 'unreadable', reason: 'repo_not_allowed' });
    expect(fake.requests).toEqual([]);
    // The registered one passes through.
    expect((await host.branch_head({ repo: 'acme/app', branch: 'main' })).state).toBe('ok');
    expect(fake.requests).toHaveLength(1);
  });

  it('an unreadable registry allows nothing (unknown/registry_unavailable), and recovers', async () => {
    const { host, fake, reg } = setup([{ project_id: 'p1', repo: 'acme/app' }]);
    reg.breakIt();
    expect(await host.list_repos()).toMatchObject({
      state: 'unknown',
      reason: 'registry_unavailable',
    });
    expect(await host.collaborators({ repo: 'acme/app' })).toMatchObject({ state: 'unknown' });
    expect(await host.projectOf('acme/app')).toMatchObject({ state: 'unknown' });
    expect(fake.requests).toEqual([]);
    reg.breakIt(false);
    expect((await host.collaborators({ repo: 'acme/app' })).state).toBe('ok');
  });

  it('knows the project of a registered repo', async () => {
    const { host } = setup([{ project_id: 'p1', repo: 'acme/app' }]);
    expect(await host.projectOf('Acme/App')).toEqual({ state: 'ok', value: 'p1' });
    expect(await host.projectOf('acme/lib')).toEqual({ state: 'ok', value: null });
  });

  it('a broken installation read is passed through, not turned into an empty list', async () => {
    const { host, fake } = setup([{ project_id: 'p1', repo: 'acme/app' }]);
    fake.breakAll({ state: 'unknown', reason: 'network', message: 'down' });
    expect(await host.list_repos()).toMatchObject({ state: 'unknown', reason: 'network' });
  });
});
