import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readdir, realpath } from 'node:fs/promises';
import http from 'node:http';
import { join, resolve, sep } from 'node:path';

// The package mirror (PLAN M13.2; RV §2: "the ONLY egress a sandbox gets besides the gateway"). A tiny read-only
// HTTP server over one fixed directory: GET and HEAD, nothing else. No upstream fetch (it cannot reach the
// internet: it sits on internal networks only), no write, no listing outside `/index.json`, no symlink followed.
// The fixture set is empty for now; real wheels and npm tarballs are DEC-17.

export interface MirrorOptions {
  /** The directory served. Read at request time, never written. */
  readonly root: string;
  readonly log?: (line: string) => void;
}

const SAFE = /^\/[A-Za-z0-9_.@+~/-]*$/;
const TYPES: Record<string, string> = {
  '.json': 'application/json',
  '.html': 'text/html; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.whl': 'application/octet-stream',
  '.tgz': 'application/gzip',
  '.gz': 'application/gzip',
};

async function walk(root: string, rel = '', out: string[] = [], depth = 0): Promise<string[]> {
  if (depth > 8 || out.length > 10_000) return out;
  for (const e of await readdir(join(root, rel), { withFileTypes: true })) {
    if (e.isSymbolicLink()) continue;
    const r = rel === '' ? e.name : `${rel}/${e.name}`;
    if (e.isDirectory()) await walk(root, r, out, depth + 1);
    else if (e.isFile() && e.name !== 'README.md') out.push(r);
  }
  return out;
}

export function createMirror(opts: MirrorOptions): http.Server {
  const root = resolve(opts.root);
  const log = opts.log ?? (() => undefined);
  return http.createServer(async (req, res) => {
    const reply = (
      status: number,
      body: string,
      type = 'text/plain; charset=utf-8',
      extra: Record<string, string> = {},
    ) => {
      res.writeHead(status, {
        'Content-Type': type,
        'Content-Length': Buffer.byteLength(body),
        'X-Content-Type-Options': 'nosniff',
        ...extra,
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    };
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return reply(405, 'the mirror is read-only\n', 'text/plain', { Allow: 'GET, HEAD' });
      }
      const url = req.url ?? '/';
      const q = url.indexOf('?');
      const path = q === -1 ? url : url.slice(0, q);
      if (path === '/healthz') return reply(200, 'ok\n');
      if (path === '/index.json') {
        const names = (await walk(root)).sort();
        const files = [];
        for (const n of names) {
          const h = createHash('sha256');
          const s = createReadStream(join(root, n));
          for await (const c of s) h.update(c as Buffer);
          files.push({ path: n, size: (await lstat(join(root, n))).size, sha256: h.digest('hex') });
        }
        return reply(200, JSON.stringify({ files }), 'application/json');
      }
      if (
        !SAFE.test(path) ||
        path.includes('..') ||
        path.includes('//') ||
        path.endsWith('/') ||
        path === '/'
      ) {
        return reply(404, 'not found\n');
      }
      const full = join(root, path);
      if (full !== root && !full.startsWith(root + sep)) return reply(404, 'not found\n');
      const st = await lstat(full).catch(() => null);
      // a symlink is never followed, a directory is never listed
      if (!st || !st.isFile()) return reply(404, 'not found\n');
      if ((await realpath(full)) !== full) return reply(404, 'not found\n');
      const ext = path.slice(path.lastIndexOf('.'));
      res.writeHead(200, {
        'Content-Type': TYPES[ext] ?? 'application/octet-stream',
        'Content-Length': st.size,
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return void res.end();
      createReadStream(full).pipe(res);
    } catch (e) {
      log(`error ${req.url}: ${e instanceof Error ? e.message : String(e)}`);
      if (!res.headersSent) reply(500, 'error\n');
      else res.destroy();
    }
  });
}
