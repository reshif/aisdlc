import { FakePushGuards, HttpCodeHostPush } from '@aisdlc/ports';
import { WRITE_ITEM, WRITE_UNIT, writeRequest, writeSeed } from '@aisdlc/ports/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { TOKENS, startCodeHostApp, type CodeHostTestApp } from './stack.js';

// The codehost's HTTP door to the Push Broker (PLAN M13.6): service tokens and scopes in front of the one write, the repo
// allow-list in front of that, and `HttpCodeHostPush` (what core-worker uses) over it.

const noIdentity = { links: async () => ({ ok: true, value: [] }) } as never;
let s: CodeHostTestApp | null = null;
afterEach(async () => {
  await s?.stop();
  s = null;
});

const file = { op: 'put' as const, path: 'src/a.js', mode: '100644' as const, content_b64: 'eA==' };
async function start(registered = [{ project_id: 'acme', repo: 'acme/app' }]) {
  const guards = new FakePushGuards().setLease(WRITE_ITEM, WRITE_UNIT, {
    held: true,
    epoch: 3,
    lane: 'L4',
  });
  s = await startCodeHostApp(noIdentity, writeSeed(), registered, undefined, guards);
  return { s, guards };
}

describe('POST /v1/repos/:owner/:name/push', () => {
  it('needs the `push` scope: census, posture and unknown callers may not write', async () => {
    const { s } = await start();
    for (const t of [TOKENS.census, TOKENS.posture, TOKENS.all, TOKENS.none]) {
      expect(
        (await s.call(t, 'POST', '/v1/repos/acme/app/push', writeRequest([file]))).status,
        t,
      ).toBe(403);
    }
    expect(
      (await s.call(null, 'POST', '/v1/repos/acme/app/push', writeRequest([file]))).status,
    ).toBe(401);
    expect(s.gh.server.apiRequests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('writes a Draft PR for a push caller and answers the applied patch', async () => {
    const { s } = await start();
    const r = await s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/push', writeRequest([file]));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      state: 'ok',
      value: {
        branch: `agent/${WRITE_ITEM}/${WRITE_UNIT}`,
        created: true,
        pr: { number: 1, draft: true },
      },
    });
    // the body names the repo: another repository in the body is refused, not written
    const other = await s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/push', {
      ...writeRequest([file]),
      repo: 'acme/lib',
    });
    expect(other.status).toBe(400);
    expect((await s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/push', 'not json')).status).toBe(
      400,
    );
  });

  it('a repo with no S0 record is repo_not_allowed (403) and a push to it makes no request', async () => {
    const { s } = await start([]);
    const before = s.gh.server.apiRequests.length;
    const r = await s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/push', writeRequest([file]));
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ state: 'unreadable', reason: 'repo_not_allowed' });
    expect(s.gh.server.apiRequests.length).toBe(before);
  });

  it('M16 (OB §8, DEC-21): a repo suspended for drift refuses an agent push (403 prr_suspended); a human-led L8 push is not stopped by it', async () => {
    const { s, guards } = await start();
    guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: true, epoch: 3, lane: 'L4', suspended: true });
    const r = await s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/push', writeRequest([file]));
    expect(r.status).toBe(403);
    expect(r.json).toMatchObject({ code: 'prr_suspended' });
    expect(s.gh.server.apiRequests.filter((x) => x.method !== 'GET')).toEqual([]);
    guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: true, epoch: 3, lane: 'L8', suspended: true });
    const l8 = await s.call(
      TOKENS.push,
      'POST',
      '/v1/repos/acme/app/push',
      writeRequest([file], { lane: 'L8' }),
    );
    expect(l8.status).toBe(200);
  });

  it('a refusal is not a 2xx and carries its code: stale epoch and a moved branch are 409, a secret or a path 403', async () => {
    const { s } = await start();
    const post = (b: unknown) => s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/push', b);
    const stale = await post(writeRequest([file], { lease_epoch: 2 }));
    expect(stale.status).toBe(409);
    expect(stale.json).toMatchObject({ code: 'stale_epoch' });
    const outside = await post(writeRequest([file], { branch: 'main' }));
    expect(outside.status).toBe(403);
    expect(outside.json).toMatchObject({ code: 'branch_not_allowed' });
    const protectedPath = await post(writeRequest([{ ...file, path: 'AGENTS.md' }]));
    expect(protectedPath.json).toMatchObject({ code: 'protected_path' });
    expect(s.gh.server.apiRequests.filter((r) => r.method !== 'GET')).toEqual([]);
    // nothing in any response carries a token
    for (const o of s.outputs) expect(o).not.toMatch(/ghs_/);
  });
});

describe('HttpCodeHostPush (what core-worker holds) over the route', () => {
  it('apply_patch and pr_status round-trip, and a refusal comes back as the read that was not ok', async () => {
    const { s, guards } = await start();
    const client = new HttpCodeHostPush({ baseUrl: s.url, token: TOKENS.push });
    const a = await client.apply_patch(writeRequest([file]));
    expect(a).toMatchObject({
      state: 'ok',
      value: { created: true, pr: { number: 1, draft: true } },
    });
    const st = await client.pr_status({ repo: 'acme/app', number: 1 });
    expect(st).toMatchObject({
      state: 'ok',
      value: { number: 1, state: 'open', merged: false, draft: true, checks_read: false },
    });
    guards.setLease(WRITE_ITEM, WRITE_UNIT, { held: true, epoch: 9, lane: 'L4' });
    const stale = await client.apply_patch(
      writeRequest([file], { expected_head: a.state === 'ok' ? a.value.commit_sha : null }),
    );
    expect(stale).toMatchObject({ state: 'unreadable', reason: 'refused', code: 'stale_epoch' });
    // a wrong token is a refusal, never a success
    const bad = new HttpCodeHostPush({ baseUrl: s.url, token: TOKENS.census });
    expect((await bad.apply_patch(writeRequest([file]))).state).not.toBe('ok');
    // an unreachable codehost is unknown
    const down = new HttpCodeHostPush({ baseUrl: 'http://127.0.0.1:1', token: TOKENS.push });
    expect(await down.apply_patch(writeRequest([file]))).toMatchObject({ state: 'unknown' });
  });

  it('redraft_pr (owner decision 2026-11-13) round-trips under scope push, for exactly the PR in the path', async () => {
    const { s } = await start();
    const client = new HttpCodeHostPush({ baseUrl: s.url, token: TOKENS.push });
    expect((await client.apply_patch(writeRequest([file]))).state).toBe('ok');
    const req = {
      repo: 'acme/app',
      item_id: WRITE_ITEM,
      unit_key: WRITE_UNIT,
      branch: `agent/${WRITE_ITEM}/${WRITE_UNIT}`,
      pr_number: 1,
      lease_epoch: 3,
    };
    expect(await client.redraft_pr(req)).toMatchObject({
      state: 'ok',
      value: { pr_number: 1, draft: true, commented: true },
    });
    expect(s.gh.server.pulls[0]?.comments?.map((c) => c.body)).toHaveLength(1);
    // another scope may not, and the body must name the PR of the path
    for (const t of [TOKENS.census, TOKENS.posture]) {
      expect((await s.call(t, 'POST', '/v1/repos/acme/app/pulls/1/redraft', req)).status).toBe(403);
    }
    expect(
      (await s.call(TOKENS.push, 'POST', '/v1/repos/acme/app/pulls/2/redraft', req)).status,
    ).toBe(400);
    expect(s.gh.server.pulls[0]?.comments).toHaveLength(1);
  });
});
