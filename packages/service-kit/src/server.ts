import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import { OtlpExporter, carryTrace, instrumentApp, type TelemetryConfig } from './telemetry.js';

/** A Fastify instance with no logging noise; services add their routes. Bodies up to 8 MiB unless a service says more. */
export function newApp(opts: { bodyLimit?: number } = {}): FastifyInstance {
  return Fastify({ logger: false, bodyLimit: opts.bodyLimit ?? 8 * 1024 * 1024 });
}

/**
 * Listens on a loopback port (0 = any free port) and returns the base URL. With `telemetry` (from `listenConfig`, M19)
 * every request's server span and duration are exported to the OTLP collector, content-free.
 */
export async function listen(
  app: FastifyInstance,
  opts: { host?: string; port?: number; telemetry?: TelemetryConfig } = {},
): Promise<string> {
  // M19: with telemetry, a server span per request; without, the caller's trace is still carried on outbound calls
  if (opts.telemetry) instrumentApp(app, new OtlpExporter(opts.telemetry));
  else carryTrace(app);
  await app.listen({ host: opts.host ?? '127.0.0.1', port: opts.port ?? 0 });
  const addr = app.server.address();
  if (addr === null || typeof addr === 'string') throw new Error('server has no TCP address');
  const host = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  return `http://${host}:${addr.port}`;
}

/** The error body every service uses: `{error: {code, message}}`. */
export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ error: { code, message } });
}
