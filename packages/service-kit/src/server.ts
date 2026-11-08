import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';

/** A Fastify instance with no logging noise; services add their routes. */
export function newApp(): FastifyInstance {
  return Fastify({ logger: false, bodyLimit: 8 * 1024 * 1024 });
}

/** Listens on a loopback port (0 = any free port) and returns the base URL. */
export async function listen(
  app: FastifyInstance,
  opts: { host?: string; port?: number } = {},
): Promise<string> {
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
