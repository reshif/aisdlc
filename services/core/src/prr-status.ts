import {
  PRR_EVENT,
  PrrStatusChangedPayload,
  canTransitionReadinessBy,
  prrStream,
  repoKeyOf,
  type CauseCode,
  type ReadinessStatus,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { coreError, type CoreError } from './errors.js';
import { governingPrr } from './fold.js';
import { inCoreTx, lockKeys, type CoreDeps } from './journal.js';
import { repoIdentity } from './prr-store.js';

/** Mechanical checks tighten only: they can never activate and never supersede (OB §2.3, DM §6.3). */
export type MechanicalStatus = Extract<ReadinessStatus, 'stale' | 'suspended' | 'expired'>;

/**
 * A mechanical check (a poll, the nightly staleness check, the rules poll, the expiry sweep) moves
 * the governing PRR of a repo towards `stale`, `suspended` or `expired` (PLAN M7.6: these send new
 * work to L8 through the 1.4 rule). The state machine decides what is allowed: nothing here can
 * make a record active again; that takes a new version and its M4. `record_hash` does not change.
 */
export async function setPrrStatus(
  deps: CoreDeps,
  input: { repo: string; to: MechanicalStatus; cause: CauseCode },
): Promise<Result<{ version: number; from: ReadinessStatus; changed: boolean }, CoreError>> {
  type Out = { version: number; from: ReadinessStatus; changed: boolean };
  return inCoreTx<Out>(deps, async (j, tx) => {
    const id = await repoIdentity(tx, input.repo);
    if (!id) return err(coreError('not_found', `core has no repo ${input.repo}`));
    await lockKeys(tx, [`project:${id.project_id}`, `repo:${repoKeyOf(input.repo)}`]);
    const gov = governingPrr(await j.prr(id.project_id, id.repo_id));
    if (!gov) return err(coreError('conflict', 'no PRR has been made active for this repo'));
    if (gov.status === input.to) {
      return ok({ version: gov.version, from: gov.status, changed: false });
    }
    if (!canTransitionReadinessBy('mechanical', gov.status, input.to)) {
      return err(
        coreError(
          'conflict',
          `a mechanical check cannot take a ${gov.status} record to ${input.to}`,
        ),
      );
    }
    const w = await j.emit(
      prrStream(id.project_id, id.repo_id),
      PRR_EVENT.status_changed,
      PrrStatusChangedPayload.parse({
        version: gov.version,
        record_hash: gov.prr.record_hash,
        from: gov.status,
        to: input.to,
        actor: 'mechanical',
        cause: input.cause,
      }),
      'system.mechanical',
    );
    return w.ok ? ok({ version: gov.version, from: gov.status, changed: true }) : w;
  });
}
