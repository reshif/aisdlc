import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SANDBOX_LABEL } from '@aisdlc/contracts';
import { DockerProxy } from '@aisdlc/docker-proxy';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DockerSandboxDriver } from '../src/index.js';

// M19, the runner-killed drill: what a sandbox-controller that died mid-session leaves on the daemon (its sessions'
// containers keep running, their networks and repo copies stay) is removed by the next controller's sweep, through
// the real proxy, and only what carries THIS proxy's owner label. A stub daemon stands in for Docker (no Docker
// needed): it answers the proxy's lists with the labels the daemon would and records every verb.

const OWNER = 'host-a';
const own = (session: string, cls = 'W') => ({
  [SANDBOX_LABEL.sandbox]: '1',
  [SANDBOX_LABEL.owner]: OWNER,
  [SANDBOX_LABEL.session]: session,
  [SANDBOX_LABEL.class]: cls,
});
const other = (session: string) => ({
  [SANDBOX_LABEL.sandbox]: '1',
  [SANDBOX_LABEL.owner]: 'host-b',
  [SANDBOX_LABEL.session]: session,
});

let dir: string;
let scratch: string;
let daemon: http.Server;
let proxy: DockerProxy;
let seen: Array<{ method: string; url: string }> = [];
type C = { Id: string; Names: string[]; State: string; Labels: Record<string, string> };
let containers: C[] = [];
let networks: Array<{ Id: string; Name: string; Labels: Record<string, string> }> = [];

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'aisdlc-sweep-'));
  scratch = join(dir, 'scratch');
  daemon = http.createServer(async (req, res) => {
    for await (const _ of req) void _;
    const u = req.url ?? '';
    seen.push({ method: req.method ?? '', url: u });
    const json = (status: number, v: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(v === undefined ? '' : JSON.stringify(v));
    };
    // the daemon applies the label filter the proxy sent (and the proxy checks the labels again)
    const labelsOf = (q: string): string[] => {
      const f = new URL(`http://d${q}`).searchParams.get('filters');
      return f ? ((JSON.parse(f) as { label?: string[] }).label ?? []) : [];
    };
    const matches = (labels: Record<string, string>, want: string[]) =>
      want.every((w) => {
        const [k, v] = w.split('=');
        return labels[k as string] === v;
      });
    if (req.method === 'GET' && u.startsWith('/containers/json')) {
      return json(
        200,
        containers.filter((c) => matches(c.Labels, labelsOf(u))),
      );
    }
    if (req.method === 'GET' && u.startsWith('/networks?')) {
      return json(
        200,
        networks.filter((n) => matches(n.Labels, labelsOf(u))),
      );
    }
    let m: RegExpExecArray | null;
    if ((m = /^\/containers\/([^/?]+)\/json$/.exec(u))) {
      const c = containers.find((x) => x.Names[0] === `/${m?.[1]}`);
      // the peers, labelled by compose (the proxy connects and disconnects only them)
      const peer = { 'stack-gateway': 'gateway', 'stack-package-mirror': 'mirror' }[m[1] as string];
      if (peer) return json(200, { Config: { Labels: { [SANDBOX_LABEL.peer]: peer } } });
      return c ? json(200, { Config: { Labels: c.Labels } }) : json(404, { message: 'no' });
    }
    if ((m = /^\/containers\/([^/?]+)\?/.exec(u)) && req.method === 'DELETE') {
      containers = containers.filter((x) => x.Names[0] !== `/${m?.[1]}`);
      return json(204, undefined);
    }
    if ((m = /^\/networks\/([^/?]+)$/.exec(u))) {
      const n = networks.find((x) => x.Name === m?.[1]);
      if (req.method === 'GET')
        return n ? json(200, { Labels: n.Labels, Internal: true }) : json(404, { message: 'no' });
      if (req.method === 'DELETE') {
        networks = networks.filter((x) => x.Name !== m?.[1]);
        return json(204, undefined);
      }
    }
    if (/^\/networks\/[^/]+\/disconnect$/.test(u)) return json(200, {});
    return json(404, { message: 'not stubbed' });
  });
  const daemonSock = join(dir, 'daemon.sock');
  await new Promise<void>((r) => daemon.listen(daemonSock, r));
  proxy = new DockerProxy({
    policy: {
      images: ['aisdlc/sandbox:local'],
      entrypoint: ['/usr/local/bin/aisdlc-run'],
      scratchRoot: scratch,
      allowNetworks: true,
      maxSandboxes: 4,
      codingCap: 1,
      archiveGet: [],
      archivePut: [],
      maxArchiveBytes: 1024,
      owner: OWNER,
    },
    upstream: { socketPath: daemonSock },
  });
  await proxy.listen({ socketPath: join(dir, 'proxy.sock') });
});
afterAll(async () => {
  await proxy.close();
  await new Promise((r) => daemon.close(r));
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  seen = [];
  rmSync(scratch, { recursive: true, force: true });
  containers = [
    // the dead controller's W session, still running, and a K session that already exited
    {
      Id: 'a'.repeat(64),
      Names: ['/aisdlc-sbx-s6-w-000001'],
      State: 'running',
      Labels: own('s6-w-000001'),
    },
    {
      Id: 'b'.repeat(64),
      Names: ['/aisdlc-sbx-k-000002'],
      State: 'exited',
      Labels: own('k-000002', 'K'),
    },
    // the session the live controller runs right now: kept
    {
      Id: 'c'.repeat(64),
      Names: ['/aisdlc-sbx-keep-000003'],
      State: 'running',
      Labels: own('keep-000003'),
    },
    // another runner host's sandbox on the same daemon: never touched
    {
      Id: 'd'.repeat(64),
      Names: ['/aisdlc-sbx-other-000004'],
      State: 'running',
      Labels: other('other-000004'),
    },
    // not a sandbox at all
    { Id: 'e'.repeat(64), Names: ['/postgres'], State: 'running', Labels: {} },
  ];
  networks = [
    { Id: '1'.repeat(64), Name: 'aisdlc-sbx-net-s6-w-000001', Labels: own('s6-w-000001') },
    { Id: '2'.repeat(64), Name: 'aisdlc-sbx-net-keep-000003', Labels: own('keep-000003') },
    { Id: '3'.repeat(64), Name: 'aisdlc-sbx-net-other-000004', Labels: other('other-000004') },
  ];
  for (const s of ['s6-w-000001', 'keep-000003', 'gone-000005']) {
    mkdirSync(join(scratch, s, 'repo'), { recursive: true });
    writeFileSync(join(scratch, s, 'repo', 'a.txt'), 'x');
  }
  // not a session directory: the sweep leaves anything that is not one alone
  mkdirSync(join(scratch, 'README'), { recursive: true });
});

