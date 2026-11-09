import { inspect } from 'node:util';
import { describe, expect, it } from 'vitest';
import { FakeAgentKeys, RunKeyVault, type AgentKeyRequest } from '../src/index.js';

const req = (over: Partial<AgentKeyRequest['mint']> = {}): AgentKeyRequest => ({
  budget: { group_id: 'unit:i1:coder', max_tokens: 1000, max_cost_micro_usd: 5000 },
  mint: {
    scope: { kind: 'unit', ref: 'i1' },
    project_id: 'p1' as never,
    lane: 'L3',
    data_class_max: 'D2',
    models: ['claude-sonnet-5-5'],
    tools: ['Read', 'Grep'],
    budget_group: 'unit:i1:coder',
    expires_at: '2026-11-09T12:00:00.000Z',
    item_id: 'i1',
    step: '6.4',
    ...over,
  },
});

describe('FakeAgentKeys (the AgentKeyPort fake)', () => {
  it('mints a key with exactly what was asked, and a copy of it cannot widen the one it holds', async () => {
    const keys = new FakeAgentKeys();
    const r = await keys.mint(req());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.vkey).toMatchObject({
      vkey_id: 'fake-vkey-1',
      tools: ['Read', 'Grep'],
      data_class_max: 'D2',
      budget_group: 'unit:i1:coder',
      step: '6.4',
    });
    expect(r.value.secret).toMatch(/^aisk_[0-9a-f]{48}$/);
    // the caller's copy is its own
    (r.value.vkey.tools as string[]).push('Bash');
    expect(keys.view('fake-vkey-1')?.tools).toEqual(['Read', 'Grep']);
    const v = keys.view('fake-vkey-1');
    v?.tools.push('Bash');
    expect(keys.all()[0]?.tools).toEqual(['Read', 'Grep']);
  });

  it("validates the request with the gateway's own contract, and is deterministic", async () => {
    const keys = new FakeAgentKeys();
    expect((await keys.mint(req({ data_class_max: 'D9' as never }))).ok).toBe(false);
    expect((await keys.mint(req({ budget_group: 'other' }))).ok).toBe(false);
    expect(keys.requests).toHaveLength(0);
    const a = await new FakeAgentKeys().mint(req());
    const b = await new FakeAgentKeys().mint(req());
    expect(a).toEqual(b);
  });

  it('can be unreachable or refuse, and then mints nothing', async () => {
    const down = new FakeAgentKeys().breakIt();
    const r = await down.mint(req());
    expect(r).toMatchObject({ ok: false, error: { _tag: 'AgentKeyError', code: 'unavailable' } });
    const refusing = new FakeAgentKeys().refuseWith('killed');
    expect(await refusing.mint(req())).toMatchObject({ ok: false, error: { code: 'killed' } });
    expect(down.all()).toHaveLength(0);
    expect(refusing.all()).toHaveLength(0);
  });
});

describe("RunKeyVault (the in-process seam for a run key's secret)", () => {
  it('lends the secret for one call and never returns it as a value; a run it holds nothing for is null', async () => {
    const v = new RunKeyVault();
    v.put('run-1', 'vk-1', 'aisk_secret_value');
    expect(await v.lend('run-1', async (s) => s.length)).toBe('aisk_secret_value'.length);
    expect(await v.lend('run-2', async () => 'x')).toBeNull();
    expect(v.keyOf('run-1')).toBe('vk-1');
    expect(v.has('run-1')).toBe(true);
  });

  it('serialises, prints and inspects as a count, whatever it holds', async () => {
    const v = new RunKeyVault();
    v.put('run-1', 'vk-1', 'aisk_secret_value');
    for (const shown of [
      JSON.stringify(v),
      String(inspect(v)),
      `${JSON.stringify({ v })}`,
      inspect({ nested: { v } }, { depth: 5 }),
    ]) {
      expect(shown).not.toContain('aisk_secret_value');
    }
    expect(JSON.stringify(v)).toBe('{"vault":"run-key","held":1}');
    expect(Object.keys(v)).toEqual([]);
    expect(Object.getOwnPropertyNames(v)).toEqual([]);
  });

  it('drop forgets the secret and says which key it was', async () => {
    const v = new RunKeyVault();
    v.put('run-1', 'vk-1', 's');
    expect(v.drop('run-1')).toBe('vk-1');
    expect(v.has('run-1')).toBe(false);
    expect(v.drop('run-1')).toBeNull();
    expect(v.size).toBe(0);
  });

  it('FakeAgentKeys can revoke a key it minted, and only that', async () => {
    const keys = new FakeAgentKeys();
    const k = await keys.mint(req());
    if (!k.ok) throw new Error('mint');
    expect((await keys.revoke(k.value.vkey.vkey_id)).ok).toBe(true);
    expect(keys.view(k.value.vkey.vkey_id)?.revoked_at).not.toBeNull();
    expect((await keys.revoke('nope')).ok).toBe(false);
    expect(keys.revoked).toEqual([k.value.vkey.vkey_id]);
  });
});
