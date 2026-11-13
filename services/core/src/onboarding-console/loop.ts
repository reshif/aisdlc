import type { LoopContext, LoopSpec } from '@aisdlc/loops';
import { activeSessionIds, observe, wake, type ConsoleDeps } from './engine.js';

/**
 * `onboarding_console`: for every session that is not over, notes what moved in the record (an observation turn when the
 * blockers changed) and lets the agent answer what is new. A paused session is looked at (its observation is kept) and
 * not woken; a stopped one is not looked at. One failing session does not stop the others.
 */
export function onboardingConsoleLoop(
  d: ConsoleDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 15_000;
  return {
    name: 'onboarding_console',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(10_000, intervalMs), maxMs: Math.max(intervalMs, 120_000) },
    async tick(ctx: LoopContext) {
      const ids = await activeSessionIds(d);
      return ctx.eachItem(
        ids,
        (id) => `onboarding console ${id}`,
        async (id) => {
          const o1 = await observe(d, id);
          if (!o1.ok && o1.error.code !== 'conflict') throw new Error(o1.error.message);
          const w = await wake(d, id);
          if (!w.ok && w.error.code !== 'conflict') throw new Error(w.error.message);
        },
      );
    },
  };
}
