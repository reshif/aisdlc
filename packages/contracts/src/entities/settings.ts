import { z } from 'zod';
import { GateId, type GateId as GateIdType } from '../flow.js';
import { AgentId } from './agent-definitions.js';
import { GATE_POLICIES, GatePolicy } from './gate-lifecycle.js';
import { INTEGRATION_HEALTH_STALE_MS } from './integrations.js';
import { PROBE_GRANT_TTL_S } from './onboarding-probe.js';
import { LF6_MIN_AFFIRMED_OR_UNKNOWN, MAX_LIGHT_CLAIMS } from './onboarding-light.js';
import {
  HEALTH_SNAPSHOT_INTERVAL_MS,
  OPS_ALERT_AFTER_MS,
  OPS_CHECKPOINT_OVERDUE_MS,
} from './ops-health.js';
import { TWO_PERSON_GATES } from './projects.js';
import { MAX_WAIVER_DAYS, PRR_FRESH_DAYS } from './readiness.js';
import { SANDBOX_PROFILES, SandboxClass, SandboxLimits } from './sandbox.js';
import { STEP_UP_TTL_SECONDS } from './step-up.js';
import { EVAL_COMPARE_LEVEL } from './evals.js';

// Portal v2 settings (docs/design/settings-catalogue.md; screen map §5, H1-H29): what was a constant or an
// environment variable becomes a config key of the FACTORY layer, M1-gated like every revision, with today's value
// as its default. Each key has one Zod schema here (the portal renders a form from its JSON Schema) and one pure
// reader (`*From`) that turns a config snapshot into the value in force. FAIL CLOSED: a published value that no
// longer fits its schema is never replaced by a looser one; the reader returns the default only where the default is
// the safe side, and otherwise `null` (the caller treats it as unmet).
//
// The catalogue's own data (tracks, retry limits, rework, extension, gating, eligibility, autonomy: H1-H5, H18-H21)
// is NOT here: those keys are registered by `@aisdlc/config` over the schemas of `@aisdlc/catalogue`, and a change to
// them makes a new catalogue version (items keep the version they pinned).

/** The keys, one place. */
export const SETTINGS_KEYS = {
  /** H6, H7: who decides each approval, two people, confirm it's you, may share a card. */
  gates_policy: 'gates.policy',
  /** H8: approval expiry and the life of a confirm-it's-you proof and a prepared decision. */
  gates_timers: 'gates.timers',
  /** H10: readiness rules. */
  readiness_policy: 'readiness.policy',
  /** H16: sign-in session limits. */
  session_policy: 'session.policy',
  /** H17: the gateway's per-process safety ceiling. */
  gateway_limits: 'gateway.limits',
  /** H22, H23: health and alert timers. */
  ops_health: 'ops.health',
  /** H24: the evaluation gate. */
  evals_gate: 'evals.gate',
  /** H25: GitHub poll intervals. */
  codehost_polls: 'codehost.polls',
  /** H26: the request text limit. */
  work_request: 'work.request',
  /** H27: the test-run (onboarding probe) sandbox lease. */
  sandbox_probe: 'sandbox.probe',
  /** H28: the sandbox kinds' ceilings (lower only, within the deployment's ceilings `SANDBOX_PROFILES`). */
  sandbox_profiles: 'sandbox.profiles',
  /** H15: the budget share of each part size. */
  planning_size_share: 'planning.size_share',
  /** H12, H13, H14: model, budget, turns and time limits per agent, and agents on or off. */
  agents_settings: 'agents.config',
} as const;
export type SettingsKey = (typeof SETTINGS_KEYS)[keyof typeof SETTINGS_KEYS];

/** A snapshot as `ConfigReader.current()` gives it (the shape every reader below takes). */
export interface SettingsSnapshot {
  readonly rejected: readonly string[];
  get(key: string): unknown;
}

/**
 * The value of `key` in force: the published value when it fits `schema`, the default when nothing is published, and
 * `null` when the published value no longer fits (the caller decides the safe side).
 */
export function settingFrom<T>(
  c: SettingsSnapshot | null | undefined,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
): T | null {
  if (!c) return fallback;
  if (c.rejected.includes(key)) return null;
  const v = c.get(key);
  if (v === undefined) return fallback;
  const p = schema.safeParse(v);
  return p.success ? p.data : null;
}

// ---------------------------------------------------------------- the settings in force in this process

const inForce = new Map<string, unknown>();

/**
 * Installs the value of a settings key for this process (`followSettings` in `@aisdlc/config` does it for every key
 * on every revision; `null`: back to the default). Read deep in code that has no config reader with `settingInForce`.
 * The value must already be validated (the installer parses it with the key's schema).
 */
