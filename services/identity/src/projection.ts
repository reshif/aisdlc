import {
  BindingCreatedPayload,
  BindingRevokedPayload,
  BindingUpdatedPayload,
  GroupCreatedPayload,
  GroupUpdatedPayload,
  IDENTITY_EVENT,
  IDENTITY_STREAM_PREFIXES,
  LinkLinkedPayload,
  MemberAddedPayload,
  MemberRemovedPayload,
  PrincipalCreatedPayload,
  PrincipalStatusChangedPayload,
  PrincipalUpdatedPayload,
  QualificationGrantedPayload,
  QualificationRevokedPayload,
  TeamCreatedPayload,
  TeamUpdatedPayload,
  identityLinkKey,
  type RecordEvent,
} from '@aisdlc/contracts';
import type { Executor, Projection, Tx } from '@aisdlc/record';

// The `identity` read model (PLAN M4.1): principals, groups, memberships, bindings, qualifications,
// identity links and teams, folded from the identity journal alone. `apply` is a deterministic
// function of the event and the rows its own earlier events produced.

const streamId = (stream: string): string => stream.slice(stream.indexOf(':') + 1);

async function applyPrincipal(tx: Tx, e: RecordEvent): Promise<void> {
  const id = streamId(e.stream_id);
  switch (e.type) {
    case IDENTITY_EVENT.principal_created: {
      const p = PrincipalCreatedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO identity.principal
           (principal_id, kind, status, entra_oid, upn, logins, machine_actions, breakglass,
            display_handle, display_name, role_label, status_changed_at)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11,$12)
         ON CONFLICT (principal_id) DO NOTHING`,
        [
          p.principal_id,
          p.kind,
          p.status,
          p.entra_oid,
          p.upn,
          JSON.stringify(p.logins),
          JSON.stringify(p.machine_actions),
          p.breakglass,
          p.display_handle,
          p.display_name,
          p.role_label,
          p.status_changed_at,
        ],
      );
      break;
    }
    case IDENTITY_EVENT.principal_updated: {
      const u = PrincipalUpdatedPayload.parse(e.payload);
      const json = new Set(['logins', 'machine_actions']);
      const sets: string[] = [];
      const values: unknown[] = [id];
      for (const [k, v] of Object.entries(u)) {
        values.push(json.has(k) ? JSON.stringify(v) : v);
        sets.push(`${k} = $${values.length}${json.has(k) ? '::jsonb' : ''}`);
      }
      await tx.query(
        `UPDATE identity.principal SET ${sets.join(', ')} WHERE principal_id = $1`,
        values,
      );
      break;
    }
    case IDENTITY_EVENT.principal_status_changed: {
      const s = PrincipalStatusChangedPayload.parse(e.payload);
      await tx.query(
        'UPDATE identity.principal SET status = $2, status_changed_at = $3 WHERE principal_id = $1',
        [id, s.status, e.occurred_at],
      );
      break;
    }
    case IDENTITY_EVENT.qualification_granted: {
      const q = QualificationGrantedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO identity.qualification
           (principal_id, qual_type, valid_from, valid_until, source, evidence_ref)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (principal_id, qual_type) DO UPDATE
           SET valid_from = $3, valid_until = $4, source = $5, evidence_ref = $6`,
        [q.principal_id, q.qual_type, q.valid_from, q.valid_until, q.source, q.evidence_ref],
      );
      break;
    }
    case IDENTITY_EVENT.qualification_revoked: {
      const q = QualificationRevokedPayload.parse(e.payload);
      await tx.query(
        'DELETE FROM identity.qualification WHERE principal_id = $1 AND qual_type = $2',
        [id, q.qual_type],
      );
      break;
    }
  }
}

async function applyGroup(tx: Tx, e: RecordEvent): Promise<void> {
  const id = streamId(e.stream_id);
  switch (e.type) {
    case IDENTITY_EVENT.group_created: {
      const g = GroupCreatedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO identity.grp (group_id, display, pim_managed, protected)
         VALUES ($1,$2,$3,$4) ON CONFLICT (group_id) DO NOTHING`,
        [g.group_id, g.display, g.pim_managed, g.protected],
      );
      break;
    }
    case IDENTITY_EVENT.group_updated: {
      const u = GroupUpdatedPayload.parse(e.payload);
      if (u.display !== undefined) {
        await tx.query('UPDATE identity.grp SET display = $2 WHERE group_id = $1', [id, u.display]);
      }
      if (u.pim_managed !== undefined) {
        await tx.query('UPDATE identity.grp SET pim_managed = $2 WHERE group_id = $1', [
          id,
          u.pim_managed,
        ]);
      }
      break;
    }
    case IDENTITY_EVENT.member_added: {
      const m = MemberAddedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO identity.membership
           (group_id, principal_id, active_from, active_until, via, source)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (group_id, principal_id) DO UPDATE
           SET active_from = $3, active_until = $4, via = $5, source = $6`,
        [m.group_id, m.principal_id, m.active_from, m.active_until, m.via, m.source],
      );
      break;
    }
    case IDENTITY_EVENT.member_removed: {
      const m = MemberRemovedPayload.parse(e.payload);
      await tx.query('DELETE FROM identity.membership WHERE group_id = $1 AND principal_id = $2', [
        id,
        m.principal_id,
      ]);
      break;
    }
  }
}

