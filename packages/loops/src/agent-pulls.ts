import {
  AgentPullsFact,
  type AgentPull,
  type ProjectId,
  type RepoFullName,
} from '@aisdlc/contracts';
import {
  err,
  ok,
  systemClock,
  taggedError,
  type Clock,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import { repoKey, type CodeHostPort } from '@aisdlc/ports';
import type pg from 'pg';
import { recordObservation, type ObservationOutcome } from './inbound-facts.js';
import type { LoopContext, LoopSpec } from './supervisor.js';

// The agent pull requests (PLAN M15.2; FL 8.2 "HUMAN merges on GitHub ... factory reconciles"). A person merges an
// agent PR on the code host; the factory learns it the way it learns every other change there: by polling, and by
// recording what it saw BEFORE anything acts on it (an inbound fact). Once per tick, for each repo with agent PRs the
// work engine watches, every watched PR is read (`pr_status`) and the repo's set of PRs is one fact of kind
// `agent_pulls`, written only when it changed. A PR that cannot be read fails that repo's poll: no fact is written for
// it, so a merge state nobody could read is never news (and never a completion).

export const WatchedPullsError = taggedError('WatchedPullsError');
export type WatchedPullsError = TaggedError<'WatchedPullsError', { message: string }>;

/** One agent PR the work engine wants watched. */
export interface WatchedPull {
  readonly repo: RepoFullName;
  readonly project_id: ProjectId;
  readonly number: number;
}

/** Which agent PRs to watch now (core: the PRs of the items still in flight). */
export interface WatchedPullsPort {
  list(): Promise<Result<WatchedPull[], WatchedPullsError>>;
}

/** Deterministic `WatchedPullsPort`. */
export class FakeWatchedPulls implements WatchedPullsPort {
  private pulls: WatchedPull[] = [];
  private down = false;

  set(pulls: readonly WatchedPull[]): this {
    this.pulls = [...pulls];
    return this;
  }

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async list(): Promise<Result<WatchedPull[], WatchedPullsError>> {
    if (this.down) return err(WatchedPullsError({ message: 'work engine unavailable' }));
    return ok([...this.pulls]);
  }
}

export interface AgentPullsDeps {
  readonly pool: pg.Pool;
  readonly source: Pick<CodeHostPort, 'pr_status'>;
  readonly watched: WatchedPullsPort;
  readonly clock?: Clock;
}

export interface AgentPullsReport {
  readonly repo: string;
  readonly outcome: ObservationOutcome;
}

const ISO = (v: string | null): string | null => (v === null ? null : new Date(v).toISOString());

/** Groups the watched PRs by repo (the first spelling of a repo wins), in a stable order. */
function byRepo(pulls: readonly WatchedPull[]): Array<{ repo: WatchedPull; numbers: number[] }> {
  const m = new Map<string, { repo: WatchedPull; numbers: Set<number> }>();
  for (const p of pulls) {
    const k = repoKey(p.repo);
    const g = m.get(k) ?? { repo: p, numbers: new Set<number>() };
    g.numbers.add(p.number);
    m.set(k, g);
  }
  return [...m.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([, g]) => ({ repo: g.repo, numbers: [...g.numbers].sort((a, b) => a - b) }));
}

/** Reads one repo's watched PRs and records them as one `agent_pulls` fact. Throws when any PR cannot be read. */
export async function observeRepoPulls(
  d: AgentPullsDeps,
  repo: WatchedPull,
  numbers: readonly number[],
  intervalMs: number,
): Promise<ObservationOutcome> {
  const pulls: AgentPull[] = [];
  for (const number of numbers) {
    const r = await d.source.pr_status({ repo: repo.repo, number });
    if (r.state !== 'ok') {
      throw new Error(`PR #${number} of ${repo.repo}: ${r.state}/${r.reason}: ${r.message}`);
    }
    const v = r.value;
    pulls.push({
      number: v.number,
      state: v.state,
      merged: v.merged,
      head_sha: v.head_sha,
      base_ref: v.base_ref,
      base_sha: v.base_sha,
      mergeable: v.mergeable,
      merge_commit_sha: v.merge_commit_sha,
      merged_at: ISO(v.merged_at),
      merged_by: v.merged_by,
    });
  }
  // what the host said must be a fact of the contract's shape, or it is not recorded at all
  const value = AgentPullsFact.parse({ pulls });
  return recordObservation(
    d.pool,
    {
      kind: 'agent_pulls',
      repo: repo.repo,
      project_id: repo.project_id,
      value: value as unknown as Record<string, unknown>,
      poll_interval_ms: intervalMs,
    },
    d.clock ?? systemClock,
  );
}

/** One pass over every repo (tests, and the loop's body without the supervisor). A repo that fails is reported. */
export async function observeAgentPulls(
  d: AgentPullsDeps,
  o: { intervalMs?: number } = {},
): Promise<{ recorded: AgentPullsReport[]; failed: Array<{ repo: string; message: string }> }> {
  const w = await d.watched.list();
  if (!w.ok) throw new Error(`the watched agent PRs could not be read: ${w.error.message}`);
  const recorded: AgentPullsReport[] = [];
  const failed: Array<{ repo: string; message: string }> = [];
  for (const g of byRepo(w.value)) {
    try {
      const outcome = await observeRepoPulls(d, g.repo, g.numbers, o.intervalMs ?? ONE_MINUTE_MS);
      recorded.push({ repo: g.repo.repo, outcome });
    } catch (e) {
      failed.push({ repo: g.repo.repo, message: e instanceof Error ? e.message : String(e) });
    }
  }
  return { recorded, failed };
}

export const ONE_MINUTE_MS = 60_000;

/** `agent_pulls`: every watched agent PR, per repo, each minute by default. */
export function agentPullsLoop(
  d: AgentPullsDeps,
  o: {
    intervalMs?: number;
    startDelayMs?: number;
    onOutcome?: (repo: string, outcome: ObservationOutcome) => void;
  } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? ONE_MINUTE_MS;
  return {
    name: 'agent_pulls',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(30_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick(ctx: LoopContext) {
      const w = await d.watched.list();
      if (!w.ok) throw new Error(`the watched agent PRs could not be read: ${w.error.message}`);
      return ctx.eachItem(
        byRepo(w.value),
        (g) => g.repo.repo,
        async (g) => {
          const out = await observeRepoPulls(d, g.repo, g.numbers, intervalMs);
          o.onOutcome?.(g.repo.repo, out);
        },
      );
    },
  };
}
