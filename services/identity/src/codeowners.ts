import {
  roleMapGroupId,
  type PrincipalId,
  type ProjectId,
  type SetCodeownerMembersResult,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { ProjectSettingsPort } from '@aisdlc/ports';
import { addMemberTx, removeMemberTx } from './commands.js';
import { identityError, type IdentityError } from './errors.js';
import { lockKeys } from './journal.js';
import { inIdentityTx, type IdentityDeps } from './tx.js';

// Code owners -> the project's g4 group (PLAN M5.2, the M4.4 follow-up). When a project's g4 slot
// is `codeowners` the role map creates `rm.<project>.g4` with unmanaged membership: nobody holds
// it until this command runs. The codehost service reads CODEOWNERS at the default-branch head,
// maps the owners to principals through IdentityLink (`github_login`) and calls this with the
// result. The writer stays here: this is the only code that writes `codeowners` memberships.
//
// The command SETS the membership: the group ends up holding exactly `principals`. Nothing is added
// to the journal when it already does. It refuses, and changes nothing, when the project's settings
// cannot be read, when the g4 slot is held by named principals (the role map generates those), when
// the generated group does not exist yet (reconcile first), or when a principal is unknown.

export const CODEOWNERS_ACTOR = 'system.codeowners_sync';

export interface CodeownersDeps extends IdentityDeps {
  readonly settings: ProjectSettingsPort;
}

export interface SetCodeownerMembersInput {
  readonly project_id: ProjectId;
  readonly principals: readonly PrincipalId[];
  /** Where the owners were read, for the audit trail (`owner/name@sha`). */
  readonly source_ref: string;
}

export async function setCodeownerMembers(
  deps: CodeownersDeps,
  input: SetCodeownerMembersInput,
  actor: string = CODEOWNERS_ACTOR,
): Promise<Result<SetCodeownerMembersResult, IdentityError>> {
  const view = await deps.settings.get(input.project_id);
  if (!view.ok) {
    return err(identityError('unavailable', `project settings: ${view.error.message}`, view.error));
  }
  if (view.value.settings.role_map.g4.kind !== 'codeowners') {
    return err(
      identityError(
        'refused',
        `project ${input.project_id}: the g4 slot is held by named principals, not by code owners`,
      ),
    );
  }
  const group = roleMapGroupId(input.project_id, 'g4');
  const wanted = [...new Set(input.principals)].sort();

  return inIdentityTx(deps, async (j) => {
    await lockKeys(j.tx, [`group:${group}`]);
    const state = await j.group(group);
    if (!state) {
      return err(
        identityError('not_found', `group ${group} does not exist: reconcile the project first`),
      );
    }
    // Fail closed before writing anything: every principal must exist and not be deleted.
    const missing: string[] = [];
    for (const id of wanted) {
      const p = await j.principal(id);
      if (!p || p.principal.status === 'deleted') missing.push(id);
    }
    if (missing.length > 0) {
      return err(
        identityError('unknown_principal', `unknown principals: ${missing.join(', ')}`, {
          principals: missing,
        }),
      );
    }

    const have = new Map(state.members);
    const added: PrincipalId[] = [];
    const removed: PrincipalId[] = [];
    for (const id of wanted) {
      // Already held from this source: not written again (a re-add would only move `active_from`).
      if (have.get(id)?.source === 'codeowners') continue;
      const r = await addMemberTx(
        deps,
        j,
        { group_id: group, principal_id: id, source: 'codeowners' },
        actor,
        true,
      );
      if (!r.ok) return r;
      if (r.value.changed) added.push(id as PrincipalId);
    }
    const want = new Set<string>(wanted);
    for (const id of [...have.keys()].sort()) {
      if (want.has(id)) continue;
      const r = await removeMemberTx(
        j,
        group,
        id,
        `no longer a code owner (${input.source_ref})`.slice(0, 500),
        actor,
        true,
      );
      if (!r.ok) return r;
      if (r.value.changed) removed.push(id as PrincipalId);
    }
    return ok({
      project_id: input.project_id,
      group_id: group,
      members: wanted as PrincipalId[],
      added,
      removed,
    });
  });
}
