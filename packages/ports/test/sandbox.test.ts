import { SANDBOX_PROFILES, SandboxClassValues, sandboxEnvViolations } from '@aisdlc/contracts';
import { makeCanary } from '@aisdlc/secrets-rules';
import { describe, expect, it } from 'vitest';
import { FakeSandbox, preflightSpec, scanSandboxOutput, type SandboxSpec } from '../src/index.js';

const spec = (over: Partial<SandboxSpec> = {}): SandboxSpec => ({
  session_id: 'sess-000001',
  class: 'K-exec',
  command: ['node', 'probe.js'],
  repo: [{ path: 'probe.js', content: 'console.log(1)' }],
  ...over,
});

describe('sandbox profiles (the ceilings)', () => {
  it('every class has /out, a memory limit, a pid limit and a time limit', () => {
    for (const c of SandboxClassValues) {
      const p = SANDBOX_PROFILES[c];
      expect(p.class).toBe(c);
      expect(p.limits.memory_mb).toBeGreaterThan(0);
      expect(p.limits.pids).toBeGreaterThan(0);
      expect(p.limits.time_s).toBeGreaterThan(0);
      expect(p.limits.out_bytes).toBeGreaterThan(0);
    }
  });
  it('K has no NIC, no key and no execution; K-exec has the mirror only and no key (roadmap 5.6)', () => {
    expect(SANDBOX_PROFILES.K).toMatchObject({
      network: 'none',
      key: false,
      exec: false,
      repo: 'ro',
    });
    expect(SANDBOX_PROFILES['K-exec']).toMatchObject({ network: 'mirror', key: false, exec: true });
  });
  it('only a class with a key may reach the gateway', () => {
    for (const c of SandboxClassValues) {
      const p = SANDBOX_PROFILES[c];
      expect(p.network.includes('gateway'), c).toBe(p.key);
    }
  });
});

