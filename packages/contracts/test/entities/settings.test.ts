import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AgentsSettingsConfig,
  CatalogueVersion,
  CodehostPollsConfig,
  DEFAULT_CODEHOST_POLLS,
  DEFAULT_EVALS_GATE,
  DEFAULT_GATES_POLICY,
  DEFAULT_GATES_TIMERS,
  DEFAULT_GATEWAY_LIMITS,
  DEFAULT_OPS_HEALTH,
  DEFAULT_PLANNING_SIZE_SHARE,
  DEFAULT_READINESS_POLICY,
  DEFAULT_SANDBOX_PROBE,
  DEFAULT_SANDBOX_PROFILES,
  DEFAULT_SESSION_POLICY,
  DEFAULT_WORK_REQUEST,
  EVAL_COMPARE_LEVEL,
  EvalsGateConfig,
  GATE_POLICIES,
  GatesPolicyConfig,
  GatesTimersConfig,
  GatewayLimitsConfig,
  HEALTH_SNAPSHOT_INTERVAL_MS,
  INTEGRATION_HEALTH_STALE_MS,
  LF6_MIN_AFFIRMED_OR_UNKNOWN,
  MAX_LIGHT_CLAIMS,
  MAX_WAIVER_DAYS,
  OPS_ALERT_AFTER_MS,
  OPS_CHECKPOINT_OVERDUE_MS,
  OpsHealthConfig,
  PRR_FRESH_DAYS,
  PROBE_GRANT_TTL_S,
  PlanningSizeShareConfig,
  ReadinessPolicyConfig,
  SANDBOX_PROFILES,
  STEP_UP_TTL_SECONDS,
  SandboxProbeConfig,
  SandboxProfilesConfig,
  SessionPolicyConfig,
  TWO_PERSON_GATES,
  WorkRequestConfig,
  gatePoliciesOf,
  gatePolicies,
  gatePolicy,
  installGatePolicies,
  settingFrom,
  gateAttributes,
} from '../../src/index.js';

// Portal v2 settings: each key's default is the constant it replaces, a change is read back, and a bad value is refused.

const SCHEMAS: ReadonlyArray<[string, z.ZodType, unknown]> = [
  ['gates.policy', GatesPolicyConfig, DEFAULT_GATES_POLICY],
  ['gates.timers', GatesTimersConfig, DEFAULT_GATES_TIMERS],
  ['readiness.policy', ReadinessPolicyConfig, DEFAULT_READINESS_POLICY],
  ['session.policy', SessionPolicyConfig, DEFAULT_SESSION_POLICY],
  ['gateway.limits', GatewayLimitsConfig, DEFAULT_GATEWAY_LIMITS],
  ['ops.health', OpsHealthConfig, DEFAULT_OPS_HEALTH],
  ['evals.gate', EvalsGateConfig, DEFAULT_EVALS_GATE],
  ['codehost.polls', CodehostPollsConfig, DEFAULT_CODEHOST_POLLS],
  ['work.request', WorkRequestConfig, DEFAULT_WORK_REQUEST],
  ['sandbox.probe', SandboxProbeConfig, DEFAULT_SANDBOX_PROBE],
  ['sandbox.profiles', SandboxProfilesConfig, DEFAULT_SANDBOX_PROFILES],
  ['planning.size_share', PlanningSizeShareConfig, DEFAULT_PLANNING_SIZE_SHARE],
  ['agents.settings', AgentsSettingsConfig, {}],
];

afterEach(() => installGatePolicies(null));

