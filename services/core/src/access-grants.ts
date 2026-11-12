import {
  ACCESS_GRANT_APPLIED_ENTRY,
  ACCESS_GRANT_EVENT,
  ACCESS_GRANT_ORIGIN,
  ACCESS_GRANT_STREAM_PREFIX,
  AccessBindingRow,
  AccessGrantAppliedPayload,
  AccessGrantProposedPayload,
  AccessGrantView,
  FACTORY_PROJECT_ID,
  ROLE_MAP_ORIGIN,
  Scope,
  accessGrantStream,
  accessProjectOf,
  isGrantableRole,
  scopeKey,
  type AccessChange,
  type AccessDecideResult,
  type AccessGrantStatus,
  type AccessOrigin,
  type AccessProposeResult,
  type LedgerEntryDraft,
  type PrincipalId,
  type ProjectId,
} from '@aisdlc/contracts';
import {
  DEFAULT_POLICY_BUNDLE_VERSION,
  decide,
  enterLedger,
  lockKey,
  openGate,
  prepare,
  readGateState,
  recordEvidenceViewed,
  type DecisionDeps,
  type GateState,
} from '@aisdlc/decisions';
import { freshReadModel, getPrincipal, queryGrants } from '@aisdlc/identity/read';
import {
  deterministicId,
  err,
  hashCanonical,
  newId,
  ok,
  sha256Hex,
  type Result,
} from '@aisdlc/kernel';
import { appendLedgerEntryTx } from '@aisdlc/ledger';
import type pg from 'pg';
import { decisionRefusal } from './cards/api.js';
import type { AccessGrantWriterPort } from './clients.js';
import { coreError, type CoreError } from './errors.js';
import { clockOf, inCoreLedgerTx, inCoreTx, lockKeys } from './journal.js';

// Granting and revoking role bindings (portal-review P1-6; portal-coverage §5 item 6 `access.manage`). The route asks
// the PDP for `access.manage` on the scope's resource first (or, for an access request, only that the person asks for
// themselves); this module checks the rest and never approves anything:
//
//   propose  the change is checked against identity's read model (a grantable role at a scope it may have, a person who
//            is active or a team with an IdP group, nothing already held; a revoke names a binding in force that is not
//            the role map's, and never the last factory admin binding), then an M1 gate (subject `access`) is opened at
//            the scope's admin slot: the project's, or the factory pseudo-project's (`factory.m1_policy`, fleet holders)
//            with its deciders narrowed to the slot's holders LESS the proposer and the person granted. So nobody decides
//            their own grant, no single-holder waiver applies, and a change nobody else can decide is refused at
//            propose. Then `access_grant.proposed` is recorded.
//   decide   prepare, evidence, decide on that gate (the kernel checks the slot, the deciders and the rest; the nonce
//            must be the grant's gate's and the person's own). An approval that ends the gate is applied at once.
//   apply    only for a gate decided approve on the ledger over exactly the proposal's hash: identity's `grant` scope
//            writes it (`m_gate_ref` = the approving entry), then one transaction takes the gate key, the ledger lock,
//            records `access_grant.applied` and writes the `access.grant_applied` ledger entry last (AGENTS.md lock
//            order). Idempotent: identity answers `changed: false` to a repeat, and the event is written once.
//
// BOOTSTRAP (P1-6): there is no exception for the first extra factory admin. A fleet grant is decided under the factory
// M1 rule, which never lets the proposer decide and allows no waiver (PLAN M15.5, §7a); with a single factory admin
// such a proposal has no decider and is refused. The specs name no bootstrap rule, so a second factory admin is made
// out of band (the seed, `SEED_FACTORY_ADMIN`), never from the portal.

export interface AccessDeps {
  readonly pool: pg.Pool;
  /** The decision kernel as core wires it (the factory pseudo-project answered from `factory.m1_policy`). */
  readonly decisions: DecisionDeps;
  /** Identity's `grant` scope; absent: proposals and decisions work, nothing is applied (`unavailable`). */
  readonly writer?: AccessGrantWriterPort | undefined;
}

const notFound = (m: string) => err(coreError('not_found', m));

interface BindingRow {
  readonly binding_id: string;
  readonly group_id: string;
  readonly role_id: string;
  readonly scope: Scope;
  readonly constraints: Record<string, unknown>;
  readonly expiry: string | null;
}

