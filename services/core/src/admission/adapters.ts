import type { BudgetGroupSpec } from '@aisdlc/contracts';
import { err, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import {
  envelopeError,
  type EnvelopeError,
  type EnvelopePort,
  type WaitSnapshotPort,
  type WaitSnapshotRequest,
  type SnapshotError,
} from '@aisdlc/ports';
import type { GatewayKeyClient } from '../agent-keys.js';

/**
 * The real `EnvelopePort` (PLAN M13.1): the envelope is a budget group in the model gateway, created through its
 * admin API (core's service token has scope `admin` there). Creating it again with the same limits answers with
 * the group as it stands, so a re-admission finds its own group with what was spent.
 */
export class GatewayEnvelope implements EnvelopePort {
  constructor(private readonly client: Pick<GatewayKeyClient, 'createBudgetGroup'>) {}

  async reserve(spec: BudgetGroupSpec): Promise<Result<{ group_id: string }, EnvelopeError>> {
    const g = await this.client.createBudgetGroup(spec);
    return g.ok
      ? ok({ group_id: spec.group_id })
      : err(envelopeError(g.error.code, g.error.message));
  }
}

/**
 * The `WaitSnapshotPort` until M13.3 gives the session something to snapshot: a stable reference to the point the
 * session waited at (unit, epoch, gate), with no body behind it yet. The reference is what the grant, the
 * re-admission and the record carry; M13.3 replaces this adapter and keeps the seam.
 */
export class ReferenceSnapshots implements WaitSnapshotPort {
  async keep(req: WaitSnapshotRequest): Promise<Result<{ snapshot_ref: string }, SnapshotError>> {
    const h = sha256Hex([req.unit_id, req.lease_epoch, req.gate, req.gate_instance_id].join('|'));
    return ok({ snapshot_ref: `snap:${h.slice(0, 32)}` });
  }
}
