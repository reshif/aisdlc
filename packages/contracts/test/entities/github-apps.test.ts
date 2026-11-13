import { describe, expect, it } from 'vitest';
import {
  CODEHOST_ROLE_PERMISSIONS,
  GATE_CHECK_APP_PERMISSIONS,
  GATE_RELAY_APP_PERMISSIONS,
  TRACKER_APP_PERMISSIONS,
  comparePermissions,
  forbiddenPermissionsIn,
  gateRequirementOf,
  githubAppPermissions,
  githubAppsView,
  unionPermissions,
} from '../../src/index.js';

describe('the two-App layout', () => {
  it('the factory App is read + push by default, the union of the codehost roles it plays', () => {
    expect(githubAppPermissions('factory')).toEqual({
      contents: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });
    expect(githubAppPermissions('factory')).toEqual(
      unionPermissions(
        CODEHOST_ROLE_PERMISSIONS.hub,
        CODEHOST_ROLE_PERMISSIONS.posture,
        CODEHOST_ROLE_PERMISSIONS.docs,
      ),
    );
  });

  it('adds issues and deployments only when the owner opts in', () => {
    expect(githubAppPermissions('factory', { tracker: true, gateRelay: true })).toEqual({
      contents: 'write',
      deployments: 'write',
      issues: 'write',
      metadata: 'read',
      pull_requests: 'write',
    });
    expect(githubAppPermissions('factory', { tracker: true })).toEqual(
      unionPermissions(githubAppPermissions('factory'), TRACKER_APP_PERMISSIONS),
    );
    expect(githubAppPermissions('factory', { gateRelay: true })).toEqual(
      unionPermissions(githubAppPermissions('factory'), GATE_RELAY_APP_PERMISSIONS),
    );
  });

  it('gate-check is its own App, and the pushing App can never write a check', () => {
    expect(githubAppPermissions('gate-check')).toEqual(GATE_CHECK_APP_PERMISSIONS);
    const factory = githubAppPermissions('factory', { tracker: true, gateRelay: true });
    expect(factory['checks']).toBeUndefined();
    expect(githubAppPermissions('gate-check')['contents']).toBeUndefined();
  });

  it('never asks for anything forbidden (administration, workflows, statuses, ...)', () => {
    for (const p of [
      githubAppPermissions('factory', { tracker: true, gateRelay: true }),
      githubAppPermissions('gate-check'),
    ]) {
      expect(forbiddenPermissionsIn(p)).toEqual([]);
      for (const name of ['administration', 'workflows', 'statuses'])
        expect(p[name]).toBeUndefined();
    }
  });

  it('compares a grant with what is required: missing, extra, forbidden', () => {
    const req = githubAppPermissions('factory');
    expect(comparePermissions({ ...req }, req).ok).toBe(true);
    expect(comparePermissions({ contents: 'read', metadata: 'read' }, req)).toEqual({
      ok: false,
      missing: ['contents:write', 'pull_requests:write'],
      extra: [],
      forbidden: [],
    });
    expect(comparePermissions({ ...req, administration: 'write', checks: 'write' }, req)).toEqual({
      ok: false,
      missing: [],
      extra: ['administration:write', 'checks:write'],
      forbidden: ['administration:write'],
    });
  });
});

describe('the GitHub Apps panel view', () => {
  it('aisdlc/gate is required only when pinned to gate-check’s App; unread is unknown', () => {
    const gate = [{ context: 'aisdlc/gate', integration_id: 22 }];
    expect(gateRequirementOf(gate, '22')).toBe('required');
    expect(gateRequirementOf([{ context: 'aisdlc/gate', integration_id: null }], '22')).toBe(
      'other_source',
    );
    expect(gateRequirementOf(gate, '33')).toBe('other_source');
    expect(gateRequirementOf([], '22')).toBe('not_required');
    expect(gateRequirementOf(null, '22')).toBe('unknown');
    expect(gateRequirementOf(gate, null)).toBe('unknown');
  });

  it('groups jobs by App id, flags gate-check sharing an App with the pusher, unknown grant stays null', () => {
    const r = (job: 'read' | 'push' | 'gate-check', app: string) => ({
      job,
      app_id: app,
      installation_id: 1,
      login: null,
      key_loaded: true,
      last_ok_at: null,
      installation: { state: 'unknown' as const, reason: 'network' },
    });
    const v = githubAppsView({
      sources: [],
      reports: [r('read', '1'), r('push', '1'), r('gate-check', '1')],
      branches: [],
    });
    expect(v.apps).toHaveLength(1);
    expect(v.apps[0]?.shares_with_pusher).toBe(true);
    expect(v.apps[0]?.comparison).toBeNull();
  });
});
