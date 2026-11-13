import {
  CodehostPollsConfig,
  EvalsGateConfig,
  GatesTimersConfig,
  GatewayLimitsConfig,
  OpsHealthConfig,
  PlanningSizeShareConfig,
  SandboxProbeConfig,
  SandboxProfilesConfig,
  SessionPolicyConfig,
  WorkRequestConfig,
  installSetting,
  type SettingsKey,
  DEFAULT_GATES_POLICY,
  GatesPolicyConfig,
  SETTINGS_KEYS,
  gatePoliciesOf,
  installGatePolicies,
  installReadinessPolicy,
  settingFrom,
} from '@aisdlc/contracts';
import { readinessPolicyFrom } from './readers.js';
import type pg from 'pg';
import type { z } from 'zod';
import { loadSettingsReleases } from './catalogue.js';
import type { ConfigReader, EffectiveConfig } from './reader.js';

// What a process that reads config follows of the portal v2 settings, on every revision (no restart):
//   - the catalogue's settings releases, so `catalogueFor` reads an item pinned to one (`loadSettingsReleases`);
//   - the approvals table (`gates.policy`), installed for `gatePolicy` (every reader of a gate's slot, two-person
//     rule, step-up and card sharing). A published table that does not read installs the code's table
//     (`GATE_POLICIES`) and is reported: the shipped rules, never a looser guess.

/** The scalar keys installed for `settingInForce` (a value that does not read installs nothing: the default). */
const SCALARS: ReadonlyArray<[SettingsKey, z.ZodType]> = [
  [SETTINGS_KEYS.gates_timers, GatesTimersConfig],
  [SETTINGS_KEYS.session_policy, SessionPolicyConfig],
  [SETTINGS_KEYS.gateway_limits, GatewayLimitsConfig],
  [SETTINGS_KEYS.ops_health, OpsHealthConfig],
  [SETTINGS_KEYS.evals_gate, EvalsGateConfig],
  [SETTINGS_KEYS.codehost_polls, CodehostPollsConfig],
  [SETTINGS_KEYS.work_request, WorkRequestConfig],
  [SETTINGS_KEYS.sandbox_probe, SandboxProbeConfig],
  [SETTINGS_KEYS.sandbox_profiles, SandboxProfilesConfig],
  [SETTINGS_KEYS.planning_size_share, PlanningSizeShareConfig],
];

/** Installs every scalar settings key of a snapshot for this process. */
export function applyScalarSettings(c: EffectiveConfig): void {
  for (const [key, schema] of SCALARS) {
    if (c.rejected.includes(key)) {
      installSetting(key, null);
      continue;
    }
    const p = schema.safeParse(c.get(key));
    installSetting(key, p.success ? p.data : null);
  }
}

/** Installs the approvals table of a snapshot. Returns false when the published value did not read. */
export function applyGatePolicies(c: EffectiveConfig): boolean {
  const v = settingFrom(c, SETTINGS_KEYS.gates_policy, GatesPolicyConfig, DEFAULT_GATES_POLICY);
  installGatePolicies(v === null ? null : gatePoliciesOf(v));
  return v !== null;
}

export interface FollowSettingsOptions {
  readonly reader: ConfigReader;
  /** The record database, for the releases. Absent: releases are not loaded (a process that pins nothing). */
  readonly pool?: pg.Pool;
  /** Install `gates.policy` (default true). */
  readonly gatePolicies?: boolean;
  readonly onError?: (e: unknown) => void;
}

/** Applies the settings now and on every change; resolves after the first load. Returns the unsubscribe. */
export async function followSettings(o: FollowSettingsOptions): Promise<() => void> {
  const report = o.onError ?? (() => undefined);
  const load = async () => {
    if (!o.pool) return;
    try {
      const r = await loadSettingsReleases(o.pool);
      for (const why of r.refused) report(new Error(`catalogue release refused: ${why}`));
    } catch (e) {
      report(e);
    }
  };
  const apply = (c: EffectiveConfig) => {
    // `readiness.policy` (H10): card 1's waivers, card 2's claims and LF6, the readiness record's freshness
    installReadinessPolicy(readinessPolicyFrom({ current: () => c }));
    applyScalarSettings(c);
    if (o.gatePolicies !== false && !applyGatePolicies(c)) {
      report(
        new Error(
          `${SETTINGS_KEYS.gates_policy} does not read: the code's approvals table is in force`,
        ),
      );
    }
  };
  apply(o.reader.current());
  await load();
  return o.reader.subscribe(({ to }) => {
    apply(to);
    void load();
  });
}
