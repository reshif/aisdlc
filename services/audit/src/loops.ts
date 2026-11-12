import type { LoopSpec } from '@aisdlc/loops';
import { executeApproved, sweepRetention, type GovernDeps, type RetentionRead } from './govern.js';

// The audit service's two loops (PLAN M19), supervised like every loop (per-loop backoff, health, logs):
//
//   audit_erasure     every approved erasure not finished (core was down, or the service stopped between payloads)
//   audit_retention   one sweep of the published retention classes (a class with `days: null` erases nothing)

export interface AuditLoopOptions {
  readonly executeIntervalMs?: number;
  readonly retentionIntervalMs?: number;
  readonly startDelayMs?: number;
  readonly log?: (line: string) => void;
}

export function auditLoops(
  d: GovernDeps,
  retention: () => RetentionRead,
  o: AuditLoopOptions = {},
): LoopSpec[] {
  const e = o.executeIntervalMs ?? 30_000;
  const r = o.retentionIntervalMs ?? 3_600_000;
  return [
    {
      name: 'audit_erasure',
      intervalMs: e,
      ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
      retry: { baseMs: Math.min(5_000, e), maxMs: Math.max(e, 120_000) },
      tick: async () => {
        const n = await executeApproved(d);
        if (n > 0) o.log?.(`${n} erasure(s) executed`);
      },
    },
    {
      name: 'audit_retention',
      intervalMs: r,
      startDelayMs: (o.startDelayMs ?? 0) + 2_000,
      retry: { baseMs: Math.min(30_000, r), maxMs: Math.max(r, 600_000) },
      tick: async () => {
        const s = await sweepRetention(d, retention());
        if (!s.ok) throw new Error(`retention: ${s.error.code}`);
        if (s.value.due > 0 || s.value.held > 0) {
          o.log?.(`retention: ${s.value.due} payload(s) due, ${s.value.held} kept under a hold`);
        }
      },
    },
  ];
}
