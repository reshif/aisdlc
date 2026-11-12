import type { SandboxGrantRef } from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { makeCanary } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import type {
  FakeSandbox,
  FakeSandboxScript,
  SandboxError,
  SandboxPort,
  SandboxSpec,
} from './sandbox.js';

// The SandboxPort contract suite (PLAN M14.2). `sandboxContract` runs the same scenarios against `FakeSandbox`
// directly and against the sandbox-controller with `HttpSandbox` in front of it (a `FakeSandbox` behind): what a
// session sends and what comes back must be the same either way, including the refusals.

export interface SandboxHarness {
  readonly port: SandboxPort;
  /** The fake that runs the sessions (behind the controller, or the port itself). */
  readonly fake: FakeSandbox;
  stop?: () => Promise<void>;
}

/** The grant every spec of the suite names (a harness with a controller grants exactly this one). */
export const CONTRACT_GRANT: SandboxGrantRef = {
  grant_id: 'unit-contract@3',
  item_id: '01930000-0000-7000-8000-000000000001',
  unit_id: 'unit-contract',
  lease_epoch: 3,
};

const KEY = `aisk_${'0123456789abcdef'.repeat(2)}`;

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  session_id: 'contract-0001',
  class: 'O',
  command: ['npm', 'test'],
  repo: [
    { path: 'package.json', content: '{"name":"x"}' },
    { path: 'bin/blob', content: new Uint8Array([0, 1, 2, 255, 254]), executable: true },
  ],
  repo_full_name: 'acme/app',
  grant: CONTRACT_GRANT,
  ...over,
});

function failure(r: { ok: boolean; error?: SandboxError }): SandboxError {
  if (r.ok || !r.error) throw new Error('expected an error result');
  return r.error;
}

