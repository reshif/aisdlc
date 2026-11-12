import { GATE_CHECK_APP_PERMISSIONS, GATE_RELAY_APP_PERMISSIONS } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CODEHOST_PORT_METHODS,
  FakeGitHub,
  GATE_CHECK_HOST_METHODS,
  GATE_RELAY_HOST_METHODS,
  emptySeed,
  forbiddenVerbMethods,
  readUnknown,
} from '../src/index.js';
import { GR_REPO, gateRelayHostContract, grCreate } from '../src/testing.js';

// gate-relay's App on the in-memory fake (the GitHub adapter over the fake HTTP server runs the same suite in
// services/gate-relay). Three Apps, three credentials, one host: only gate-relay's token carries `deployments: write`.
const GATE_RELAY_APP = { app_id: 3003, permissions: GATE_RELAY_APP_PERMISSIONS };
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
    repos: [{ full_name: GR_REPO, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo: GR_REPO, branch: 'main', sha: 'c'.repeat(40) }],
  });

gateRelayHostContract('FakeGitHub deployment view', async () => {
  const f = new FakeGitHub(seed());
  return {
    deploys: f.asDeployApp(GATE_RELAY_APP),
    push: f.asDeployApp(f.pushApp),
    checks: f.asDeployApp(GATE_CHECK_APP),
    setStatus: async (id, state) => void f.setDeploymentStatus(GR_REPO, id, state),
    breakHost: () => void f.breakChecksApi(readUnknown('server_error', 'down')),
    unbreak: () => void f.unbreak(),
  };
});

describe('gate-relay’s credential is its own: no other port or App writes a deployment', () => {
  it('its App asks for deployments write and metadata read only', () => {
    expect(GATE_RELAY_APP_PERMISSIONS).toEqual({ deployments: 'write', metadata: 'read' });
    // neither the Push Broker's nor gate-check's grant carries deployments
    expect(GATE_CHECK_APP_PERMISSIONS['deployments']).toBeUndefined();
    expect(seed().installation.permissions['deployments']).toBeUndefined();
  });

  it('its port has no forbidden verb; the other ports have no deployment method', () => {
    expect(forbiddenVerbMethods(GATE_RELAY_HOST_METHODS)).toEqual([]);
    for (const m of [...CODEHOST_PORT_METHODS, ...GATE_CHECK_HOST_METHODS])
      expect(m, m).not.toMatch(/deploy/);
    const f = new FakeGitHub(seed());
    const view = f.asDeployApp(GATE_RELAY_APP) as unknown as Record<string, unknown>;
    for (const m of ['apply_patch', 'write_check_run', 'list_pulls'])
      expect(view[m]).toBeUndefined();
    const checks = f.asApp(GATE_CHECK_APP) as unknown as Record<string, unknown>;
    for (const m of GATE_RELAY_HOST_METHODS) expect(checks[m], m).toBeUndefined();
    for (const m of GATE_RELAY_HOST_METHODS)
      expect((f as unknown as Record<string, unknown>)[m], m).toBeUndefined();
  });

  it('a deployment records the App that created it', async () => {
    const f = new FakeGitHub(seed());
    const r = await f.asDeployApp(GATE_RELAY_APP).create_deployment(grCreate());
    expect(r.state).toBe('ok');
    expect(f.deploymentsOf(GR_REPO).map((d) => d.app_id)).toEqual([3003]);
  });
});
