import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FLEET_REF, ROLE_CATALOGUE, label, type RoleDef, type Scope } from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { adminApi, errorText, useOverride } from '../admin';
import type { Me } from '../api';
import { roleExplain, roleLabel, useProjectIds } from './shared';

// "Give a role" for a person or a team (screen map §2.13 Role assignments): the role, where it applies, an optional
// end date. It is written at once by identity when the PDP allows `access.manage` on that scope (the factory admin
// everywhere; a project admin on their project); the access-sync loop puts it in the decision log. A role of a
// project's role map (who decides its approvals) is changed in that project's settings instead.

const GIVABLE: readonly RoleDef[] = ROLE_CATALOGUE.filter(
  (r) => !r.service_only && r.scope_kinds.some((k) => k === 'fleet' || k === 'project'),
);

export function GiveRole({
  me,
  who,
  group,
  onDone,
}: {
  me: Me;
  /** "Nora Newbie", "the Payments team". */
  who: string;
  /** The group the role is given to (created when it does not exist yet). */
  group: (reason: string | undefined) => Promise<string>;
  onDone?: () => void;
}) {
  const id = useId();
  const qc = useQueryClient();
  const ov = useOverride();
  const projects = useProjectIds(me, 'access.manage');
  const [role, setRole] = useState(
    GIVABLE.find((r) => r.role_id === 'project.viewer')?.role_id ?? '',
  );
  const def = GIVABLE.find((r) => r.role_id === role);
  const kinds = (def?.scope_kinds ?? []).filter((k) => k === 'fleet' || k === 'project');
  const [kind, setKind] = useState<'fleet' | 'project'>('project');
  const scopeKind = kinds.includes(kind) ? kind : (kinds[0] ?? 'fleet');
  const [project, setProject] = useState('');
  const [until, setUntil] = useState('');
  const chosenProject = project || projects[0] || '';
  const scope: Scope | null =
    scopeKind === 'fleet'
      ? { kind: 'fleet', ref: FLEET_REF }
      : chosenProject
        ? { kind: 'project', ref: chosenProject }
        : null;
  const give = useMutation({
    mutationFn: () =>
      ov.ifNeeded(`Give the role as factory admin`, async (reason) => {
        if (!scope) throw new Error('Choose where the role applies.');
        const g = await group(reason);
        return adminApi.grant(
          {
            group_id: g,
            role_id: role,
            scope,
            expiry: until ? new Date(`${until}T23:59:59Z`).toISOString() : null,
          },
          me.csrf_token,
          reason,
        );
      }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['people'] });
      void qc.invalidateQueries({ queryKey: ['teams'] });
      onDone?.();
    },
  });
  return (
    <form
      className="adm-form"
      aria-label={`Give ${who} a role`}
      onSubmit={(e) => {
        e.preventDefault();
        give.mutate();
      }}
    >
      <div className="adm-form-row">
        <div>
          <label className="ui-label" htmlFor={`${id}-r`}>
            {label('concept', 'role')}
          </label>
          <select
            id={`${id}-r`}
            className="ui-select"
            value={role}
            onChange={(e) => setRole(e.target.value)}
            aria-describedby={`${id}-rh`}
          >
            {GIVABLE.map((r) => (
              <option key={r.role_id} value={r.role_id}>
                {roleLabel(r.role_id, r)}
              </option>
            ))}
          </select>
          <p id={`${id}-rh`} className="ui-help">
            {roleExplain(role, def)}
            {def?.slot ? ' Usually given through the project’s settings (who decides what).' : ''}
          </p>
        </div>
        <div>
          <label className="ui-label" htmlFor={`${id}-k`}>
            Where
          </label>
          <select
            id={`${id}-k`}
            className="ui-select"
            value={scopeKind}
            onChange={(e) => setKind(e.target.value as 'fleet' | 'project')}
          >
            {kinds.includes('project') ? <option value="project">One project</option> : null}
            {kinds.includes('fleet') ? (
              <option value="fleet">{label('concept', 'role_scope_fleet')}</option>
            ) : null}
          </select>
        </div>
      </div>
      <div className="adm-form-row">
        {scopeKind === 'project' ? (
          <div>
            <label className="ui-label" htmlFor={`${id}-p`}>
              {label('concept', 'project')}
            </label>
            {projects.length > 0 ? (
              <select
                id={`${id}-p`}
                className="ui-select"
                value={chosenProject}
                onChange={(e) => setProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${id}-p`}
                className="ui-input"
                value={project}
                placeholder="payments-api"
                onChange={(e) => setProject(e.target.value.trim())}
              />
            )}
          </div>
        ) : (
          <div />
        )}
        <div>
          <label className="ui-label" htmlFor={`${id}-u`}>
            Until (optional)
          </label>
          <input
            id={`${id}-u`}
            className="ui-input"
            type="date"
            value={until}
            onChange={(e) => setUntil(e.target.value)}
          />
        </div>
      </div>
      <div className="adm-acts">
        <button
          type="submit"
          className="ui-btn ui-btn-primary"
          disabled={give.isPending || !scope || role === ''}
        >
          Give role
        </button>
      </div>
      {give.isError && errorText(give.error) ? (
        <p className="ui-help ui-help-bad" role="alert">
          {errorText(give.error)}
        </p>
      ) : null}
      {give.isSuccess ? (
        <p className="ui-help" role="status">
          Given. It is in force now and in the decision log.
        </p>
      ) : null}
      {ov.dialog}
    </form>
  );
}
