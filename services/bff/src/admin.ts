import {
  DELETION_ROUTES,
  DeletionKindValues,
  DeletionKind,
  type DeletionKind as Kind,
} from '@aisdlc/contracts';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// Portal v2's admin lifecycle through the bff (docs/design/screen-map.md §3, N19, N26; docs/specs/deletion.md). The bff
// carries the signed-in person's act and decides nothing itself: core asks the PDP `<kind>.delete` for the person and
// runs the deletion; identity asks the PDP `identity.admin` / `access.manage` for every write. The override reason, when
// the person gives one, travels on in its header (`override.ts`).
//
//   POST   /api/deletions/preview          {kind, id}            what would go, what blocks it
//   DELETE /api/<projects|repos|items|people|teams|bindings>/:id  {reason, confirm}   delete it
//   POST   /api/people                     {principal}           create a person          (identity, scope admin)
//   POST   /api/people/:id/update          {changes}             edit
//   POST   /api/people/:id/status          {status, reason}      suspend or reactivate
//   POST   /api/teams                      {team}                create a team
//   POST   /api/groups                     {group}               create a group
//   POST   /api/groups/:id/members         {principal_id, ...}   add a member
//   POST   /api/groups/:id/members/remove  {principal_id, reason} remove a member
//   POST   /api/bindings                   {group_id, role_id, scope, ...}   grant a role
//   POST   /api/bindings/:id/revoke        {reason}              revoke it

export interface AdminRouteDeps {
  readonly app: FastifyInstance;
  readonly core: CoreClient | undefined;
  /** Identity's API with scope `admin`; absent: the people, team and binding writes answer 503. */
  readonly identity: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

const PreviewBody = z.strictObject({ kind: DeletionKind, id: z.string().min(1).max(256) });
const DeleteBody = z.strictObject({
  reason: z.string().min(1).max(2000),
  confirm: z.string().min(1).max(256),
});
const AnyBody = z.record(z.string(), z.unknown());

/** The identity writes the portal makes, as `bff path -> identity path`. */
const IDENTITY_WRITES: ReadonlyArray<readonly [string, (p: Record<string, string>) => string]> = [
  ['/api/people', () => '/v1/principals'],
  ['/api/people/:id/update', (p) => `/v1/principals/${enc(p['id'])}/update`],
  ['/api/people/:id/status', (p) => `/v1/principals/${enc(p['id'])}/status`],
  ['/api/teams', () => '/v1/teams'],
  ['/api/groups', () => '/v1/groups'],
  ['/api/groups/:id/members', (p) => `/v1/groups/${enc(p['id'])}/members`],
  ['/api/groups/:id/members/remove', (p) => `/v1/groups/${enc(p['id'])}/members/remove`],
  ['/api/bindings', () => '/v1/bindings'],
  ['/api/bindings/:id/revoke', (p) => `/v1/bindings/${enc(p['id'])}/revoke`],
];

const enc = (s: string | undefined): string => encodeURIComponent(s ?? '');

export function registerAdminRoutes(d: AdminRouteDeps): void {
  const { app } = d;

  /** An upstream answer as the browser's: its status and its error code and message, never more. */
  function relay(reply: FastifyReply, r: CallResult, name: string) {
    if (!r.reached)
      return sendError(reply, 502, `${name}_unavailable`, `${name} could not be reached`);
    if (r.status >= 500 && r.status !== 503) {
      return sendError(reply, 502, `${name}_error`, `${name} could not answer`);
    }
    if (r.status < 200 || r.status >= 300) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      return sendError(
        reply,
        r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the request was refused',
      );
    }
    return reply.code(r.status).send(r.json);
  }

  app.post('/api/deletions/preview', async (req, reply) => {
    if (!d.core)
      return sendError(reply, 503, 'core_not_configured', 'the bff has no route to core');
    const b = PreviewBody.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    const r = await d.core.call('POST', '/v1/deletions/preview', {
      ...b.data,
      on_behalf_of: d.principalOf(req),
    });
    return relay(reply, r, 'core');
  });

  for (const kind of DeletionKindValues as readonly Kind[]) {
    app.delete(`/api/${DELETION_ROUTES[kind]}/:id`, async (req, reply) => {
      if (!d.core) {
        return sendError(reply, 503, 'core_not_configured', 'the bff has no route to core');
      }
      const id = (req.params as { id: string }).id;
      const b = DeleteBody.safeParse(req.body ?? {});
      if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
      const r = await d.core.call('DELETE', `/v1/${DELETION_ROUTES[kind]}/${enc(id)}`, {
        ...b.data,
        on_behalf_of: d.principalOf(req),
      });
      return relay(reply, r, 'core');
    });
  }

  for (const [path, upstream] of IDENTITY_WRITES) {
    app.post(path, async (req, reply) => {
      if (!d.identity) {
        return sendError(reply, 503, 'identity_not_configured', 'the bff has no route to identity');
      }
      const b = AnyBody.safeParse(req.body ?? {});
      if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
      // the person is the session's, never the body's
      const { on_behalf_of: _ignored, ...rest } = b.data;
      void _ignored;
      const r = await d.identity.call('POST', upstream(req.params as Record<string, string>), {
        ...rest,
        on_behalf_of: d.principalOf(req),
      });
      return relay(reply, r, 'identity');
    });
  }
}
