import type { LoopSpec } from '@aisdlc/loops';
import type { GateRelay } from './relay.js';

// gate-relay's two loops (PLAN M15.3), supervised like every loop (per-loop backoff, health, logs):
//
//   gate_relay_consume   every item's newest approved G5 not yet answered: checked again, then released once
//   gate_relay_health    every deployment with no verdict: its newest status (B16 rollback when unhealthy)

export interface GateRelayLoopOptions {
  readonly consumeIntervalMs?: number;
  readonly healthIntervalMs?: number;
  readonly startDelayMs?: number;
  readonly onRelease?: (n: number) => void;
}

export function gateRelayLoops(relay: GateRelay, o: GateRelayLoopOptions = {}): LoopSpec[] {
  const c = o.consumeIntervalMs ?? 15_000;
  const h = o.healthIntervalMs ?? 30_000;
  return [
    {
      name: 'gate_relay_consume',
      intervalMs: c,
      ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
      retry: { baseMs: Math.min(5_000, c), maxMs: Math.max(c, 60_000) },
      tick: async () => {
        const r = await relay.consumeAll();
        const released = r.filter((x) => x.kind === 'released').length;
        if (released > 0) o.onRelease?.(released);
      },
    },
    {
      name: 'gate_relay_health',
      intervalMs: h,
      startDelayMs: (o.startDelayMs ?? 0) + 1_000,
      retry: { baseMs: Math.min(5_000, h), maxMs: Math.max(h, 120_000) },
      tick: async () => {
        await relay.observeAll();
      },
    },
  ];
}
