import { agentSettingsDefaults } from '@aisdlc/agents';
import {
  AgentsSettingsConfig,
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
  EvalsGateConfig,
  GATEWAY_CONFIG_KEYS,
  GatesPolicyConfig,
  GatesTimersConfig,
  GatewayLimitsConfig,
  OpsHealthConfig,
  PlanningSizeShareConfig,
  ReadinessPolicyConfig,
  SETTINGS_KEYS,
  SandboxProbeConfig,
  SandboxProfilesConfig,
  SessionPolicyConfig,
  WorkRequestConfig,
  type GatewayModels,
} from '@aisdlc/contracts';
import { AGENT_SPECS } from '@aisdlc/agents';
import type { z } from 'zod';
import { registerCatalogueConfig } from './catalogue.js';
import type { ConfigRegistry } from './registry.js';

// The portal v2 settings that were constants or environment variables (screen map §5, H6-H17, H22-H28): one
// factory key each, today's value as the default, M1-gated like every revision. `docs/design/settings-catalogue.md`
// lists them with their plain names, who may change them and when a change takes effect. The catalogue's own
// sections (H1-H5, H18-H21) are `registerCatalogueConfig`.

interface Def {
  readonly key: string;
  readonly schema: z.ZodType;
  readonly default: unknown;
  readonly description: string;
}

const DEFS: readonly Def[] = [
  {
    key: SETTINGS_KEYS.gates_policy,
    schema: GatesPolicyConfig,
    default: DEFAULT_GATES_POLICY,
    description:
      'Approvals (H6, H7): who decides each approval (the role slot), whether the requester may decide their own, confirm-it’s-you, whether it may share a card, and which approvals need two people when the project’s two-person setting is on. Takes effect for approvals opened and decided from then on. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.gates_timers,
    schema: GatesTimersConfig,
    default: DEFAULT_GATES_TIMERS,
    description:
      'Approval timers (H8): an approval expires after (an expiry never approves), a confirm-it’s-you proof lasts, a prepared decision lasts. The overdue-after of an approval is the catalogue’s B21. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.readiness_policy,
    schema: ReadinessPolicyConfig,
    default: DEFAULT_READINESS_POLICY,
    description:
      'Readiness rules (H10): the readiness record is valid for, a waiver lasts at most, facts to confirm at most, share of facts confirmed. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.session_policy,
    schema: SessionPolicyConfig,
    default: DEFAULT_SESSION_POLICY,
    description:
      'Sign-in session limits (H16): signed out after this idle time, and after this long whatever happens. The environment values are the bootstrap default only. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.gateway_limits,
    schema: GatewayLimitsConfig,
    default: DEFAULT_GATEWAY_LIMITS,
    description:
      'Model call safety ceiling (H17): the most provider calls one gateway process makes (0: none). Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.ops_health,
    schema: OpsHealthConfig,
    default: DEFAULT_OPS_HEALTH,
    description:
      'Health timers (H22, H23): health reads unknown after, readings taken every, alert after, ledger checkpoint overdue after. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.evals_gate,
    schema: EvalsGateConfig,
    default: DEFAULT_EVALS_GATE,
    description:
      'Evaluation gate (H24): the score floor, the confidence level and the resamples of the comparison with the baseline. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.codehost_polls,
    schema: CodehostPollsConfig,
    default: DEFAULT_CODEHOST_POLLS,
    description:
      'GitHub poll intervals (H25): repo heads and pull requests, protection and collaborators, installations. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.work_request,
    schema: WorkRequestConfig,
    default: DEFAULT_WORK_REQUEST,
    description:
      'Request text limit (H26): a longer request is refused, never cut. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.sandbox_probe,
    schema: SandboxProbeConfig,
    default: DEFAULT_SANDBOX_PROBE,
    description:
      'Test-run sandbox lease (H27): the onboarding test run’s grant lapses after this. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.sandbox_profiles,
    schema: SandboxProfilesConfig,
    default: DEFAULT_SANDBOX_PROFILES,
    description:
      'Sandbox limits per kind (H28): memory, CPU, processes, time, output and scratch. Lower only: each value is at most the deployment’s ceiling. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.planning_size_share,
    schema: PlanningSizeShareConfig,
    default: DEFAULT_PLANNING_SIZE_SHARE,
    description:
      'Budget share per part size (H15): the share of the coding agent’s budget a small, medium and large part may spend. Takes effect for plans made from then on. Factory layer only, M1-gated',
  },
  {
    key: SETTINGS_KEYS.agents_settings,
    schema: AgentsSettingsConfig,
    default: agentSettingsDefaults(),
    description:
      'Agents (H12, H13, H14): each agent on or off, its models, its budget per run (tokens, money, key lifetime) and, for the coding agent, max turns and time limits. Tools and most sensitive data stay the agent contract’s. Factory layer only, M1-gated',
  },
];

/** Registers every portal v2 settings key, the catalogue's sections included. Idempotent. */
export function registerSettingsConfig(registry: ConfigRegistry): ConfigRegistry {
  registerCatalogueConfig(registry);
  for (const d of DEFS) {
    if (registry.get(d.key)) continue;
    registry.setting({ ...d, overridable: false });
  }
  if (!rulesOn.has(registry)) {
    rulesOn.add(registry);
    registry.rule({
      name: 'agent models',
      check(values) {
        const table = (values[SETTINGS_KEYS.agents_settings] ?? {}) as AgentsSettingsConfig;
        const rows = (values[GATEWAY_CONFIG_KEYS.models] ?? []) as GatewayModels;
        const routed = new Set(rows.map((m) => m.model_id));
        const problems: string[] = [];
        for (const [id, row] of Object.entries(table)) {
          const contract = AGENT_SPECS.find((s) => s.agent_id === id)?.models ?? [];
          for (const m of row?.models ?? []) {
            if (!contract.includes(m) && !routed.has(m)) {
              problems.push(`${id}: model ${m} is neither in its contract nor in gateway.models`);
            }
          }
        }
        return problems;
      },
    });
  }
  return registry;
}

const rulesOn = new WeakSet<ConfigRegistry>();

/** The settings keys this module registers (not the catalogue's), for the docs and the tests. */
export const SETTINGS_KEY_DEFAULTS: ReadonlyArray<{ key: string; default: unknown }> = DEFS.map(
  (d) => ({
    key: d.key,
    default: d.default,
  }),
);