async function bindingRow(pool: pg.Pool, id: string): Promise<BindingRow | null> {
  const q = await pool.query<{
    binding_id: string;
    group_id: string;
    role_id: string;
    scope_kind: string;
    scope_ref: string;
    constraints: Record<string, unknown>;
    expiry: Date | null;
  }>(
    `SELECT binding_id, group_id, role_id, scope_kind, scope_ref, constraints, expiry
       FROM identity.binding WHERE binding_id = $1`,
    [id],
  );
  const r = q.rows[0];
  if (!r) return null;
  const scope = Scope.safeParse({ kind: r.scope_kind, ref: r.scope_ref });
  if (!scope.success) return null;
  return {
    binding_id: r.binding_id,
    group_id: r.group_id,
    role_id: r.role_id,
    scope: scope.data,
    constraints: r.constraints,
    expiry: r.expiry?.toISOString() ?? null,
  };
}

/** The person a change is about: the principal a grant names; nobody for a team or a revoke. */
const granteeOf = (c: AccessChange): PrincipalId | null =>
  c.op === 'grant' && c.target.kind === 'principal' ? c.target.principal_id : null;

/** What identifies a change, for refusing a second pending proposal of the same thing. */
const changeKey = (c: AccessChange): string =>
  c.op === 'grant'
    ? `grant:${c.target.kind === 'principal' ? `p:${c.target.principal_id}` : `t:${c.target.team_id}`}|${c.role_id}|${scopeKey(c.scope)}`
    : `revoke:${c.binding_id}`;

// ---------------------------------------------------------------- reads

interface Loaded {
  readonly proposed: AccessGrantProposedPayload;
  readonly applied: AccessGrantAppliedPayload | null;
}

async function loadGrants(db: pg.Pool | pg.PoolClient, id?: string): Promise<Loaded[]> {
  const q = await db.query<{ stream: string; type: string; body: unknown }>(
    `SELECT stream, type, body FROM record.record_event
      WHERE ${id === undefined ? 'starts_with(stream, $1)' : 'stream = $1'}
      ORDER BY global_seq`,
    [id === undefined ? ACCESS_GRANT_STREAM_PREFIX : accessGrantStream(id)],
  );
  const by = new Map<
    string,
    { proposed?: AccessGrantProposedPayload; applied?: AccessGrantAppliedPayload }
  >();
  for (const r of q.rows) {
    const cur = by.get(r.stream) ?? {};
    if (r.type === ACCESS_GRANT_EVENT.proposed)
      cur.proposed = AccessGrantProposedPayload.parse(r.body);
    if (r.type === ACCESS_GRANT_EVENT.applied)
      cur.applied = AccessGrantAppliedPayload.parse(r.body);
    by.set(r.stream, cur);
  }
  const out: Loaded[] = [];
  for (const v of by.values())
    if (v.proposed) out.push({ proposed: v.proposed, applied: v.applied ?? null });
  return out;
}

/** The approving decision of a gate over exactly `subjectHash`, or null. Gate status is read from the ledger only. */
function approvalOf(gs: GateState | null, l: Loaded) {
  if (!gs || gs.status !== 'decided' || gs.outcome !== 'approve') return null;
  const p = gs.open.payload;
  if (p.gate_id !== 'M1' || p.subject_kind !== 'access' || p.subject_id !== l.proposed.grant_id)
    return null;
  if (p.subject_hash !== l.proposed.subject_hash) return null;
  const ending = gs.decisions.find((x) => x.ledger_seq === gs.ended_ledger_seq) ?? null;
  return ending && ending.decision === 'approve' ? ending : null;
}

function statusOf(gs: GateState | null, l: Loaded): AccessGrantStatus {
  if (l.applied) return 'applied';
  if (!gs || gs.status === 'pending') return 'pending';
  if (gs.status === 'decided') return approvalOf(gs, l) ? 'approved' : 'rejected';
  return 'ended';
}

