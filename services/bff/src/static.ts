import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { FastifyInstance, FastifyReply } from 'fastify';

// The web bundle (`services/web`, built by Vite) as static files, same origin as the API: the
// browser holds one origin, one cookie and no CORS. The bff serves the files and nothing else
// of the web is trusted: the policy below is what makes a script injected into a page unable to
// run (no inline script, no remote script, no framing).

/** The policy of every HTML and asset response of the bff's web files. */
export const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

/** Paths that belong to the bff's own routes: an unknown one is a 404, never the app shell. */
const SERVER_PREFIXES = ['/api/', '/auth/', '/healthz'];

/**
 * A missing path that names a file of the bundle (P2-13): anything under `/assets/`, or a top-level name with
 * a type the bundle serves (`/favicon.ico`, `/robots.txt`). Every other path is a route of the single-page
 * app, dotted segments included (`/config/gateway.models`): the shell answers it and the router decides.
 */
export function looksLikeFile(path: string): boolean {
  if (path.startsWith('/assets/')) return true;
  const segments = path.split('/').filter((x) => x !== '');
  return segments.length === 1 && TYPES[extname(segments[0] as string)] !== undefined;
}

export function registerWebFiles(app: FastifyInstance, dir: string): void {
  const root = resolve(dir);

  async function send(reply: FastifyReply, file: string, shell: boolean) {
    const body = await readFile(file);
    reply
      .code(200)
      .header('content-type', TYPES[extname(file)] ?? 'application/octet-stream')
      .header('content-security-policy', WEB_CSP)
      // Hashed assets never change under their name; the shell must be fetched again.
      .header('cache-control', shell ? 'no-cache' : 'public, max-age=31536000, immutable');
    return reply.send(body);
  }

  app.setNotFoundHandler(async (req, reply) => {
    const path = req.url.split('?')[0] ?? '/';
    if (
      (req.method !== 'GET' && req.method !== 'HEAD') ||
      SERVER_PREFIXES.some((p) => path === p.replace(/\/$/, '') || path.startsWith(p))
    ) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such route' } });
    }
    let rel: string;
    try {
      rel = normalize(decodeURIComponent(path));
    } catch {
      return reply.code(400).send({ error: { code: 'invalid_input', message: 'bad path' } });
    }
    if (rel.includes('\0')) {
      return reply.code(400).send({ error: { code: 'invalid_input', message: 'bad path' } });
    }
    const file = join(root, rel);
    if (file !== root && !file.startsWith(root + sep)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such file' } });
    }
    const s = await stat(file).catch(() => null);
    if (s?.isFile()) return send(reply, file, extname(file) === '.html');
    if (looksLikeFile(path)) {
      return reply.code(404).send({ error: { code: 'not_found', message: 'no such file' } });
    }
    return send(reply, join(root, 'index.html'), true);
  });
}
