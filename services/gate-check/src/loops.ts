import type { ConfigReader } from '@aisdlc/config';
import { MERGE_BYPASS_CONFIG_KEY, MergeBypassConfig } from '@aisdlc/contracts';
import type { LoopContext, LoopSpec } from '@aisdlc/loops';
import type { GateChecker } from './checker.js';
import type { FactsPort } from './facts.js';

// gate-check's two loops (PLAN M14.5), supervised like every loop (per-loop backoff, health, logs):
//
//   gate_check_verdicts   every registered repo's open PRs: a verdict each, `aisdlc/gate` written when it changed
//   gate_check_merges     every registered repo's merged PRs: classed and recorded once (bypass and unauthorised
//                         merges get their X4 review from core)
//
// The registered repos are core's `core.repo` rows, read every tick. A repo that cannot be read fails ITS item; a
// PR that cannot be served fails its repo's item after the others were served.

/** The published bypass list, or `null` (nobody) when it no longer fits its schema or cannot be read. */
export function bypassFrom(reader: ConfigReader): () => MergeBypassConfig | null {
  return () => {
    try {
      const c = reader.current();
      if (c.rejected.includes(MERGE_BYPASS_CONFIG_KEY)) return null;
      const v = c.get(MERGE_BYPASS_CONFIG_KEY);
      if (v === undefined) return {};
      const p = MergeBypassConfig.safeParse(v);
      return p.success ? p.data : null;
    } catch {
      return null;
    }
  };
}

/** Runs `fn` for every item; failures are collected and thrown together at the end (one bad PR stops nothing). */
export async function eachCollecting<T>(
  items: readonly T[],
  label: (i: T) => string,
  fn: (i: T) => Promise<void>,
): Promise<void> {
  const failed: string[] = [];
  for (const i of items) {
    try {
      await fn(i);
    } catch (e) {
      failed.push(`${label(i)}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
    }
  }
  if (failed.length > 0) throw new Error(failed.join('; '));
}

export interface GateCheckLoopOptions {
  readonly verdictIntervalMs?: number;
  readonly mergeIntervalMs?: number;
  readonly startDelayMs?: number;
  readonly onWrite?: (repo: string, n: number) => void;
}

const tickOver =
  (
    facts: FactsPort,
    run: (repo: Awaited<ReturnType<FactsPort['repos']>>[number]) => Promise<void>,
  ) =>
  async (ctx: LoopContext) => {
    const repos = await facts.repos();
    return ctx.eachItem(repos, (r) => r.repo, run);
  };

export function gateCheckLoops(
  checker: GateChecker,
  facts: FactsPort,
  o: GateCheckLoopOptions = {},
): LoopSpec[] {
  const v = o.verdictIntervalMs ?? 15_000;
  const m = o.mergeIntervalMs ?? 60_000;
  return [
    {
      name: 'gate_check_verdicts',
      intervalMs: v,
      ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
      retry: { baseMs: Math.min(5_000, v), maxMs: Math.max(v, 60_000) },
      tick: tickOver(facts, async (r) => {
        const n = await checker.syncRepo(r, eachCollecting);
        if (n > 0) o.onWrite?.(r.repo, n);
      }),
    },
    {
      name: 'gate_check_merges',
      intervalMs: m,
      startDelayMs: (o.startDelayMs ?? 0) + 1_000,
      retry: { baseMs: Math.min(5_000, m), maxMs: Math.max(m, 120_000) },
      tick: tickOver(facts, async (r) => {
        await checker.observeMerges(r, eachCollecting);
      }),
    },
  ];
}