async function viewOf(d: AccessDeps, l: Loaded): Promise<AccessGrantView> {
  const gs = await readGateState(d.pool, l.proposed.gate_instance_id);
  const p = gs?.open.payload;
  let deciders: PrincipalId[] = [];
  if (p && gs?.status === 'pending') {
    const h = await d.decisions.eligibility.holders(p.project_id, 'admin');
    const only = new Set(p.deciders ?? []);
    if (h.ok) deciders = h.value.filter((x) => only.has(x) && !gs.approvers.includes(x));
  }
  return AccessGrantView.parse({
    grant_id: l.proposed.grant_id,
    change: l.proposed.change,
    origin: l.proposed.origin,
    reason: l.proposed.reason,
    proposed_by: l.proposed.proposed_by,
    project_id: l.proposed.project_id,
    gate_instance_id: l.proposed.gate_instance_id,
    subject_hash: l.proposed.subject_hash,
    gate_status: gs?.status ?? 'pending',
    outcome: gs?.outcome ?? null,
    status: statusOf(gs, l),
    deciders: [...deciders].sort(),
    quorum: p?.quorum.required ?? 1,
    proposed_at: l.proposed.at,
    applied: l.applied,
  });
}

export async function accessGrantView(
  d: AccessDeps,
  id: string,
): Promise<Result<AccessGrantView, CoreError>> {
  const [l] = await loadGrants(d.pool, id);
  return l ? ok(await viewOf(d, l)) : notFound(`no access grant ${id}`);
}

/** Every proposal, newest first; `keep` filters before the gate is read. */
export async function listAccessGrants(
  d: AccessDeps,
  keep: (p: AccessGrantProposedPayload) => Promise<boolean> | boolean = () => true,
): Promise<AccessGrantView[]> {
  const out: AccessGrantView[] = [];
  for (const l of (await loadGrants(d.pool)).reverse()) {
    if (await keep(l.proposed)) out.push(await viewOf(d, l));
  }
  return out;
}

/** The bindings in force at a scope (the fleet, or one project), with their members, for the People screen. */
export async function listBindings(
  pool: pg.Pool,
  scope: Scope,
): Promise<Result<AccessBindingRow[], CoreError>> {
  const fresh = await freshReadModel(pool);
  if (!fresh.ok) return err(coreError('unavailable', 'the identity read model is not current'));
  const q = await pool.query<{
    binding_id: string;
    group_id: string;
    role_id: string;
    scope_kind: string;
    scope_ref: string;
    constraints: Record<string, unknown>;
    expiry: Date | null;
    members: string[] | null;
  }>(
    `SELECT b.binding_id, b.group_id, b.role_id, b.scope_kind, b.scope_ref, b.constraints, b.expiry,
            (SELECT array_agg(m.principal_id ORDER BY m.principal_id) FROM identity.membership m
              WHERE m.group_id = b.group_id) AS members
       FROM identity.binding b
      WHERE b.scope_kind = $1 AND b.scope_ref = $2
      ORDER BY b.role_id, b.group_id`,
    [scope.kind, scope.ref],
  );
  return ok(
    q.rows.map((r) =>
      AccessBindingRow.parse({
        binding_id: r.binding_id,
        group_id: r.group_id,
        role_id: r.role_id,
        scope: { kind: r.scope_kind, ref: r.scope_ref },
        expiry: r.expiry?.toISOString() ?? null,
        origin:
          r.constraints['origin'] === ROLE_MAP_ORIGIN
            ? 'role_map'
            : r.constraints['origin'] === ACCESS_GRANT_ORIGIN
              ? 'access_grant'
              : 'other',
        members: r.members ?? [],
      }),
    ),
  );
}

// ---------------------------------------------------------------- propose

