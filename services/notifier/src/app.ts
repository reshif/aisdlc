import {
  NotificationChannelChoice,
  PrincipalId,
  SetPreferencesRequest,
  type NotificationChannelRow,
  type NotificationList,
  type NotificationPreferencesView,
} from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import type { LoopSupervisor } from '@aisdlc/loops';
import { newApp, sendError, type ServiceAuth } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { listNotifications, preferencesOf, setPreferences } from './store.js';

/**
 * The notifier's HTTP surface (docs/specs/notifier-api.md). `GET /healthz` and `GET /metrics` are the loops' health
 * (no credential). The rest is for the bff only (scope `people`), which passes the SIGNED-IN person in the path: the
 * notifier has no session of its own and no PDP, so it serves nobody but the bff, and the bff never lets a person name
 * another one. Nothing here decides, notifies or changes a channel: channels are config (M1).
 *
 *   GET  /v1/people/:principal/notifications?limit=   the person's notifications with their deliveries, newest first
 *   GET  /v1/people/:principal/preferences            their preferences and the channels they can choose from
 *   POST /v1/people/:principal/preferences            replace their preferences ({preferences})
 */
export type NotifierScope = 'people';

export interface NotifierAppOptions {
  readonly supervisor: LoopSupervisor;
  readonly pool: pg.Pool;
  readonly auth: ServiceAuth;
  readonly callers: Record<string, readonly NotifierScope[]>;
  readonly channels: () => NotificationChannelRow[] | null;
  readonly clock?: Clock;
}

const Limit = z.strictObject({ limit: z.coerce.number().int().min(1).max(200).optional() });

const choices = (rows: NotificationChannelRow[] | null): NotificationChannelChoice[] =>
  (rows ?? [])
    .filter((r) => r.enabled)
    .map((r) =>
      NotificationChannelChoice.parse({
        channel_id: r.channel_id,
        kind: r.kind,
        display_name: r.display_name,
        default_on: r.default_on,
        data_class_max: r.data_class_max,
      }),
    );

export function createNotifierApp(o: NotifierAppOptions): FastifyInstance {
  const app = newApp({ bodyLimit: 16 * 1024 });
  const clock = o.clock ?? systemClock;
  app.get('/healthz', async (_req, reply) => {
    const report = o.supervisor.health();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(o.supervisor.prometheus()),
  );
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = o.auth.authenticate(req.headers.authorization);
    if (caller === null)
      return sendError(reply, 401, 'unauthenticated', 'missing or unknown service token');
    if (!(o.callers[caller] ?? []).includes('people'))
      return sendError(reply, 403, 'forbidden', 'caller may not use scope people');
  });

  const principal = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const p = PrincipalId.safeParse((req.params as { principal?: string }).principal);
    if (p.success) return p.data;
    sendError(reply, 400, 'invalid_request', 'bad principal');
    return null;
  };

  app.get('/v1/people/:principal/notifications', async (req, reply) => {
    const who = principal(req, reply);
    if (who === null) return;
    const q = Limit.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_request', 'limit is 1..200');
    const out: NotificationList = {
      notifications: await listNotifications(o.pool, who, q.data.limit ?? 50),
    };
    return out;
  });

  const view = async (who: string): Promise<NotificationPreferencesView> => {
    const p = await preferencesOf(o.pool, who);
    return {
      principal_id: who as PrincipalId,
      preferences: p.preferences,
      set_at: p.set_at,
      channels: choices(o.channels()),
    };
  };

  app.get('/v1/people/:principal/preferences', async (req, reply) => {
    const who = principal(req, reply);
    if (who === null) return;
    return view(who);
  });

  app.post('/v1/people/:principal/preferences', async (req, reply) => {
    const who = principal(req, reply);
    if (who === null) return;
    const body = SetPreferencesRequest.safeParse(req.body);
    if (!body.success) return sendError(reply, 400, 'invalid_request', body.error.message);
    const chosen = body.data.preferences.channels;
    if (chosen !== null) {
      const known = new Set(choices(o.channels()).map((c) => c.channel_id));
      const unknown = chosen.filter((c) => !known.has(c));
      if (unknown.length > 0) {
        return sendError(reply, 400, 'unknown_channel', `no enabled channel ${unknown.join(', ')}`);
      }
    }
    await setPreferences(o.pool, who, body.data.preferences, clock);
    return view(who);
  });
  return app;
}
