import type { InboundFactKind, InstallationRepo, RegisteredRepo } from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { repoKey, type CodeHostPort, type RegisteredReposPort } from '@aisdlc/ports';
import type pg from 'pg';
import { recordObservation, type ObservationOutcome } from './inbound-facts.js';
import type { LoopContext, LoopSpec } from './supervisor.js';
import type { WorkInFlightPort } from './work-in-flight.js';

// The poll loops over the code host (PLAN M5.4; OB §6.5 "Polling, no webhooks", §8 table):
//
//   default_branch_head   every 10 min, per registered repo: the default branch's head sha
//   installation          every 10 min, per registered repo: the installation (selection,
//                         permissions, suspension) and the repo's place in it
//   effective_rules       hourly for a repo with work in flight, else nightly: the rules on the
//                         default branch
//
// Each poll writes an inbound fact (`recordObservation`) only when the value changed, so detection
// latency equals the interval and a repeat poll writes nothing. Reads that are not `ok` write
// nothing: no answer is not news (and never "unchanged-so-fine" for a repo that vanished: that is
// the installation loop's fact, `repo: null`). A repo that cannot be read fails ITS item only.

export const TEN_MINUTES_MS = 600_000;
export const ONE_HOUR_MS = 3_600_000;
export const ONE_DAY_MS = 86_400_000;

/** What the polls read: the read half of `CodeHostPort`. The codehost HTTP client and `FakeGitHub` fit. */
export type PollSource = Pick<
  CodeHostPort,
  'list_repos' | 'installation' | 'branch_head' | 'rules_for_branch'
>;

export interface PollDeps {
  readonly pool: pg.Pool;
  readonly source: PollSource;
  readonly registered: RegisteredReposPort;
  readonly clock?: Clock;
}

const fail = (what: string, r: { state: string; reason: string; message: string }): Error =>
  new Error(`${what}: ${r.state}/${r.reason}: ${r.message}`);

/** The registered repos (a fresh read every tick: a repo registered now is polled at the next one). */
async function registeredRepos(d: PollDeps): Promise<RegisteredRepo[]> {
  const r = await d.registered.list();
  if (!r.ok) throw new Error(`the registry of S0 repos could not be read: ${r.error.message}`);
  return r.value;
}

async function installedRepos(d: PollDeps): Promise<Map<string, InstallationRepo>> {
  const r = await d.source.list_repos();
  if (r.state !== 'ok') throw fail('list_repos', r);
  return new Map(r.value.map((x) => [repoKey(x.full_name), x]));
}

export interface PollLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
  /** Observes every outcome (tests, metrics). */
  readonly onOutcome?: (kind: InboundFactKind, repo: string, outcome: ObservationOutcome) => void;
}

const retryFor = (intervalMs: number) => ({
  baseMs: Math.min(30_000, intervalMs),
  maxMs: intervalMs,
});

/** The default branch's head, per registered repo. */
export function defaultBranchHeadLoop(d: PollDeps, o: PollLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? TEN_MINUTES_MS;
  const clock = d.clock ?? systemClock;
  return {
    name: 'default_branch_head',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: retryFor(intervalMs),
    async tick(ctx: LoopContext) {
      const repos = await registeredRepos(d);
      const installed = await installedRepos(d);
      return ctx.eachItem(
        repos,
        (r) => r.repo,
        async (r) => {
          const info = installed.get(repoKey(r.repo));
          // Not in the installation: its head cannot be read; the installation loop records that.
          if (!info) return;
          const head = await d.source.branch_head({ repo: r.repo, branch: info.default_branch });
          if (head.state !== 'ok') throw fail(`head of ${r.repo}`, head);
          const out = await recordObservation(
            d.pool,
            {
              kind: 'default_branch_head',
              repo: r.repo,
              project_id: r.project_id,
              value: { branch: info.default_branch, sha: head.value },
              poll_interval_ms: intervalMs,
            },
            clock,
          );
          o.onOutcome?.('default_branch_head', r.repo, out);
        },
      );
    },
  };
}

