import { IDENTITY_EVENT, isRoleMapGroup, type Group, type IdentityLink } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { IdentityProviderPort, IdpSnapshot, IdpSubject } from '@aisdlc/ports';
import {
  addMemberTx,
  createGroupTx,
  createPrincipalTx,
  linkIdentityTx,
  removeMemberTx,
  setPrincipalStatusTx,
  updateGroupTx,
  updatePrincipalTx,
} from './commands.js';
import { identityError, type IdentityError } from './errors.js';
import { foldLink, lockKeys, type Journal } from './journal.js';
import { inIdentityTx, type IdentityDeps } from './tx.js';

// Sync from the identity provider (PLAN M4.1). The IdP owns people and the groups it manages; the
// factory owns bindings and the generated groups. One sync reads one full snapshot through the
// port (an unreachable or invalid IdP changes nothing) and makes the journal agree with it:
// principals and links are created or updated, groups and their `sync` memberships follow the
// snapshot. The one status change a sync makes on its own is to tighten: a subject the IdP
// disabled or removed is disabled here; it is never re-enabled (loosening needs a human).

export const IDP_SYNC_ACTOR = 'system.idp_sync';

export interface IdpSyncDeps extends IdentityDeps {
  readonly idp: IdentityProviderPort;
}

export interface IdpSyncReport {
  readonly issuer: string;
  readonly principals_created: number;
  readonly principals_updated: number;
  readonly principals_disabled: number;
  readonly links_created: number;
  readonly groups_created: number;
  readonly members_added: number;
  readonly members_removed: number;
  /** Subjects skipped with the reason (a handle or link that belongs to someone else). */
  readonly skipped: readonly { subject: string; reason: string }[];
  readonly events: number;
}

const subjectLink = (s: IdpSubject): Omit<IdentityLink, 'principal_id'> => ({
  kind: 'idp_subject',
  issuer: s.issuer,
  value: s.subject,
});

export async function syncFromIdp(
  deps: IdpSyncDeps,
  opts: { actor?: string } = {},
): Promise<Result<IdpSyncReport, IdentityError>> {
  const snap = await deps.idp.syncGroups();
  if (!snap.ok) {
    return err(
      identityError('unavailable', `identity provider: ${snap.error.message}`, snap.error),
    );
  }
  const snapshot = snap.value;
  const actor = opts.actor ?? IDP_SYNC_ACTOR;
  return inIdentityTx(
    deps,
    async (j) => {
      await lockKeys(j.tx, ['idp-sync']);
      const before = j.appended;
      const r = report(snapshot.issuer);
      const principalOf = new Map<string, string>(); // IdP subject -> principal id
      const skip = (subject: string, reason: string) => r.skipped.push({ subject, reason });

      for (const s of [...snapshot.subjects].sort((a, b) => (a.subject < b.subject ? -1 : 1))) {
        const res = await syncSubject(deps, j, s, actor, r);
        if (res.ok) principalOf.set(s.subject, res.value);
        else if (res.error.code === 'database') return res;
        else skip(s.subject, res.error.message);
      }
      const groups = await syncGroupsOf(deps, j, snapshot, principalOf, actor, r);
      if (!groups.ok) return groups;
      const gone = await disableMissing(j, snapshot, actor, r);
      if (!gone.ok) return gone;
      return ok({ ...r, skipped: r.skipped, events: j.appended - before });
    },
    { exclusive: true },
  );
}

function report(issuer: string) {
  return {
    issuer,
    principals_created: 0,
    principals_updated: 0,
    principals_disabled: 0,
    links_created: 0,
    groups_created: 0,
    members_added: 0,
    members_removed: 0,
    skipped: [] as { subject: string; reason: string }[],
  };
}
type Counters = ReturnType<typeof report>;

/** Finds or creates the principal of a subject and keeps it and its link current. Returns its id. */
async function syncSubject(
  deps: IdpSyncDeps,
  j: Journal,
  s: IdpSubject,
  actor: string,
  r: Counters,
): Promise<Result<string, IdentityError>> {
  const link = await j.link(subjectLink(s));
  if (link && link.principal_id !== s.principal_id) {
    return err(
      identityError(
        'already_exists',
        `subject is linked to ${link.principal_id}, the IdP says ${s.principal_id}`,
      ),
    );
  }
  const existing = await j.principal(s.principal_id);
  if (!existing) {
    const c = await createPrincipalTx(
      deps,
      j,
      {
        principal_id: s.principal_id,
        kind: s.kind,
        entra_oid: s.kind === 'human' ? s.subject : null,
        upn: s.upn,
        logins: s.logins,
        display_handle: s.display_handle,
        display_name: s.display_name,
        // A new principal is created active; a subject the IdP already disabled is disabled below.
      },
      actor,
    );
    if (!c.ok) return c;
    r.principals_created += 1;
  } else if (existing.principal.status !== 'deleted') {
    const u = await updatePrincipalTx(
      deps,
      j,
      s.principal_id,
      { upn: s.upn, logins: s.logins, display_name: s.display_name },
      actor,
    );
    if (!u.ok) return u;
    if (u.value.changed) r.principals_updated += 1;
  }
  if (!link) {
    const l = await linkIdentityTx(j, { ...subjectLink(s), principal_id: s.principal_id }, actor);
    if (!l.ok) return l;
    if (l.value.changed) r.links_created += 1;
  }
  if (s.status !== 'active') {
    const d = await setPrincipalStatusTx(
      j,
      s.principal_id,
      'disabled',
      'disabled at the IdP',
      actor,
    );
    if (!d.ok) return d;
    if (d.value.changed) r.principals_disabled += 1;
  }
  return ok(s.principal_id);
}

