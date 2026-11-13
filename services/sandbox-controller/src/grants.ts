import {
  ONBOARDING_PROBE_UNIT,
  PROBE_GRANT_LEASE_EPOCH,
  type SandboxClass,
  type SandboxGrantRef,
  DEFAULT_SANDBOX_PROBE,
  SETTINGS_KEYS,
  settingInForce,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';

// The controller starts only sessions core granted (ADR-0003 §6: placement "never starts what core has not
// granted"). Admission is core's: it records the grant (`unit.admitted`, folded into `core.admission_grant`) and
// then asks for a session naming it. Before a session the controller reads that row and refuses unless the grant is
// ACTIVE, for exactly the item, Unit and lease epoch named (a waiting grant released its slot in HUMAN-WAIT; a
// released one, or a stale epoch, has no session). The database answering nothing is "cannot tell": refused.
//
// M16: an onboarding probe has no work item. Its grant names the Unit `onboarding-probe` and the S0 record as the
// item, and is read from core's probe grants (`core.probe_grant`, a view of the `probe.granted` events' read model):
// active only for class K-exec, at lease epoch 1, while it is `granted` (not yet recorded) and younger than
// `PROBE_GRANT_TTL_S`. A probe grant never starts any other class, and an admission grant never names that Unit.

export type GrantCheck = 'active' | 'not_active';

export interface GrantVerifier {
  /** `cls` is the class of the session asked for: a probe grant is for K-exec only. */
  check(ref: SandboxGrantRef, cls: SandboxClass): Promise<Result<GrantCheck, { message: string }>>;
}

/** The grant names an onboarding probe (not a work item's Unit). */
export const isProbeGrant = (ref: SandboxGrantRef): boolean =>
  ref.unit_id === ONBOARDING_PROBE_UNIT;

/** Reads `core.admission_grant` (the controller's role has SELECT on that one table of core). */
export class RecordGrants implements GrantVerifier {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  /** M19: the project an admission grant is for (a heartbeat names it). `null`: no such grant, or unreadable. */
  async projectOf(grantId: string): Promise<string | null> {
    try {
      const q = await this.pool.query<{ project_id: string }>(
        'SELECT project_id FROM core.admission_grant WHERE grant_id = $1',
        [grantId],
      );
      return q.rows[0]?.project_id ?? null;
    } catch {
      return null;
    }
  }

  async check(
    ref: SandboxGrantRef,
    cls: SandboxClass,
  ): Promise<Result<GrantCheck, { message: string }>> {
    if (isProbeGrant(ref)) return this.checkProbe(ref, cls);
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

  private async checkProbe(
    ref: SandboxGrantRef,
    cls: SandboxClass,
  ): Promise<Result<GrantCheck, { message: string }>> {
    if (cls !== 'K-exec' || ref.lease_epoch !== PROBE_GRANT_LEASE_EPOCH) return ok('not_active');
    try {
      const q = await this.pool.query<{ s0_id: string; status: string; fresh: boolean }>(
        `SELECT s0_id::text AS s0_id, status,
                granted_at > now() - make_interval(secs => $2) AS fresh
           FROM core.probe_grant WHERE probe_id = $1`,
        [
          ref.grant_id,
          settingInForce(SETTINGS_KEYS.sandbox_probe, DEFAULT_SANDBOX_PROBE).grant_ttl_s,
        ],
      );
      const g = q.rows[0];
      const active =
        g !== undefined && g.status === 'granted' && g.fresh === true && g.s0_id === ref.item_id;
      return ok(active ? 'active' : 'not_active');
    } catch (e) {
      return err({
        message: e instanceof Error ? e.constructor.name : 'the probe grant could not be read',
      });
    }
  }
}

/** Deterministic verifier for tests: the grants it was told are active (by id, with their item, Unit and epoch). */
export class FakeGrants implements GrantVerifier {
  private readonly active = new Map<string, SandboxGrantRef>();
  private readonly projects = new Map<string, string>();
  private down = false;
  readonly asked: SandboxGrantRef[] = [];

  grant(ref: SandboxGrantRef, projectId = 'proj-test'): this {
    this.active.set(ref.grant_id, ref);
    this.projects.set(ref.grant_id, projectId);
    return this;
  }

  async projectOf(grantId: string): Promise<string | null> {
    return this.down ? null : (this.projects.get(grantId) ?? null);
  }
  revoke(grantId: string): this {
    this.active.delete(grantId);
    return this;
  }
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async check(
    ref: SandboxGrantRef,
    cls: SandboxClass,
  ): Promise<Result<GrantCheck, { message: string }>> {
    this.asked.push(ref);
    if (this.down) return err({ message: 'the record is unreachable' });
    // the same class rule as the record's: a probe grant starts K-exec only, at epoch 1
    if (isProbeGrant(ref) && (cls !== 'K-exec' || ref.lease_epoch !== PROBE_GRANT_LEASE_EPOCH)) {
      return ok('not_active');
    }
    const g = this.active.get(ref.grant_id);
    const same =
      g !== undefined &&
      g.item_id === ref.item_id &&
      g.unit_id === ref.unit_id &&
      g.lease_epoch === ref.lease_epoch;
    return ok(same ? 'active' : 'not_active');
  }
}
