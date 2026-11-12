import { TRACKER_APP_PERMISSIONS } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CODEHOST_PORT_METHODS,
  FakeGitHub,
  GATE_CHECK_HOST_METHODS,
  ISSUE_TRACKER_METHODS,
  emptySeed,
  forbiddenVerbMethods,
  readUnknown,
} from '../src/index.js';
import { IT_REPO, issueTrackerContract, twinFile } from '../src/testing.js';

// The issue tracker's credential on the in-memory fake (the GitHub adapter over the fake HTTP server runs the same
// suite in services/codehost). The tracker and the Push Broker are different credentials on one host.
const TRACKER = {
  app_id: 3003,
  permissions: TRACKER_APP_PERMISSIONS,
  login: 'aisdlc-tracker[bot]',
};

const seed = () =>
  emptySeed({
    installation: {
      installation_id: 7,
      account_login: 'acme',
      repository_selection: 'selected',
      permissions: { contents: 'write', pull_requests: 'write', metadata: 'read' },
      suspended: false,
    },
    repos: [{ full_name: IT_REPO, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: IT_REPO, branch: 'main', sha: 'c'.repeat(40) }],
  });

issueTrackerContract('FakeGitHub tracker view', async () => {
  const f = new FakeGitHub(seed());
  return {
    tracker: f.asTracker(TRACKER),
    other: f.asTracker({ ...f.pushApp, login: 'aisdlc-push[bot]' }),
    personOpens: async (o) => f.openIssue(IT_REPO, o),
    personCloses: async (n, by) => void f.closeIssueAs(IT_REPO, n, by),
    removeIssue: async (n) => void f.removeIssue(IT_REPO, n),
    comments: async (n) =>
      (f.issuesOf(IT_REPO).find((i) => i.number === n)?.comments ?? []).map((c) => ({
        by: c.by,
        body: c.body,
      })),
    breakHost: () => void f.breakChecksApi(readUnknown('server_error', 'down')),
    unbreak: () => void f.unbreak(),
  };
});

describe('the tracker is its own credential', () => {
  it('its port has no forbidden verb, no push and no edit; neither other port can write an issue', () => {
    expect(forbiddenVerbMethods(ISSUE_TRACKER_METHODS)).toEqual([]);
    for (const m of ISSUE_TRACKER_METHODS) {
      expect(m).not.toMatch(/edit|reopen|^label|_label$|lock|transfer|assign|push|patch/);
    }
    for (const m of [...CODEHOST_PORT_METHODS, ...GATE_CHECK_HOST_METHODS]) {
      expect(m).not.toMatch(/issue/);
    }
    const view = new FakeGitHub(seed()).asTracker(TRACKER) as unknown as Record<string, unknown>;
    expect(view['apply_patch']).toBeUndefined();
    expect(view['write_check_run']).toBeUndefined();
  });

  it('the permissions it holds are exactly issues:write and metadata:read', () => {
    expect(TRACKER_APP_PERMISSIONS).toEqual({ issues: 'write', metadata: 'read' });
  });

  it('issues and pull requests share one number sequence, as on GitHub', async () => {
    const f = new FakeGitHub(seed());
    const pr = f.openPull(IT_REPO, { head_ref: 'x', head_sha: 'd'.repeat(40), author: 'octo' });
    const r = await f.asTracker(TRACKER).file_issue(twinFile());
    expect(r.state === 'ok' && r.value.number).toBe(pr + 1);
  });
});
