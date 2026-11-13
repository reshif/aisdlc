import {
  FACTORY_PROJECT_ID,
  RoleSlotValues,
  pdpResource,
  projectStream,
  roleMapGroupId,
  type ProjectId,
  repoKeyOf,
  type DeletionKind,
  type PdpResource,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';
import { coreError, type CoreError } from '../errors.js';
import {
  INDEPENDENT_STREAM_TYPES,
  PROJECT_STREAM_TYPES,
  type DeletionSpec,
  type DeletionTarget,
} from './engine.js';
import { isNeedle } from './match.js';

// Which object a `DELETE /v1/<kind>/:id` names, how the engine finds what is its (docs/specs/deletion.md §3), and the
// PDP resource its `<kind>.delete` is asked on. An object that does not exist is `not_found` (the screen's 404).

export interface ResolvedTarget extends DeletionTarget {
  readonly resource: PdpResource;
}

const independent = (t: string): boolean => !INDEPENDENT_STREAM_TYPES.includes(t);
const without = (xs: readonly string[], drop: readonly string[]) =>
  xs.filter((x) => !drop.includes(x));

const one = async (db: Executor, sql: string, args: unknown[]) =>
  (await db.query<Record<string, string>>(sql, args)).rows;

/** A project's roots: the project, its repos, and its role-map groups (`rm.<project>.<slot>`, the project's own). */
const projectSpec = (kind: DeletionKind, project: string, repos: string[]): DeletionSpec => ({
  kind,
  roots: [
    project,
    ...repos,
    ...RoleSlotValues.map((slot) => roleMapGroupId(project as ProjectId, slot) as string),
  ],
  expand: PROJECT_STREAM_TYPES,
  touch: independent,
  tables: 'all',
  ledger: 'full',
  alsoSweep: ['identity.grp'],
});

/** The repos of a project, from the read model and from the record (the read model may lag). */
async function reposOf(db: Executor, project: string): Promise<string[]> {
  const rm = await one(db, 'SELECT repo_key FROM core.repo WHERE project_id = $1', [project]);
  const rec = await one(
    db,
    `SELECT DISTINCT lower(body ->> 'repo') AS repo_key FROM record.record_event
      WHERE type = 's0.requested' AND body ->> 'project_id' = $1 AND body ? 'repo'`,
    [project],
  );
  return [...new Set([...rm, ...rec].map((r) => r['repo_key']).filter((x): x is string => !!x))];
}

export async function resolveTarget(
  db: Executor,
  kind: DeletionKind,
  id: string,
): Promise<Result<ResolvedTarget, CoreError>> {
  if (!isNeedle(id)) return err(coreError('invalid_input', 'not an id'));
  const missing = () => err(coreError('not_found', `no ${kind} ${id}`));
  switch (kind) {
    case 'project': {
      if (id === FACTORY_PROJECT_ID) {
        return err(coreError('invalid_input', 'the factory itself is not a project to delete'));
      }
      // The record says it exists (the read model may lag behind it).
      const p = await one(db, 'SELECT 1 AS x FROM record.record_event WHERE stream = $1 LIMIT 1', [
        projectStream(id),
      ]);
      if (p.length === 0) return missing();
      return ok({
        spec: projectSpec('project', id, await reposOf(db, id)),
        project: id,
        principal: null,
        resource: pdpResource.project(id),
      });
    }
    case 'repo': {
      const key = repoKeyOf(id);
      const r = await one(
        db,
        `SELECT body ->> 'project_id' AS project_id FROM record.record_event
          WHERE type = 's0.requested' AND lower(body ->> 'repo') = $1 ORDER BY global_seq LIMIT 1`,
        [key],
      );
      const project = r[0]?.['project_id'];
      if (!project) return missing();
      const siblings = await reposOf(db, project);
      // The project's only repo: the project goes with it (docs/design/screen-map.md §3).
      const spec: DeletionSpec =
        siblings.filter((x) => x !== key).length === 0
          ? projectSpec('repo', project, [key])
          : {
              kind: 'repo',
              roots: [key],
              expand: without(PROJECT_STREAM_TYPES, ['project', 'binding', 'control', 'banner']),
              touch: independent,
              tables: 'all',
              ledger: 'full',
            };
      return ok({ spec, project, principal: null, resource: pdpResource.repo(project, key) });
    }
    case 'item': {
      const r = await one(
        db,
        `SELECT body ->> 'project_id' AS project_id, body ->> 'lane' AS lane FROM record.record_event
          WHERE stream = $1 AND seq = 1`,
        [`item:${id}`],
      );
      const project = r[0]?.['project_id'];
      if (!project) return missing();
      return ok({
        spec: {
          kind: 'item',
          roots: [id],
          expand: without(PROJECT_STREAM_TYPES, [
            'project',
            'repo',
            's0',
            'prr',
            'census',
            'binding',
            'control',
            'banner',
          ]),
          touch: independent,
          tables: 'all',
          ledger: 'full',
        },
        project,
        principal: null,
        resource: pdpResource.item(project, id, r[0]?.['lane'] ?? null),
      });
    }
    case 'person': {
      const r = await one(
        db,
        'SELECT principal_id FROM identity.principal WHERE principal_id = $1',
        [id],
      );
      if (r.length === 0) return missing();
      return ok({
        spec: {
          kind: 'person',
          roots: [id],
          expand: [],
          touch: (t) => ['principal', 'group', 'notifier', 'notifier-pref'].includes(t),
          tables: ['identity', 'directory', 'bff', 'notifier'],
          ledger: 'person',
          alsoSweep: ['identity.principal', 'directory.principal'],
        },
        project: null,
        principal: id,
        resource: pdpResource.fleet(),
      });
    }
    case 'team': {
      const r = await one(db, 'SELECT team_id FROM identity.team WHERE team_id = $1', [id]);
      if (r.length === 0) return missing();
      return ok({
        spec: {
          kind: 'team',
          roots: [id],
          expand: [],
          touch: (t) => ['team', 'binding'].includes(t),
          tables: ['identity', 'directory'],
          ledger: 'none',
          alsoSweep: ['identity.team', 'directory.team'],
        },
        project: null,
        principal: null,
        resource: pdpResource.fleet(),
      });
    }
    case 'binding': {
      const r = await one(
        db,
        'SELECT scope_kind, scope_ref FROM identity.binding WHERE binding_id::text = $1',
        [id],
      );
      const b = r[0];
      if (!b) return missing();
      return ok({
        spec: {
          kind: 'binding',
          roots: [id],
          expand: [],
          touch: (t) => ['binding', 'access_grant'].includes(t),
          tables: ['identity'],
          ledger: 'full',
        },
        project: b['scope_kind'] === 'project' ? (b['scope_ref'] ?? null) : null,
        principal: null,
        resource:
          b['scope_kind'] === 'project' && b['scope_ref']
            ? pdpResource.project(b['scope_ref'])
            : pdpResource.fleet(),
      });
    }
  }
}