describe('preflightSpec', () => {
  it('accepts a plain K-exec session and lowers limits only', () => {
    const r = preflightSpec(spec({ limits: { time_s: 5, memory_mb: 128 } }));
    expect(r.ok && [r.value.limits.time_s, r.value.limits.memory_mb]).toEqual([5, 128]);
    const up = preflightSpec(spec({ limits: { memory_mb: 99_999 } }));
    expect(!up.ok && up.error.code).toBe('invalid_spec');
  });
  it('refuses a key for a class without one, and a key class without its key', () => {
    expect(preflightSpec(spec({ gateway_key: 'vk_live_abcdefgh' })).ok).toBe(false);
    const w = preflightSpec(spec({ class: 'W' }));
    expect(!w.ok && w.error.message).toContain('no key, no run');
    expect(preflightSpec(spec({ class: 'W', gateway_key: 'vk_abcdefgh1234' })).ok).toBe(true);
  });
  it('refuses a credential in the environment by name and by value', () => {
    expect(preflightSpec(spec({ env: { ANTHROPIC_API_KEY: 'x' } })).ok).toBe(false);
    expect(preflightSpec(spec({ env: { AISDLC_ANYTHING: 'x' } })).ok).toBe(false);
    expect(preflightSpec(spec({ env: { NOTE: makeCanary('env') } })).ok).toBe(false);
    expect(preflightSpec(spec({ env: { CI: '1', LANG: 'C' } })).ok).toBe(true);
    expect(sandboxEnvViolations({ GITHUB_TOKEN: 'x' }, 'W')).toHaveLength(1);
  });
  it('refuses repo code in a class that runs none unless the command is a trusted one of the image', () => {
    const r = preflightSpec(spec({ class: 'K', command: ['node', 'probe.js'] }));
    expect(!r.ok && r.error.code).toBe('exec_not_allowed');
    expect(
      preflightSpec(spec({ class: 'K', command: ['/opt/scanners/trufflehog'] }), {
        trustedCommands: ['/opt/scanners/trufflehog'],
      }).ok,
    ).toBe(true);
  });
  it('refuses traversal, absolute and duplicate repo paths, and a file that is also a directory', () => {
    for (const path of ['../x', '/etc/passwd', 'a/../../x', 'a//b', './x', 'a\\b']) {
      expect(preflightSpec(spec({ repo: [{ path, content: '' }] })).ok, path).toBe(false);
    }
    expect(
      preflightSpec(
        spec({
          repo: [
            { path: 'a', content: '' },
            { path: 'a', content: '' },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(
      preflightSpec(
        spec({
          repo: [
            { path: 'a', content: '' },
            { path: 'a/b', content: '' },
          ],
        }),
      ).ok,
    ).toBe(false);
  });
  it('refuses a session id that is not a plain slug', () => {
    for (const id of ['x', 'Has Space', '../../etc', 'a'.repeat(60), '-lead00']) {
      expect(preflightSpec(spec({ session_id: id })).ok, id).toBe(false);
    }
  });
});

describe('scanSandboxOutput', () => {
  it('fires on a factory canary in /out or in the logs and never returns the value', () => {
    const c = makeCanary('t');
    const a = scanSandboxOutput([{ path: 'r.txt', content: Buffer.from(`x ${c} y`) }]);
    expect(a.canary).toBe(true);
    expect(JSON.stringify(a)).not.toContain(c);
    const b = scanSandboxOutput([], [{ path: 'stderr', text: c }]);
    expect(b.canary).toBe(true);
    expect(scanSandboxOutput([{ path: 'r.txt', content: Buffer.from('all clear') }]).clean).toBe(
      true,
    );
  });
});

describe('FakeSandbox', () => {
  it('runs a script under the same rules, with the profile peers, and withholds /out on a canary', async () => {
    const c = makeCanary('fake');
    const fake = new FakeSandbox((s) => ({
      exit_code: 3,
      out: s.command[1] === 'plant' ? { 'r.txt': c } : { 'r.json': '{}' },
    }));
    const ok1 = await fake.run(spec());
    expect(
      ok1.ok && [ok1.value.status, ok1.value.exit_code, ok1.value.peers, ok1.value.out.length],
    ).toEqual(['exited', 3, ['mirror'], 1]);
    const bad = await fake.run(spec({ command: ['node', 'plant'] }));
    expect(
      bad.ok && [bad.value.quarantined, bad.value.out.length, bad.value.out_scan.canary],
    ).toEqual([true, 0, true]);
  });
  it('caps /out and makes an oversized run void', async () => {
    const fake = new FakeSandbox(() => ({ out: { big: 'x'.repeat(5000) } }));
    const r = await fake.run(spec({ limits: { out_bytes: 1024 } }));
    expect(r.ok && [r.value.status, r.value.exit_code, r.value.out.length]).toEqual([
      'out_oversized',
      null,
      0,
    ]);
  });
  it('allows one coding session at a time and refuses a second, never queues it', async () => {
    let release!: () => void;
    const held = new Promise<void>((res) => (release = res));
    const fake = new FakeSandbox(async () => {
      await held;
      return {};
    });
    const w = { class: 'W' as const, gateway_key: 'vk_abcdefgh1234' };
    const first = fake.run(spec({ ...w, session_id: 'sess-w00001' }));
    const second = await fake.run(spec({ ...w, session_id: 'sess-w00002' }));
    expect(!second.ok && second.error.code).toBe('busy');
    // a K session is not a coding session
    release();
    expect((await first).ok).toBe(true);
    expect((await fake.run(spec({ ...w, session_id: 'sess-w00003' }))).ok).toBe(true);
  });
  it('an unavailable host is a refusal, never a pass', async () => {
    const r = await new FakeSandbox().breakIt().run(spec());
    expect(!r.ok && r.error.code).toBe('unavailable');
  });
});

describe('the image of a session (M16)', () => {
  it('an image is named by digest only; a tag is refused before anything runs', () => {
    const hex = 'a'.repeat(64);
    expect(preflightSpec(spec({ image: `sha256:${hex}` })).ok).toBe(true);
    expect(preflightSpec(spec({ image: `aisdlc/sandbox-onboarding@sha256:${hex}` })).ok).toBe(true);
    for (const bad of ['aisdlc/sandbox-onboarding:local', `sha256:${hex.slice(1)}`, 'ubuntu']) {
      const r = preflightSpec(spec({ image: bad }));
      expect(r.ok ? null : r.error.code).toBe('invalid_spec');
    }
  });
});
