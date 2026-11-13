import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WEB_CSP } from '../src/static.js';
import { startBffStack, type BffStack } from '../src/testing.js';

let s: BffStack;
let dir: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-web-'));
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>shell</title>');
  writeFileSync(join(dir, 'assets', 'app-1a2b.js'), 'console.log(1)');
  writeFileSync(join(dir, '..', 'aisdlc-outside.txt'), 'secret');
  s = await startBffStack({ override: { webDir: dir } });
});
afterAll(async () => {
  await s.stop();
  rmSync(dir, { recursive: true, force: true });
  rmSync(join(dir, '..', 'aisdlc-outside.txt'), { force: true });
});

describe('the web bundle served by the bff', () => {
  it('serves the shell at / and at any route of the single-page app, with the strict policy', async () => {
    // P2-13: a dotted last segment (a config key) is a route too
    for (const path of [
      '/',
      '/projects/acme',
      '/s0/abc',
      '/config/gateway.models',
      '/config/project.role_map/',
      '/items/abc.def',
    ]) {
      const r = await fetch(`${s.base}${path}`);
      expect(r.status).toBe(200);
      expect(r.headers.get('content-type')).toMatch(/^text\/html/);
      expect(await r.text()).toContain('<title>shell</title>');
      const csp = r.headers.get('content-security-policy') as string;
      expect(csp).toBe(WEB_CSP);
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("frame-ancestors 'none'");
      expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*/);
      expect(r.headers.get('cache-control')).toBe('no-cache');
      expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    }
  });

  it('serves hashed assets as immutable, with their type, and 404s a missing file (not the shell)', async () => {
    const a = await fetch(`${s.base}/assets/app-1a2b.js`);
    expect(a.status).toBe(200);
    expect(a.headers.get('content-type')).toMatch(/^text\/javascript/);
    expect(a.headers.get('cache-control')).toMatch(/immutable/);
    expect((await fetch(`${s.base}/assets/gone.js`)).status).toBe(404);
    expect((await fetch(`${s.base}/assets/deep/gone.css`)).status).toBe(404);
    expect((await fetch(`${s.base}/favicon.ico`)).status).toBe(404);
    expect((await fetch(`${s.base}/robots.txt`)).status).toBe(404);
  });

  it('does not leave the directory, and does not serve the shell for the bff routes it does not have', async () => {
    for (const p of [
      '/..%2Faisdlc-outside.txt',
      '/%2e%2e/aisdlc-outside.txt',
      '/assets/..%2f..%2fx.js',
    ]) {
      const r = await fetch(`${s.base}${p}`);
      expect(await r.text()).not.toContain('secret');
      expect(r.status).not.toBe(200);
    }
    const nope = await fetch(`${s.base}/auth/nothing`);
    expect(nope.status).toBe(404);
    expect(((await nope.json()) as { error: { code: string } }).error.code).toBe('not_found');
    expect((await fetch(`${s.base}/api/nothing`)).status).toBe(401); // the API wants a session first
    expect((await fetch(`${s.base}/`, { method: 'POST' })).status).toBe(404);
  });

  it('keeps the API policy where it was: nothing may load from an API response', async () => {
    const r = await fetch(`${s.base}/healthz`);
    expect(r.headers.get('content-security-policy')).toBe(
      "default-src 'none'; frame-ancestors 'none'",
    );
    expect(r.headers.get('cache-control')).toBe('no-store');
  });
});
