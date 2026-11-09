import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_LABEL } from '@aisdlc/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DockerProxy } from '../src/index.js';
import { cfg, validBody } from './helpers.js';

// The proxy against a stub daemon: what the stub never sees, the proxy never sent. No Docker needed.

interface Seen {
  method: string;
  url: string;
  body: string;
  headers: http.IncomingHttpHeaders;
}
let dir: string;
let daemon: http.Server;
let seen: Seen[] = [];
let containers: Record<string, { Config: { Labels: Record<string, string> } }> = {};
let networks: Record<string, { Labels: Record<string, string>; Internal: boolean }> = {};
let listing: Array<{ State: string; Labels: Record<string, string> }> = [];
let proxy: DockerProxy;
let sock: string;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'dockerproxy-'));
  const daemonSock = join(dir, 'daemon.sock');
  daemon = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    seen.push({
      method: req.method ?? '',
      url: req.url ?? '',
      body: Buffer.concat(chunks).toString(),
      headers: req.headers,
    });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    const u = req.url ?? '';
    let m: RegExpExecArray | null;
    if (u === '/_ping') return json(200, 'OK');
    if (u.startsWith('/containers/json')) return json(200, listing);
    if ((m = /^\/containers\/([^/?]+)\/json$/.exec(u))) {
      const c = containers[m[1] as string];
      return c ? json(200, c) : json(404, { message: 'no such container' });
    }
    if ((m = /^\/networks\/([^/?]+)$/.exec(u)) && req.method === 'GET') {
      const n = networks[m[1] as string];
      return n ? json(200, n) : json(404, { message: 'no such network' });
    }
    return json(201, { Id: 'abc' });
  });
  await new Promise<void>((r) => daemon.listen(daemonSock, r));
  sock = join(dir, 'proxy.sock');
  proxy = new DockerProxy({ policy: cfg(), upstream: { socketPath: daemonSock } });
  await proxy.listen({ socketPath: sock });
});
afterAll(async () => {
  await proxy.close();
  await new Promise((r) => daemon.close(r));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  listing = [];
  containers = {
    'aisdlc-sbx-sess-000001': { Config: { Labels: { [SANDBOX_LABEL.sandbox]: '1' } } },
    postgres: { Config: { Labels: {} } },
    'aisdlc-gateway': { Config: { Labels: { [SANDBOX_LABEL.peer]: 'gateway' } } },
    'aisdlc-package-mirror': { Config: { Labels: { [SANDBOX_LABEL.peer]: 'mirror' } } },
  };
  networks = {
    'aisdlc-sbx-net-sess-000001': { Labels: { [SANDBOX_LABEL.sandbox]: '1' }, Internal: true },
    'aisdlc-sbx-net-sess-000002': { Labels: {}, Internal: true },
    'aisdlc-sbx-net-sess-000003': { Labels: { [SANDBOX_LABEL.sandbox]: '1' }, Internal: false },
  };
});

