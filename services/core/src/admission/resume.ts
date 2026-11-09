import { UNIT_EVENT } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { ItemState } from '@aisdlc/work';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx, lockKeys } from '../journal.js';
import { listUnits } from '../planning/units.js';
import { admitCandidate, type Admission, type AdmissionDeps } from './admit.js';
import { emitUnitEvent } from './events.js';
import { unitLockKey } from './fold.js';
import { listGrants, listLeases } from './read.js';

/**
 * The guard of every S6 command after 6.0 (PLAN M13.1): the session needs a lease and a slot. A grant that is
 * active with a held lease is the common case. After HUMAN-WAIT (a waiting grant), a handoff and hand-back, or a
 * back-edge into S6 after the lease ended, the Unit is admitted AGAIN ("re-admits via 6.1 on decision"): the same
 * checks as 6.0, a fresh epoch, the same envelope group (its spend carries over), the clock resumed, and, after a
 * wait, the snapshot's reference on the new grant. A refusal is HELD like 6.0's. No grant at all is a refusal:
 * an S6 command never runs without one.
 */
export async function ensureAdmitted(
  d: AdmissionDeps,
  s: ItemState,
  commandKey: string,
): Promise<Result<Admission | { readonly admitted: true; readonly unit_id: null }, CoreError>> {
  const grants = await listGrants(d.pool, s.item_id);
  const active = grants.find((g) => g.status === 'active');
  const leases = await listLeases(d.pool, s.item_id);
  if (active) {
    const l = leases.find((x) => x.unit_id === active.unit_id);
    if (l && l.status === 'held' && l.holder_kind === 'agent') {
      d.attempted?.(s.project_id);
      return ok({ admitted: true, unit_id: null });
    }
    // the grant outlived its session (S6 was left and is entered again): it ends, and the Unit is re-admitted
    const w = await inCoreTx(d, async (j, tx) => {
      await lockKeys(tx, [unitLockKey(s.item_id)]);
      const e = await emitUnitEvent(
        j,
        tx,
        s.item_id,
        UNIT_EVENT.grant_released,
        {
          grant_id: active.grant_id,
          unit_id: active.unit_id,
          item_id: s.item_id as never,
          cause: 'readmitted',
        },
        `grant:released:${active.grant_id}`,
      );
      return e.ok ? ok(undefined) : e;
    });
    if (!w.ok) return w;
  }
  const last = [...grants]
    .sort((a, b) => Date.parse(a.granted_at) - Date.parse(b.granted_at))
    .at(-1);
  if (!last)
    return err(coreError('refused', 'no admission grant: an S6 command never runs without one'));
  const unit = (await listUnits(d.pool, s.item_id)).find((u) => u.unit_id === last.unit_id);
  if (!unit) return err(coreError('refused', `the Unit ${last.unit_id} is gone`));
  const resumes =
    last.status === 'waiting' && last.snapshot_ref !== null
      ? { grant_id: last.grant_id, snapshot_ref: last.snapshot_ref }
      : null;
  return admitCandidate(d, s, unit, `readmit:${commandKey}`, resumes);
}
