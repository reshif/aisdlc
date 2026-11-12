import type { SandboxGrantRef } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';

// The controller starts only sessions core granted (ADR-0003 §6: placement "never starts what core has not
// granted"). Admission is core's: it records the grant (`unit.admitted`, folded into `core.admission_grant`) and
// then asks for a session naming it. Before a session the controller reads that row and refuses unless the grant is
// ACTIVE, for exactly the item, Unit and lease epoch named (a waiting grant released its slot in HUMAN-WAIT; a
// released one, or a stale epoch, has no session). The database answering nothing is "cannot tell": refused.

export type GrantCheck = 'active' | 'not_active';

export interface GrantVerifier {
  check(ref: SandboxGrantRef): Promise<Result<GrantCheck, { message: string }>>;
}

/** Reads `core.admission_grant` (the controller's role has SELECT on that one table of core). */
export class RecordGrants implements GrantVerifier {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async check(ref: SandboxGrantRef): Promise<Result<GrantCheck, { message: string }>> {
    try {
      const q = await this.pool.query<{
        item_id: string;
        unit_id: string;
        lease_epoch: number;
        status: string;
      }>(
        'SELECT item_id::text AS item_id, unit_id, lease_epoch, status FROM core.admission_grant WHERE grant_id = $1',
        [ref.grant_id],
      );
      const g = q.rows[0];
      const active =
        g !== undefined &&
        g.status === 'active' &&
        g.item_id === ref.item_id &&
        g.unit_id === ref.unit_id &&
        g.lease_epoch === ref.lease_epoch;
      return ok(active ? 'active' : 'not_active');
    } catch (e) {
      return err({
        message: e instanceof Error ? e.constructor.name : 'the grant could not be read',
      });
    }
  }
}

/** Deterministic verifier for tests: the grants it was told are active (by id, with their item, Unit and epoch). */
export class FakeGrants implements GrantVerifier {
  private readonly active = new Map<string, SandboxGrantRef>();
  private down = false;
  readonly asked: SandboxGrantRef[] = [];

  grant(ref: SandboxGrantRef): this {
    this.active.set(ref.grant_id, ref);
    return this;
  }
  revoke(grantId: string): this {
    this.active.delete(grantId);
    return this;
  }
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async check(ref: SandboxGrantRef): Promise<Result<GrantCheck, { message: string }>> {
    this.asked.push(ref);
    if (this.down) return err({ message: 'the record is unreachable' });
    const g = this.active.get(ref.grant_id);
    const same =
      g !== undefined &&
      g.item_id === ref.item_id &&
      g.unit_id === ref.unit_id &&
      g.lease_epoch === ref.lease_epoch;
    return ok(same ? 'active' : 'not_active');
  }
}