async function syncGroupsOf(
  deps: IdpSyncDeps,
  j: Journal,
  snap: IdpSnapshot,
  principalOf: ReadonlyMap<string, string>,
  actor: string,
  r: Counters,
): Promise<Result<void, IdentityError>> {
  const inSnapshot = new Set(snap.groups.map((g) => g.group_id as string));
  const desired = new Map<string, Set<string>>();
  for (const g of snap.groups) desired.set(g.group_id, new Set());
  for (const s of snap.subjects) {
    const p = principalOf.get(s.subject);
    if (p === undefined) continue; // skipped subject: its memberships are left as they are
    for (const g of s.groups) desired.get(g)?.add(p);
  }
  const skipped = new Set(r.skipped.map((x) => x.subject));
  const skippedPrincipals = new Set(
    snap.subjects.filter((s) => skipped.has(s.subject)).map((s) => s.principal_id as string),
  );

  for (const g of [...snap.groups].sort((a, b) => (a.group_id < b.group_id ? -1 : 1))) {
    if (isRoleMapGroup(g.group_id)) {
      r.skipped.push({ subject: g.group_id, reason: 'generated groups are not synced' });
      continue;
    }
    const want: Group = {
      group_id: g.group_id,
      display: g.display,
      pim_managed: g.pim_managed,
      protected: g.protected,
    };
    const created = await createGroupTx(j, want, actor);
    if (!created.ok) {
      if (created.error.code !== 'already_exists') return created;
      const u = await updateGroupTx(
        j,
        g.group_id,
        { display: g.display, pim_managed: g.pim_managed },
        actor,
      );
      if (!u.ok) return u;
    } else if (created.value.changed) r.groups_created += 1;
  }

  // Memberships: every group that has, or should have, `sync` members.
  const withSync = await j.tx.query<{ stream: string }>(
    `SELECT DISTINCT stream FROM record.record_event WHERE type = $1 AND body ->> 'source' = 'sync'`,
    [IDENTITY_EVENT.member_added],
  );
  const groups = new Set([
    ...inSnapshot,
    ...withSync.rows.map((x) => x.stream.slice('group:'.length)),
  ]);
  for (const gid of [...groups].sort()) {
    const state = await j.group(gid);
    if (!state) continue;
    const want = desired.get(gid) ?? new Set<string>();
    const viaOf = (state.group.pim_managed ? 'pim_activation' : 'direct') as
      'pim_activation' | 'direct';
    for (const p of [...want].sort()) {
      const m = await addMemberTx(
        deps,
        j,
        { group_id: gid, principal_id: p, via: viaOf, source: 'sync' },
        actor,
        true,
      );
      if (!m.ok) return m;
      if (m.value.changed) r.members_added += 1;
    }
    for (const [p, m] of [...state.members].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (m.source !== 'sync' || want.has(p) || skippedPrincipals.has(p)) continue;
      const rm = await removeMemberTx(j, gid, p, 'left the group at the IdP', actor, true);
      if (!rm.ok) return rm;
      if (rm.value.changed) r.members_removed += 1;
    }
  }
  return ok(undefined);
}

/** Subjects of this issuer that were linked before and are no longer in the snapshot: disable them. */
async function disableMissing(
  j: Journal,
  snap: IdpSnapshot,
  actor: string,
  r: Counters,
): Promise<Result<void, IdentityError>> {
  const q = await j.tx.query<{ stream: string }>(
    `SELECT DISTINCT stream FROM record.record_event
      WHERE type = $1 AND body ->> 'kind' = 'idp_subject' AND body ->> 'issuer' = $2`,
    [IDENTITY_EVENT.link_linked, snap.issuer],
  );
  const present = new Set(snap.subjects.map((s) => s.subject));
  for (const row of q.rows) {
    const link = foldLink(await j.events(row.stream));
    if (!link || present.has(link.value)) continue;
    const d = await setPrincipalStatusTx(
      j,
      link.principal_id,
      'disabled',
      'removed from the IdP',
      actor,
    );
    if (!d.ok) {
      if (d.error.code === 'refused' || d.error.code === 'not_found') continue;
      return d;
    }
    if (d.value.changed) r.principals_disabled += 1;
  }
  return ok(undefined);
}
