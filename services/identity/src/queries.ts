import {
  ROLE_CATALOGUE,
  roleDef,
  scopeCovers,
  type Principal,
  type PrincipalId,
  type RoleDef,
  type Scope,
} from '@aisdlc/contracts';
import type { Executor } from '@aisdlc/record';

// Read side of the identity read model: who is in which group, and which bindings are in force for
// whom at a scope and an instant. Everything is evaluated at the `at` the caller gives (the clock
// is not read here), so the same question has the same answer in a test and in production. An
// access question that cannot be answered from the read model is "no": nothing here widens.

export type PrincipalRow = Pick<
  Principal,
  | 'principal_id'
  | 'kind'
  | 'status'
  | 'entra_oid'
  | 'upn'
  | 'logins'
  | 'machine_actions'
  | 'breakglass'
  | 'display_handle'
  | 'display_name'
  | 'role_label'
  | 'status_changed_at'
>;

interface PrincipalDb {
  principal_id: string;
  kind: string;
  status: string;
  entra_oid: string | null;
  upn: string | null;
  logins: string[];
  machine_actions: string[];
  breakglass: boolean;
  display_handle: string;
  display_name: string;
  role_label: string | null;
  status_changed_at: Date;
}

const toPrincipal = (r: PrincipalDb): PrincipalRow =>
  ({ ...r, status_changed_at: r.status_changed_at.toISOString() }) as PrincipalRow;

export async function getPrincipal(db: Executor, id: string): Promise<PrincipalRow | null> {
  const q = await db.query<PrincipalDb>(
    'SELECT * FROM identity.principal WHERE principal_id = $1',
    [id],
  );
  return q.rows[0] ? toPrincipal(q.rows[0]) : null;
}

export interface GroupMembership {
  readonly group_id: string;
  readonly display: string;
  readonly protected: boolean;
  readonly active_from: string;
  readonly active_until: string | null;
  readonly via: string;
  readonly source: string;
}

/** The groups a principal is in at `at` (membership window open). Not filtered by principal status. */
export async function resolveGroups(
  db: Executor,
  principal: string,
  at: Date,
): Promise<GroupMembership[]> {
  const q = await db.query<{
    group_id: string;
    display: string;
    protected: boolean;
    active_from: Date;
    active_until: Date | null;
    via: string;
    source: string;
  }>(
    `SELECT m.group_id, g.display, g.protected, m.active_from, m.active_until, m.via, m.source
       FROM identity.membership m JOIN identity.grp g ON g.group_id = m.group_id
      WHERE m.principal_id = $1 AND m.active_from <= $2 AND (m.active_until IS NULL OR m.active_until > $2)
      ORDER BY m.group_id`,
    [principal, at],
  );
  return q.rows.map((r) => ({
    ...r,
    active_from: r.active_from.toISOString(),
    active_until: r.active_until ? r.active_until.toISOString() : null,
  }));
}

/** One path from a principal to a role at a scope: membership, group, binding. */
export interface Grant {
  readonly principal: Pick<
    PrincipalRow,
    'principal_id' | 'display_handle' | 'display_name' | 'kind' | 'status'
  >;
  readonly binding_id: string;
  readonly role_id: string;
  readonly scope: Scope;
  readonly constraints: Record<string, unknown>;
  readonly expiry: string | null;
  readonly m_gate_ref: string | null;
  readonly config_rev: string | null;
  readonly group_id: string;
  readonly group_display: string;
  readonly membership: {
    readonly active_from: string;
    readonly active_until: string | null;
    readonly via: string;
    readonly source: string;
  };
  /** Why this path grants nothing right now; empty = in force. */
  readonly blockers: readonly string[];
}

export interface GrantFilter {
  readonly principal?: string;
  readonly role?: string;
}

/**
 * Every path (membership of a bound group) that reaches a role at a scope covering `target`,
 * with the reasons any of them is not in force at `at`: principal not active, membership not
 * started or ended, binding expired, role unknown, service-only role held by a human, or a
 * required qualification missing or outside its validity.
 */
