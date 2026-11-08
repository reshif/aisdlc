import {
  IDENTITY_EVENT,
  ROLE_CATALOGUE,
  ROLE_MAP_GROUP_PREFIX,
  ROLE_MAP_ORIGIN,
  bindingStream,
  groupStream,
  impliedBindings,
  type BindingSpec,
  type LedgerEntryId,
  type PrincipalId,
  type ProjectId,
  type RoleDef,
} from '@aisdlc/contracts';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import type { ProjectSettingsPort } from '@aisdlc/ports';
import {
  addMemberTx,
  createBindingTx,
  createGroupTx,
  removeMemberTx,
  revokeBindingTx,
} from './commands.js';
import { identityError, type IdentityError } from './errors.js';
import { lockKeys, type Journal } from './journal.js';
import { inIdentityTx, type IdentityDeps } from './tx.js';

// Role map -> bindings (PLAN M4.4, DM §8 gap 3). `impliedBindings` (contracts) says what the
// project's settings imply; this applies the difference to the journal as ordinary events, in one
// transaction, so each change is also an access ledger entry once the access-sync loop has run.
// Idempotent: running it twice, or on settings that already are in force, writes nothing.

export const ROLE_MAP_ACTOR = 'system.role_map';

export interface ReconcileDeps extends IdentityDeps {
  readonly settings: ProjectSettingsPort;
  readonly catalogue?: readonly RoleDef[];
}

export interface ReconcileInput {
  readonly project_id: ProjectId;
  /** Who published the change; default the system actor. The decision itself is the M1 gate's. */
  readonly actor?: string;
  /** The config revision (`rev_hash`) the settings came from, stamped on bindings made now. */
  readonly config_rev?: string | null;
  /** The ledger entry of the decision that approved the role map (M1, or M4 for onboarding). */
  readonly m_gate_ref?: LedgerEntryId | null;
}

export interface ReconcileReport {
  readonly project_id: ProjectId;
  readonly groups_created: number;
  readonly members_added: number;
  readonly members_removed: number;
  readonly bindings_created: number;
  readonly bindings_updated: number;
  readonly bindings_revoked: number;
  /** Journal events written; 0 when the project already matched its role map. */
  readonly events: number;
}

/** The generated bindings of a project that are in force now, read from the authoritative record. */
async function activeGenerated(j: Journal, project: string): Promise<Set<string>> {
  const q = await j.tx.query<{ stream: string }>(
    `SELECT DISTINCT stream FROM record.record_event
      WHERE type = $1 AND body -> 'constraints' ->> 'project_id' = $2
        AND body -> 'constraints' ->> 'origin' = $3`,
    [IDENTITY_EVENT.binding_created, project, ROLE_MAP_ORIGIN],
  );
  const out = new Set<string>();
  for (const r of q.rows) {
    const id = r.stream.slice('binding:'.length);
    const s = await j.binding(id);
    if (s && !s.revoked) out.add(id);
  }
  return out;
}

async function generatedGroups(j: Journal, project: string): Promise<string[]> {
  const q = await j.tx.query<{ stream: string }>(
    'SELECT stream FROM record.record_event WHERE type = $1 AND starts_with(stream, $2) ORDER BY stream',
    [IDENTITY_EVENT.group_created, groupStream(`${ROLE_MAP_GROUP_PREFIX}${project}.`)],
  );
  return q.rows.map((r) => r.stream.slice('group:'.length));
}

function counts() {
  return {
    groups_created: 0,
    members_added: 0,
    members_removed: 0,
    bindings_created: 0,
    bindings_updated: 0,
    bindings_revoked: 0,
  };
}

/**
 * Makes the journal's generated groups, memberships and bindings of `project_id` equal what its
 * settings imply. Refuses (and changes nothing) when the settings cannot be read, a delegation
 * reaches outside the project, a T2 project has two-person unlocked, or a role names a principal
 * the identity service does not know. Bindings and groups that the settings no longer imply are
 * revoked and emptied; nothing is ever deleted from the journal.
 */