/** Checks a change against identity's read model; the M1 gate decides whether it happens. */
async function checkChange(d: AccessDeps, c: AccessChange): Promise<Result<void, CoreError>> {
  const fresh = await freshReadModel(d.pool);
  if (!fresh.ok) return err(coreError('unavailable', 'the identity read model is not current'));
  const now = clockOf(d.decisions).now();
  if (c.op === 'grant') {
    if (!isGrantableRole(c.role_id, c.scope.kind)) {
      return err(
        coreError(
          'invalid_input',
          `${c.role_id} at a ${c.scope.kind} scope is not granted here: a slot role changes with the project's role map (Project settings, card 4)`,
        ),
      );
    }
    if (c.expiry !== null && Date.parse(c.expiry) <= now.getTime()) {
      return err(coreError('invalid_input', 'the end date is not in the future'));
    }
    if (c.target.kind === 'principal') {
      const p = await getPrincipal(d.pool, c.target.principal_id);
      if (!p) return notFound(`no principal ${c.target.principal_id}`);
      if (p.status !== 'active') {
        return err(coreError('refused', `${c.target.principal_id} is ${p.status}`));
      }
      const held = await queryGrants(d.pool, { principal: c.target.principal_id }, null, now);
      if (
        held.some(
          (g) =>
            g.blockers.length === 0 &&
            g.role_id === c.role_id &&
            g.scope.kind === c.scope.kind &&
            g.scope.ref === c.scope.ref,
        )
      ) {
        return err(
          coreError('conflict', `${c.target.principal_id} already holds ${c.role_id} there`),
        );
      }
    } else {
      const t = await d.pool.query<{ idp_group: string | null }>(
        'SELECT idp_group FROM identity.team WHERE team_id = $1',
        [c.target.team_id],
      );
      const row = t.rows[0];
      if (!row) return notFound(`no team ${c.target.team_id}`);
      if (row.idp_group === null) {
        return err(coreError('refused', `team ${c.target.team_id} has no IdP group to bind`));
      }
      const have = await d.pool.query(
        `SELECT 1 FROM identity.binding WHERE group_id = $1 AND role_id = $2 AND scope_kind = $3 AND scope_ref = $4`,
        [row.idp_group, c.role_id, c.scope.kind, c.scope.ref],
      );
      if (have.rows.length > 0) {
        return err(
          coreError('conflict', `team ${c.target.team_id} already holds ${c.role_id} there`),
        );
      }
    }
    return ok(undefined);
  }
  const b = await bindingRow(d.pool, c.binding_id);
  if (!b) return notFound(`no binding ${c.binding_id} in force`);
  if (b.constraints['origin'] === ROLE_MAP_ORIGIN) {
    return err(
      coreError(
        'refused',
        "a role-map binding changes with the project's role map (Project settings, card 4)",
      ),
    );
  }
  if (b.scope.kind !== 'fleet' && b.scope.kind !== 'project') {
    return err(coreError('refused', `a binding at a ${b.scope.kind} scope is not revoked here`));
  }
  if (
    b.group_id !== c.group_id ||
    b.role_id !== c.role_id ||
    scopeKey(b.scope) !== scopeKey(c.scope)
  ) {
    return err(coreError('conflict', 'the binding is not what the revoke describes: reload it'));
  }
  if (b.role_id === 'factory.admin' && b.scope.kind === 'fleet') {
    const others = await d.pool.query(
      `SELECT 1 FROM identity.binding WHERE role_id = 'factory.admin' AND scope_kind = 'fleet' AND binding_id <> $1`,
      [b.binding_id],
    );
    if (others.rows.length === 0) {
      return err(coreError('refused', 'this is the last factory admin binding: it is not revoked'));
    }
  }
  return ok(undefined);
}

/**
 * Proposes a grant or a revoke (`origin: admin`, the route asked the PDP for `access.manage`) or records an access
 * request (`origin: request`, a grant for the proposer themselves). Opens its M1 gate; never decides it.
 */
