import { BudgetGroupSpec, type HumanWaitGate } from '@aisdlc/contracts';
import { err, ok, sha256Hex, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// The two ports behind 6.0 admission and HUMAN-WAIT (PLAN M13.1).
//
// EnvelopePort: "the envelope from 5.5 reserved". The real adapter creates a budget group in the model gateway
// for the Unit with the Unit's limits (the gateway's admin API, the same call a per-Unit key's group uses; creating
// it again with the same limits answers with the group as it stands, so a re-admission finds its own group with
// what was spent). Unreachable or refused means the envelope is not reserved, and the admission says no.
//
// WaitSnapshotPort: HUMAN-WAIT keeps "a snapshot" of the waiting session while its lease and slot are released.
// The snapshot itself (the workspace, the transcript) is M13.3's; M13.1 defines the seam and the reference.

export const EnvelopeError = taggedError('EnvelopeError');
export type EnvelopeError = TaggedError<'EnvelopeError', { code: string; message: string }>;
export const envelopeError = (code: string, message: string): EnvelopeError =>
  EnvelopeError({ code, message });

export interface EnvelopePort {
  /** Creates (or finds) the Unit's budget group with these limits. An error: the envelope is not reserved. */
  reserve(spec: BudgetGroupSpec): Promise<Result<{ group_id: string }, EnvelopeError>>;
}

/** Deterministic fake: validates the spec with the gateway's own contract and remembers what it reserved. */
export class FakeEnvelope implements EnvelopePort {
  readonly reserved: BudgetGroupSpec[] = [];
  private readonly groups = new Map<string, BudgetGroupSpec>();
  private down = false;
  private refuse: string | null = null;

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  refuseWith(code: string | null): this {
    this.refuse = code;
    return this;
  }

  has(group_id: string): boolean {
    return this.groups.has(group_id);
  }

  async reserve(spec: BudgetGroupSpec): Promise<Result<{ group_id: string }, EnvelopeError>> {
    if (this.down) return err(envelopeError('unavailable', 'the gateway did not answer'));
    if (this.refuse) return err(envelopeError(this.refuse, 'the gateway refused the budget group'));
    const v = BudgetGroupSpec.safeParse(spec);
    if (!v.success) return err(envelopeError('invalid_request', 'not a valid budget group'));
    const known = this.groups.get(v.data.group_id);
    if (
      known &&
      (known.max_tokens !== v.data.max_tokens ||
        known.max_cost_micro_usd !== v.data.max_cost_micro_usd)
    ) {
      return err(envelopeError('conflict', 'the group exists with other limits'));
    }
    if (!known) {
      this.groups.set(v.data.group_id, structuredClone(v.data));
      this.reserved.push(structuredClone(v.data));
    }
    return ok({ group_id: v.data.group_id });
  }
}

export const SnapshotError = taggedError('SnapshotError');
export type SnapshotError = TaggedError<'SnapshotError', { message: string }>;

export interface WaitSnapshotRequest {
  readonly unit_id: string;
  readonly item_id: string;
  /** The epoch of the lease that is being released. */
  readonly lease_epoch: number;
  /** The pending gate; `null` when the wait is a hold on the repo (a suspension, a security event: M16). */
  readonly gate: HumanWaitGate | null;
  /** The wait's key: the gate instance, or `hold:<ref>` for a hold. */
  readonly gate_instance_id: string;
}

export interface WaitSnapshotPort {
  /** Keeps the waiting session's state and answers its reference (the same request, the same reference). */
  keep(req: WaitSnapshotRequest): Promise<Result<{ snapshot_ref: string }, SnapshotError>>;
}

/** Deterministic fake: the reference is a hash of the request; `breakIt` makes keeping fail. */
export class FakeWaitSnapshots implements WaitSnapshotPort {
  readonly kept: WaitSnapshotRequest[] = [];
  private down = false;

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async keep(req: WaitSnapshotRequest): Promise<Result<{ snapshot_ref: string }, SnapshotError>> {
    if (this.down) return err(SnapshotError({ message: 'the snapshot store did not answer' }));
    const snapshot_ref = `snap:${sha256Hex(
      [req.unit_id, req.lease_epoch, req.gate, req.gate_instance_id].join('|'),
    ).slice(0, 32)}`;
    if (
      !this.kept.some(
        (k) => k.gate_instance_id === req.gate_instance_id && k.lease_epoch === req.lease_epoch,
      )
    ) {
      this.kept.push(structuredClone(req));
    }
    return ok({ snapshot_ref });
  }
}
