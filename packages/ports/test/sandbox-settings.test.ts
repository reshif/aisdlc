import {
  CODING_SESSION_CAP,
  CODING_SESSION_HARD_CEILING,
  SANDBOX_PROFILES,
  SandboxCapsConfig,
} from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import { CodingGate, FakeSandbox, preflightSpec, profileUnder } from '../src/index.js';

// Portal v2: the coding cap follows `sandbox.caps.coding` up to the hard ceiling (H9), and `sandbox.profiles` lowers a
// class's ceilings, never raises them (H28).

const spec = (cls: 'W' | 'O', limits?: Record<string, number>) =>
  ({
    session_id: `sess-${Math.random().toString(16).slice(2, 10)}`,
    class: cls,
    command: ['true'],
    repo: [],
    ...(cls === 'W' ? { gateway_key: 'vk_abcdefgh1234' } : {}),
    ...(limits ? { limits } : {}),
  }) as never;

describe('the coding cap (H9)', () => {
  it('defaults to one; follows a function; never goes above the hard ceiling', () => {
    expect(new CodingGate().limit).toBe(CODING_SESSION_CAP);
    let cap = 3;
    const g = new CodingGate(() => cap);
    const held = [g.tryAcquire('W'), g.tryAcquire('W'), g.tryAcquire('W')];
    expect(held.every((r) => r !== null)).toBe(true);
    expect(g.tryAcquire('W')).toBeNull();
    cap = 99;
    expect(g.limit).toBe(CODING_SESSION_HARD_CEILING);
    cap = -1;
    expect(g.limit).toBe(CODING_SESSION_CAP);
    for (const r of held) r?.();
    expect(g.active).toBe(0);
  });

  it('the config schema takes up to the hard ceiling and refuses more', () => {
    expect(
      SandboxCapsConfig.safeParse({ total: 8, coding: CODING_SESSION_HARD_CEILING }).success,
    ).toBe(true);
    expect(
      SandboxCapsConfig.safeParse({ total: 16, coding: CODING_SESSION_HARD_CEILING + 1 }).success,
    ).toBe(false);
  });

  it('two W sessions run at once on a fake whose cap is two', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => (release = r));
    const fake = new FakeSandbox(
      async () => {
        await gate;
        return { exit_code: 0 };
      },
      { codingCap: 2 },
    );
    const a = fake.run(spec('W'));
    const b = fake.run(spec('W'));
    const c = await fake.run(spec('W'));
    expect(!c.ok && c.error.code).toBe('busy');
    release();
    expect((await a).ok && (await b).ok).toBe(true);
  });
});

describe('the class ceilings (H28)', () => {
  it('lower only: a value above the code’s ceiling is ignored', () => {
    const p = profileUnder('O', { O: { time_s: 60, memory_mb: 1_000_000 } });
    expect(p.limits.time_s).toBe(60);
    expect(p.limits.memory_mb).toBe(SANDBOX_PROFILES.O.limits.memory_mb);
    expect(profileUnder('O', null)).toBe(SANDBOX_PROFILES.O);
  });

  it('a spec above a lowered ceiling is refused; at or below it passes', () => {
    const ceilings = () => ({ O: { time_s: 60 } });
    expect(preflightSpec(spec('O', { time_s: 120 }), { ceilings }).ok).toBe(false);
    const ok = preflightSpec(spec('O'), { ceilings });
    expect(ok.ok && ok.value.limits.time_s).toBe(60);
    expect(preflightSpec(spec('O', { time_s: 120 })).ok).toBe(true);
  });
});
