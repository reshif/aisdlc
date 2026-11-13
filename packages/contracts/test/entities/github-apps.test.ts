import { describe, expect, it } from 'vitest';
import {
  CODEHOST_ROLE_PERMISSIONS,
  GATE_CHECK_APP_PERMISSIONS,
  GATE_RELAY_APP_PERMISSIONS,
  TRACKER_APP_PERMISSIONS,
  comparePermissions,
  forbiddenPermissionsIn,
  githubAppPermissions,
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