export async function queryGrants(
  db: Executor,
  filter: GrantFilter,
  target: Scope,
  at: Date,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): Promise<Grant[]> {
  const q = await db.query<{
    principal_id: string;
    kind: string;
    status: string;
    display_handle: string;
    display_name: string;
    group_id: string;
    group_display: string;
    active_from: Date;
    active_until: Date | null;
    via: string;
    source: string;
    binding_id: string;
    role_id: string;
    scope_kind: string;
    scope_ref: string;
    constraints: Record<string, unknown>;
    expiry: Date | null;
    m_gate_ref: string | null;
    config_rev: string | null;
  }>(
    `SELECT p.principal_id, p.kind, p.status, p.display_handle, p.display_name,
            m.group_id, g.display AS group_display, m.active_from, m.active_until, m.via, m.source,
            b.binding_id, b.role_id, b.scope_kind, b.scope_ref, b.constraints, b.expiry,
            b.m_gate_ref, b.config_rev
       FROM identity.membership m
       JOIN identity.binding b ON b.group_id = m.group_id
       JOIN identity.grp g ON g.group_id = m.group_id
       JOIN identity.principal p ON p.principal_id = m.principal_id
      WHERE ($1::text IS NULL OR m.principal_id = $1) AND ($2::text IS NULL OR b.role_id = $2)
      ORDER BY p.principal_id, b.role_id, b.binding_id`,
    [filter.principal ?? null, filter.role ?? null],
  );
  const covering = q.rows.filter((r) =>
    scopeCovers({ kind: r.scope_kind, ref: r.scope_ref } as Scope, target),
  );
  const ids = [...new Set(covering.map((r) => r.principal_id))];
  const quals = new Map<
    string,
    Array<{ qual_type: string; valid_from: Date; valid_until: Date | null }>
  >();
  if (ids.length > 0) {
    const qq = await db.query<{
      principal_id: string;
      qual_type: string;
      valid_from: Date;
      valid_until: Date | null;
    }>(
      'SELECT principal_id, qual_type, valid_from, valid_until FROM identity.qualification WHERE principal_id = ANY($1::text[])',
      [ids],
    );
    for (const r of qq.rows) quals.set(r.principal_id, [...(quals.get(r.principal_id) ?? []), r]);
  }
  const t = at.getTime();
  return covering.map((r): Grant => {
    const blockers: string[] = [];
    if (r.status !== 'active') blockers.push(`principal_${r.status}`);
    if (r.active_from.getTime() > t) blockers.push('membership_not_started');
    if (r.active_until !== null && r.active_until.getTime() <= t)
      blockers.push('membership_expired');
    if (r.expiry !== null && r.expiry.getTime() <= t) blockers.push('binding_expired');
    const role = roleDef(r.role_id, catalogue);
    if (!role) blockers.push('unknown_role');
    else {
      if (role.service_only && r.kind !== 'service') blockers.push('service_only_role');
      const need = role.requires_qualification;
      if (need !== null) {
        const ok = (quals.get(r.principal_id) ?? []).some(
          (x) =>
            x.qual_type === need &&
            x.valid_from.getTime() <= t &&
            (x.valid_until === null || x.valid_until.getTime() > t),
        );
        if (!ok) blockers.push(`qualification_missing:${need}`);
      }
    }
    return {
      principal: {
        principal_id: r.principal_id as PrincipalId,
        display_handle: r.display_handle,
        display_name: r.display_name,
        kind: r.kind as Principal['kind'],
        status: r.status as Principal['status'],
      },
      binding_id: r.binding_id,
      role_id: r.role_id,
      scope: { kind: r.scope_kind, ref: r.scope_ref } as Scope,
      constraints: r.constraints,
      expiry: r.expiry ? r.expiry.toISOString() : null,
      m_gate_ref: r.m_gate_ref,
      config_rev: r.config_rev,
      group_id: r.group_id,
      group_display: r.group_display,
      membership: {
        active_from: r.active_from.toISOString(),
        active_until: r.active_until ? r.active_until.toISOString() : null,
        via: r.via,
        source: r.source,
      },
      blockers,
    };
  });
}

export interface EffectiveBinding {
  readonly binding_id: string;
  readonly role_id: string;
  readonly scope: Scope;
  readonly group_id: string;
  readonly constraints: Record<string, unknown>;
  readonly expiry: string | null;
}

/** The bindings in force for a principal at a scope and an instant. */
export async function effectiveBindings(
  db: Executor,
  principal: string,
  target: Scope,
  at: Date,
  catalogue: readonly RoleDef[] = ROLE_CATALOGUE,
): Promise<EffectiveBinding[]> {
  const grants = await queryGrants(db, { principal }, target, at, catalogue);
  return grants
    .filter((g) => g.blockers.length === 0)
    .map((g) => ({
      binding_id: g.binding_id,
      role_id: g.role_id,
      scope: g.scope,
      group_id: g.group_id,
      constraints: g.constraints,
      expiry: g.expiry,
    }));
}

/** The principal an external identity is linked to now, or `null`. */
export async function resolveLink(
  db: Executor,
  ref: { kind: string; issuer: string | null; value: string },
): Promise<PrincipalRow | null> {
  const q = await db.query<PrincipalDb>(
    `SELECT p.* FROM identity.identity_link l JOIN identity.principal p ON p.principal_id = l.principal_id
      WHERE l.kind = $1 AND l.issuer IS NOT DISTINCT FROM $2 AND l.value = $3`,
    [ref.kind, ref.issuer, ref.kind === 'idp_subject' ? ref.value : ref.value.toLowerCase()],
  );
  return q.rows[0] ? toPrincipal(q.rows[0]) : null;
}
