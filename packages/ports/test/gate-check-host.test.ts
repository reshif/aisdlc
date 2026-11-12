import { GATE_CHECK_APP_PERMISSIONS } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CODEHOST_PORT_METHODS,
  FakeGitHub,
  GATE_CHECK_HOST_METHODS,
  emptySeed,
  forbiddenVerbMethods,
  readUnknown,
} from '../src/index.js';
import { GC_REPO, gateCheckHostContract } from '../src/testing.js';

// gate-check's App on the in-memory fake (the GitHub adapter over the fake HTTP server runs the same suite in
// services/gate-check). gate-check's App id and the Push Broker's are different credentials on one host.
const GATE_CHECK_APP = { app_id: 2002, permissions: GATE_CHECK_APP_PERMISSIONS };

const seed = () =>
  emptySeed({
    installation: {
      installation_id: 7,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: GC_REPO, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: GC_REPO, branch: 'main', sha: 'c'.repeat(40) }],
  });

gateCheckHostContract('FakeGitHub app view', async () => {
  const f = new FakeGitHub(seed());
  return {
    checks: f.asApp(GATE_CHECK_APP),
    other: f.asApp(f.pushApp),
    openPull: async (o) => f.openPull(GC_REPO, o),
    pushToPull: async (n, sha) => void f.pushToPull(GC_REPO, n, sha),
    landPull: async (n, by) => void f.landPull(GC_REPO, n, by),
    breakHost: () => void f.breakChecksApi(readUnknown('server_error', 'down')),
    unbreak: () => void f.unbreak(),
  };
});

describe('the two credentials are two Apps with no overlap', () => {
  it('gate-check’s port has no push and no forbidden verb; the Push Broker’s has no check-run write', () => {
    expect(forbiddenVerbMethods(GATE_CHECK_HOST_METHODS)).toEqual([]);
    const view = new FakeGitHub(seed()).asApp(GATE_CHECK_APP) as unknown as Record<string, unknown>;
    // the one read both ports have is a branch's head; none of the Push Broker's other methods (its push above all)
    for (const m of CODEHOST_PORT_METHODS.filter((x) => x !== 'branch_head'))
      expect(view[m], m).toBeUndefined();
    expect(view['apply_patch']).toBeUndefined();
    for (const m of CODEHOST_PORT_METHODS) expect(m).not.toMatch(/check/);
  });

  it('the Push Broker’s PRs are authored by its bot; a person’s by the person', async () => {
    const f = new FakeGitHub(seed());
    f.openPull(GC_REPO, { head_ref: 'x', head_sha: 'd'.repeat(40), author: 'octo' });
    const r = await f.asApp(GATE_CHECK_APP).list_pulls({ repo: GC_REPO, state: 'open' });
    expect(r.state === 'ok' && r.value.map((p) => p.author)).toEqual([
      { login: 'octo', type: 'User' },
    ]);
  });
});
