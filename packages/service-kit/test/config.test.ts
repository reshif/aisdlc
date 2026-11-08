import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  EXIT_CONFIG,
  ServiceConfigError,
  databaseUrl,
  httpUrlEnv,
  jsonEnv,
  listenConfig,
  requiredEnv,
  runService,
} from '../src/index.js';

describe('config helpers', () => {
  it('requiredEnv refuses missing and blank', () => {
    expect(requiredEnv({ A: 'x' }, 'A')).toBe('x');
    expect(() => requiredEnv({}, 'A')).toThrow(/A is required/);
    expect(() => requiredEnv({ A: '  ' }, 'A')).toThrow(ServiceConfigError);
  });

  it('listenConfig defaults, accepts 0, refuses a bad port', () => {
    expect(listenConfig({}, 'X', 8300)).toEqual({ host: '127.0.0.1', port: 8300 });
    expect(listenConfig({ X_HOST: '0.0.0.0', X_PORT: '0' }, 'X', 8300)).toEqual({
      host: '0.0.0.0',
      port: 0,
    });
    for (const bad of ['abc', '70000', '-1', '1.5']) {
      expect(() => listenConfig({ X_PORT: bad }, 'X', 1)).toThrow(/X_PORT/);
    }
  });

  it('jsonEnv reports bad JSON and bad shape as configuration errors', () => {
    const schema = z.record(z.string(), z.strictObject({ token_ref: z.string() }));
    expect(jsonEnv({ C: '{"a":{"token_ref":"env:T"}}' }, 'C', schema)).toEqual({
      a: { token_ref: 'env:T' },
    });
    expect(() => jsonEnv({ C: '{' }, 'C', schema)).toThrow(/C is not valid JSON/);
    expect(() => jsonEnv({ C: '{"a":{}}' }, 'C', schema)).toThrow(/^.*C:/);
    expect(() => jsonEnv({}, 'C', schema)).toThrow(/C is required/);
  });

  it('databaseUrl takes references and password-free URLs only', () => {
    const url = 'postgres://app:s3cretpassword@db/x';
    expect(databaseUrl({ D: 'env:U', U: url }, 'D')).toBe(url);
    expect(databaseUrl({ D: 'postgres://app@db/x' }, 'D')).toBe('postgres://app@db/x');
    expect(databaseUrl({ D: 'postgres://postgres@%2Ftmp%2Fs:5432/x' }, 'D')).toMatch(/^postgres:/);
    expect(() => databaseUrl({ D: url }, 'D')).toThrow(/contains a password/);
    expect(() => databaseUrl({ D: 'mysql://x' }, 'D')).toThrow(/must be env:NAME/);
    expect(() => databaseUrl({ D: 'env:NOPE' }, 'D')).toThrow(ServiceConfigError);
  });

  it('httpUrlEnv requires an http(s) URL', () => {
    expect(httpUrlEnv({ U: 'http://127.0.0.1:1' }, 'U')).toBe('http://127.0.0.1:1');
    expect(() => httpUrlEnv({ U: 'nope' }, 'U')).toThrow(/not a URL/);
    expect(() => httpUrlEnv({ U: 'ftp://x' }, 'U')).toThrow(/http\(s\)/);
  });
});

describe('runService', () => {
  const harness = () => {
    const lines: string[] = [];
    const exits: number[] = [];
    const handlers = new Map<string, () => void>();
    const deps = {
      log: (l: string) => lines.push(l),
      error: (l: string) => lines.push(`ERR ${l}`),
      exit: ((c: number) => {
        exits.push(c);
        return undefined as never;
      }) as (c: number) => never,
      proc: {
        once: (sig: string, fn: () => void) => handlers.set(sig, fn),
        on: (sig: string, fn: () => void) => handlers.set(sig, fn),
      } as unknown as Pick<NodeJS.Process, 'once' | 'on'>,
      shutdownTimeoutMs: 50,
    };
    return { lines, exits, handlers, deps };
  };
  const tick = () => new Promise((r) => setTimeout(r, 10));

  it('exits 78 with a clear message on a configuration error, 1 on any other failure', async () => {
    const a = harness();
    await runService('svc', () => Promise.reject(new ServiceConfigError('X is required')), a.deps);
    expect(a.exits).toEqual([EXIT_CONFIG]);
    expect(a.lines).toEqual(['ERR svc: configuration error: X is required']);
    const b = harness();
    await runService('svc', () => Promise.reject(new Error('boom')), b.deps);
    expect(b.exits).toEqual([1]);
  });

  it('closes once on SIGTERM and exits 0; a second signal exits 1 at once', async () => {
    const h = harness();
    let closes = 0;
    await runService(
      'svc',
      () =>
        Promise.resolve({
          url: 'http://x',
          close: async () => {
            closes += 1;
            await tick();
          },
        }),
      h.deps,
    );
    expect(h.lines[0]).toBe('svc listening on http://x');
    h.handlers.get('SIGTERM')?.();
    h.handlers.get('SIGINT')?.();
    expect(h.exits).toEqual([1]);
    await tick();
    await tick();
    expect(closes).toBe(1);
    expect(h.exits).toEqual([1, 0]);
  });

  it('exits 1 when close fails or hangs', async () => {
    const failing = harness();
    await runService(
      'svc',
      () => Promise.resolve({ url: 'u', close: () => Promise.reject(new Error('x')) }),
      failing.deps,
    );
    failing.handlers.get('SIGINT')?.();
    await tick();
    expect(failing.exits).toEqual([1]);

    const hung = harness();
    await runService(
      'svc',
      () => Promise.resolve({ url: 'u', close: () => new Promise<void>(() => undefined) }),
      hung.deps,
    );
    hung.handlers.get('SIGTERM')?.();
    await new Promise((r) => setTimeout(r, 120));
    expect(hung.exits).toEqual([1]);
  });
});
