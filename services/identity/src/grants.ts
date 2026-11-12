import {
  ACCESS_GRANT_ORIGIN,
  grantGroupId,
  isGrantableRole,
  type IdentityGrantRequest,
  type IdentityGrantResult,
  type IdentityRevokeRequest,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { addMemberTx, createBindingTx, createGroupTx, revokeBindingTx } from './commands.js';
import { identityError, type IdentityError } from './errors.js';
import { inIdentityTx, type IdentityDeps } from './tx.js';

// The decided grant path (portal-review P1-6). Identity's scope `grant` is held by core alone, and core calls it only
// after an M1 gate approved the change on the ledger: `m_gate_ref` is that decision's entry. A principal's grants are
// bound through their own grant group (`grant.<principal>`, created on the first grant, members changed by nothing
// else); a team's through its IdP group. A binding written here carries `origin: access_grant` and the grant's id, so
// asking again with the same grant is `changed: false`, and only a decided revoke (also scope `grant`) ends it. Like
// every identity write, the access-sync loop makes its access ledger entries.

export async function grantAccess(
  deps: IdentityDeps,
  req: IdentityGrantRequest,
): Promise<Result<IdentityGrantResult, IdentityError>> {
  if (!isGrantableRole(req.role_id, req.scope.kind)) {
    return err(
      identityError(
        'invalid_input',
        `${req.role_id} at a ${req.scope.kind} scope is not granted here (a slot role changes with the role map)`,
      ),
    );
  }
  const actor = req.on_behalf_of;
  return inIdentityTx(deps, async (j) => {
    let group: string;
    let changed = false;
    if (req.target.kind === 'principal') {
      const p = await j.principal(req.target.principal_id);
      if (!p)
        return err(identityError('unknown_principal', `no principal ${req.target.principal_id}`));
      if (p.principal.status !== 'active') {
        return err(identityError('refused', `${req.target.principal_id} is ${p.principal.status}`));
      }
      group = grantGroupId(req.target.principal_id);
      const g = await createGroupTx(
        j,
        {
          group_id: group,
          display: `Grants of ${req.target.principal_id}`,
          pim_managed: false,
          protected: true,
        },
        actor,
        { grant: true },
      );
      if (!g.ok) return g;
      const m = await addMemberTx(
        deps,
        j,
        { group_id: group, principal_id: req.target.principal_id, source: 'access_grant' },
        actor,
        true,
      );
      if (!m.ok) return m;
      changed = g.value.changed || m.value.changed;
    } else {
      const t = await j.team(req.target.team_id);
      if (!t) return err(identityError('not_found', `no team ${req.target.team_id}`));
      if (t.idp_group === null) {
        return err(identityError('refused', `team ${req.target.team_id} has no IdP group to bind`));
      }
      group = t.idp_group;
    }
    const b = await createBindingTx(
      deps,
      j,
      {
        group_id: group,
        role_id: req.role_id,
        scope: req.scope,
        constraints: { origin: ACCESS_GRANT_ORIGIN, grant_id: req.grant_id },
        expiry: req.expiry,
        m_gate_ref: req.m_gate_ref,
      },
      actor,
      { grant: true },
    );
    if (!b.ok) return b;
    return ok({
      binding_id: b.value.binding_id as never,
      group_id: group as never,
      changed: changed || b.value.changed,
    });
  });
}

export async function revokeAccess(
  deps: IdentityDeps,
  req: IdentityRevokeRequest,
): Promise<Result<IdentityGrantResult, IdentityError>> {
  return inIdentityTx(deps, async (j) => {
    const cur = await j.binding(req.binding_id);
    if (!cur) return err(identityError('not_found', `no binding ${req.binding_id}`));
    const r = await revokeBindingTx(
      j,
      req.binding_id,
      `${req.reason} (grant ${req.grant_id}, decision ${req.m_gate_ref})`,
      req.on_behalf_of,
      false,
      true,
    );
    if (!r.ok) return r;
    return ok({
      binding_id: req.binding_id,
      group_id: cur.binding.group_id,
      changed: r.value.changed,
    });
  });
}