describe('settings keys', () => {
  it.each(SCHEMAS)('%s: the default fits its schema and has a JSON Schema', (_k, schema, def) => {
    expect(schema.safeParse(def).success).toBe(true);
    const js = z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input' });
    expect(typeof js).toBe('object');
  });

  it('every default equals the constant it replaces', () => {
    expect(DEFAULT_GATES_TIMERS).toEqual({
      expires_after_s: 7 * 86_400,
      step_up_ttl_s: STEP_UP_TTL_SECONDS,
      nonce_ttl_s: 600,
    });
    expect(DEFAULT_READINESS_POLICY).toEqual({
      prr_fresh_days: PRR_FRESH_DAYS,
      max_waiver_days: MAX_WAIVER_DAYS,
      max_light_claims: MAX_LIGHT_CLAIMS,
      lf6_min_affirmed_or_unknown: LF6_MIN_AFFIRMED_OR_UNKNOWN,
    });
    expect(DEFAULT_SESSION_POLICY).toEqual({ idle_s: 1800, absolute_s: 28_800 });
    expect(DEFAULT_GATEWAY_LIMITS.max_provider_calls).toBe(1000);
    expect(DEFAULT_OPS_HEALTH).toEqual({
      stale_after_ms: INTEGRATION_HEALTH_STALE_MS,
      snapshot_interval_ms: HEALTH_SNAPSHOT_INTERVAL_MS,
      alert_after_ms: OPS_ALERT_AFTER_MS,
      checkpoint_overdue_ms: OPS_CHECKPOINT_OVERDUE_MS,
    });
    expect(DEFAULT_EVALS_GATE).toEqual({ floor: 0.8, level: EVAL_COMPARE_LEVEL, resamples: 2000 });
    expect(DEFAULT_CODEHOST_POLLS).toEqual({
      fast_ms: 600_000,
      hourly_ms: 3_600_000,
      daily_ms: 86_400_000,
    });
    expect(DEFAULT_WORK_REQUEST.max_text_chars).toBe(20_000);
    expect(DEFAULT_SANDBOX_PROBE.grant_ttl_s).toBe(PROBE_GRANT_TTL_S);
    for (const [c, p] of Object.entries(SANDBOX_PROFILES)) {
      expect(DEFAULT_SANDBOX_PROFILES[c as keyof typeof SANDBOX_PROFILES]).toEqual(p.limits);
    }
    expect(DEFAULT_PLANNING_SIZE_SHARE).toEqual({ small: 0.25, medium: 0.5, large: 1 });
    expect(gatePoliciesOf(DEFAULT_GATES_POLICY)).toEqual(GATE_POLICIES);
    expect(DEFAULT_GATES_POLICY.two_person_gates).toEqual([...TWO_PERSON_GATES]);
  });

  it('refuses invalid values', () => {
    expect(SessionPolicyConfig.safeParse({ idle_s: 9000, absolute_s: 600 }).success).toBe(false);
    expect(GatesTimersConfig.safeParse({ ...DEFAULT_GATES_TIMERS, step_up_ttl_s: 5 }).success).toBe(
      false,
    );
    // a ceiling may be lowered, never raised above the deployment's
    expect(SandboxProfilesConfig.safeParse({ W: { memory_mb: 1024 } }).success).toBe(true);
    expect(
      SandboxProfilesConfig.safeParse({ W: { memory_mb: SANDBOX_PROFILES.W.limits.memory_mb + 1 } })
        .success,
    ).toBe(false);
    // X, E, Q and M approvals never share a card
    const bad = structuredClone(DEFAULT_GATES_POLICY);
    bad.gates.X1 = { ...bad.gates.X1, consolidatable: true };
    expect(GatesPolicyConfig.safeParse(bad).success).toBe(false);
    expect(
      GatesPolicyConfig.safeParse({ ...DEFAULT_GATES_POLICY, two_person_gates: ['X1', 'X1'] })
        .success,
    ).toBe(false);
    expect(AgentsSettingsConfig.safeParse({ A9: { tools: ['Bash'] } }).success).toBe(false);
    expect(AgentsSettingsConfig.safeParse({ nobody: {} }).success).toBe(false);
  });

  it('settingFrom: default when unset, the value when set, null when the published value is unreadable', () => {
    const snap = (v: Record<string, unknown>, rejected: string[] = []) => ({
      rejected,
      get: (k: string) => v[k],
    });
    expect(settingFrom(snap({}), 'work.request', WorkRequestConfig, DEFAULT_WORK_REQUEST)).toEqual(
      DEFAULT_WORK_REQUEST,
    );
    expect(
      settingFrom(
        snap({ 'work.request': { max_text_chars: 900 } }),
        'work.request',
        WorkRequestConfig,
        DEFAULT_WORK_REQUEST,
      ),
    ).toEqual({ max_text_chars: 900 });
    expect(
      settingFrom(
        snap({}, ['work.request']),
        'work.request',
        WorkRequestConfig,
        DEFAULT_WORK_REQUEST,
      ),
    ).toBeNull();
    expect(
      settingFrom(
        snap({ 'work.request': { max_text_chars: 'x' } }),
        'work.request',
        WorkRequestConfig,
        DEFAULT_WORK_REQUEST,
      ),
    ).toBeNull();
  });

  it('CatalogueVersion takes a settings release of a base and nothing else', () => {
    expect(CatalogueVersion.safeParse('1.4.0+settings.3').success).toBe(true);
    expect(CatalogueVersion.safeParse('1.4.0+settings.0').success).toBe(false);
    expect(CatalogueVersion.safeParse('1.4.0-settings.1').success).toBe(false);
    expect(CatalogueVersion.safeParse('1.4.0').success).toBe(true);
  });
});

describe('the approvals table in force (gates.policy)', () => {
  it('is GATE_POLICIES until a table is installed, and the installed one after', () => {
    expect(gatePolicies()).toBe(GATE_POLICIES);
    const changed = structuredClone(DEFAULT_GATES_POLICY);
    changed.gates.G2 = { ...changed.gates.G2, slot: 'design', step_up: true };
    changed.two_person_gates = ['X1'];
    installGatePolicies(gatePoliciesOf(GatesPolicyConfig.parse(changed)));
    expect(gatePolicy('G2')).toMatchObject({ slot: 'design', step_up: true });
    expect(gatePolicy('X2').two_person).toBe('never');
    expect(gatePolicy('X1').two_person).toBe('project');
    // the PDP's gate attributes read the same table
    expect(gateAttributes('G2').slot).toBe('design');
    installGatePolicies(null);
    expect(gatePolicy('G2').slot).toBe('intent');
  });

  it('refuses a table that is not one valid row per gate (the previous one stays)', () => {
    expect(() => installGatePolicies({ G0: { slot: 'nobody' } } as never)).toThrow();
    expect(gatePolicies()).toBe(GATE_POLICIES);
  });
});
