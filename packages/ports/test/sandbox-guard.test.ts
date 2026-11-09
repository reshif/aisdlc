import { SandboxClassValues } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import { describe, expect, it } from 'vitest';
import {
  FakeSandbox,
  GuardedSandbox,
  checkSessionAllowed,
  type SandboxSpec,
} from '../src/index.js';

const spec = (cls: SandboxSpec['class'], repo?: string): SandboxSpec => ({
  session_id: 'guard-0001',
  class: cls,
  command: ['node', '--version'],
  repo: [],
  ...(cls === 'P' || cls === 'W' || cls === 'V' ? { gateway_key: 'aisk_0123456789abcdef' } : {}),
  ...(repo ? { repo_full_name: repo } : {}),
});

const deps = (o: { allow?: readonly string[] | null; open?: boolean | 'error' } = {}) => ({
  execAllowedRepos: () => (o.allow === undefined ? ['acme/owned'] : o.allow),
  hasOpenSecretFinding: async (_repo: string) =>
    o.open === 'error' ? err({ message: 'knowledge down' }) : ok(o.open === true),
});

describe('DEC-18 owner allow-list and B1 over classes', () => {
  it('refuses exec classes for a repo that is not on the allow-list, with exec_not_allowed', async () => {
    for (const cls of ['W', 'K-exec', 'O'] as const) {
      const r = await checkSessionAllowed(deps(), 'acme/other', cls);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.code).toBe('exec_not_allowed');
    }
  });
  it('an unreadable allow-list and an empty one allow nothing', async () => {
    for (const allow of [null, []] as const) {
      const r = await checkSessionAllowed(deps({ allow }), 'acme/owned', 'W');
      expect(r.ok === false && r.error.code).toBe('exec_not_allowed');
    }
  });
  it('an open secret finding blocks P, W, O, V and K-exec and never K', async () => {
    const blocked: string[] = [];
    for (const cls of SandboxClassValues) {
      const r = await checkSessionAllowed(deps({ open: true }), 'acme/owned', cls);
      if (!r.ok) {
        expect(r.error.code).toBe('b1_blocked');
        blocked.push(cls);
      }
    }
    expect(blocked.sort()).toEqual(['K-exec', 'O', 'P', 'V', 'W']);
  });
  it('cannot tell whether a finding is open: blocked (fail closed); K still runs', async () => {
    expect((await checkSessionAllowed(deps({ open: 'error' }), 'acme/owned', 'W')).ok).toBe(false);
    expect((await checkSessionAllowed(deps({ open: 'error' }), 'acme/owned', 'K')).ok).toBe(true);
  });
  it('a clean, owned repo passes every class; P and V need no allow-list (they run no repo code)', async () => {
    for (const cls of SandboxClassValues) {
      expect((await checkSessionAllowed(deps(), 'acme/owned', cls)).ok).toBe(true);
    }
    expect((await checkSessionAllowed(deps({ allow: [] }), 'acme/any', 'P')).ok).toBe(true);
  });
  it('a guarded sandbox starts nothing on a refusal and needs the repo named', async () => {
    const inner = new FakeSandbox(() => ({ exit_code: 0 }));
    const g = new GuardedSandbox(inner, deps({ open: true }));
    const a = await g.run(spec('W', 'acme/owned'));
    expect(a.ok === false && a.error.code).toBe('b1_blocked');
    const b = await g.run(spec('W'));
    expect(b.ok === false && b.error.code).toBe('refused');
    expect(inner.runs).toEqual([]);
    const clean = new GuardedSandbox(inner, deps());
    expect((await clean.run(spec('W', 'acme/owned'))).ok).toBe(true);
    expect(inner.runs).toHaveLength(1);
  });
});
