import {
  NotificationList,
  NotificationPreferencesView,
  SetPreferencesRequest,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// A person's notifications and preferences (PLAN M18; docs/specs/notifier-api.md), in front of the notifier:
//
//   GET /api/me/notifications?limit=          what the notifier raised for the signed-in person, newest first; a
//                                             notification about a project they can no longer view is left out
//                                             (the PDP's `project.view`, asked now)
//   GET /api/me/notifications/preferences     their preferences and the channels they can choose
//   PUT /api/me/notifications/preferences     replace them ({preferences})
//
// The person is ALWAYS the session's: no route takes a principal, so nobody reads or changes another person's
// notifications. The notifier is best effort and never the record of what waits (the inbox is): when it is not
// configured or not reachable these routes answer 503/502 and nothing else in the portal is affected.

export interface NotificationRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly notifier: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

const Limit = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).optional() });

export function registerNotificationRoutes(d: NotificationRouteDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }

  const notifier = (reply: FastifyReply): CoreClient | null => {
    if (d.notifier) return d.notifier;
    sendError(reply, 503, 'notifier_not_configured', 'notifications are not configured');
    return null;
  };

  async function upstream<T>(
    reply: FastifyReply,
    c: CoreClient,
    method: 'GET' | 'POST',
    path: string,
    parse: (v: unknown) => T,
    body?: unknown,
  ): Promise<T | null> {
    const r = await c.call(method, path, body);
    if (!r.reached || r.status >= 500) {
      sendError(reply, 502, 'notifier_unavailable', 'the notifier could not answer');
      return null;
    }
    if (r.status < 200 || r.status >= 300) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      sendError(
        reply,
        r.status === 401 || r.status === 403 ? 502 : r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the request was refused',
      );
      return null;
    }
    try {
      return parse(r.json);
    } catch {
      sendError(reply, 502, 'notifier_error', 'the notifier sent something unexpected');
      return null;
    }
  }

  const me = (req: FastifyRequest) => encodeURIComponent(d.principalOf(req));

  app.get('/api/me/notifications', async (req, reply) => {
    const c = notifier(reply);
    if (!c) return;
    const q = Limit.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'limit is 1..200');
    const got = await upstream(
      reply,
      c,
      'GET',
      `/v1/people/${me(req)}/notifications?limit=${q.data.limit ?? 50}`,
      (v) => NotificationList.parse(v),
    );
    if (!got) return;
    const who = d.principalOf(req);
    const seen = new Map<string, boolean>();
    const out: NotificationList = { notifications: [] };
    for (const n of got.notifications) {
      const p = n.content.project_id;
      if (p !== null) {
        if (!seen.has(p)) seen.set(p, await allowed(who, 'project.view', pdpResource.project(p)));
        if (!seen.get(p)) continue;
      }
      out.notifications.push(n);
    }
    return out;
  });

  app.get('/api/me/notifications/preferences', async (req, reply) => {
    const c = notifier(reply);
    if (!c) return;
    return upstream(reply, c, 'GET', `/v1/people/${me(req)}/preferences`, (v) =>
      NotificationPreferencesView.parse(v),
    );
  });

  app.put('/api/me/notifications/preferences', async (req, reply) => {
    const c = notifier(reply);
    if (!c) return;
    const body = SetPreferencesRequest.safeParse(req.body ?? {});
    if (!body.success) return sendError(reply, 400, 'invalid_input', body.error.message);
    return upstream(
      reply,
      c,
      'POST',
      `/v1/people/${me(req)}/preferences`,
      (v) => NotificationPreferencesView.parse(v),
      body.data,
    );
  });
}
