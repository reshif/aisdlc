import {
  CodehostPollsConfig,
  DEFAULT_CODEHOST_POLLS,
  DEFAULT_EVALS_GATE,
  DEFAULT_GATES_TIMERS,
  DEFAULT_GATEWAY_LIMITS,
  DEFAULT_OPS_HEALTH,
  DEFAULT_READINESS_POLICY,
  DEFAULT_SANDBOX_PROBE,
  DEFAULT_SESSION_POLICY,
  DEFAULT_WORK_REQUEST,
  EvalsGateConfig,
  GatesTimersConfig,
  GatewayLimitsConfig,
  OpsHealthConfig,
  ReadinessPolicyConfig,
  SETTINGS_KEYS,
  SandboxProbeConfig,
  SessionPolicyConfig,
  WorkRequestConfig,
  settingFrom,
  type SettingsSnapshot,
} from '@aisdlc/contracts';
import { canonicalJson } from '@aisdlc/kernel';
import type { z } from 'zod';

// The runtime readers of the portal v2 timer and policy settings (H8, H10, H16, H17, H22-H27): each takes anything
// with `current()` (a `ConfigReader`) and is called where the value is used, so a published revision is in force on
// the next use, without a restart. A value that does not read falls back to the default (these are timers and
// limits whose defaults are the shipped, tested values; nothing here approves or admits anything by itself).
//
// `bootstrap`: a service whose environment sets the value (the env stays as the bootstrap default only): the env
// value is used until the factory publishes a value that differs from the code's default.

export interface SnapshotSource {
  current(): SettingsSnapshot;
}

function read<T>(
  src: SnapshotSource | null | undefined,
  key: string,
  schema: z.ZodType<T>,
  fallback: T,
  bootstrap?: T,
): T {
  const v = settingFrom(src?.current(), key, schema, fallback);
  if (v === null) return bootstrap ?? fallback;
  if (bootstrap !== undefined && canonicalJson(v) === canonicalJson(fallback)) return bootstrap;
  return v;
}

/** `gates.timers` (H8). */
export const gatesTimersFrom = (src?: SnapshotSource | null): GatesTimersConfig =>
  read(src, SETTINGS_KEYS.gates_timers, GatesTimersConfig, DEFAULT_GATES_TIMERS);

/** `readiness.policy` (H10). */
export const readinessPolicyFrom = (src?: SnapshotSource | null): ReadinessPolicyConfig =>
  read(src, SETTINGS_KEYS.readiness_policy, ReadinessPolicyConfig, DEFAULT_READINESS_POLICY);

/** `session.policy` (H16); `bootstrap` is the env's (`BFF_IDLE_SECONDS`, `BFF_ABSOLUTE_SECONDS`). */
export const sessionPolicyFrom = (
  src?: SnapshotSource | null,
  bootstrap?: SessionPolicyConfig,
): SessionPolicyConfig =>
  read(src, SETTINGS_KEYS.session_policy, SessionPolicyConfig, DEFAULT_SESSION_POLICY, bootstrap);

/** `gateway.limits` (H17); `bootstrap` is `GATEWAY_MAX_PROVIDER_CALLS`. */
export const gatewayLimitsFrom = (
  src?: SnapshotSource | null,
  bootstrap?: GatewayLimitsConfig,
): GatewayLimitsConfig =>
  read(src, SETTINGS_KEYS.gateway_limits, GatewayLimitsConfig, DEFAULT_GATEWAY_LIMITS, bootstrap);

/** `ops.health` (H22, H23). */
export const opsHealthFrom = (src?: SnapshotSource | null): OpsHealthConfig =>
  read(src, SETTINGS_KEYS.ops_health, OpsHealthConfig, DEFAULT_OPS_HEALTH);

/** `evals.gate` (H24). */
export const evalsGateFrom = (src?: SnapshotSource | null): EvalsGateConfig =>
  read(src, SETTINGS_KEYS.evals_gate, EvalsGateConfig, DEFAULT_EVALS_GATE);

/** `codehost.polls` (H25); `bootstrap` is core-worker's env intervals. */
export const codehostPollsFrom = (
  src?: SnapshotSource | null,
  bootstrap?: CodehostPollsConfig,
): CodehostPollsConfig =>
  read(src, SETTINGS_KEYS.codehost_polls, CodehostPollsConfig, DEFAULT_CODEHOST_POLLS, bootstrap);

/** `work.request` (H26). */
export const workRequestFrom = (src?: SnapshotSource | null): WorkRequestConfig =>
  read(src, SETTINGS_KEYS.work_request, WorkRequestConfig, DEFAULT_WORK_REQUEST);

/** `sandbox.probe` (H27). */
export const sandboxProbeFrom = (src?: SnapshotSource | null): SandboxProbeConfig =>
  read(src, SETTINGS_KEYS.sandbox_probe, SandboxProbeConfig, DEFAULT_SANDBOX_PROBE);
