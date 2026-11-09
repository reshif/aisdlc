import { KillQuery } from '@aisdlc/contracts';
import { admitAgentWork, type KillStatePort } from '@aisdlc/ports';
import { newApp } from '@aisdlc/service-kit';
import type { LoopSupervisor } from '@aisdlc/loops';
import type { FastifyInstance } from 'fastify';

/**
 * `GET /healthz`: one aggregated answer. 200 while every loop is ok, starting or degraded; 503
 * while any loop has been failing for longer than its threshold, is stalled, or an alert is active
 * (dead-lettered outbox messages). The body names each loop and alert. `GET /metrics`: per-loop
 * Prometheus text. Neither takes a credential and neither returns anything read from a repo.
 *
 * `GET /admission?project_id=..&lane=..` (M9.6): the verdict this process would give agent work for
 * that scope right now, from the kill switch (an unreachable kill switch is `unreachable`, never
 * admitted). Read-only and on the internal network like the other two; the compose smoke test uses it.
 */
export function createCoreWorkerApp(
  supervisor: LoopSupervisor,
  o: { kill?: KillStatePort } = {},
): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async (_req, reply) => {
    const report = supervisor.health();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(supervisor.prometheus()),
  );
  app.get('/admission', async (req, reply) => {
    if (!o.kill) return reply.code(503).send({ error: 'no kill switch is configured' });
    const q = KillQuery.safeParse(req.query);
    if (!q.success) return reply.code(400).send({ error: q.error.message });
    const a = await admitAgentWork(o.kill, q.data);
    return reply.code(a.admitted ? 200 : 423).send(a);
  });
  return app;
}