export async function proposeAccess(
  d: AccessDeps,
  o: { by: PrincipalId; change: AccessChange; reason: string; origin: AccessOrigin },
): Promise<Result<AccessProposeResult, CoreError>> {
  if (o.origin === 'request' && granteeOf(o.change) !== o.by) {
    return err(coreError('invalid_input', 'an access request is for the person who asks'));
  }
  const checked = await checkChange(d, o.change);
  if (!checked.ok) return checked;
  const key = changeKey(o.change);
  for (const l of await loadGrants(d.pool)) {
    if (changeKey(l.proposed.change) !== key) continue;
    const gs = await readGateState(d.pool, l.proposed.gate_instance_id);
    if (gs?.status === 'pending') {
      return err(
        coreError('conflict', `the same change is already waiting (${l.proposed.grant_id})`),
      );
    }
  }
  const clock = clockOf(d.decisions);
  const scope = o.change.scope;
  const project: ProjectId = accessProjectOf(scope);
  const grantee = granteeOf(o.change);
  const holders = await d.decisions.eligibility.holders(project, 'admin');
  if (!holders.ok)
    return err(coreError('unavailable', `who decides it is unknown: ${holders.error.message}`));
  const deciders = [...new Set(holders.value)].filter((p) => p !== o.by && p !== grantee).sort();
  if (deciders.length === 0) {
    return err(
      coreError(
        'refused',
        project === FACTORY_PROJECT_ID
          ? 'nobody can decide this: a fleet change needs a factory admin other than the proposer and the person granted, and there is none (no bootstrap exception: a second factory admin is made with the seed)'
          : `nobody can decide this: the admin slot of ${project} has no holder other than the proposer and the person granted`,
      ),
    );
  }
  const grantId = newId<'AccessGrant'>(clock.nowMs()) as string;
  const subjectHash = hashCanonical({
    grant_id: grantId,
    change: o.change,
    origin: o.origin,
    reason: o.reason,
    proposed_by: o.by,
  });
  const opened = await openGate(d.decisions, {
    gate_id: 'M1',
    project_id: project,
    subject_kind: 'access',
    subject_id: grantId,
    subject_hash: subjectHash,
    requester: o.by,
    ...(grantee ? { authors: [grantee] } : {}),
    deciders,
    facts: { access_change: o.change as never, origin: o.origin },
  });
  if (!opened.ok) return err(decisionRefusal(opened.error));
  const gate = opened.value.gate_instance_id;
  const payload = AccessGrantProposedPayload.parse({
    grant_id: grantId,
    change: o.change,
    origin: o.origin,
    reason: o.reason,
    proposed_by: o.by,
    subject_hash: subjectHash,
    gate_instance_id: gate,
    project_id: project,
    at: clock.now().toISOString(),
  });
  const w = await inCoreTx({ pool: d.pool, clock }, async (j, tx) => {
    await lockKeys(tx, [`access_grant:${grantId}`]);
    const e = await j.emit(accessGrantStream(grantId), ACCESS_GRANT_EVENT.proposed, payload, o.by);
    return e.ok ? ok(undefined) : e;
  });
  if (!w.ok) return w;
  return ok({ grant_id: grantId, gate_instance_id: gate as never, deciders });
}

// ---------------------------------------------------------------- decide

async function grantGate(d: AccessDeps, id: string): Promise<Result<Loaded, CoreError>> {
  const [l] = await loadGrants(d.pool, id);
  return l ? ok(l) : notFound(`no access grant ${id}`);
}

export async function prepareAccess(
  d: AccessDeps,
  o: { grant_id: string; principal: PrincipalId },
) {
  const l = await grantGate(d, o.grant_id);
  if (!l.ok) return l;
  const p = await prepare(d.decisions, {
    gate_instance_id: l.value.proposed.gate_instance_id,
    principal: o.principal,
  });
  return p.ok
    ? ok({
        nonce: p.value.nonce,
        expires_at: p.value.expires_at,
        evidence_hash: p.value.evidence_hash,
      })
    : err(decisionRefusal(p.error));
}

/** The nonce must be one this person prepared on this grant's gate: never a nonce of another gate. */
async function nonceIsFor(d: AccessDeps, nonce: string, gate: string, principal: string) {
  const q = await d.pool.query<{ gate_instance_id: string; principal: string }>(
    'SELECT gate_instance_id::text AS gate_instance_id, principal FROM decisions.gate_nonce WHERE nonce_sha256 = $1',
    [sha256Hex(nonce)],
  );
  const r = q.rows[0];
  return r !== undefined && r.gate_instance_id === gate && r.principal === principal;
}

export async function recordAccessEvidence(
  d: AccessDeps,
  o: { grant_id: string; principal: PrincipalId; nonce: string; evidence_hash: string },
) {
  const l = await grantGate(d, o.grant_id);
  if (!l.ok) return l;
  if (!(await nonceIsFor(d, o.nonce, l.value.proposed.gate_instance_id, o.principal))) {
    return err(coreError('refused', 'that nonce is not yours for this grant'));
  }
  const r = await recordEvidenceViewed(d.decisions, {
    nonce: o.nonce,
    evidence_hash: o.evidence_hash,
  });
  return r.ok ? ok({ evidence_viewed: true as const }) : err(decisionRefusal(r.error));
}

export async function decideAccess(
  d: AccessDeps,
  o: { grant_id: string; principal: PrincipalId; nonce: string; decision: string },
): Promise<Result<AccessDecideResult, CoreError>> {
  const l = await grantGate(d, o.grant_id);
  if (!l.ok) return l;
  if (!(await nonceIsFor(d, o.nonce, l.value.proposed.gate_instance_id, o.principal))) {
    return err(coreError('refused', 'that nonce is not yours for this grant'));
  }
  const r = await decide(d.decisions, { nonce: o.nonce, decision: o.decision });
  if (!r.ok) return err(decisionRefusal(r.error));
  const after = r.value.after;
  let applied = false;
  let applyError: string | null = null;
  if (after.status === 'decided' && after.outcome === 'approve') {
    const a = await applyAccess(d, o.grant_id);
    applied = a.ok;
    applyError = a.ok ? null : a.error.message;
  }
  const v = await accessGrantView(d, o.grant_id);
  return ok({
    outcome: after.outcome,
    status: v.ok ? v.value.status : 'pending',
    applied,
    apply_error: applyError,
  });
}