export function sandboxContract(
  name: string,
  make: (script: FakeSandboxScript) => Promise<SandboxHarness>,
): void {
  describe(`SandboxPort contract: ${name}`, () => {
    it('a session runs to its end: exit code, logs, /out (text and bytes, hashed), limits and peers', async () => {
      const h = await make(() => ({
        exit_code: 3,
        stdout: 'ran\n',
        stderr: 'warn\n',
        out: { 'report.json': '{"ok":true}', 'bin.dat': new Uint8Array([9, 8, 7, 0]) },
      }));
      const r = await h.port.run(spec({ limits: { time_s: 60 } }));
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value).toMatchObject({
        session_id: 'contract-0001',
        class: 'O',
        status: 'exited',
        exit_code: 3,
        stdout: 'ran\n',
        stderr: 'warn\n',
        quarantined: false,
        detail: null,
        peers: ['mirror'],
        limits: { time_s: 60, memory_mb: 1024 },
      });
      const out = Object.fromEntries(r.value.out.map((f) => [f.path, f]));
      expect(Buffer.from(out['report.json']!.content).toString()).toBe('{"ok":true}');
      expect([...out['bin.dat']!.content]).toEqual([9, 8, 7, 0]);
      expect(out['bin.dat']!.sha256).toBe(sha256Hex(new Uint8Array([9, 8, 7, 0])));
      expect(out['bin.dat']!.size).toBe(4);
      await h.stop?.();
    });

    it('the spec arrives as it was sent: the repo copy (text stays text, bytes stay bytes), argv, env, limits, key', async () => {
      const h = await make(() => ({ exit_code: 0 }));
      const r = await h.port.run(
        spec({
          class: 'W',
          gateway_key: KEY,
          command: ['node', 'run.js', '--flag', 'a b'],
          env: { CI: '1' },
          limits: { memory_mb: 512 },
        }),
      );
      expect(r.ok).toBe(true);
      const got = h.fake.runs.at(-1)!;
      expect(got.command).toEqual(['node', 'run.js', '--flag', 'a b']);
      expect(got.env).toEqual({ CI: '1' });
      expect(got.limits).toEqual({ memory_mb: 512 });
      expect(got.gateway_key).toBe(KEY);
      expect(got.repo_full_name).toBe('acme/app');
      const [text, bin] = got.repo;
      expect(text?.content).toBe('{"name":"x"}');
      expect(bin?.content).toBeInstanceOf(Uint8Array);
      expect([...(bin?.content as Uint8Array)]).toEqual([0, 1, 2, 255, 254]);
      expect(bin?.executable).toBe(true);
      await h.stop?.();
    });

    it('a void run is a run, not an error: no exit code, the reason, no /out', async () => {
      const h = await make(() => ({ status: 'timed_out', out: { 'x.txt': 'partial' } }));
      const r = await h.port.run(spec());
      expect(r.ok && r.value).toMatchObject({
        status: 'timed_out',
        exit_code: null,
        detail: 'timed_out',
        out: [],
      });
      await h.stop?.();
    });

    it('a canary in /out quarantines the run: /out is withheld, the finding is named', async () => {
      const h = await make(() => ({ exit_code: 0, out: { 'leak.txt': makeCanary('contract') } }));
      const r = await h.port.run(spec());
      if (!r.ok) throw new Error(r.error.message);
      expect(r.value.quarantined).toBe(true);
      expect(r.value.out).toEqual([]);
      expect(r.value.out_scan.canary).toBe(true);
      expect(r.value.out_scan.findings.some((f) => f.path === 'leak.txt')).toBe(true);
      await h.stop?.();
    });

    it('refusals start nothing: a limit above the ceiling, a key class without its key, a credential in env', async () => {
      const h = await make(() => ({ exit_code: 0 }));
      const before = h.fake.runs.length;
      expect(failure(await h.port.run(spec({ limits: { memory_mb: 99_999 } }))).code).toBe(
        'invalid_spec',
      );
      expect(failure(await h.port.run(spec({ class: 'W' }))).code).toBe('invalid_spec');
      expect(failure(await h.port.run(spec({ env: { GITHUB_TOKEN: 'x' } }))).code).toBe(
        'invalid_spec',
      );
      expect(failure(await h.port.run(spec({ class: 'K' }))).code).toBe('exec_not_allowed');
      expect(h.fake.runs.length).toBe(before);
      await h.stop?.();
    });

    it('one coding session at a time: a second W while one runs is busy and starts nothing; the slot comes back', async () => {
      let release: () => void = () => undefined;
      const gate = new Promise<void>((r) => (release = r));
      const h = await make(async (s) => {
        if (s.session_id === 'contract-w-1') await gate;
        return { exit_code: 0 };
      });
      const first = h.port.run(spec({ session_id: 'contract-w-1', class: 'W', gateway_key: KEY }));
      // let the first one reach the driver
      for (let i = 0; i < 50 && h.fake.runs.length === 0; i++) {
        await new Promise((r) => setTimeout(r, 10));
      }
      const second = await h.port.run(
        spec({ session_id: 'contract-w-2', class: 'W', gateway_key: KEY }),
      );
      expect(failure(second).code).toBe('busy');
      // other classes are not coding sessions
      expect((await h.port.run(spec({ session_id: 'contract-o-1' }))).ok).toBe(true);
      release();
      expect((await first).ok).toBe(true);
      const third = await h.port.run(
        spec({ session_id: 'contract-w-3', class: 'W', gateway_key: KEY }),
      );
      expect(third.ok).toBe(true);
      expect(h.fake.runs.map((x) => x.session_id)).not.toContain('contract-w-2');
      await h.stop?.();
    });

    it('a host that is down is unavailable, never a run', async () => {
      const h = await make(() => ({ exit_code: 0 }));
      h.fake.breakIt();
      expect(failure(await h.port.run(spec())).code).toBe('unavailable');
      h.fake.breakIt(false);
      expect((await h.port.run(spec())).ok).toBe(true);
      await h.stop?.();
    });
  });
}
