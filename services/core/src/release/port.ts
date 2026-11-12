import { readReleaseSetting } from '@aisdlc/config';
import {
  G5_FACTS_KEY,
  NOT_RELEASED_CODE_PREFIX,
  ReleaseBinding,
  isStagingFirst,
  deployMarkerHash,
  foldReleaseStatus,
  gateRelayStream,
  type StageOutcome,
  type StageRequest,
} from '@aisdlc/contracts';
import { ok, sha256Hex, type Result } from '@aisdlc/kernel';
import type { ReleasePort, StagePortError, StagePorts } from '@aisdlc/ports';
import { DeferDelivery } from '@aisdlc/record';
import type pg from 'pg';
import type { CoreDeps } from '../journal.js';
import { requestSpawn } from '../work-signals.js';
import { latestG5 } from './binding.js';

// S8b Release (PLAN M15.3; FL "S8b Release: gate-relay binds/consumes G5"). Core never deploys: gate-relay, in the gate
// plane, consumes an approved G5 exactly once and creates the deployment through its own App. This port is how the item
// learns what came of it, from gate-relay's record (`gaterelay:<item>`), and answers the engine:
//
//   release off (the project's `project.release`)        completed: nothing to release (the route had no G5)
//   not chosen, or unreadable                            failed `not_released:no_target` (RELHOLD: unknown is not
//                                                        released)
//   no approved G5 for the item                          failed `not_released:no_g5`
//   gate-relay has not answered, or the deployment has   deferred: the command waits, uncounted, and is asked again
//   no verdict yet (pending, queued, in progress)
//   gate-relay refused the G5                            failed `not_released:<refusal>` (RELHOLD; re-request -> G5)
//   the deployment is healthy                            completed, the output bound to the DeployMarker
//   ... but it was an L5 change's staging release (M17)  failed `not_released:staging_released` (RELHOLD): staging
//                                                        before production; the re-requested G5 binds production
//   the deployment is unhealthy (gate-relay rolled back) B16: a NEW linked rollback item (L0), then failed
//                                                        `not_released:rolled_back` (RELHOLD)
//
// Every other release step (S9's) is the base port's.

export interface GateRelayReleaseOptions {
  readonly pool: pg.Pool;
  readonly base: ReleasePort;
  /** For the B16 signal on the item. */
  readonly deps: CoreDeps;
  /** How long a deferred S8b waits before it is asked again (default 15 s). */
  readonly retryMs?: number;
}

const notReleased = (why: string): StageOutcome => ({
  outcome: 'failed',
  code: `${NOT_RELEASED_CODE_PREFIX}${why}`.slice(0, 64),
});

export class GateRelayReleasePort implements ReleasePort {
  readonly port = 'release' as const;

  constructor(private readonly o: GateRelayReleaseOptions) {}

  async run(req: StageRequest): Promise<Result<StageOutcome, StagePortError>> {
    if (req.step !== 'S8b') return this.o.base.run(req);
    const release = await readReleaseSetting(this.o.pool, req.project_id);
    if (release.state === 'ok' && release.value?.mode === 'off') {
      return ok({
        outcome: 'completed',
        output_hash: sha256Hex(`release-off|${req.item_id}`) as never,
      });
    }
    if (release.state !== 'ok' || release.value === null) return ok(notReleased('no_target'));
    const g5 = await latestG5(this.o.pool, req.item_id);
    if (!g5 || g5.state.status !== 'decided' || g5.state.outcome !== 'approve') {
      return ok(notReleased('no_g5'));
    }
    const ev = await this.o.pool.query<{ type: string; body: unknown }>(
      'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [gateRelayStream(req.item_id)],
    );
    const st = foldReleaseStatus(ev.rows, g5.gate_instance_id);
    switch (st.state) {
      case 'none':
      case 'intended':
      case 'deployed':
        // gate-relay has not consumed the G5 yet, or the deploy system has not reported: not released, not failed
        throw new DeferDelivery(
          `S8b: release ${st.state} for G5 ${g5.gate_instance_id}`,
          this.o.retryMs ?? 15_000,
        );
      case 'refused':
        return ok(notReleased(st.reason));
      case 'healthy': {
        // M17: an L5 change released to its service's staging environment is not released to the target yet
        const b = ReleaseBinding.safeParse(
          (g5.state.open.payload.facts as Record<string, unknown>)[G5_FACTS_KEY],
        );
        if (b.success && b.data.status === 'bound' && isStagingFirst(b.data)) {
          return ok(notReleased('staging_released'));
        }
        return ok({ outcome: 'completed', output_hash: deployMarkerHash(st.marker) as never });
      }
      case 'unhealthy': {
        // B16: deploy unhealthy -> rollback (gate-relay made it) and a NEW linked L0 item that carries the fix
        const s = await requestSpawn(this.o.deps, req.item_id, {
          edge: 'B16',
          kind: 'rollback',
          lane: 'L0',
          key: st.marker.marker_id,
          by: 'system.release',
        });
        if (!s.ok) throw new Error(`B16: ${s.error.message}`);
        return ok(notReleased('rolled_back'));
      }
    }
  }
}

/** The stage ports of a deployment whose releases go through gate-relay: `release` is this port, the rest are `base`. */
export function releaseStagePorts(o: Omit<GateRelayReleaseOptions, 'base'> & { base: StagePorts }) {
  const { base, ...rest } = o;
  return { ...base, release: new GateRelayReleasePort({ ...rest, base: base.release }) };
}
