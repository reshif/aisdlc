import { readUnknown } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpCodeHostReads } from '../src/index.js';
import { startFakeCodehost } from './fake-codehost.js';

const TOKEN = 't'.repeat(32);
let ch: Awaited<ReturnType<typeof startFakeCodehost>>;
beforeAll(async () => {
  ch = await startFakeCodehost(TOKEN);
});
afterAll(() => ch.stop());

describe('HttpCodeHostReads', () => {
  it('reads repos, installation, a head and the rules as the port would', async () => {
    const c = new HttpCodeHostReads({ baseUrl: ch.url, token: TOKEN });
    const repos = await c.list_repos();
    expect(repos.state === 'ok' && repos.value.map((r) => r.full_name)).toEqual([
      'acme/app',
      'acme/lib',
    ]);
    expect(await c.installation()).toMatchObject({ state: 'ok', value: { installation_id: 4242 } });
    expect(await c.branch_head({ repo: 'acme/app', branch: 'main' })).toEqual({
      state: 'ok',
      value: 'a'.repeat(40),
    });
    const rules = await c.rules_for_branch({ repo: 'acme/app', branch: 'main' });
    expect(rules.state === 'ok' && rules.value.required_checks).toHaveLength(2);
  });

  it('passes a read that is not ok through, and never turns a failure into a value', async () => {
    const c = new HttpCodeHostReads({ baseUrl: ch.url, token: TOKEN });
    expect(await c.branch_head({ repo: 'acme/app', branch: 'nope' })).toMatchObject({
      state: 'unreadable',
      reason: 'not_found',
    });
    ch.gh.breakAll(readUnknown('rate_limited', 'slow'));
    expect(await c.list_repos()).toMatchObject({ state: 'unknown', reason: 'rate_limited' });
    ch.gh.unbreak();
    // Wrong token: the service answers 401; that is not a repo list.
    const bad = new HttpCodeHostReads({ baseUrl: ch.url, token: 'x'.repeat(32) });
    expect(await bad.list_repos()).toMatchObject({ state: 'unreadable', reason: 'forbidden' });
    // Nothing listening: unknown/network.
    const down = new HttpCodeHostReads({
      baseUrl: 'http://127.0.0.1:1',
      token: TOKEN,
      timeoutMs: 500,
    });
    expect(await down.installation()).toMatchObject({ state: 'unknown', reason: 'network' });
  });
});