const driver = () =>
  new DockerSandboxDriver({
    endpoint: { socketPath: join(dir, 'proxy.sock') },
    image: 'aisdlc/sandbox:local',
    scratch: { local: scratch, host: scratch },
    peers: { mirror: 'stack-package-mirror', gateway: 'stack-gateway' },
  });

describe('the sweep of a runner host (M19)', () => {
  it("removes this host's sessions that nothing runs, with their networks and repo copies, and keeps the rest", async () => {
    const r = await driver().sweep(new Set(['keep-000003']));
    expect(r.errors).toEqual([]);
    expect([...r.containers].sort()).toEqual(['k-000002', 's6-w-000001']);
    expect(r.networks).toEqual(['s6-w-000001']);
    expect([...r.scratch].sort()).toEqual(['gone-000005', 's6-w-000001']);
    // on the daemon: the kept session, the other host's and the database are there; nothing else of this host
    expect(containers.map((c) => c.Names[0]).sort()).toEqual([
      '/aisdlc-sbx-keep-000003',
      '/aisdlc-sbx-other-000004',
      '/postgres',
    ]);
    expect(networks.map((n) => n.Name).sort()).toEqual([
      'aisdlc-sbx-net-keep-000003',
      'aisdlc-sbx-net-other-000004',
    ]);
    expect(existsSync(join(scratch, 'keep-000003'))).toBe(true);
    expect(existsSync(join(scratch, 's6-w-000001'))).toBe(false);
    expect(existsSync(join(scratch, 'README'))).toBe(true);
    // every verb that reached the daemon named this host's sandboxes only (the lists, the inspects, the removals)
    const verbs = seen
      .filter((s) => s.method !== 'GET')
      .map((s) => `${s.method} ${s.url.split('?')[0]}`);
    expect(verbs.some((v) => /other-000004|postgres|keep-000003/.test(v))).toBe(false);
    // the peers were disconnected before the network went
    expect(verbs).toContain('POST /networks/aisdlc-sbx-net-s6-w-000001/disconnect');
    expect(verbs).toContain('DELETE /networks/aisdlc-sbx-net-s6-w-000001');
  });

  it('at boot (nothing to keep) everything of this host goes, and a second sweep finds nothing', async () => {
    const d = driver();
    const first = await d.sweep();
    expect([...first.containers].sort()).toEqual(['k-000002', 'keep-000003', 's6-w-000001']);
    const again = await d.sweep();
    expect(again).toEqual({ containers: [], networks: [], scratch: [], errors: [] });
    expect(containers.map((c) => c.Names[0]).sort()).toEqual([
      '/aisdlc-sbx-other-000004',
      '/postgres',
    ]);
  });

  it('a proxy that cannot be reached is an error in the report, never a throw', async () => {
    const d = new DockerSandboxDriver({
      endpoint: { socketPath: join(dir, 'nobody.sock') },
      image: 'aisdlc/sandbox:local',
      scratch: { local: join(dir, 'none'), host: join(dir, 'none') },
      peers: {},
    });
    const r = await d.sweep();
    expect(r.containers).toEqual([]);
    expect(r.errors.join(' ')).toMatch(/proxy/);
  });
});
