import { err, ok, type Result } from '@aisdlc/kernel';
import { SnapshotError, type WaitSnapshotPort, type WaitSnapshotRequest } from '@aisdlc/ports';
import type { SessionStore } from './store.js';

/**
 * The real `WaitSnapshotPort` (HUMAN-WAIT, M13.1's seam, M13.4's content): the snapshot is of the session's REAL
 * workspace (the tree of /work as the last coding run left it, content-addressed in the session store), and the
 * reference names it. The same request gives the same reference. No session workspace, no snapshot: the wait is
 * refused and the session keeps its lease and slot (fail closed).
 */
export class StoreWaitSnapshots implements WaitSnapshotPort {
  constructor(private readonly store: SessionStore) {}

  async keep(req: WaitSnapshotRequest): Promise<Result<{ snapshot_ref: string }, SnapshotError>> {
    const s = this.store.load(req.item_id);
    if (s === null)
      return err(SnapshotError({ message: 'there is no session workspace to snapshot' }));
    const ref = this.store.snapshot(s, {
      gate: req.gate,
      gate_instance_id: req.gate_instance_id,
      lease_epoch: req.lease_epoch,
      why: 'human_wait',
    });
    s.snapshot_ref = ref;
    this.store.save(s);
    return ok({ snapshot_ref: ref });
  }
}
