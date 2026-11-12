import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMirror } from '../src/index.js';

let dir: string;
let base: string;
let server: ReturnType<typeof createMirror>;
const get = (path: string, init?: RequestInit) => fetch(`${base}${path}`, init);

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mirror-'));
  mkdirSync(join(dir, 'simple'));
  writeFileSync(join(dir, 'simple', 'pkg-1.0-py3-none-any.whl'), 'wheel-bytes');
  writeFileSync(join(dir, 'secret-outside.txt'), 'outside');
  const root = join(dir, 'root');
  mkdirSync(root);
  mkdirSync(join(root, 'simple'));
  writeFileSync(join(root, 'simple', 'pkg-1.0-py3-none-any.whl'), 'wheel-bytes');
  mkdirSync(join(root, 'simple', 'pkg'));
  writeFileSync(
    join(root, 'simple', 'pkg', 'index.html'),
    '<a href="../pkg-1.0-py3-none-any.whl">pkg-1.0-py3-none-any.whl</a>',
  );
  symlinkSync(join(dir, 'secret-outside.txt'), join(root, 'link.txt'));
  symlinkSync(dir, join(root, 'dirlink'));
  server = createMirror({ root });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
});

describe('package mirror', () => {
  it('serves a fixed file and lists it with its hash', async () => {
    const r = await get('/simple/pkg-1.0-py3-none-any.whl');
    expect([r.status, await r.text()]).toEqual([200, 'wheel-bytes']);
    const idx = (await (await get('/index.json')).json()) as {
      files: Array<{ path: string; size: number }>;
    };
    expect(idx.files.map((f) => f.path)).toEqual([
      'simple/pkg-1.0-py3-none-any.whl',
      'simple/pkg/index.html',
    ]);
  });
  it('serves a PEP 503 project page from its index.html; a directory without one is still 404', async () => {
    const r = await get('/simple/pkg/');
    expect([r.status, r.headers.get('content-type')]).toEqual([200, 'text/html; charset=utf-8']);
    expect(await r.text()).toContain('pkg-1.0-py3-none-any.whl');
    expect((await get('/simple/none/')).status).toBe(404);
    expect((await get('/simple/')).status).toBe(404);
  });
  it('is read-only: any method but GET and HEAD is 405', async () => {
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      expect(
        (await get('/simple/x.whl', { method, ...(method === 'DELETE' ? {} : { body: 'x' }) }))
          .status,
        method,
      ).toBe(405);
    }
    expect((await get('/simple/pkg-1.0-py3-none-any.whl', { method: 'HEAD' })).status).toBe(200);
  });
  it('404s what is not there, a directory, a symlink and every traversal', async () => {
    for (const p of [
      '/nope.whl',
      '/simple',
      '/simple/',
      '/',
      '/link.txt',
      '/dirlink/secret-outside.txt',
      '/../secret-outside.txt',
      '/simple/../../secret-outside.txt',
      '/%2e%2e/secret-outside.txt',
      '/simple//x',
      '/etc/passwd',
    ]) {
      expect((await get(p)).status, p).toBe(404);
    }
  });
  it('an empty fixture set is a working, empty mirror (the state of this milestone)', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'mirror-empty-'));
    const s = createMirror({ root: empty });
    await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
    const b = `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    expect(((await (await fetch(`${b}/index.json`)).json()) as { files: unknown[] }).files).toEqual(
      [],
    );
    expect((await fetch(`${b}/simple/django/`)).status).toBe(404);
    expect((await fetch(`${b}/healthz`)).status).toBe(200);
    s.closeAllConnections();
    await new Promise((r) => s.close(r));
    rmSync(empty, { recursive: true, force: true });
  });
});