// ---------------------------------------------------------------- apply

/** Writes what an approved M1 decided, through identity's `grant` scope, then records it. Idempotent. */
export async function applyAccess(
  d: AccessDeps,
  id: string,
): Promise<Result<AccessGrantAppliedPayload, CoreError>> {
  const got = await grantGate(d, id);
  if (!got.ok) return got;
  const l = got.value;
  if (l.applied) return ok(l.applied);
  const gate = l.proposed.gate_instance_id;
  const approval = approvalOf(await readGateState(d.pool, gate), l);
  if (!approval) return err(coreError('conflict', 'the grant is not approved on the ledger'));
  if (!d.writer) return err(coreError('unavailable', 'no identity grant writer is configured'));
  const c = l.proposed.change;
  const by = approval.actor as PrincipalId;
  const w =
    c.op === 'grant'
      ? await d.writer.grant({
          grant_id: id,
          target: c.target,
          role_id: c.role_id,
          scope: c.scope,
          expiry: c.expiry,
          m_gate_ref: approval.entry_id as never,
          on_behalf_of: by,
        })
      : await d.writer.revoke({
          grant_id: id,
          binding_id: c.binding_id,
          m_gate_ref: approval.entry_id as never,
          reason: l.proposed.reason,
          on_behalf_of: by,
        });
  if (!w.ok) return err(coreError('unavailable', `identity: ${w.error.message}`));
  const clock = clockOf(d.decisions);
  const body = AccessGrantAppliedPayload.parse({
    grant_id: id,
    gate_instance_id: gate,
    decision_entry_id: approval.entry_id,
    binding_id: w.value.binding_id,
    group_id: w.value.group_id,
    changed: w.value.changed,
    at: clock.now().toISOString(),
  });
  return inCoreLedgerTx({ pool: d.pool, clock, ledger: d.decisions.ledger }, async (j, tx) => {
    // the lock order: the gate key, the ledger lock, the record append, the ledger entry last
    await lockKey(tx, `gate:${gate}`);
    await lockKeys(tx, [`access_grant:${id}`]);
    const entered = await enterLedger(tx, d.decisions);
    if (!entered.ok) return err(coreError('unavailable', entered.error.message));
    const pending = [...entered.value];
    const have = (await j.events(accessGrantStream(id))).find(
      (e) => e.type === ACCESS_GRANT_EVENT.applied,
    );
    if (have) return ok({ value: AccessGrantAppliedPayload.parse(have.payload), pending });
    const e = await j.emit(accessGrantStream(id), ACCESS_GRANT_EVENT.applied, body, by);
    if (!e.ok) return e;
    const draft: LedgerEntryDraft = {
      entry_id: deterministicId<'LedgerEntry'>(`${ACCESS_GRANT_APPLIED_ENTRY}:${id}`) as never,
      entry_type: ACCESS_GRANT_APPLIED_ENTRY,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: 'access',
      subject_id: id as never,
      subject_hash: hashCanonical(body) as never,
      decision: null,
      actor: by,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: { kind: 'access_grant_applied', change: c, ...body } as never,
      created_at: body.at as never,
    };
    const le = await appendLedgerEntryTx(tx, d.decisions.ledger, draft);
    if (!le.ok) return err(coreError('unavailable', le.error.message));
    pending.push(...le.value.pending);
    return ok({ value: body, pending });
  });
}

/** Applies every approved grant identity has not written yet (a retry after identity was down). */
export async function applyApprovedAccess(
  d: AccessDeps,
): Promise<{ applied: string[]; failed: string[] }> {
  const applied: string[] = [];
  const failed: string[] = [];
  for (const l of await loadGrants(d.pool)) {
    if (l.applied) continue;
    if (!approvalOf(await readGateState(d.pool, l.proposed.gate_instance_id), l)) continue;
    const r = await applyAccess(d, l.proposed.grant_id);
    (r.ok ? applied : failed).push(l.proposed.grant_id);
  }
  return { applied, failed };
}
