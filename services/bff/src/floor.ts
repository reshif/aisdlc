import {
  FleetView,
  FloorView,
  ProjectId,
  SandboxSlots,
  collapseFleetRow,
  cutFloorView,
  pdpResource,
  type FloorProject,
  type FloorSessions,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { CoreClient } from './core-client.js';
import type { Levels, RolesIn } from './levels.js';

// The floor (PLAN M19): `GET /api/floor/:project`. The PDP's `floor.read` on the project here (core asks again, and
// `item.view_floor` for each item), core's live read model, the sandbox-controller's sessions per class (unknown when
// it cannot be asked: never "free"), then the cut to the person's view level and data class (`cutFloorView`: a viewer
// sees positions, never a title). No binding in force reads as the lowest cut (V1, D0).
//
// Live updates are a poll with an ETag: the tag is the hash of the cut answer without its read time, so an unchanged
// floor answers `304` with no body. The answer says how fresh it is (`freshness`); the web shows a stale banner when
// the read model is behind or the poll fails, never data that only looks fresh.

export interface FloorRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  readonly sandboxController?: CoreClient;
  readonly principalOf: (req: FastifyRequest) => string;
  readonly levelsOf: (principal: string, project: string) => Promise<Levels | null>;
  /** Where the person holds a role (the fleet's cut: a confidential project is collapsed without one there). */
  readonly rolesOf: (principal: string) => Promise<RolesIn>;
}

/**
 * The fleet cut to one person (PLAN M19, DM FloorProject, FD-D6). Per project: a CONFIDENTIAL project the person holds
 * no role in is collapsed (its name and how many are in flight), shown to them only if they may view it or hold a
 * fleet role; any other project they may not view is left out (as if it did not exist); one they may view without
 * `floor.read` is collapsed too. Only `floor.read` with a role there (or an internal project) gives the full row.
 */
export async function cutFleet(
  rows: readonly FloorProject[],
  roles: RolesIn,
  may: (action: 'project.view' | 'floor.read', project: string) => Promise<boolean>,
): Promise<FloorProject[]> {
  const out: FloorProject[] = [];
  for (const r of rows) {
    const view = await may('project.view', r.project_id);
    if (r.classification === 'confidential' && !roles.projects.has(r.project_id)) {
      if (view || roles.fleet) out.push(collapseFleetRow(r, 'confidential'));
      continue;
    }
    if (!view) continue;
    out.push((await may('floor.read', r.project_id)) ? r : collapseFleetRow(r, 'no_floor_read'));
  }
  return out;
}

const LOWEST: Levels = { view_level: 'V1', data_class: 'D0' };

/** The ETag of a floor answer: what a person sees, without the instant it was read. */
export const floorEtag = (v: FloorView): string =>
  `"${hashCanonical({ ...v, freshness: { ...v.freshness, read_at: null } })}"`;

async function sessionsOf(sc: CoreClient | undefined): Promise<FloorSessions | null> {
  if (!sc) return null;
  const r = await sc.call('GET', '/v1/slots');
  if (!r.reached || r.status !== 200) return null;
  const p = SandboxSlots.safeParse(r.json);
  if (!p.success) return null;
  return {
    caps: p.data.caps,
    caps_source: p.data.caps_source,
    used: p.data.used,
    free: p.data.free,
  };
}

export function registerFloorRoutes(d: FloorRouteDeps): void {
  d.app.get('/api/fleet', async (req, reply) => {
    const principal = d.principalOf(req);
    if (!d.core) return sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
    const r = await d.core.call('GET', '/v1/fleet');
    if (!r.reached) {
      return sendError(reply, 502, 'core_unavailable', 'the factory core could not be reached');
    }
    if (r.status !== 200)
      return sendError(reply, 502, 'core_error', 'the factory core could not answer');
    const got = FleetView.safeParse(r.json);
    if (!got.success) {
      return sendError(reply, 502, 'core_error', 'the factory core sent something unexpected');
    }
    let roles: RolesIn;
    try {
      roles = await d.rolesOf(principal);
    } catch {
      roles = { fleet: false, projects: new Set() };
    }
    const may = async (action: 'project.view' | 'floor.read', project: string) => {
      try {
        return (
          (
            await d.pdp.decide(
              { principal, action, resource: pdpResource.project(project as never) },
              { log: false },
            )
          ).decision === 'allow'
        );
      } catch {
        return false;
      }
    };
    const out: FleetView = {
      ...got.data,
      projects: await cutFleet(got.data.projects, roles, may),
      sessions: await sessionsOf(d.sandboxController),
    };
    reply.header('cache-control', 'no-cache');
    return out;
  });

  d.app.get('/api/floor/:project', async (req, reply) => {
    const project = ProjectId.safeParse((req.params as { project: string }).project);
    if (!project.success) return sendError(reply, 400, 'invalid_input', 'bad project id');
    const principal = d.principalOf(req);
    let allow: boolean;
    try {
      allow =
        (
          await d.pdp.decide({
            principal,
            action: 'floor.read',
            resource: pdpResource.project(project.data),
          })
        ).decision === 'allow';
    } catch {
      allow = false;
    }
    if (!allow) return sendError(reply, 403, 'forbidden', 'floor.read denied');
    if (!d.core) return sendError(reply, 503, 'core_not_configured', 'the bff has no core to call');
    const q = new URLSearchParams({ on_behalf_of: principal }).toString();
    const r = await d.core.call('GET', `/v1/floor/${encodeURIComponent(project.data)}?${q}`);
    if (!r.reached) {
      return sendError(reply, 502, 'core_unavailable', 'the factory core could not be reached');
    }
    if (r.status >= 500) {
      return sendError(reply, 502, 'core_error', 'the factory core could not answer');
    }
    if (r.status !== 200) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      return sendError(
        reply,
        r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the request was refused',
      );
    }
    const got = FloorView.safeParse(r.json);
    if (!got.success || got.data.project_id !== project.data) {
      return sendError(reply, 502, 'core_error', 'the factory core sent something unexpected');
    }
    let lv: Levels | null;
    try {
      lv = await d.levelsOf(principal, project.data);
    } catch {
      lv = null;
    }
    const { view_level, data_class } = lv ?? LOWEST;
    const view = cutFloorView(
      { ...got.data, sessions: await sessionsOf(d.sandboxController) },
      view_level,
      data_class,
    );
    const etag = floorEtag(view);
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return view;
  });
}