/** The installation and each registered repo's place in it. */
export function installationLoop(d: PollDeps, o: PollLoopOptions = {}): LoopSpec {
  const intervalMs = o.intervalMs ?? TEN_MINUTES_MS;
  const clock = d.clock ?? systemClock;
  return {
    name: 'installation',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: retryFor(intervalMs),
    async tick(ctx: LoopContext) {
      const repos = await registeredRepos(d);
      const inst = await d.source.installation();
      if (inst.state !== 'ok') throw fail('installation', inst);
      const installed = await installedRepos(d);
      const permissions = Object.fromEntries(
        Object.entries(inst.value.permissions).sort(([a], [b]) => a.localeCompare(b)),
      );
      return ctx.eachItem(
        repos,
        (r) => r.repo,
        async (r) => {
          const info = installed.get(repoKey(r.repo));
          const out = await recordObservation(
            d.pool,
            {
              kind: 'installation',
              repo: r.repo,
              project_id: r.project_id,
              value: {
                installation: {
                  installation_id: inst.value.installation_id,
                  account_login: inst.value.account_login,
                  repository_selection: inst.value.repository_selection,
                  permissions,
                  suspended: inst.value.suspended,
                },
                // `null`: the installation no longer reaches the repo. That is the fact.
                repo: info
                  ? {
                      default_branch: info.default_branch,
                      private: info.private,
                      archived: info.archived,
                    }
                  : null,
              },
              poll_interval_ms: intervalMs,
            },
            clock,
          );
          o.onOutcome?.('installation', r.repo, out);
        },
      );
    },
  };
}

export interface RulesLoopOptions extends Omit<PollLoopOptions, 'intervalMs'> {
  /** Poll period for a repo with work in flight. Default one hour. */
  readonly inFlightIntervalMs?: number;
  /** Poll period for a repo without. Default one day ("nightly"). */
  readonly idleIntervalMs?: number;
  /** How often the loop wakes to see which repos are due. Default five minutes. */
  readonly tickMs?: number;
}

/**
 * The effective rules on the default branch. The loop wakes every `tickMs` and polls the repos that
 * are due: hourly when `WorkInFlightPort` says there is work, nightly otherwise. When the work
 * engine cannot say, the repo counts as busy (the faster rate). Detection latency is the repo's
 * period plus at most one tick.
 */
export function effectiveRulesLoop(
  d: PollDeps & { readonly workInFlight: WorkInFlightPort },
  o: RulesLoopOptions = {},
): LoopSpec {
  const inFlightMs = o.inFlightIntervalMs ?? ONE_HOUR_MS;
  const idleMs = o.idleIntervalMs ?? ONE_DAY_MS;
  const tickMs = o.tickMs ?? Math.min(300_000, inFlightMs);
  const clock = d.clock ?? systemClock;
  const lastPolled = new Map<string, number>();
  return {
    name: 'effective_rules',
    intervalMs: tickMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: retryFor(tickMs),
    // A repo is polled at most `idleMs` apart, so the loop is unhealthy only past that.
    unhealthyAfterMs: Math.max(3 * tickMs, 60_000) + idleMs,
    async tick(ctx: LoopContext) {
      const repos = await registeredRepos(d);
      const installed = await installedRepos(d);
      return ctx.eachItem(
        repos,
        (r) => r.repo,
        async (r) => {
          const key = repoKey(r.repo);
          const info = installed.get(key);
          if (!info) return;
          const busy = await d.workInFlight.hasWorkInFlight(r.repo);
          const period = !busy.ok || busy.value ? inFlightMs : idleMs;
          const last = lastPolled.get(key);
          const now = clock.nowMs();
          if (last !== undefined && now - last < period) return;
          const rules = await d.source.rules_for_branch({
            repo: r.repo,
            branch: info.default_branch,
          });
          if (rules.state !== 'ok') throw fail(`rules of ${r.repo}`, rules);
          const out = await recordObservation(
            d.pool,
            {
              kind: 'effective_rules',
              repo: r.repo,
              project_id: r.project_id,
              value: rules.value as unknown as Record<string, unknown>,
              poll_interval_ms: period,
            },
            clock,
          );
          lastPolled.set(key, now);
          o.onOutcome?.('effective_rules', r.repo, out);
        },
      );
    },
  };
}