export function installSetting(key: SettingsKey, value: unknown): void {
  if (value === null || value === undefined) inForce.delete(key);
  else inForce.set(key, value);
}

/** The installed value of a key, or `fallback` (its default) when this process installed none. */
export function settingInForce<T>(key: SettingsKey, fallback: T): T {
  return inForce.has(key) ? (inForce.get(key) as T) : fallback;
}

// ---------------------------------------------------------------- H6, H7 approvals

/**
 * The approvals table: one row per gate (`GATE_POLICIES` is the default) and the gates that need two people when the
 * project's two-person setting is on (`TWO_PERSON_GATES`). The `two_person` of a row follows the list: a gate in
 * `two_person_gates` is `project`, every other gate `never` (one source, never two answers).
 */
export const GatesPolicyConfig = z
  .strictObject({
    gates: z.record(GateId, GatePolicy.omit({ two_person: true })),
    two_person_gates: z.array(GateId).max(GateId.options.length),
  })
  .refine((v) => new Set(v.two_person_gates).size === v.two_person_gates.length, {
    message: 'a gate is listed twice in two_person_gates',
  })
  .refine((v) => (['X', 'E', 'Q', 'M'] as const).every((f) => noConsolidatable(v.gates, f)), {
    message: 'exception (X, E), quarantine (Q) and meta (M) approvals never share a card',
  });
export type GatesPolicyConfig = z.infer<typeof GatesPolicyConfig>;

function noConsolidatable(
  gates: Readonly<Record<string, { consolidatable: boolean }>>,
  family: string,
): boolean {
  return Object.entries(gates).every(([g, p]) => !g.startsWith(family) || !p.consolidatable);
}

export const DEFAULT_GATES_POLICY: GatesPolicyConfig = {
  gates: Object.fromEntries(
    Object.entries(GATE_POLICIES).map(([g, p]) => [
      g,
      {
        slot: p.slot,
        own_request: p.own_request,
        step_up: p.step_up,
        consolidatable: p.consolidatable,
      },
    ]),
  ) as GatesPolicyConfig['gates'],
  two_person_gates: [...TWO_PERSON_GATES],
};

/** The policy rows in force, built from a config value (the shape `GATE_POLICIES` has). */
export function gatePoliciesOf(v: GatesPolicyConfig): Record<GateIdType, GatePolicy> {
  const two = new Set<string>(v.two_person_gates);
  return Object.fromEntries(
    Object.entries(v.gates).map(([g, p]) => [
      g,
      { ...p, two_person: two.has(g) ? 'project' : 'never' } satisfies GatePolicy,
    ]),
  ) as Record<GateIdType, GatePolicy>;
}

// ---------------------------------------------------------------- H8 approval timers

export const GatesTimersConfig = z.strictObject({
  /** A gate opened without `facts.expires_at` expires after this (an expiry never approves). */
  expires_after_s: z
    .number()
    .int()
    .min(3600)
    .max(90 * 86_400),
  /** A confirm-it's-you proof lives this long (D37: short-lived). */
  step_up_ttl_s: z.number().int().min(30).max(900),
  /** A prepared decision's nonce lives this long. */
  nonce_ttl_s: z.number().int().min(60).max(3600),
});
export type GatesTimersConfig = z.infer<typeof GatesTimersConfig>;
export const DEFAULT_GATES_TIMERS: GatesTimersConfig = {
  expires_after_s: 7 * 86_400,
  step_up_ttl_s: STEP_UP_TTL_SECONDS,
  nonce_ttl_s: 600,
};

// ---------------------------------------------------------------- H10 readiness

/**
 * Lower only for the three numbers the record's own schemas bound (`PRR_FRESH_DAYS`, `MAX_WAIVER_DAYS`,
 * `MAX_LIGHT_CLAIMS` are the ceilings a stored record is checked against); the LF6 share may move either way.
 */
export const ReadinessPolicyConfig = z.strictObject({
  /** The readiness record (PRR) is fresh this many days after it is issued. */
  prr_fresh_days: z.number().int().min(1).max(PRR_FRESH_DAYS),
  /** A gap waiver lasts at most this many days. */
  max_waiver_days: z.number().int().min(1).max(MAX_WAIVER_DAYS),
  /** Light onboarding asks to confirm at most this many facts. */
  max_light_claims: z.number().int().min(1).max(MAX_LIGHT_CLAIMS),
  /** At least this share of the facts must be confirmed or "don't know" (LF6). */
  lf6_min_affirmed_or_unknown: z.number().min(0.5).max(1),
});
export type ReadinessPolicyConfig = z.infer<typeof ReadinessPolicyConfig>;
export const DEFAULT_READINESS_POLICY: ReadinessPolicyConfig = {
  prr_fresh_days: PRR_FRESH_DAYS,
  max_waiver_days: MAX_WAIVER_DAYS,
  max_light_claims: MAX_LIGHT_CLAIMS,
  lf6_min_affirmed_or_unknown: LF6_MIN_AFFIRMED_OR_UNKNOWN,
};

