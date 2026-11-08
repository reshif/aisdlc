import { newApp } from '@aisdlc/service-kit';
import type { LoopSupervisor } from '@aisdlc/loops';
import type { FastifyInstance } from 'fastify';

/**
 * `GET /healthz`: one aggregated answer. 200 while every loop is ok, starting or degraded; 503
 * while any loop has been failing for longer than its threshold, is stalled, or an alert is active
 * (dead-lettered outbox messages). The body names each loop and alert. `GET /metrics`: per-loop
 * Prometheus text. Neither takes a credential and neither returns anything read from a repo.
 */
export function createCoreWorkerApp(supervisor: LoopSupervisor): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async (_req, reply) => {
    const report = supervisor.health();
    return reply.code(report.status === 'ok' ? 200 : 503).send(report);
  });
  app.get('/metrics', async (_req, reply) =>
    reply.type('text/plain; version=0.0.4').send(supervisor.prometheus()),
  );
  return app;
}
