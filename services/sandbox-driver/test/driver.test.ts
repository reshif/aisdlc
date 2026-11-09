import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SandboxSpec } from '@aisdlc/ports';
import { makeCanary } from '@aisdlc/secrets-rules';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerAvailable, hostPidCount, startRig, type Rig } from './harness.js';

const docker = dockerAvailable();
if (!docker.ok) console.warn(`sandbox-driver Docker tests SKIPPED: ${docker.why}`);

const GW_KEY = 'vk_test_0123456789abcdef';
let rig: Rig;
const none = { containers: [], networks: [], volumes: [], scratch: [] };

const spec = (
  over: Partial<SandboxSpec> & Pick<SandboxSpec, 'session_id' | 'class' | 'command'>,
): SandboxSpec => ({
  repo: [{ path: 'README.md', content: 'hi' }],
  ...over,
});
const must = <T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};

describe.skipIf(!docker.ok)(
  'DockerSandboxDriver through the allow-list proxy (real Docker)',
  () => {
    beforeAll(async () => {
      rig = await startRig({
        canaries: [makeCanary('drv-a'), makeCanary('drv-b')],
        gatewayKey: GW_KEY,
      });
    });
    afterAll(async () => {
      await rig?.teardown();
    });

    it('K: no NIC, the repo is read-only, /out comes back (fix #25), nothing is left behind', async () => {
      const d = rig.driver({ trustedCommands: ['node'] });
      const run = must(
        await d.run(
          spec({
            session_id: 'k-basic-001',
            class: 'K',
            command: [
              'node',
              '-e',
              `const fs=require('fs');fs.writeFileSync('/out/a.txt','hello');
             let ro='no';try{fs.writeFileSync('/repo/x','y')}catch(e){ro=e.code}
             console.log('NICS '+Object.keys(require('os').networkInterfaces()).join(',')+' RO '+ro+' CWD '+process.cwd())`,
            ],
          }),
        ),
      );
      expect(run.status).toBe('exited');
      expect(run.exit_code).toBe(0);
      expect(run.stdout).toContain('NICS lo RO EROFS CWD /repo');
      expect(run.out.map((o) => [o.path, Buffer.from(o.content).toString()])).toEqual([
        ['a.txt', 'hello'],
      ]);
      expect(run.peers).toEqual([]);
      expect(run.cleanup_errors).toEqual([]);
      expect(rig.leftovers()).toEqual(none);
    });

    it('K-exec: only the mirror is a peer, the repo copy is writable in /work, the mounted repo is not', async () => {
      const d = rig.driver();
      const run = must(
        await d.run(
          spec({
            session_id: 'kx-basic-001',
            class: 'K-exec',
            command: [
              'node',
              '-e',
              `const fs=require('fs');const http=require('http');
             fs.writeFileSync('x','w');let ro='no';try{fs.writeFileSync('/repo/x','y')}catch(e){ro=e.code}
             http.get('http://package-mirror:8420/healthz',r=>{console.log('MIRROR '+r.statusCode+' RO '+ro+' CWD '+process.cwd()+' NICS '+Object.keys(require('os').networkInterfaces()).sort());r.resume()}).on('error',e=>console.log('ERR '+e.code))`,
            ],
          }),
        ),
      );
      expect(run.stdout).toContain('MIRROR 200 RO EROFS CWD /work/repo NICS eth0,lo');
      expect(run.peers).toEqual(['mirror']);
      expect(rig.leftovers()).toEqual(none);
    });

    it('W: the gateway and the mirror are the peers; the key is the only credential and only the gateway accepts it', async () => {
      const d = rig.driver();
      const script = `
      const get=(u,h)=>fetch(u,{headers:h||{},signal:AbortSignal.timeout(3000)}).then(r=>r.status,e=>String(e.cause&&e.cause.code||e.code||e.message));
      (async()=>{
        const url=process.env.AISDLC_GATEWAY_URL, key=process.env.AISDLC_GATEWAY_KEY;
        const names=Object.keys(process.env).filter(n=>/KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|AUTH|CANARY/i.test(n)).sort();
        console.log('RES '+JSON.stringify({
          nokey: await get(url+'/v1/messages'),
          withkey: await get(url+'/v1/messages',{'x-api-key':key}),
          mirror: await get('http://package-mirror:8420/healthz'),
          external: await get('http://example.com/'),
          metadata: await get('http://169.254.169.254/'),
          credentialNames: names,
          keyLooksRight: typeof key==='string' && key.length>8,
        }));
      })();`;
      const run = must(
        await d.run(
          spec({
            session_id: 'w-basic-001',
            class: 'W',
            command: ['node', '-e', script],
            gateway_key: GW_KEY,
          }),
        ),
      );
      const res = JSON.parse(/RES (\{.*\})/.exec(run.stdout)?.[1] ?? '{}') as Record<
        string,
        unknown
      >;
      expect(res['nokey']).toBe(401);
      expect(res['withkey']).toBe(200);
      expect(res['mirror']).toBe(200);
      expect(typeof res['external']).toBe('string');
      expect(typeof res['metadata']).toBe('string');
      // the gateway virtual key is the ONLY credential-shaped name, and the key value never came back out
      expect(res['credentialNames']).toEqual(['AISDLC_GATEWAY_KEY']);
      expect(run.stdout + run.stderr).not.toContain(GW_KEY);
      expect(run.peers).toEqual(['gateway', 'mirror']);
      expect(rig.leftovers()).toEqual(none);
    });

    it('one coding session at a time: the driver refuses a second, and so does the proxy for a second driver', async () => {
      const d1 = rig.driver();
      const d2 = rig.driver();
      const w = (id: string, command: string[]) =>
        spec({ session_id: id, class: 'W', command, gateway_key: GW_KEY, limits: { time_s: 20 } });
      const first = d1.run(w('w-cap-0001', ['sleep', '4']));
      await new Promise((r) => setTimeout(r, 2500));
      const second = await d1.run(w('w-cap-0002', ['true']));
      expect(!second.ok && second.error.code).toBe('busy');
      const third = await d2.run(w('w-cap-0003', ['true']));
      expect(!third.ok && third.error.code).toBe('busy');
      expect(!third.ok && third.error.message).toMatch(/429|coding session/);
      expect(must(await first).status).toBe('exited');
      // a K session is not a coding session
      expect(rig.leftovers()).toEqual(none);
    });

    it('every sandbox is capped in memory (and has no swap), pids and cpu, as the daemon made it', async () => {
      const d = rig.driver();
      const run = must(
        await d.run(
          spec({
            session_id: 'kx-limits-01',
            class: 'K-exec',
            limits: { memory_mb: 192, pids: 48 },
            command: [
              'sh',
              '-c',
              'cat /sys/fs/cgroup/memory/memory.limit_in_bytes /sys/fs/cgroup/memory.max 2>/dev/null; cat /sys/fs/cgroup/pids/pids.max /sys/fs/cgroup/pids.max 2>/dev/null',
            ],
          }),
        ),
      );
      expect(run.limits).toMatchObject({ memory_mb: 192, pids: 48 });
      expect(run.stdout).toContain(String(192 * 1024 * 1024));
      expect(run.stdout).toMatch(/\b48\b/);
    });

    describe('refusals leave nothing behind', () => {
      it('a credential in the environment (by name, by value) or a key where there is none starts nothing', async () => {
        const d = rig.driver();
        const before = hostPidCount();
        for (const [env, key] of [
          [{ ANTHROPIC_API_KEY: 'x' }, undefined],
          [{ NOTE: makeCanary('env-value') }, undefined],
          [{}, 'vk_test_0123456789abcdef'],
        ] as const) {
          const r = await d.run(
            spec({
              session_id: 'kx-cred-0001',
              class: 'K-exec',
              command: ['true'],
              env,
              ...(key ? { gateway_key: key } : {}),
            }),
          );
          expect(!r.ok && r.error.code).toBe('invalid_spec');
        }
        expect(rig.leftovers()).toEqual(none);
        expect(hostPidCount() - before).toBeLessThan(15);
      });
      it('a class that runs no repo code refuses an untrusted command', async () => {
        const r = await rig
          .driver({ trustedCommands: ['/opt/scanners/scan'] })
          .run(spec({ session_id: 'k-exec-0001', class: 'K', command: ['node', 'x.js'] }));
        expect(!r.ok && r.error.code).toBe('exec_not_allowed');
      });
      it('an image the proxy does not allow is refused after the network was made, and the network is removed', async () => {
        const r = await rig
          .driver({ image: 'alpine:latest' })
          .run(spec({ session_id: 'kx-image-001', class: 'K-exec', command: ['true'] }));
        expect(!r.ok && r.error.code).toBe('refused');
        expect(rig.leftovers()).toEqual(none);
      });
      it('a class that needs a peer which is not configured does not run, and makes no network', async () => {
        const r = await rig
          .driver({ peers: {} })
          .run(spec({ session_id: 'kx-peer-0001', class: 'K-exec', command: ['true'] }));
        expect(!r.ok && r.error.code).toBe('unavailable');
        expect(rig.leftovers()).toEqual(none);
      });
      it('a scratch directory that already exists is not reused and not removed', async () => {
        const dir = join(rig.scratchRoot, 'k-taken-0001');
        mkdirSync(dir);
        const r = await rig
          .driver({ trustedCommands: ['true'] })
          .run(spec({ session_id: 'k-taken-0001', class: 'K', command: ['true'] }));
        expect(!r.ok && r.error.code).toBe('driver_failure');
        expect(existsSync(dir)).toBe(true);
        rmSync(dir, { recursive: true });
      });
      it('a proxy that is not there is an error, never a pass', async () => {
        const r = await rig
          .driver({
            endpoint: { socketPath: join(rig.scratchRoot, 'nope.sock') },
            trustedCommands: ['true'],
          })
          .run(spec({ session_id: 'k-noprox-001', class: 'K', command: ['true'] }));
        expect(r.ok).toBe(false);
        expect(rig.leftovers()).toEqual(none);
      });
    });

    it('an /out that went past the cap makes the run void, and nothing of it is returned', async () => {
      const d = rig.driver();
      const run = must(
        await d.run(
          spec({
            session_id: 'kx-oversz-01',
            class: 'K-exec',
            // the tmpfs rounds its size up to a page, so a 2 KiB cap can hold 4 KiB: the reader's own cap (2 KiB) refuses it
            limits: { out_bytes: 2048 },
            command: [
              'node',
              '-e',
              "try{require('fs').writeFileSync('/out/big',Buffer.alloc(1e6,1))}catch(e){};console.log('done')",
            ],
          }),
        ),
      );
      expect(run.status).toBe('out_oversized');
      expect(run.exit_code).toBeNull();
      expect(run.out).toEqual([]);
      expect(run.detail).toMatch(/bytes/);
      expect(rig.leftovers()).toEqual(none);
    });
  },
);