let readinessInForce: ReadinessPolicyConfig = DEFAULT_READINESS_POLICY;

/**
 * The readiness rules in force in this process (`readiness.policy`, installed on every revision by a service that
 * reads config; `null`: the defaults). Read where the rule is applied: card 1's waivers, card 2's claims and LF6, the
 * readiness record's freshness. An invalid value throws and the previous rules stay.
 */
export function installReadinessPolicy(v: ReadinessPolicyConfig | null): void {
  readinessInForce = v === null ? DEFAULT_READINESS_POLICY : ReadinessPolicyConfig.parse(v);
}
export const readinessPolicy = (): ReadinessPolicyConfig => readinessInForce;

// ---------------------------------------------------------------- H16 sign-in sessions

export const SessionPolicyConfig = z
  .strictObject({
    idle_s: z.number().int().min(60).max(86_400),
    absolute_s: z
      .number()
      .int()
      .min(300)
      .max(7 * 86_400),
  })
  .refine((v) => v.idle_s <= v.absolute_s, {
    message: 'the idle limit cannot be above the absolute limit',
  });
export type SessionPolicyConfig = z.infer<typeof SessionPolicyConfig>;
/** The env (`BFF_IDLE_SECONDS`, `BFF_ABSOLUTE_SECONDS`) stays as the bootstrap default only. */
export const DEFAULT_SESSION_POLICY: SessionPolicyConfig = {
  idle_s: 30 * 60,
  absolute_s: 8 * 3600,
};

// ---------------------------------------------------------------- H17 gateway ceiling

export const GatewayLimitsConfig = z.strictObject({
  /** Most provider calls one gateway process makes before it refuses (0: none). */
  max_provider_calls: z.number().int().min(0).max(10_000_000),
});
export type GatewayLimitsConfig = z.infer<typeof GatewayLimitsConfig>;
export const DEFAULT_GATEWAY_LIMITS: GatewayLimitsConfig = { max_provider_calls: 1000 };

// ---------------------------------------------------------------- H22, H23 health

export const OpsHealthConfig = z.strictObject({
  /** A health report older than this reads `unknown`. */
  stale_after_ms: z.number().int().min(10_000).max(3_600_000),
  /** How often core-worker takes the readings. */
  snapshot_interval_ms: z.number().int().min(5_000).max(600_000),
  /** A tile must read bad this long before anyone is paged. */
  alert_after_ms: z.number().int().min(10_000).max(3_600_000),
  /** The newest ledger checkpoint may be this old, while entries wait, before it is overdue. */
  checkpoint_overdue_ms: z.number().int().min(60_000).max(86_400_000),
});
export type OpsHealthConfig = z.infer<typeof OpsHealthConfig>;
export const DEFAULT_OPS_HEALTH: OpsHealthConfig = {
  stale_after_ms: INTEGRATION_HEALTH_STALE_MS,
  snapshot_interval_ms: HEALTH_SNAPSHOT_INTERVAL_MS,
  alert_after_ms: OPS_ALERT_AFTER_MS,
  checkpoint_overdue_ms: OPS_CHECKPOINT_OVERDUE_MS,
};

// ---------------------------------------------------------------- H24 evaluation gate

export const EvalsGateConfig = z.strictObject({
  /** Below this pass rate a run fails the gate whatever the baseline. */
  floor: z.number().min(0).max(1),
  /** The bootstrap's confidence level. */
  level: z.number().min(0.5).max(0.999),
  resamples: z.number().int().min(100).max(100_000),
});
export type EvalsGateConfig = z.infer<typeof EvalsGateConfig>;
export const DEFAULT_EVALS_GATE: EvalsGateConfig = {
  floor: 0.8,
  level: EVAL_COMPARE_LEVEL,
  resamples: 2000,
};

// ---------------------------------------------------------------- H25 GitHub polls

export const CodehostPollsConfig = z.strictObject({
  /** Repo heads and pull requests. */
  fast_ms: z.number().int().min(60_000).max(86_400_000),
  /** Branch protection, collaborators. */
  hourly_ms: z.number().int().min(300_000).max(86_400_000),
  /** Installations and repo lists. */
  daily_ms: z
    .number()
    .int()
    .min(3_600_000)
    .max(7 * 86_400_000),
});
export type CodehostPollsConfig = z.infer<typeof CodehostPollsConfig>;
export const DEFAULT_CODEHOST_POLLS: CodehostPollsConfig = {
  fast_ms: 600_000,
  hourly_ms: 3_600_000,
  daily_ms: 86_400_000,
};