function call(
  method: string,
  url: string,
  body?: string | Buffer,
  headers: Record<string, string> = {},
) {
  return new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = http.request(
      {
        socketPath: sock,
        method,
        path: url,
        headers: {
          ...(body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {}),
          ...headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}
const json = (body: unknown) => JSON.stringify(body);
const JSON_H = { 'Content-Type': 'application/json' };
const nonInspect = () => seen.filter((s) => !/\/json(\?|$)/.test(s.url) || s.method !== 'GET');

describe('what reaches the daemon', () => {
  it('nothing, for exec, build, pull, volumes, info and the rest', async () => {
    const calls: Array<[string, string]> = [
      ['POST', '/containers/aisdlc-sbx-sess-000001/exec'],
      ['POST', '/exec/abcdef123456/start'],
      ['POST', '/build'],
      ['POST', '/images/create?fromImage=alpine'],
      ['GET', '/images/json'],
      ['POST', '/volumes/create'],
      ['GET', '/info'],
      ['GET', '/version'],
      ['POST', '/containers/prune'],
      ['POST', '/containers/aisdlc-sbx-sess-000001/attach'],
      ['POST', '/containers/aisdlc-sbx-sess-000001/update'],
      ['POST', '/swarm/init'],
      ['POST', '/session'],
    ];
    for (const [m, u] of calls) {
      const r = await call(m, u, m === 'POST' ? '{}' : undefined, JSON_H);
      expect(r.status, `${m} ${u}`).toBe(403);
    }
    expect(seen).toEqual([]);
  });

  it('refuses a Privileged create with 403 and says why; the daemon never sees it', async () => {
    const b = validBody('K');
    b.HostConfig.Privileged = true;
    const r = await call('POST', '/containers/create?name=aisdlc-sbx-sess-000001', json(b), JSON_H);
    expect(r.status).toBe(403);
    expect(r.body).toMatch(/privileged/i);
    expect(seen).toEqual([]);
  });

  it("forwards a valid create as the proxy's own rebuild, with rebuilt headers", async () => {
    // duplicate key (last wins in both parsers) and odd spacing: the daemon must get the re-serialised body
    const raw = JSON.stringify(validBody('K')).replace('{"Image"', '{ "Image":"x", "Image"');
    const r = await call('POST', '/containers/create?name=aisdlc-sbx-sess-000001', raw, {
      ...JSON_H,
      'X-Registry-Auth': 'abc',
      Authorization: 'Bearer x',
    });
    expect(r.status).toBe(201);
    const create = seen.find((s) => s.url.startsWith('/containers/create'));
    expect(create?.url).toBe('/containers/create?name=aisdlc-sbx-sess-000001');
    expect(create?.body).not.toBe(raw);
    expect(JSON.parse(create?.body ?? '{}').HostConfig.CapDrop).toEqual(['ALL']);
    expect(create?.headers['x-registry-auth']).toBeUndefined();
    expect(create?.headers['authorization']).toBeUndefined();
  });

  it('refuses a body that is not JSON, a wrong content type and an oversize body', async () => {
    expect(
      (await call('POST', '/containers/create?name=aisdlc-sbx-sess-000001', '{nope', JSON_H))
        .status,
    ).toBe(400);
    expect(
      (
        await call('POST', '/containers/create?name=aisdlc-sbx-sess-000001', json(validBody()), {
          'Content-Type': 'text/plain',
        })
      ).status,
    ).toBe(415);
    expect(
      (
        await call(
          'POST',
          '/containers/create?name=aisdlc-sbx-sess-000001',
          'x'.repeat(70_000),
          JSON_H,
        )
      ).status,
    ).toBe(413);
    expect(seen).toEqual([]);
  });

  it('refuses an HTTP upgrade (attach and exec need one)', async () => {
    const status = await new Promise<string>((resolve) => {
      const s = net.connect(sock);
      s.on('data', (d) => {
        resolve(String(d).split('\r\n')[0] as string);
        s.destroy();
      });
      s.write(
        'POST /containers/aisdlc-sbx-sess-000001/attach HTTP/1.1\r\nHost: x\r\nConnection: Upgrade\r\nUpgrade: tcp\r\nContent-Length: 0\r\n\r\n',
      );
    });
    expect(status).toMatch(/403/);
    expect(seen).toEqual([]);
  });
});

describe('ownership: a verb on a container or network needs the sandbox label', () => {
  it('start, kill, logs and delete work on a sandbox and are refused on anything else', async () => {
    for (const [m, v] of [
      ['POST', 'start'],
      ['POST', 'kill'],
      ['GET', 'logs?stdout=1'],
      ['POST', 'wait'],
    ] as const) {
      expect((await call(m, `/containers/aisdlc-sbx-sess-000001/${v}`)).status, v).toBe(201);
    }
    expect((await call('DELETE', '/containers/aisdlc-sbx-sess-000001?force=true')).status).toBe(
      201,
    );
    seen = [];
    // the host's database container is not a sandbox: a sandbox-shaped path cannot name it, and its id form is checked by label
    containers['abcdef123456'] = { Config: { Labels: {} } };
    for (const [m, u] of [
      ['POST', '/containers/abcdef123456/start'],
      ['DELETE', '/containers/abcdef123456?force=true'],
      ['GET', '/containers/abcdef123456/logs'],
      ['POST', '/containers/abcdef123456/kill'],
    ] as const) {
      expect((await call(m, u)).status, u).toBe(403);
    }
    expect(nonInspect()).toEqual([]);
  });
  it('a missing container is a 404, not an error to retry blindly', async () => {
    expect((await call('DELETE', '/containers/aisdlc-sbx-sess-000009?force=true')).status).toBe(
      404,
    );
  });
  it('a network is deleted only if it is a labelled internal session network', async () => {
    expect((await call('DELETE', '/networks/aisdlc-sbx-net-sess-000001')).status).toBe(201);
    expect((await call('DELETE', '/networks/aisdlc-sbx-net-sess-000002')).status).toBe(403);
    expect((await call('DELETE', '/networks/aisdlc-sbx-net-sess-000003')).status).toBe(403);
    expect((await call('DELETE', '/networks/bridge')).status).toBe(403);
    expect(seen.filter((s) => s.method === 'DELETE').map((s) => s.url)).toEqual([
      '/networks/aisdlc-sbx-net-sess-000001',
    ]);
  });
  it('connects only a peer-labelled container, under its own alias', async () => {
    const connect = (container: string, alias: string, net = 'aisdlc-sbx-net-sess-000001') =>
      call(
        'POST',
        `/networks/${net}/connect`,
        json({ Container: container, EndpointConfig: { Aliases: [alias] } }),
        JSON_H,
      );
    expect((await connect('aisdlc-gateway', 'gateway')).status).toBe(201);
    expect((await connect('aisdlc-package-mirror', 'package-mirror')).status).toBe(201);
    expect((await connect('aisdlc-gateway', 'package-mirror')).status).toBe(403);
    expect((await connect('postgres', 'gateway')).status).toBe(403);
    expect((await connect('aisdlc-sbx-sess-000001', 'gateway')).status).toBe(403);
    expect((await connect('aisdlc-gateway', 'gateway', 'aisdlc-sbx-net-sess-000002')).status).toBe(
      403,
    );
    expect(seen.filter((s) => s.method === 'POST' && s.url.endsWith('/connect')).length).toBe(2);
  });
  it('creates a session network only as an internal labelled one', async () => {
    const b = {
      Name: 'aisdlc-sbx-net-sess-000004',
      Internal: true,
      Labels: { [SANDBOX_LABEL.sandbox]: '1', [SANDBOX_LABEL.session]: 'sess-000004' },
    };
    expect((await call('POST', '/networks/create', json(b), JSON_H)).status).toBe(201);
    expect(
      (await call('POST', '/networks/create', json({ ...b, Internal: false }), JSON_H)).status,
    ).toBe(403);
    const forwarded = seen.filter((s) => s.url === '/networks/create');
    expect(forwarded).toHaveLength(1);
    expect(JSON.parse(forwarded[0]?.body ?? '{}')).toMatchObject({
      Internal: true,
      Driver: 'bridge',
      Attachable: false,
    });
  });
});

describe('caps are counted from the daemon', () => {
  const live = (cls: string, state = 'running') => ({
    State: state,
    Labels: { [SANDBOX_LABEL.sandbox]: '1', [SANDBOX_LABEL.class]: cls },
  });
  const make = (cls: 'K' | 'W', n: number) => {
    const b = validBody(cls, `sess-0000${n}`);
    return call('POST', `/containers/create?name=aisdlc-sbx-sess-0000${n}`, json(b), JSON_H);
  };
  it('refuses a second coding session', async () => {
    listing = [live('W')];
    const r = await make('W', 2);
    expect(r.status).toBe(429);
    expect(r.body).toMatch(/coding session/);
    expect(seen.some((s) => s.url.startsWith('/containers/create'))).toBe(false);
    listing = [live('W', 'exited')];
    expect((await make('W', 3)).status).toBe(201);
  });
  it('refuses a create past the sandbox cap, and when the daemon cannot count', async () => {
    listing = [live('K'), live('K'), live('K'), live('K', 'created')];
    expect((await make('K', 5)).status).toBe(429);
    listing = [live('K')];
    expect((await make('K', 6)).status).toBe(201);
  });
});

describe('archive is off unless configured', () => {
  it('refuses get and put of any path by default', async () => {
    expect((await call('GET', '/containers/aisdlc-sbx-sess-000001/archive?path=/out')).status).toBe(
      403,
    );
    expect(
      (await call('PUT', '/containers/aisdlc-sbx-sess-000001/archive?path=/repo', 'x')).status,
    ).toBe(403);
    expect(nonInspect()).toEqual([]);
  });
  it('with a path configured: that path only, and uploads are capped', async () => {
    const dir2 = mkdtempSync(join(tmpdir(), 'dockerproxy2-'));
    const s2 = join(dir2, 'p.sock');
    const p2 = new DockerProxy({
      policy: cfg({ archiveGet: ['/out'], archivePut: ['/repo'], maxArchiveBytes: 10 }),
      upstream: { socketPath: join(dir, 'daemon.sock') },
    });
    await p2.listen({ socketPath: s2 });
    const c = (m: string, u: string, body?: string) =>
      new Promise<number>((resolve, reject) => {
        const req = http.request(
          {
            socketPath: s2,
            method: m,
            path: u,
            headers: body !== undefined ? { 'Content-Length': Buffer.byteLength(body) } : {},
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve(res.statusCode ?? 0));
          },
        );
        req.on('error', reject);
        req.end(body);
      });
    expect(await c('GET', '/containers/aisdlc-sbx-sess-000001/archive?path=/out')).toBe(201);
    expect(await c('GET', '/containers/aisdlc-sbx-sess-000001/archive?path=/etc')).toBe(403);
    expect(await c('PUT', '/containers/aisdlc-sbx-sess-000001/archive?path=/repo', 'small')).toBe(
      201,
    );
    expect(
      await c('PUT', '/containers/aisdlc-sbx-sess-000001/archive?path=/repo', 'x'.repeat(50)),
    ).toBe(413);
    expect(await c('PUT', '/containers/aisdlc-sbx-sess-000001/archive?path=/out', 'x')).toBe(403);
    await p2.close();
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe('health', () => {
  it('answers /healthz from the daemon ping and counts refusals', async () => {
    expect((await call('GET', '/healthz')).status).toBe(200);
    const before = proxy.stats.refused;
    await call('POST', '/build', '{}');
    expect(proxy.stats.refused).toBe(before + 1);
  });
});
