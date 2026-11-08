import {
  Binding,
  Group,
  IDENTITY_EVENT,
  IdentityLink,
  Membership,
  MemberRemovedPayload,
  PrincipalId,
  PrincipalKind,
  PrincipalStatus,
  PrincipalUpdatedPayload,
  Qualification,
  ROLE_CATALOGUE,
  Team,
  TeamUpdatedPayload,
  GroupUpdatedPayload,
  bindingIdFor,
  bindingStream,
  groupStream,
  identityLinkKey,
  identityLinkStream,
  isCodeownersGroup,
  isRoleMapGroup,
  normalizeLinkValue,
  principalStream,
  roleDef,
  teamStream,
  ROLE_MAP_ORIGIN,
  Principal as PrincipalSchema,
  type RoleDef,
  type Scope,
} from '@aisdlc/contracts';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import { z } from 'zod';
import { identityError, type IdentityError } from './errors.js';
import { lockKeys, type Journal } from './journal.js';
import { clockOf, inIdentityTx, type IdentityDeps } from './tx.js';

// The identity commands (PLAN M4.1): the only code that appends to the identity journal. Each one
// is a single transaction: lock the aggregate's key, fold its stream from the record, check the
// rules, append events, and return `changed: false` when the state already is what was asked.
// Access ledger entries are not written here; the access-sync loop makes them (`access-sync.ts`).

export interface Changed {
  readonly changed: boolean;
}

const unchanged: Changed = { changed: false };
const changed: Changed = { changed: true };

const invalid = (message: string, detail?: unknown): IdentityError =>
  identityError('invalid_input', message, detail);

function actorOf(actor: string): Result<string, IdentityError> {
  const p = PrincipalId.safeParse(actor);
  return p.success
    ? ok(actor)
    : err(invalid(`actor ${JSON.stringify(actor)} is not a principal id`));
}

async function emit(
  j: Journal,
  stream: string,
  type: string,
  payload: object,
  actor: string,
): Promise<Result<void, IdentityError>> {
  const r = await j.emit(stream, type, payload, actor);
  return r.ok ? ok(undefined) : r;
}

// ---------------------------------------------------------------- Principals

export const NewPrincipal = z.strictObject({
  principal_id: PrincipalId,
  kind: PrincipalKind,
  entra_oid: z.string().min(1).nullable().default(null),
  upn: z.string().min(1).nullable().default(null),
  logins: z.array(z.string().min(1)).default([]),
  machine_actions: z.array(z.string().min(1)).default([]),
  breakglass: z.boolean().default(false),
  display_handle: z.string().min(1),
  display_name: z.string().min(1),
  role_label: z.string().min(1).nullable().default(null),
  status: PrincipalStatus.default('active'),
});
export type NewPrincipal = z.input<typeof NewPrincipal>;

/**
 * Display handles are unique, compared without case (pickers and mentions use them). The check
 * reads the authoritative record in the writer's own transaction, under a lock on the handle: the
 * principals whose events ever carried the handle are folded, and one that holds it now owns it.
 * (It must not wait for the read model or for another database connection: a writer holds one
 * connection already, and a pool of writers all asking for a second one would deadlock.)
 */