// ---------------------------------------------------------------- H26 request text

export const WorkRequestConfig = z.strictObject({
  /** A request longer than this is refused, never truncated. */
  max_text_chars: z.number().int().min(500).max(200_000),
});
export type WorkRequestConfig = z.infer<typeof WorkRequestConfig>;
export const DEFAULT_WORK_REQUEST: WorkRequestConfig = { max_text_chars: 20_000 };

// ---------------------------------------------------------------- H27 test-run lease

export const SandboxProbeConfig = z.strictObject({
  /** The onboarding test-run grant lapses after this. */
  grant_ttl_s: z.number().int().min(300).max(7200),
});
export type SandboxProbeConfig = z.infer<typeof SandboxProbeConfig>;
export const DEFAULT_SANDBOX_PROBE: SandboxProbeConfig = { grant_ttl_s: PROBE_GRANT_TTL_S };

// ---------------------------------------------------------------- H28 sandbox ceilings

/**
 * Per kind, the limits a session may have. Each value is at most the deployment's ceiling (`SANDBOX_PROFILES`, which
 * is code: the host was sized for it), so a setting can only lower a ceiling or put it back.
 */
export const SandboxProfilesConfig = z
  .partialRecord(SandboxClass, SandboxLimits.partial())
  .superRefine((v, ctx) => {
    for (const [cls, lim] of Object.entries(v)) {
      const ceiling = SANDBOX_PROFILES[cls as SandboxClass].limits;
      for (const [k, n] of Object.entries(lim ?? {})) {
        if (typeof n === 'number' && n > ceiling[k as keyof SandboxLimits]) {
          ctx.addIssue({
            code: 'custom',
            message: `${cls}.${k}=${n} is above the deployment ceiling ${ceiling[k as keyof SandboxLimits]}`,
          });
        }
      }
    }
  });
export type SandboxProfilesConfig = z.infer<typeof SandboxProfilesConfig>;
export const DEFAULT_SANDBOX_PROFILES: SandboxProfilesConfig = Object.fromEntries(
  Object.entries(SANDBOX_PROFILES).map(([c, p]) => [c, { ...p.limits }]),
);

// ---------------------------------------------------------------- H15 budget share per part size

export const PlanningSizeShareConfig = z.strictObject({
  small: z.number().gt(0).max(1),
  medium: z.number().gt(0).max(1),
  large: z.number().gt(0).max(1),
});
export type PlanningSizeShareConfig = z.infer<typeof PlanningSizeShareConfig>;
export const DEFAULT_PLANNING_SIZE_SHARE: PlanningSizeShareConfig = {
  small: 0.25,
  medium: 0.5,
  large: 1,
};

// ---------------------------------------------------------------- H12, H13, H14 per agent

/**
 * One agent's settings. Everything is optional: what a row leaves out is the agent contract's value. The contract's
 * tools and most sensitive data stay the contract's (no setting can widen them); `models` must be models the gateway
 * routes (`gateway.models`, checked across keys where both are registered).
 */
export const AgentSettingsRow = z.strictObject({
  enabled: z.boolean().optional(),
  models: z.array(z.string().min(1).max(64)).min(1).max(8).optional(),
  budget: z
    .strictObject({
      max_tokens: z.number().int().min(1).max(1_000_000_000),
      max_cost_micro_usd: z.number().int().min(1).max(1_000_000_000_000),
      ttl_seconds: z.number().int().min(60).max(86_400),
    })
    .optional(),
  /** The coding agent: most turns of one session. */
  max_turns: z.number().int().min(1).max(500).optional(),
  /** The coding agent: wall clock of one session. */
  run_time_s: z.number().int().min(60).max(14_400).optional(),
  /** The coding agent: wall clock of one test run. */
  test_time_s: z.number().int().min(30).max(14_400).optional(),
});
export type AgentSettingsRow = z.infer<typeof AgentSettingsRow>;
export const AgentsSettingsConfig = z.partialRecord(AgentId, AgentSettingsRow);
export type AgentsSettingsConfig = z.infer<typeof AgentsSettingsConfig>;

/** The coding session's limits of today (`packages/build` coding port), the defaults of the coder row. */
export const DEFAULT_CODER_LIMITS = { max_turns: 40, run_time_s: 1800, test_time_s: 600 } as const;
