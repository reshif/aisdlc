import {
  DEFAULT_GATES_POLICY,
  DEFAULT_GATES_TIMERS,
  DEFAULT_SESSION_POLICY,
  DEFAULT_WORK_REQUEST,
  SETTINGS_KEYS,
  gatePolicy,
  installGatePolicies,
  settingInForce,
} from '@aisdlc/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import {
  applyGatePolicies,
  applyScalarSettings,
  codehostPollsFrom,
  evalsGateFrom,
  gatesTimersFrom,
  gatewayLimitsFrom,
  opsHealthFrom,
  readinessPolicyFrom,
  sandboxProbeFrom,
  sessionPolicyFrom,
  workRequestFrom,
} from '../src/index.js';

// Portal v2: the runtime readers of the timer and policy settings, and what a process installs from a snapshot.

const snap = (v: Record<string, unknown>, rejected: string[] = []) => ({
  rejected,
  get: (k: string) => v[k],
});
const from = (v: Record<string, unknown>, rejected: string[] = []) => ({
  current: () => snap(v, rejected),
});

afterEach(() => {
  installGatePolicies(null);
  applyScalarSettings(snap({}) as never);
});

describe('runtime readers', () => {
  it('the env is the bootstrap default until a value other than the code default is published', () => {
    const env = { idle_s: 600, absolute_s: 3600 };
    expect(sessionPolicyFrom(from({}), env)).toEqual(env);
    expect(
      sessionPolicyFrom(from({ [SETTINGS_KEYS.session_policy]: DEFAULT_SESSION_POLICY }), env),
    ).toEqual(env);
    const published = { idle_s: 900, absolute_s: 7200 };
    expect(sessionPolicyFrom(from({ [SETTINGS_KEYS.session_policy]: published }), env)).toEqual(
      published,
    );
    expect(sessionPolicyFrom(from({}, [SETTINGS_KEYS.session_policy]), env)).toEqual(env);
    expect(gatewayLimitsFrom(from({}), { max_provider_calls: 5 }).max_provider_calls).toBe(5);
    expect(
      gatewayLimitsFrom(from({ [SETTINGS_KEYS.gateway_limits]: { max_provider_calls: 9 } }), {
        max_provider_calls: 5,
      }).max_provider_calls,
    ).toBe(9);
  });

  it('each reader gives the old constant unset and the published value set', () => {
    expect(gatesTimersFrom(from({}))).toEqual(DEFAULT_GATES_TIMERS);
    expect(
      gatesTimersFrom(
        from({ [SETTINGS_KEYS.gates_timers]: { ...DEFAULT_GATES_TIMERS, step_up_ttl_s: 120 } }),
      ).step_up_ttl_s,
    ).toBe(120);
    expect(
      workRequestFrom(from({ [SETTINGS_KEYS.work_request]: { max_text_chars: 900 } })),
    ).toEqual({ max_text_chars: 900 });
    expect(sandboxProbeFrom(from({})).grant_ttl_s).toBe(1200);
    expect(opsHealthFrom(from({})).stale_after_ms).toBe(120_000);
    expect(evalsGateFrom(from({})).floor).toBe(0.8);
    expect(codehostPollsFrom(from({})).fast_ms).toBe(600_000);
    expect(readinessPolicyFrom(from({})).prr_fresh_days).toBe(90);
  });
});

describe('what a process installs', () => {
  it('applyScalarSettings: a published value is in force for settingInForce; a bad one is the default', () => {
    applyScalarSettings(snap({ [SETTINGS_KEYS.work_request]: { max_text_chars: 900 } }) as never);
    expect(settingInForce(SETTINGS_KEYS.work_request, DEFAULT_WORK_REQUEST).max_text_chars).toBe(
      900,
    );
    applyScalarSettings(snap({ [SETTINGS_KEYS.work_request]: { max_text_chars: 'x' } }) as never);
    expect(settingInForce(SETTINGS_KEYS.work_request, DEFAULT_WORK_REQUEST)).toEqual(
      DEFAULT_WORK_REQUEST,
    );
  });

  it('applyGatePolicies: the published approvals table, or the code’s table when it does not read', () => {
    const changed = structuredClone(DEFAULT_GATES_POLICY);
    changed.two_person_gates = ['X1'];
    expect(applyGatePolicies(snap({ [SETTINGS_KEYS.gates_policy]: changed }) as never)).toBe(true);
    expect(gatePolicy('X2').two_person).toBe('never');
    expect(applyGatePolicies(snap({}, [SETTINGS_KEYS.gates_policy]) as never)).toBe(false);
    expect(gatePolicy('X2').two_person).toBe('project');
  });
});
