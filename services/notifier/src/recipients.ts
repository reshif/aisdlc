import {
  PrincipalId,
  ROLE_CATALOGUE,
  roleForSlot,
  type ProjectId,
  type RoleSlot,
  type Scope,
} from '@aisdlc/contracts';
import { projectScope, queryGrants } from '@aisdlc/identity/read';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type pg from 'pg';

// Who a notification is for (PLAN M18): read from identity's read model at raise time, never decided here. A slot's
// holders are the principals whose grant of the slot's role at the project is in force now (no blocker: active,
// membership running, binding not expired, qualification valid) - exactly what the eligibility port answers, without
// the right to decide that only the inbox and the PDP give. A person's email address is their `email` identity link
// (the IdP's, never one they type), read at delivery time and never recorded.

export interface RecipientsPort {
  /** The principals holding `slot` on `project` now (sorted, distinct). Unknown: an empty list. */
  slotHolders(project: ProjectId, slot: RoleSlot): Promise<PrincipalId[]>;
  /** The principals holding `role` at the fleet now. */
  fleetRoleHolders(role: string): Promise<PrincipalId[]>;
  /** Whether the principal is a human whose account is active (a disabled one is notified of nothing). */
  isActiveHuman(principal: string): Promise<boolean>;
  /** The person's email link, or `null`. */
  email(principal: string): Promise<string | null>;
}

const FLEET: Scope = { kind: 'fleet', ref: '*' };

export class IdentityRecipients implements RecipientsPort {
  constructor(
    private readonly pool: Pick<pg.Pool, 'query'>,
    private readonly clock: Clock = systemClock,
  ) {}

  private async inForce(role: string, scope: Scope): Promise<PrincipalId[]> {
    const grants = await queryGrants(this.pool, { role }, scope, this.clock.now(), ROLE_CATALOGUE);
    const ids = new Set<string>();
    for (const g of grants) {
      if (g.blockers.length === 0 && g.principal.kind === 'human')
        ids.add(g.principal.principal_id);
    }
    return [...ids].sort().map((p) => PrincipalId.parse(p));
  }

  slotHolders(project: ProjectId, slot: RoleSlot): Promise<PrincipalId[]> {
    return this.inForce(roleForSlot(slot, ROLE_CATALOGUE), projectScope(project));
  }

  fleetRoleHolders(role: string): Promise<PrincipalId[]> {
    return this.inForce(role, FLEET);
  }

  async isActiveHuman(principal: string): Promise<boolean> {
    const r = await this.pool.query<{ ok: boolean }>(
      `SELECT (kind = 'human' AND status = 'active') AS ok FROM identity.principal WHERE principal_id = $1`,
      [principal],
    );
    return r.rows[0]?.ok === true;
  }

  async email(principal: string): Promise<string | null> {
    const r = await this.pool.query<{ value: string }>(
      `SELECT value FROM identity.identity_link WHERE principal_id = $1 AND kind = 'email'
        ORDER BY link_key LIMIT 1`,
      [principal],
    );
    return r.rows[0]?.value ?? null;
  }
}

/** Deterministic recipients for tests of everything above identity. */
export class FakeRecipients implements RecipientsPort {
  readonly slots = new Map<string, PrincipalId[]>();
  readonly fleet = new Map<string, PrincipalId[]>();
  readonly emails = new Map<string, string>();
  readonly inactive = new Set<string>();

  setSlot(project: string, slot: RoleSlot, principals: readonly string[]): this {
    this.slots.set(
      `${project}/${slot}`,
      principals.map((p) => PrincipalId.parse(p)),
    );
    return this;
  }

  async slotHolders(project: ProjectId, slot: RoleSlot): Promise<PrincipalId[]> {
    return [...(this.slots.get(`${project}/${slot}`) ?? [])].sort();
  }

  async fleetRoleHolders(role: string): Promise<PrincipalId[]> {
    return [...(this.fleet.get(role) ?? [])].sort();
  }

  async isActiveHuman(principal: string): Promise<boolean> {
    return !this.inactive.has(principal);
  }

  async email(principal: string): Promise<string | null> {
    return this.emails.get(principal) ?? null;
  }
}