async function handleOwner(j: Journal, handle: string, self: string): Promise<string | null> {
  const lower = handle.toLowerCase();
  await lockKeys(j.tx, [`handle:${lower}`]);
  const q = await j.tx.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = 'principal.created' AND lower(body ->> 'display_handle') = $1
     UNION
     SELECT stream FROM record.record_event
      WHERE type = 'principal.updated' AND lower(body ->> 'display_handle') = $1`,
    [lower],
  );
  for (const row of q.rows) {
    const id = row.stream.slice('principal:'.length);
    if (id === self) continue;
    const p = await j.principal(id);
    if (p && p.principal.display_handle.toLowerCase() === lower) return id;
  }
  return null;
}

export async function createPrincipalTx(
  deps: IdentityDeps,
  j: Journal,
  input: NewPrincipal,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const parsed = NewPrincipal.safeParse(input);
  if (!parsed.success) return err(invalid(parsed.error.message));
  const now = clockOf(deps).now().toISOString();
  const p = PrincipalSchema.safeParse({ ...parsed.data, status_changed_at: now });
  if (!p.success) return err(invalid(p.error.message));
  const id = p.data.principal_id;
  await lockKeys(j.tx, [`principal:${id}`]);
  const existing = await j.principal(id);
  if (existing) {
    // Compared without the creation time: asking again later is still the same principal.
    const same = { ...existing.principal, status_changed_at: p.data.status_changed_at };
    return canonicalJson(same) === canonicalJson(p.data)
      ? ok(unchanged)
      : err(identityError('already_exists', `principal ${id} exists with other attributes`));
  }
  const owner = await handleOwner(j, p.data.display_handle, id);
  if (owner !== null) {
    return err(
      identityError('already_exists', `handle ${p.data.display_handle} belongs to ${owner}`),
    );
  }
  const r = await emit(j, principalStream(id), IDENTITY_EVENT.principal_created, p.data, actor);
  if (!r.ok) return r;
  return ok(changed);
}

export async function createPrincipal(
  deps: IdentityDeps,
  input: NewPrincipal,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => createPrincipalTx(deps, j, input, actor));
}

export async function updatePrincipalTx(
  deps: IdentityDeps,
  j: Journal,
  id: string,
  changes: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const parsed = PrincipalUpdatedPayload.safeParse(changes);
  if (!parsed.success) return err(invalid(parsed.error.message));
  await lockKeys(j.tx, [`principal:${id}`]);
  const cur = await j.principal(id);
  if (!cur) return err(identityError('not_found', `no principal ${id}`));
  if (cur.principal.status === 'deleted') {
    return err(identityError('refused', `principal ${id} is deleted`));
  }
  const actual: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(parsed.data)) {
    if (canonicalJson((cur.principal as Record<string, unknown>)[k]) !== canonicalJson(v)) {
      actual[k] = v;
    }
  }
  if (Object.keys(actual).length === 0) return ok(unchanged);
  const next = PrincipalSchema.safeParse({ ...cur.principal, ...actual });
  if (!next.success) return err(invalid(next.error.message));
  const handle = actual['display_handle'];
  if (typeof handle === 'string') {
    const owner = await handleOwner(j, handle, id);
    if (owner !== null) {
      return err(identityError('already_exists', `handle ${handle} belongs to ${owner}`));
    }
  }
  const r = await emit(j, principalStream(id), IDENTITY_EVENT.principal_updated, actual, actor);
  if (!r.ok) return r;
  return ok(changed);
}

export async function updatePrincipal(
  deps: IdentityDeps,
  id: string,
  changes: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => updatePrincipalTx(deps, j, id, changes, actor));
}

/**
 * Sets the status. `deleted` is terminal (a deleted principal is never brought back; create a new
 * one). Disabling ends every access of the principal at once: effective access reads the status.
 */
export async function setPrincipalStatusTx(
  j: Journal,
  id: string,
  status: PrincipalStatus,
  reason: string,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const s = PrincipalStatus.safeParse(status);
  if (!s.success || reason.trim() === '') return err(invalid('status and a reason are required'));
  await lockKeys(j.tx, [`principal:${id}`]);
  const cur = await j.principal(id);
  if (!cur) return err(identityError('not_found', `no principal ${id}`));
  if (cur.principal.status === status) return ok(unchanged);
  if (cur.principal.status === 'deleted') {
    return err(identityError('refused', `principal ${id} is deleted`));
  }
  const r = await emit(
    j,
    principalStream(id),
    IDENTITY_EVENT.principal_status_changed,
    { status, reason },
    actor,
  );
  return r.ok ? ok(changed) : r;
}

export async function setPrincipalStatus(
  deps: IdentityDeps,
  id: string,
  status: PrincipalStatus,
  reason: string,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => setPrincipalStatusTx(j, id, status, reason, actor));
}

// ---------------------------------------------------------------- Qualifications

export async function grantQualification(
  deps: IdentityDeps,
  input: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  const q = Qualification.safeParse(input);
  if (!q.success) return err(invalid(q.error.message));
  return inIdentityTx(deps, async (j) => {
    await lockKeys(j.tx, [`principal:${q.data.principal_id}`]);
    const cur = await j.principal(q.data.principal_id);
    if (!cur) return err(identityError('not_found', `no principal ${q.data.principal_id}`));
    if (cur.principal.status === 'deleted')
      return err(identityError('refused', 'principal is deleted'));
    const have = cur.qualifications.get(q.data.qual_type);
    if (have && canonicalJson(have) === canonicalJson(q.data)) return ok(unchanged);
    const r = await emit(
      j,
      principalStream(q.data.principal_id),
      IDENTITY_EVENT.qualification_granted,
      q.data,
      actor,
    );
    return r.ok ? ok(changed) : r;
  });
}

export async function revokeQualification(
  deps: IdentityDeps,
  principal: string,
  qual_type: string,
  reason: string,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  if (reason.trim() === '' || qual_type === '')
    return err(invalid('qual_type and a reason are required'));
  return inIdentityTx(deps, async (j) => {
    await lockKeys(j.tx, [`principal:${principal}`]);
    const cur = await j.principal(principal);
    if (!cur) return err(identityError('not_found', `no principal ${principal}`));
    if (!cur.qualifications.has(qual_type)) return ok(unchanged);
    const r = await emit(
      j,
      principalStream(principal),
      IDENTITY_EVENT.qualification_revoked,
      { qual_type, reason },
      actor,
    );
    return r.ok ? ok(changed) : r;
  });
}

// ---------------------------------------------------------------- Identity links

export interface LinkRef {
  readonly kind: IdentityLink['kind'];
  readonly issuer: string | null;
  readonly value: string;
}

export async function linkIdentityTx(
  j: Journal,
  input: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const raw = IdentityLink.safeParse(input);
  if (!raw.success) return err(invalid(raw.error.message));
  const link: IdentityLink = {
    ...raw.data,
    value: normalizeLinkValue(raw.data.kind, raw.data.value),
  };
  await lockKeys(j.tx, [`link:${identityLinkKey(link)}`]);
  const p = await j.principal(link.principal_id);
  if (!p) return err(identityError('not_found', `no principal ${link.principal_id}`));
  if (p.principal.status === 'deleted')
    return err(identityError('refused', 'principal is deleted'));
  const cur = await j.link(link);
  if (cur) {
    return cur.principal_id === link.principal_id
      ? ok(unchanged)
      : err(
          identityError(
            'already_exists',
            `${link.kind} ${link.value} is already linked to ${cur.principal_id}`,
          ),
        );
  }
  const r = await emit(j, identityLinkStream(link), IDENTITY_EVENT.link_linked, link, actor);
  return r.ok ? ok(changed) : r;
}

export async function linkIdentity(
  deps: IdentityDeps,
  input: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => linkIdentityTx(j, input, actor));
}

export async function unlinkIdentity(
  deps: IdentityDeps,
  ref: LinkRef,
  reason: string,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  if (reason.trim() === '') return err(invalid('a reason is required'));
  const key = { ...ref, value: normalizeLinkValue(ref.kind, ref.value) };
  return inIdentityTx(deps, async (j) => {
    await lockKeys(j.tx, [`link:${identityLinkKey(key)}`]);
    const cur = await j.link(key);
    if (!cur) return ok(unchanged);
    const r = await emit(
      j,
      identityLinkStream(key),
      IDENTITY_EVENT.link_unlinked,
      { principal_id: cur.principal_id, reason },
      actor,
    );
    return r.ok ? ok(changed) : r;
  });
}

// ---------------------------------------------------------------- Groups and memberships

export async function createGroupTx(
  j: Journal,
  input: unknown,
  actor: string,
  opts: { generated?: boolean } = {},
): Promise<Result<Changed, IdentityError>> {
  const g = Group.safeParse(input);
  if (!g.success) return err(invalid(g.error.message));
  if (isRoleMapGroup(g.data.group_id) && opts.generated !== true) {
    return err(identityError('protected_group', `${g.data.group_id} is generated from a role map`));
  }
  await lockKeys(j.tx, [`group:${g.data.group_id}`]);
  const cur = await j.group(g.data.group_id);
  if (cur) {
    return canonicalJson(cur.group) === canonicalJson(g.data)
      ? ok(unchanged)
      : err(
          identityError('already_exists', `group ${g.data.group_id} exists with other attributes`),
        );
  }
  const r = await emit(
    j,
    groupStream(g.data.group_id),
    IDENTITY_EVENT.group_created,
    g.data,
    actor,
  );
  return r.ok ? ok(changed) : r;
}

export async function createGroup(
  deps: IdentityDeps,
  input: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => createGroupTx(j, input, actor));
}

export async function updateGroupTx(
  j: Journal,
  id: string,
  changes: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const u = GroupUpdatedPayload.safeParse(changes);
  if (!u.success) return err(invalid(u.error.message));
  if (isRoleMapGroup(id)) return err(identityError('protected_group', `${id} is generated`));
  await lockKeys(j.tx, [`group:${id}`]);
  const cur = await j.group(id);
  if (!cur) return err(identityError('not_found', `no group ${id}`));
  const actual: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(u.data)) {
    if ((cur.group as Record<string, unknown>)[k] !== v) actual[k] = v;
  }
  if (Object.keys(actual).length === 0) return ok(unchanged);
  const r = await emit(j, groupStream(id), IDENTITY_EVENT.group_updated, actual, actor);
  return r.ok ? ok(changed) : r;
}

export async function updateGroup(
  deps: IdentityDeps,
  id: string,
  changes: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => updateGroupTx(j, id, changes, actor));
}

export interface AddMemberInput {
  readonly group_id: string;
  readonly principal_id: string;
  readonly active_from?: string;
  readonly active_until?: string | null;
  readonly via?: Membership['via'];
  /** The writer's own sources: `sync` (IdP sync), `role_map` (reconcile), `codeowners` (code owner sync). Default `oidc_token_dev`. */
  readonly source?: Membership['source'];
}

/** `internal`: the caller is the reconcile (`role_map`), the code owner sync (`codeowners`) or the IdP sync (`sync`), which may touch their groups. */
export async function addMemberTx(
  deps: IdentityDeps,
  j: Journal,
  input: AddMemberInput,
  actor: string,
  internal: boolean,
): Promise<Result<Changed, IdentityError>> {
  const m = Membership.safeParse({
    group_id: input.group_id,
    principal_id: input.principal_id,
    active_from: input.active_from ?? clockOf(deps).now().toISOString(),
    active_until: input.active_until ?? null,
    via: input.via ?? 'direct',
    source: input.source ?? 'oidc_token_dev',
  });
  if (!m.success) return err(invalid(m.error.message));
  const group = isRoleMapGroup(m.data.group_id);
  const source = m.data.source;
  if (group && (!internal || (source !== 'role_map' && source !== 'codeowners'))) {
    return err(
      identityError(
        'protected_group',
        `${m.data.group_id} is generated from a role map; its members change only with the role map`,
      ),
    );
  }
  if (source === 'role_map' && !group) {
    return err(identityError('invalid_input', 'source role_map is for generated groups'));
  }
  // The one membership a role map does not generate: the g4 group of a project whose g4 slot is
  // `codeowners`, set by `setCodeownerMembers` (codeowners.ts) and by nothing else.
  if (source === 'codeowners' && !isCodeownersGroup(m.data.group_id)) {
    return err(
      identityError('invalid_input', 'source codeowners is only for the g4 group of a project'),
    );
  }
  await lockKeys(j.tx, [`group:${m.data.group_id}`]);
  const g = await j.group(m.data.group_id);
  if (!g) return err(identityError('not_found', `no group ${m.data.group_id}`));
  const p = await j.principal(m.data.principal_id);
  if (!p) return err(identityError('unknown_principal', `no principal ${m.data.principal_id}`));
  if (p.principal.status === 'deleted')
    return err(identityError('refused', 'principal is deleted'));
  const have = g.members.get(m.data.principal_id);
  // The same membership (group, principal, source, via, active_until) is unchanged whatever
  // `active_from` the caller stamped: asking again must not move the start of a membership, and
  // must not write an event (each one becomes an access ledger entry).
  if (
    have &&
    have.source === m.data.source &&
    have.via === m.data.via &&
    have.active_until === m.data.active_until
  ) {
    return ok(unchanged);
  }
  // A real change keeps the original start unless the caller named one.
  const next =
    have && input.active_from === undefined
      ? Membership.safeParse({ ...m.data, active_from: have.active_from })
      : m;
  if (!next.success) return err(invalid(next.error.message));
  const r = await emit(
    j,
    groupStream(m.data.group_id),
    IDENTITY_EVENT.member_added,
    next.data,
    actor,
  );
  return r.ok ? ok(changed) : r;
}

export async function addMember(
  deps: IdentityDeps,
  input: AddMemberInput,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => addMemberTx(deps, j, input, actor, false));
}

export async function removeMemberTx(
  j: Journal,
  group: string,
  principal: string,
  reason: string,
  actor: string,
  internal: boolean,
): Promise<Result<Changed, IdentityError>> {
  const body = MemberRemovedPayload.safeParse({ principal_id: principal, reason });
  if (!body.success) return err(invalid(body.error.message));
  if (isRoleMapGroup(group) && !internal) {
    return err(identityError('protected_group', `${group} is generated from a role map`));
  }
  await lockKeys(j.tx, [`group:${group}`]);
  const g = await j.group(group);
  if (!g) return err(identityError('not_found', `no group ${group}`));
  if (!g.members.has(principal)) return ok(unchanged);
  const r = await emit(j, groupStream(group), IDENTITY_EVENT.member_removed, body.data, actor);
  return r.ok ? ok(changed) : r;
}

export async function removeMember(
  deps: IdentityDeps,
  group: string,
  principal: string,
  reason: string,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => removeMemberTx(j, group, principal, reason, actor, false));
}

// ---------------------------------------------------------------- Bindings

export interface CreateBindingInput {
  readonly group_id: string;
  readonly role_id: string;
  readonly scope: Scope;
  readonly constraints?: Record<string, unknown>;
  readonly expiry?: string | null;
  readonly m_gate_ref?: string | null;
  readonly config_rev?: string | null;
}

/**
 * A binding is `(group, role, scope)`; its id is derived from that triple, so asking twice is one
 * binding. The role must be in the catalogue and the scope kind one the role allows. Bindings of a
 * project role slot at a project or lane are generated from the role map and refused here
 * (`generated_only`): the role map is the one place who-holds-what is edited (DM §8 gap 3).
 */
export async function createBindingTx(
  deps: IdentityDeps,
  j: Journal,
  input: CreateBindingInput,
  actor: string,
  opts: { generated?: boolean; catalogue?: readonly RoleDef[] } = {},
): Promise<Result<Changed & { binding_id: string }, IdentityError>> {
  const catalogue = opts.catalogue ?? ROLE_CATALOGUE;
  const role = roleDef(input.role_id, catalogue);
  if (!role) return err(invalid(`unknown role ${input.role_id}`));
  if (!role.scope_kinds.includes(input.scope.kind)) {
    return err(invalid(`role ${role.role_id} cannot be bound at a ${input.scope.kind} scope`));
  }
  const generated = opts.generated === true;
  const slotScope = input.scope.kind === 'project' || input.scope.kind === 'lane';
  if (role.slot !== null && slotScope && !generated) {
    return err(
      identityError(
        'generated_only',
        `${role.role_id} at ${input.scope.kind} scope is generated from the project role map`,
      ),
    );
  }
  if (isRoleMapGroup(input.group_id) !== generated) {
    return err(
      identityError(
        generated ? 'invalid_input' : 'protected_group',
        generated
          ? 'a generated binding uses a generated group'
          : `${input.group_id} is generated; bind a group you own`,
      ),
    );
  }
  const now = clockOf(deps).now();
  const b = Binding.safeParse({
    binding_id: bindingIdFor(input.group_id, input.role_id, input.scope),
    group_id: input.group_id,
    role_id: input.role_id,
    scope: input.scope,
    constraints: input.constraints ?? {},
    expiry: input.expiry ?? null,
    m_gate_ref: input.m_gate_ref ?? null,
    config_rev: input.config_rev ?? null,
  });
  if (!b.success) return err(invalid(b.error.message));
  if (!generated && b.data.constraints['origin'] === ROLE_MAP_ORIGIN) {
    return err(invalid('constraint origin "role_map" is reserved for generated bindings'));
  }
  if (b.data.expiry !== null && Date.parse(b.data.expiry) <= now.getTime()) {
    return err(invalid('expiry is not in the future'));
  }
  const id = b.data.binding_id;
  await lockKeys(j.tx, [`binding:${id}`, `group:${input.group_id}`]);
  const g = await j.group(input.group_id);
  if (!g) return err(identityError('not_found', `no group ${input.group_id}`));
  const cur = await j.binding(id);
  if (cur && !cur.revoked) {
    return canonicalJson(cur.binding) === canonicalJson(b.data)
      ? ok({ ...unchanged, binding_id: id })
      : err(identityError('already_exists', `binding ${id} exists with other attributes`));
  }
  const r = await emit(j, bindingStream(id), IDENTITY_EVENT.binding_created, b.data, actor);
  return r.ok ? ok({ ...changed, binding_id: id }) : r;
}

export async function createBinding(
  deps: IdentityDeps,
  input: CreateBindingInput,
  actor: string,
): Promise<Result<Changed & { binding_id: string }, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => createBindingTx(deps, j, input, actor));
}

export async function revokeBindingTx(
  j: Journal,
  id: string,
  reason: string,
  actor: string,
  internal: boolean,
): Promise<Result<Changed, IdentityError>> {
  if (reason.trim() === '') return err(invalid('a reason is required'));
  await lockKeys(j.tx, [`binding:${id}`]);
  const cur = await j.binding(id);
  if (!cur) return err(identityError('not_found', `no binding ${id}`));
  if (cur.revoked) return ok(unchanged);
  if (!internal && cur.binding.constraints['origin'] === ROLE_MAP_ORIGIN) {
    return err(identityError('generated_only', 'a generated binding changes with the role map'));
  }
  const r = await emit(j, bindingStream(id), IDENTITY_EVENT.binding_revoked, { reason }, actor);
  return r.ok ? ok(changed) : r;
}

export async function revokeBinding(
  deps: IdentityDeps,
  id: string,
  reason: string,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  return inIdentityTx(deps, (j) => revokeBindingTx(j, id, reason, actor, false));
}

// ---------------------------------------------------------------- Teams

export async function createTeam(
  deps: IdentityDeps,
  input: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  const t = Team.safeParse(input);
  if (!t.success) return err(invalid(t.error.message));
  return inIdentityTx(deps, async (j) => {
    await lockKeys(j.tx, [`team:${t.data.team_id}`]);
    if (t.data.idp_group !== null && !(await j.group(t.data.idp_group))) {
      return err(identityError('not_found', `no group ${t.data.idp_group} to map the team to`));
    }
    const cur = await j.team(t.data.team_id);
    if (cur) {
      return canonicalJson(cur) === canonicalJson(t.data)
        ? ok(unchanged)
        : err(
            identityError('already_exists', `team ${t.data.team_id} exists with other attributes`),
          );
    }
    const r = await emit(j, teamStream(t.data.team_id), IDENTITY_EVENT.team_created, t.data, actor);
    return r.ok ? ok(changed) : r;
  });
}

export async function updateTeam(
  deps: IdentityDeps,
  id: string,
  changes: unknown,
  actor: string,
): Promise<Result<Changed, IdentityError>> {
  const a = actorOf(actor);
  if (!a.ok) return a;
  const u = TeamUpdatedPayload.safeParse(changes);
  if (!u.success) return err(invalid(u.error.message));
  return inIdentityTx(deps, async (j) => {
    await lockKeys(j.tx, [`team:${id}`]);
    const cur = await j.team(id);
    if (!cur) return err(identityError('not_found', `no team ${id}`));
    const actual: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(u.data)) {
      if ((cur as Record<string, unknown>)[k] !== v) actual[k] = v;
    }
    if (Object.keys(actual).length === 0) return ok(unchanged);
    const g = actual['idp_group'];
    if (typeof g === 'string' && !(await j.group(g))) {
      return err(identityError('not_found', `no group ${g} to map the team to`));
    }
    const r = await emit(j, teamStream(id), IDENTITY_EVENT.team_updated, actual, actor);
    return r.ok ? ok(changed) : r;
  });
}