export async function reconcileProject(
  deps: ReconcileDeps,
  input: ReconcileInput,
): Promise<Result<ReconcileReport, IdentityError>> {
  const view = await deps.settings.get(input.project_id);
  if (!view.ok) {
    return err(identityError('unavailable', `project settings: ${view.error.message}`, view.error));
  }
  const { settings, tier } = view.value;
  if (tier === 'T2' && !(settings.two_person.locked_on && settings.two_person.enabled)) {
    return err(identityError('refused', 'T2 locks two-person on; the settings do not'));
  }
  const catalogue = deps.catalogue ?? ROLE_CATALOGUE;
  const implied = impliedBindings(settings, catalogue);
  if (!implied.ok) {
    return err(identityError('refused', implied.error.violations.join('; '), implied.error));
  }
  const specs = implied.value;
  const actor = input.actor ?? ROLE_MAP_ACTOR;
  const project = input.project_id;

  return inIdentityTx(
    deps,
    async (j) => {
      const bindingIds = specs.map((s) => s.binding_id as string);
      await lockKeys(j.tx, [`reconcile:${project}`]);
      const existing = await activeGenerated(j, project);
      const groups = new Set([
        ...specs.map((s) => s.group_id as string),
        ...(await generatedGroups(j, project)),
      ]);
      await lockKeys(j.tx, [
        ...[...groups].map((g) => `group:${g}`),
        ...[...existing, ...bindingIds].map((b) => `binding:${b}`),
      ]);

      // Fail closed before writing anything: every named principal must exist and not be deleted.
      const named = new Set<PrincipalId>();
      for (const s of specs) for (const m of s.members ?? []) named.add(m);
      const missing: string[] = [];
      for (const id of [...named].sort()) {
        const p = await j.principal(id);
        if (!p || p.principal.status === 'deleted') missing.push(id);
      }
      if (missing.length > 0) {
        return err(
          identityError(
            'unknown_principal',
            `role map names unknown principals: ${missing.join(', ')}`,
            {
              principals: missing,
            },
          ),
        );
      }

      const c = counts();
      const before = j.appended;
      const desiredBindings = new Set(bindingIds);
      for (const spec of specs) {
        const r = await applySpec(deps, j, spec, actor, input, c);
        if (!r.ok) return r;
      }
      // Generated bindings the settings no longer imply (a revoked lane delegation, say), and their groups.
      for (const id of [...existing].sort()) {
        if (desiredBindings.has(id)) continue;
        const revoked = await revokeBindingTx(
          j,
          id,
          'no longer implied by the role map',
          actor,
          true,
        );
        if (!revoked.ok) return revoked;
        if (revoked.value.changed) c.bindings_revoked += 1;
      }
      const wanted = new Set(specs.map((s) => s.group_id as string));
      for (const g of [...groups].sort()) {
        if (wanted.has(g)) continue;
        const state = await j.group(g);
        for (const m of [...(state?.members.keys() ?? [])].sort()) {
          const r = await removeMemberTx(j, g, m, 'no longer implied by the role map', actor, true);
          if (!r.ok) return r;
          if (r.value.changed) c.members_removed += 1;
        }
      }
      return ok({ project_id: project, ...c, events: j.appended - before });
    },
    { exclusive: true },
  );
}

async function applySpec(
  deps: ReconcileDeps,
  j: Journal,
  spec: BindingSpec,
  actor: string,
  input: ReconcileInput,
  c: ReturnType<typeof counts>,
): Promise<Result<void, IdentityError>> {
  const g = await createGroupTx(
    j,
    { group_id: spec.group_id, display: spec.group_display, pim_managed: false, protected: true },
    actor,
    { generated: true },
  );
  if (!g.ok) return g;
  if (g.value.changed) c.groups_created += 1;

  if (spec.members !== null) {
    const state = await j.group(spec.group_id);
    const have = new Set(state?.members.keys() ?? []);
    for (const m of spec.members) {
      const r = await addMemberTx(
        deps,
        j,
        { group_id: spec.group_id, principal_id: m, source: 'role_map' },
        actor,
        true,
      );
      if (!r.ok) return r;
      if (r.value.changed) c.members_added += 1;
      have.delete(m);
    }
    for (const stale of [...have].sort()) {
      const r = await removeMemberTx(
        j,
        spec.group_id,
        stale,
        'no longer in the role map',
        actor,
        true,
      );
      if (!r.ok) return r;
      if (r.value.changed) c.members_removed += 1;
    }
  } else {
    // A `codeowners` slot has no generated members. Members left from when the slot was held by
    // named principals (source `role_map`) would keep its approval rights until a code owner sync
    // ran: remove them now (fail closed). Members the code owner sync set are left alone.
    const state = await j.group(spec.group_id);
    for (const [id, m] of [...(state?.members ?? [])].sort(([a], [b]) => (a < b ? -1 : 1))) {
      if (m.source !== 'role_map') continue;
      const r = await removeMemberTx(
        j,
        spec.group_id,
        id,
        'the slot is now held by code owners',
        actor,
        true,
      );
      if (!r.ok) return r;
      if (r.value.changed) c.members_removed += 1;
    }
  }

  const cur = await j.binding(spec.binding_id);
  if (cur && !cur.revoked) {
    if (canonicalJson(cur.binding.constraints) !== canonicalJson(spec.constraints)) {
      const r = await j.emit(
        bindingStream(spec.binding_id),
        IDENTITY_EVENT.binding_updated,
        { constraints: spec.constraints, config_rev: input.config_rev ?? cur.binding.config_rev },
        actor,
      );
      if (!r.ok) return r;
      c.bindings_updated += 1;
    }
    return ok(undefined);
  }
  const b = await createBindingTx(
    deps,
    j,
    {
      group_id: spec.group_id,
      role_id: spec.role_id,
      scope: spec.scope,
      constraints: spec.constraints as Record<string, unknown>,
      m_gate_ref: input.m_gate_ref ?? null,
      config_rev: input.config_rev ?? null,
    },
    actor,
    { generated: true, ...(deps.catalogue ? { catalogue: deps.catalogue } : {}) },
  );
  if (!b.ok) return b;
  if (b.value.changed) c.bindings_created += 1;
  return ok(undefined);
}
