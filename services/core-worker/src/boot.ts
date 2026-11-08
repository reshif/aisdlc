import { createPool } from '@aisdlc/db';
import {
  LoopSupervisor,
  FakeWorkInFlight,
  defaultBranchHeadLoop,
  effectiveRulesLoop,
  installationLoop,
  outboxWatchLoop,
  type WorkInFlightPort,
} from '@aisdlc/loops';
import { FileRegisteredRepos } from '@aisdlc/ports';
import { listen, listenConfig, type Env, type RunningService } from '@aisdlc/service-kit';
import { createCoreWorkerApp } from './app.js';
import { HttpCodeHostReads } from './codehost-client.js';
import { coreWorkerConfigFromEnv } from './config.js';

/**
 * Starts core-worker (PLAN §5: the one process that hosts every loop), with the code-host poll
 * loops and the outbox dead-letter alert so far (M5.4). More loops (inbox, relay, reconciler,
 * checkpointer, ...) are `supervisor.add(...)` calls here as their milestones land.
 *
 * Until the work engine exists (M9) there is no source of "work in flight": the fake says none, so
 * effective rules are polled nightly. That is the slower, never the faster, rate, so the real port
 * must be wired in before agent work can start (M9.1 owns that).
 */
export async function bootCoreWorker(
  env: Env,
  deps: { workInFlight?: WorkInFlightPort; log?: (line: string) => void } = {},
): Promise<RunningService> {
  const cfg = coreWorkerConfigFromEnv(env);
  const listenOpts = listenConfig(env, 'CORE_WORKER', 8360);
  const log = deps.log ?? ((line: string) => console.log(`core-worker: ${line}`));
  const pool = createPool(cfg.databaseUrl, 6);
  try {
    const have = await pool.query<{ record: string | null }>(
      `SELECT to_regclass('record.record_event')::text AS record`,
    );
    if (have.rows[0]?.record == null) {
      throw new Error('the record schema is missing: migrate the record database first');
    }
    const supervisor = new LoopSupervisor({ log });
    const source = new HttpCodeHostReads({ baseUrl: cfg.codehostUrl, token: cfg.codehostToken });
    const poll = {
      pool,
      source,
      registered: new FileRegisteredRepos(cfg.registeredReposFile),
    };
    supervisor
      .add(defaultBranchHeadLoop(poll, { intervalMs: cfg.headIntervalMs }))
      .add(installationLoop(poll, { intervalMs: cfg.installationIntervalMs, startDelayMs: 1_000 }))
      .add(
        effectiveRulesLoop(
          { ...poll, workInFlight: deps.workInFlight ?? new FakeWorkInFlight() },
          {
            inFlightIntervalMs: cfg.rulesInFlightIntervalMs,
            idleIntervalMs: cfg.rulesIdleIntervalMs,
            tickMs: cfg.rulesTickMs,
            startDelayMs: 2_000,
          },
        ),
      )
      .add(
        outboxWatchLoop({
          pool,
          intervalMs: cfg.outboxWatchIntervalMs,
          setAlert: (k, a) => supervisor.setAlert(k, a),
        }),
      );
    const app = createCoreWorkerApp(supervisor);
    const url = await listen(app, listenOpts);
    supervisor.start();
    return {
      url,
      close: async () => {
        await app.close();
        await supervisor.stop();
        await pool.end();
      },
    };
  } catch (e) {
    await pool.end().catch(() => undefined);
    throw e;
  }
}