async function applyBinding(tx: Tx, e: RecordEvent): Promise<void> {
  const id = streamId(e.stream_id);
  switch (e.type) {
    case IDENTITY_EVENT.binding_created: {
      const b = BindingCreatedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO identity.binding
           (binding_id, group_id, role_id, scope_kind, scope_ref, constraints, expiry, m_gate_ref,
            config_rev)
         VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9)
         ON CONFLICT (binding_id) DO UPDATE
           SET group_id = $2, role_id = $3, scope_kind = $4, scope_ref = $5, constraints = $6::jsonb,
               expiry = $7, m_gate_ref = $8, config_rev = $9`,
        [
          b.binding_id,
          b.group_id,
          b.role_id,
          b.scope.kind,
          b.scope.ref,
          JSON.stringify(b.constraints),
          b.expiry,
          b.m_gate_ref,
          b.config_rev,
        ],
      );
      break;
    }
    case IDENTITY_EVENT.binding_updated: {
      const u = BindingUpdatedPayload.parse(e.payload);
      await tx.query(
        'UPDATE identity.binding SET constraints = $2::jsonb, config_rev = $3 WHERE binding_id = $1',
        [id, JSON.stringify(u.constraints), u.config_rev],
      );
      break;
    }
    case IDENTITY_EVENT.binding_revoked:
      BindingRevokedPayload.parse(e.payload);
      await tx.query('DELETE FROM identity.binding WHERE binding_id = $1', [id]);
      break;
  }
}

async function applyTeam(tx: Tx, e: RecordEvent): Promise<void> {
  const id = streamId(e.stream_id);
  if (e.type === IDENTITY_EVENT.team_created) {
    const t = TeamCreatedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO identity.team (team_id, name, classification, idp_group)
       VALUES ($1,$2,$3,$4) ON CONFLICT (team_id) DO NOTHING`,
      [t.team_id, t.name, t.classification, t.idp_group],
    );
  } else if (e.type === IDENTITY_EVENT.team_updated) {
    const u = TeamUpdatedPayload.parse(e.payload);
    for (const [k, v] of Object.entries(u)) {
      await tx.query(`UPDATE identity.team SET ${k} = $2 WHERE team_id = $1`, [id, v]);
    }
  }
}

async function applyLink(tx: Tx, e: RecordEvent): Promise<void> {
  const key = streamId(e.stream_id);
  if (e.type === IDENTITY_EVENT.link_linked) {
    const l = LinkLinkedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO identity.identity_link (link_key, principal_id, kind, issuer, value)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (link_key) DO UPDATE SET principal_id = $2, kind = $3, issuer = $4, value = $5`,
      [identityLinkKey(l), l.principal_id, l.kind, l.issuer, l.value],
    );
  } else if (e.type === IDENTITY_EVENT.link_unlinked) {
    await tx.query('DELETE FROM identity.identity_link WHERE link_key = $1', [key]);
  }
}

export interface IdentitySnapshot {
  principals: unknown[];
  groups: unknown[];
  memberships: unknown[];
  bindings: unknown[];
  qualifications: unknown[];
  links: unknown[];
  teams: unknown[];
}

const TABLES = [
  'identity.identity_link',
  'identity.qualification',
  'identity.binding',
  'identity.membership',
  'identity.grp',
  'identity.principal',
  'identity.team',
] as const;

export const identityProjection: Projection<IdentitySnapshot> = {
  name: 'identity',
  version: 1,
  tables: TABLES,

  async apply(tx, event) {
    const s = event.stream_id;
    if (!IDENTITY_STREAM_PREFIXES.some((p) => s.startsWith(p))) return;
    if (s.startsWith('principal:')) await applyPrincipal(tx, event);
    else if (s.startsWith('group:')) await applyGroup(tx, event);
    else if (s.startsWith('binding:')) await applyBinding(tx, event);
    else if (s.startsWith('team:')) await applyTeam(tx, event);
    else if (s.startsWith('link:')) await applyLink(tx, event);
  },

  async reset(tx) {
    for (const t of TABLES) await tx.query(`DELETE FROM ${t}`);
  },

  async snapshot(db: Executor) {
    const q = async (sql: string) => (await db.query(sql)).rows;
    return {
      principals: await q('SELECT * FROM identity.principal ORDER BY principal_id'),
      groups: await q('SELECT * FROM identity.grp ORDER BY group_id'),
      memberships: await q('SELECT * FROM identity.membership ORDER BY group_id, principal_id'),
      bindings: await q('SELECT * FROM identity.binding ORDER BY binding_id'),
      qualifications: await q(
        'SELECT * FROM identity.qualification ORDER BY principal_id, qual_type',
      ),
      links: await q('SELECT * FROM identity.identity_link ORDER BY link_key'),
      teams: await q('SELECT * FROM identity.team ORDER BY team_id'),
    };
  },
};
