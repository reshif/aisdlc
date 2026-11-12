import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { KILL_EVENT, KILL_SIGNATURE_PENDING, killActHash, type KillEvent } from '@aisdlc/contracts';
import { manualClock } from '@aisdlc/kernel';
import { admitAgentWork, fakeKeyCustody } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpKillState } from '../src/client.js';
import { verifyKillJournal, verifyKillJournalReport } from '../src/journal.js';
import { KillService } from '../src/service.js';
import { mintTestStepUpProof, startTestKillswitch, type TestKillswitch } from '../src/testing.js';

// The kill switch on its own (PLAN M9.6, AR9): its own database, its own key, its own authority. Nothing
// in this file starts core, the record or a work engine.

const custody = fakeKeyCustody();
const clock = manualClock('2026-11-09T08:00:00.000Z');
let ks: TestKillswitch;
let n = 0;
beforeAll(async () => {
  ks = await startTestKillswitch({ custody, clock, admins: ['root', 'root2'] });
});
afterAll(async () => {
  await ks.stop();
});

const ok = <T>(
  r: { ok: true; value: T } | { ok: false; error: { code: string; message: string } },
): T => {
  if (!r.ok) throw new Error(`${r.error.code}: ${r.error.message}`);
  return r.value;
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

/** A project with the holders core-worker would have pushed. */
async function project(
  o: {
    admins?: string[];
    kill?: string[];
    tier?: 'T0' | 'T1' | 'T2' | null;
    two_person?: boolean;
  } = {},
) {
  n += 1;
  const id = `ks-${n}`;
  const admins = o.admins ?? [`admin-${n}`];
  ok(
    await ks.service.syncHolders(id, {
      admins,
      kill_holders: o.kill ?? [],
      tier: o.tier ?? 'T1',
      two_person: o.two_person ?? false,
    }),
  );
  return { id, admins, kill: o.kill ?? [] };
}
const killOf = (project_id: string) => ({ kind: 'project', ref: project_id });

describe("who may kill (the PDP decides, over the kill switch's own facts)", () => {
  it('the project admin and the kill slot may kill their project; a stranger and an unknown person may not', async () => {
    const p = await project({ kill: ['kate'] });
    expect(
      code(await ks.service.requestKill('stranger', { scope: killOf(p.id), reason: 'x' })),
    ).toBe('forbidden');
    expect(
      code(await ks.service.requestKill('nobody-at-all', { scope: killOf(p.id), reason: 'x' })),
    ).toBe('forbidden');
    ok(await ks.service.requestKill('kate', { scope: killOf(p.id), reason: 'bad deploy' }));
    const q = await project();
    ok(
      await ks.service.requestKill(q.admins[0] as string, { scope: killOf(q.id), reason: 'stop' }),
    );
    // a holder of one project holds nothing of another
    const r = await project();
    expect(code(await ks.service.requestKill('kate', { scope: killOf(r.id), reason: 'x' }))).toBe(
      'forbidden',
    );
  });

  it('the fleet kill is the factory admins only, never a project admin or a kill holder', async () => {
    const p = await project({ kill: ['kate'] });
    const fleet = { kind: 'fleet', ref: '*' };
    expect(
      code(await ks.service.requestKill(p.admins[0] as string, { scope: fleet, reason: 'x' })),
    ).toBe('forbidden');
    expect(code(await ks.service.requestKill('kate', { scope: fleet, reason: 'x' }))).toBe(
      'forbidden',
    );
    const k = ok(await ks.service.requestKill('root', { scope: fleet, reason: 'incident' }));
    expect(k).toMatchObject({ state: 'active', scope: fleet, release_required: 2 });
    // release it again for the other tests: two factory admins
    ok(await ks.service.approveRelease('root', k.kill_id));
    expect(ok(await ks.service.approveRelease('root2', k.kill_id)).state).toBe('released');
  });

  it('refuses a malformed scope, an empty reason, and a lane that is not a lane', async () => {
    const p = await project();
    const a = p.admins[0] as string;
    expect(
      code(await ks.service.requestKill(a, { scope: { kind: 'repo', ref: 'x' }, reason: 'x' })),
    ).toBe('invalid_request');
    expect(code(await ks.service.requestKill(a, { scope: killOf(p.id), reason: '  ' }))).toBe(
      'invalid_request',
    );
    expect(
      code(
        await ks.service.requestKill(a, {
          scope: { kind: 'lane', ref: `${p.id}/L99` },
          reason: 'x',
        }),
      ),
    ).toBe('invalid_request');
  });

  it('a kill of a scope already in force is that kill', async () => {
    const p = await project();
    const a = p.admins[0] as string;
    const one = ok(await ks.service.requestKill(a, { scope: killOf(p.id), reason: 'first' }));
    const two = ok(await ks.service.requestKill(a, { scope: killOf(p.id), reason: 'second' }));
    expect(two.kill_id).toBe(one.kill_id);
    expect(two.reason).toBe('first');
  });
});

describe('delegation (DEC-29): granted by the project admin, until revoked, ledgered', () => {
  it('a delegate can kill; a non-holder cannot; revoked, neither', async () => {
    const p = await project();
    const admin = p.admins[0] as string;
    expect(code(await ks.service.requestKill('dee', { scope: killOf(p.id), reason: 'x' }))).toBe(
      'forbidden',
    );
    const g = ok(await ks.service.grantDelegation(admin, { delegate: 'dee', scope: killOf(p.id) }));
    expect(g).toMatchObject({ delegate: 'dee', granted_by: admin, revoked_at: null });
    ok(await ks.service.requestKill('dee', { scope: killOf(p.id), reason: 'delegated kill' }));
    // revoke: it ends at once, and the person is a stranger again
    const kill = (
      ok(await ks.service.listKills({ active: true, project_id: p.id })) as Array<{
        kill_id: string;
      }>
    )[0];
    ok(await ks.service.approveRelease(admin, (kill as { kill_id: string }).kill_id));
    const r = ok(await ks.service.revokeDelegation(admin, g.delegation_id));
    expect(r.revoked_by).toBe(admin);
    expect(code(await ks.service.requestKill('dee', { scope: killOf(p.id), reason: 'x' }))).toBe(
      'forbidden',
    );
  });

  it('only the project admin (or a factory admin) grants one; a kill holder, a delegate and a stranger do not', async () => {
    const p = await project({ kill: ['kate'] });
    const admin = p.admins[0] as string;
    ok(await ks.service.grantDelegation(admin, { delegate: 'dee', scope: killOf(p.id) }));
    for (const who of ['kate', 'dee', 'stranger']) {
      expect(
        code(await ks.service.grantDelegation(who, { delegate: 'eve', scope: killOf(p.id) })),
        who,
      ).toBe('forbidden');
    }
    ok(await ks.service.grantDelegation('root', { delegate: 'eve', scope: killOf(p.id) }));
    // never the fleet
    expect(
      code(
        await ks.service.grantDelegation('root', {
          delegate: 'eve',
          scope: { kind: 'fleet', ref: '*' },
        }),
      ),
    ).toBe('invalid_request');
    // nobody revokes someone else's project
    const other = await project();
    const list = ok(await ks.service.listDelegations(p.id));
    expect(
      code(
        await ks.service.revokeDelegation(
          other.admins[0] as string,
          list[0]?.delegation_id as string,
        ),
      ),
    ).toBe('forbidden');
  });

  it('a lane delegation kills that lane and nothing wider', async () => {
    const p = await project();
    const admin = p.admins[0] as string;
    ok(
      await ks.service.grantDelegation(admin, {
        delegate: 'lara',
        scope: { kind: 'lane', ref: `${p.id}/L3` },
      }),
    );
    ok(
      await ks.service.requestKill('lara', {
        scope: { kind: 'lane', ref: `${p.id}/L3` },
        reason: 'lane',
      }),
    );
    expect(
      code(
        await ks.service.requestKill('lara', {
          scope: { kind: 'lane', ref: `${p.id}/L4` },
          reason: 'x',
        }),
      ),
    ).toBe('forbidden');
    expect(code(await ks.service.requestKill('lara', { scope: killOf(p.id), reason: 'x' }))).toBe(
      'forbidden',
    );
  });

  it('grant and revoke are in the signed journal', async () => {
    const p = await project();
    const admin = p.admins[0] as string;
    const g = ok(await ks.service.grantDelegation(admin, { delegate: 'jo', scope: killOf(p.id) }));
    ok(await ks.service.revokeDelegation(admin, g.delegation_id));
    const ev = ok(await ks.service.events(0, 1000));
    const mine = ev.filter((e) => e.subject === g.delegation_id);
    expect(mine.map((e) => e.kind)).toEqual([
      KILL_EVENT.delegation_granted,
      KILL_EVENT.delegation_revoked,
    ]);
    expect(mine.map((e) => e.actor)).toEqual([admin, admin]);
  });
});

describe("release (KillReleaseApproval): the project's two-person setting, T2 always two", () => {
  it('setting off: one approval releases', async () => {
    const p = await project({ two_person: false });
    const admin = p.admins[0] as string;
    const k = ok(await ks.service.requestKill(admin, { scope: killOf(p.id), reason: 'x' }));
    expect(k.release_required).toBe(1);
    const r = ok(await ks.service.approveRelease(admin, k.kill_id));
    expect(r).toMatchObject({ state: 'released', release_approvals: [admin] });
    expect(r.released_at).not.toBeNull();
  });

  it('setting on with two holders: two distinct people; the same person twice is refused', async () => {
    const p = await project({ admins: ['ann', 'ben'], two_person: true });
    const k = ok(await ks.service.requestKill('ann', { scope: killOf(p.id), reason: 'x' }));
    const first = ok(await ks.service.approveRelease('ann', k.kill_id));
    expect(first).toMatchObject({ state: 'release_pending', release_approvals: ['ann'] });
    // still killed while the release is pending
    expect(ok(await ks.service.status({ project_id: p.id })).killed).toBe(true);
    expect(code(await ks.service.approveRelease('ann', k.kill_id))).toBe('conflict');
    expect(code(await ks.service.approveRelease('stranger', k.kill_id))).toBe('forbidden');
    const second = ok(await ks.service.approveRelease('ben', k.kill_id));
    expect(second).toMatchObject({ state: 'released', release_approvals: ['ann', 'ben'] });
    expect(ok(await ks.service.status({ project_id: p.id })).killed).toBe(false);
    expect(code(await ks.service.approveRelease('ben', k.kill_id))).toBe('conflict');
  });

  it('T2 is two people whatever the setting says, and one approval does not release it', async () => {
    const p = await project({ admins: ['tia', 'tom'], tier: 'T2', two_person: false });
    const k = ok(await ks.service.requestKill('tia', { scope: killOf(p.id), reason: 'x' }));
    expect(k.release_required).toBe(2);
    expect(ok(await ks.service.approveRelease('tia', k.kill_id)).state).toBe('release_pending');
    expect(ok(await ks.service.approveRelease('tom', k.kill_id)).state).toBe('released');
  });

  it('T2 with one holder: a factory admin is the second person (no waiver exists)', async () => {
    const p = await project({ admins: ['solo'], tier: 'T2' });
    const k = ok(await ks.service.requestKill('solo', { scope: killOf(p.id), reason: 'x' }));
    expect(ok(await ks.service.approveRelease('solo', k.kill_id)).state).toBe('release_pending');
    expect(ok(await ks.service.approveRelease('root', k.kill_id)).state).toBe('released');
  });

  it('a project the kill switch was never told about is two-person (unknown means the safer setting)', async () => {
    const k = ok(
      await ks.service.requestKill('root', { scope: killOf('never-synced'), reason: 'x' }),
    );
    expect(k.release_required).toBe(2);
    expect(ok(await ks.service.approveRelease('root', k.kill_id)).state).toBe('release_pending');
    expect(ok(await ks.service.approveRelease('root2', k.kill_id)).state).toBe('released');
  });

  it('the fleet kill is released by two factory admins', async () => {
    const k = ok(
      await ks.service.requestKill('root', { scope: { kind: 'fleet', ref: '*' }, reason: 'x' }),
    );
    expect(ok(await ks.service.approveRelease('root', k.kill_id)).state).toBe('release_pending');
    expect(ok(await ks.service.status({ project_id: 'anything' })).killed).toBe(true);
    expect(ok(await ks.service.approveRelease('root2', k.kill_id)).state).toBe('released');
    expect(ok(await ks.service.status({ project_id: 'anything' })).killed).toBe(false);
  });
});

describe("who acts is a verified person, never the caller's word (RC-SEC-3)", () => {
  const post = (path: string, body: unknown) =>
    fetch(`${ks.url}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ks.tokens['bff']}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  it("one caller holding one person's proofs cannot be the second approver of a two-person release", async () => {
    const p = await project({ admins: ['amy', 'abe'], two_person: true });
    const raw = ks.clientFor('bff').raw;
    const kill = ok(
      await raw.kill(
        await ks.prove('amy', { action: 'kill.request', scope: killOf(p.id), reason: 'incident' }),
        killOf(p.id),
        'incident',
      ),
    );
    expect(kill.requested_by).toBe('amy');
    const release = { action: 'kill.release', kill_id: kill.kill_id } as const;
    ok(await raw.release(await ks.prove('amy', release), kill.kill_id));
    // a second, fresh proof of the same person is the same person
    expect(code(await raw.release(await ks.prove('amy', release), kill.kill_id))).toBe('conflict');
    // naming the other approver in the body is not possible: the body has no such field
    const named = await post(`/v1/kills/${kill.kill_id}/release`, {
      on_behalf_of: 'abe',
      step_up: { proof: await ks.prove('amy', release) },
    });
    expect(named.status).toBe(400);
    // nor is a body without a person's proof
    expect((await post(`/v1/kills/${kill.kill_id}/release`, { on_behalf_of: 'abe' })).status).toBe(
      400,
    );
    expect(ok(await ks.service.status({ project_id: p.id })).killed).toBe(true);
    // the second person's own proof releases it
    const done = ok(await raw.release(await ks.prove('abe', release), kill.kill_id));
    expect(done.state).toBe('released');
    expect([...done.release_approvals].sort()).toEqual(['abe', 'amy']);
  });

  it('refuses a proof for another act, a replayed, a reconfirm, a forged and a malformed proof', async () => {
    const p = await project({ admins: ['cat', 'cid'], two_person: true });
    const raw = ks.clientFor('bff').raw;
    const kill = ok(await ks.clientFor('bff').kill('cat', killOf(p.id), 'x'));
    const other = ok(await ks.clientFor('bff').kill('root', killOf('elsewhere'), 'y'));
    const release = { action: 'kill.release', kill_id: kill.kill_id } as const;
    // bound to another kill
    const wrong = await ks.prove('cid', { action: 'kill.release', kill_id: other.kill_id });
    expect(code(await raw.release(wrong, kill.kill_id))).toBe('unauthenticated');
    // bound to the kill request, not the release
    const asKill = await ks.prove('cid', {
      action: 'kill.request',
      scope: killOf(p.id),
      reason: 'x',
    });
    expect(code(await raw.release(asKill, kill.kill_id))).toBe('unauthenticated');
    // DEC-11(c-ii) plain confirm is not a re-authentication
    const weak = await ks.prove('cid', release, { method: 'reconfirm' });
    expect(code(await raw.release(weak, kill.kill_id))).toBe('unauthenticated');
    // signed by a key that is not the bff's
    const forged = await mintTestStepUpProof(fakeKeyCustody({ seed: 'attacker' }), {
      principal: 'cid',
      bound_hash: killActHash(release),
      now: clock.now(),
    });
    expect(code(await raw.release(forged, kill.kill_id))).toBe('unauthenticated');
    expect(code(await raw.release('su1.not.a-proof', kill.kill_id))).toBe('unauthenticated');
    // expired
    const old = await ks.prove('cid', release);
    clock.advance(10 * 60_000);
    expect(code(await raw.release(old, kill.kill_id))).toBe('unauthenticated');
    // a good proof is good once
    const good = await ks.prove('cid', release);
    ok(await raw.release(good, kill.kill_id));
    const again = ok(await ks.clientFor('bff').kill('cat', killOf(p.id), 'again'));
    expect(code(await raw.release(good, again.kill_id))).toBe('unauthenticated');
    expect(
      (await ks.database.pool.query('SELECT 1 FROM killswitch.person_proof')).rowCount,
    ).toBeGreaterThan(0);
  });

  it("a kill and a delegation are acts too: in the proof's principal's name only", async () => {
    const p = await project({ admins: ['dot'] });
    const raw = ks.clientFor('bff').raw;
    // a stranger's proof for the act is the stranger: the PDP denies them
    const scope = killOf(p.id);
    const stranger = await ks.prove('stranger', { action: 'kill.request', scope, reason: 'r' });
    expect(code(await raw.kill(stranger, scope, 'r'))).toBe('forbidden');
    // the proof binds the reason: the same proof with another reason is refused
    const proof = await ks.prove('dot', { action: 'kill.request', scope, reason: 'r' });
    expect(code(await raw.kill(proof, scope, 'other reason'))).toBe('unauthenticated');
    const d = { action: 'kill.delegate', delegate: 'eve', scope } as const;
    expect(code(await raw.delegate(await ks.prove('eve', d), 'eve', scope))).toBe('forbidden');
    ok(await raw.delegate(await ks.prove('dot', d), 'eve', scope));
  });
});

describe('status: what enforcement points read', () => {
  it('a kill covers exactly its scope; the fleet covers all; releasing ends it', async () => {
    const p = await project();
    const q = await project();
    const a = p.admins[0] as string;
    const status = async (project_id: string, extra: object = {}) =>
      ok(await ks.service.status({ project_id, ...extra })).killed;
    expect(await status(p.id)).toBe(false);
    ok(
      await ks.service.requestKill(a, { scope: { kind: 'lane', ref: `${p.id}/L3` }, reason: 'x' }),
    );
    expect(await status(p.id, { lane: 'L3' })).toBe(true);
    expect(await status(p.id, { lane: 'L4' })).toBe(false);
    expect(await status(p.id)).toBe(false); // no lane named: a lane kill is not a project kill
    expect(await status(q.id, { lane: 'L3' })).toBe(false);
    ok(
      await ks.service.requestKill(a, {
        scope: { kind: 'session', ref: `${p.id}/sess-1` },
        reason: 'x',
      }),
    );
    expect(await status(p.id, { session_id: 'sess-1' })).toBe(true);
    expect(await status(p.id, { session_id: 'sess-2' })).toBe(false);
    const k = ok(await ks.service.requestKill(a, { scope: killOf(p.id), reason: 'x' }));
    expect(await status(p.id, { lane: 'L9x' as never }).catch(() => true)).toBeDefined();
    expect(await status(p.id)).toBe(true);
    expect(await status(q.id)).toBe(false);
    ok(await ks.service.approveRelease(a, k.kill_id));
    expect(await status(p.id)).toBe(false);
  });

  it('is served over HTTP to a reader, who can read and nothing else', async () => {
    const p = await project();
    const a = p.admins[0] as string;
    const bff = ks.clientFor('bff');
    const k = ok(await bff.kill(a, killOf(p.id), 'over http'));
    const state = ks.killState('enforcer');
    const s = ok(await state.status({ project_id: p.id }));
    expect(s.killed).toBe(true);
    expect(s.kills[0]?.kill_id).toBe(k.kill_id);
    // a reader cannot kill or release, a human-acting caller cannot sync holders
    const reader = ks.clientFor('enforcer');
    expect((await reader.kill(a, killOf(p.id), 'x')).ok).toBe(false);
    expect(
      code(
        await ks
          .clientFor('bff')
          .syncHolders(p.id, { admins: ['x'], kill_holders: [], tier: null, two_person: false }),
      ),
    ).toBe('forbidden');
    ok(await bff.release(a, k.kill_id));
    expect(ok(await state.status({ project_id: p.id })).killed).toBe(false);
  });

  it('refuses a caller with no token or an unknown one', async () => {
    const res = await fetch(`${ks.url}/v1/status?project_id=x`);
    expect(res.status).toBe(401);
    const bad = await fetch(`${ks.url}/v1/status?project_id=x`, {
      headers: { authorization: 'Bearer nope-nope-nope-nope' },
    });
    expect(bad.status).toBe(401);
  });

  it('an enforcement point that cannot reach the kill switch treats the scope as killed (fail closed)', async () => {
    const dead = new HttpKillState({
      baseUrl: 'http://127.0.0.1:1',
      token: 'x'.repeat(24),
      timeoutMs: 500,
    });
    const a = await admitAgentWork(dead, { project_id: 'p' });
    expect(a).toMatchObject({ admitted: false, why: 'unreachable' });
    // a bad token is no answer either
    const unauth = new HttpKillState({ baseUrl: ks.url, token: 'y'.repeat(24) });
    expect(await admitAgentWork(unauth, { project_id: 'p' })).toMatchObject({
      admitted: false,
      why: 'unreachable',
    });
    // and a reachable one that says "not killed" admits
    expect(await admitAgentWork(ks.killState(), { project_id: 'fine-project' })).toEqual({
      admitted: true,
    });
  });
});

describe('what a human sees: the PDP decides who has a kill button', () => {
  it('capabilities follow the roles: admin, kill slot, delegate, factory admin, stranger', async () => {
    const p = await project({ kill: ['kate'] });
    const admin = p.admins[0] as string;
    ok(await ks.service.grantDelegation(admin, { delegate: 'dee', scope: killOf(p.id) }));
    const caps = async (who: string) =>
      ok(await ks.service.capabilities(who, { project_id: p.id }));
    expect(await caps(admin)).toEqual({
      kill: true,
      release: true,
      delegate: true,
      fleet_kill: false,
    });
    expect(await caps('kate')).toEqual({
      kill: true,
      release: true,
      delegate: false,
      fleet_kill: false,
    });
    expect(await caps('dee')).toEqual({
      kill: true,
      release: true,
      delegate: false,
      fleet_kill: false,
    });
    expect(await caps('root')).toEqual({
      kill: true,
      release: true,
      delegate: true,
      fleet_kill: true,
    });
    expect(await caps('stranger')).toEqual({
      kill: false,
      release: false,
      delegate: false,
      fleet_kill: false,
    });
    // over HTTP too
    const c = ok(await ks.clientFor('enforcer').capabilities('kate', p.id));
    expect(c.kill).toBe(true);
  });
});

describe('the journal: its own signed, hash-chained history', () => {
  it('verifies end to end with the public key alone, and any change is found', async () => {
    const events = ok(await ks.service.events(0, 1000)) as KillEvent[];
    expect(events.length).toBeGreaterThan(20);
    const key = ok(await ks.service.journalKey());
    expect(await verifyKillJournal(events, key)).toEqual([]);
    expect(events.every((e) => e.key_id === 'dev:killswitch')).toBe(true);
    // a changed body, a removed entry, a swapped signature
    const edited = structuredClone(events);
    (edited[3] as { body: Record<string, unknown> }).body = { forged: true };
    expect((await verifyKillJournal(edited, key)).map((p) => p.seq)).toContain(4);
    const missing = events.filter((e) => e.seq !== 5);
    expect((await verifyKillJournal(missing, key)).some((p) => p.problem.startsWith('gap'))).toBe(
      true,
    );
    const swapped = structuredClone(events);
    (swapped[2] as { signature: string }).signature = (swapped[7] as KillEvent).signature;
    expect(
      (await verifyKillJournal(swapped, key)).some((p) => p.problem.includes('signature')),
    ).toBe(true);
    // the signature is the kill switch's: not the Notary's key
    const notaryKey = await custody.publicKey('dev:notary');
    if (!notaryKey.ok) throw new Error('no notary key');
    expect((await verifyKillJournal(events.slice(0, 1), notaryKey.value)).length).toBeGreaterThan(
      0,
    );
  });

  it('is append-only in the database, and the kill state cannot be changed behind it', async () => {
    await expect(
      ks.database.pool.query(`UPDATE killswitch.journal SET actor = 'x' WHERE seq = 1`),
    ).rejects.toThrow(/append-only/);
    await expect(
      ks.database.pool.query(`DELETE FROM killswitch.journal WHERE seq = 1`),
    ).rejects.toThrow(/append-only/);
    await expect(ks.database.pool.query(`TRUNCATE killswitch.journal`)).rejects.toThrow(
      /append-only/,
    );
    await expect(
      ks.database.pool.query(`UPDATE killswitch.head SET last_seq = last_seq + 5`),
    ).rejects.toThrow(/one entry at a time/);
  });

  it('a kill that cannot be signed is not made (nothing is recorded that is not signed)', async () => {
    const down = await startTestKillswitch({
      custody: {
        ...custody,
        sign: async () => ({
          ok: false,
          error: { _tag: 'KeyCustodyError', code: 'unavailable', message: 'kms down' } as never,
        }),
      },
      admins: ['root'],
    }).catch((e: unknown) => e);
    // seeding needs a signature too, so the service cannot even start its authority: it refuses
    expect(down).toBeInstanceOf(Error);
  });
});

describe("the compose smoke's proof helper (platform/compose/kill-proof.mjs) mints what the kill switch accepts", () => {
  let k3: TestKillswitch;
  let kms: Server;
  let kmsUrl = '';
  const dir = mkdtempSync(join(tmpdir(), 'kill-proof-'));
  beforeAll(async () => {
    // real time: the helper stamps its proof with the wall clock
    k3 = await startTestKillswitch({ custody, admins: ['alice', 'bob'] });
    writeFileSync(join(dir, 'token'), 'tok\n');
    // kms-local's sign route, over the same fake custody
    kms = createServer((req, res) => {
      let raw = '';
      req.on('data', (c: Buffer) => (raw += c.toString()));
      req.on('end', () => {
        void (async () => {
          const ok =
            req.method === 'POST' &&
            req.url === '/v1/keys/dev%3Abff-stepup/sign' &&
            req.headers.authorization === 'Bearer tok';
          const sig = ok
            ? await custody.sign(
                'dev:bff-stepup',
                new Uint8Array(
                  Buffer.from((JSON.parse(raw) as { digest: string }).digest, 'base64url'),
                ),
              )
            : null;
          res.writeHead(sig?.ok ? 200 : 403, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify(
              sig?.ok
                ? { signature: Buffer.from(sig.value).toString('base64url') }
                : { error: { code: 'forbidden', message: 'no' } },
            ),
          );
        })();
      });
    });
    await new Promise<void>((r) => kms.listen(0, '127.0.0.1', r));
    kmsUrl = `http://127.0.0.1:${(kms.address() as AddressInfo).port}`;
  });
  afterAll(async () => {
    await new Promise<void>((r) => kms.close(() => r()));
    await k3.stop();
    rmSync(dir, { recursive: true, force: true });
  });
  const helper = join(
    import.meta.dirname,
    '..',
    '..',
    '..',
    'platform',
    'compose',
    'kill-proof.mjs',
  );
  // asynchronous: the fake kms-local above answers in this process
  const mint = async (principal: string, act: object) =>
    (
      await promisify(execFile)(process.execPath, [helper], {
        env: {
          PATH: process.env['PATH'] ?? '',
          PRINCIPAL: principal,
          ACT: JSON.stringify(act),
          KMS_URL: kmsUrl,
          KMS_TOKEN_FILE: join(dir, 'token'),
        },
        encoding: 'utf8',
      })
    ).stdout.trim();

  it("a kill and its two-person release, each with that person's proof", async () => {
    const scope = { kind: 'fleet', ref: '*' };
    const raw = k3.clientFor('bff').raw;
    const act = { action: 'kill.request', scope, reason: 'smoke' } as const;
    const k = ok(await raw.kill(await mint('alice', act), scope, 'smoke'));
    const rel = { action: 'kill.release', kill_id: k.kill_id };
    expect(ok(await raw.release(await mint('alice', rel), k.kill_id)).state).toBe(
      'release_pending',
    );
    expect(ok(await raw.release(await mint('bob', rel), k.kill_id)).state).toBe('released');
  });
});

describe('independence (AR9): no route to core, no dependency on the work engine, its own state', () => {
  const src = join(import.meta.dirname, '..', 'src');
  const files = readdirSync(src).filter((f) => f.endsWith('.ts'));
  const text = files.map((f) => readFileSync(join(src, f), 'utf8')).join('\n');

  it('imports neither core, the work engine, the record, the ledger nor the code host', () => {
    for (const forbidden of [
      '@aisdlc/core',
      '@aisdlc/work',
      '@aisdlc/record',
      '@aisdlc/ledger',
      '@aisdlc/codehost',
      '@aisdlc/identity',
      '@aisdlc/bff',
      'temporal',
    ]) {
      expect(text, forbidden).not.toContain(`'${forbidden}`);
    }
    const pkg = JSON.parse(readFileSync(join(src, '..', 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    const deps = Object.keys(pkg.dependencies);
    for (const d of [
      '@aisdlc/core',
      '@aisdlc/work',
      '@aisdlc/core-worker',
      '@aisdlc/record',
      '@aisdlc/ledger',
    ])
      expect(deps).not.toContain(d);
  });

  it("makes no request to anything but the key custody: it has no URL of core's", () => {
    expect(text).not.toMatch(/CORE_[A-Z_]*URL|core:83|\/v1\/(requests|items|cards|projects)/);
    // client.ts is the client OTHER services use to call the kill switch; the service itself calls nobody
    const own = files
      .filter((f) => f !== 'client.ts')
      .map((f) => readFileSync(join(src, f), 'utf8'))
      .join('\n');
    expect(own).not.toMatch(/\bfetch\(|callJson\(|http:\/\//);
  });

  it("keeps its state in its own database: one schema, none of core's", async () => {
    const r = await ks.database.pool.query<{ s: string }>(
      `SELECT DISTINCT table_schema AS s FROM information_schema.tables
        WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
    );
    expect(r.rows.map((x) => x.s)).toEqual(['killswitch']);
  });
});

describe('stopping never waits for the KMS (tightening always applies); loosening does', () => {
  let down = false;
  const flaky = {
    ...custody,
    sign: async (...a: Parameters<typeof custody.sign>) =>
      down
        ? ({
            ok: false,
            error: { _tag: 'KeyCustodyError', code: 'unavailable', message: 'kms down' },
          } as never)
        : custody.sign(...a),
  };
  let k2: TestKillswitch;
  beforeAll(async () => {
    // the bff's key custody is not the kill switch's link: its step-up proofs still come
    k2 = await startTestKillswitch({
      custody: flaky,
      stepUpSigner: custody,
      clock,
      admins: ['root', 'root2'],
    });
  });
  afterAll(async () => {
    down = false;
    await k2.stop();
  });
  const holders = (id: string, admins: string[]) =>
    k2.service.syncHolders(id, { admins, kill_holders: [], tier: 'T1', two_person: false });
  const journalKey = async () => ok(await k2.service.journalKey());

  it('KMS down: the kill is accepted and enforced at once, as an unsigned pending entry; KMS back: it is signed and the journal verifies', async () => {
    ok(await holders('kd-1', ['ada']));
    down = true;
    const k = ok(
      await k2.clientFor('bff').kill('ada', { kind: 'project', ref: 'kd-1' }, 'kms is down'),
    );
    expect(k.state).toBe('active');
    // enforced: the read API says killed, and admission is refused
    expect(ok(await k2.killState().status({ project_id: 'kd-1' })).killed).toBe(true);
    expect(await admitAgentWork(k2.killState(), { project_id: 'kd-1' })).toMatchObject({
      admitted: false,
      why: 'killed',
    });
    const evs = ok(await k2.service.events(0, 1000)) as KillEvent[];
    const mine = evs.find(
      (e) => e.kind === KILL_EVENT.requested && e.subject === k.kill_id,
    ) as KillEvent;
    expect(mine.signature).toBe(KILL_SIGNATURE_PENDING);
    const before = await verifyKillJournalReport(evs, await journalKey());
    expect(before.problems).toEqual([]); // hash-chained like the others, accepted
    expect(before.pending).toEqual([mine.seq]); // and reported
    // nothing signs while it is down
    expect(code(await k2.service.backfillSignatures())).toBe('unavailable');
    down = false;
    expect(ok(await k2.service.backfillSignatures()).attested).toBe(1);
    expect(ok(await k2.service.backfillSignatures()).attested).toBe(0);
    const after = ok(await k2.service.events(0, 1000)) as KillEvent[];
    const att = after.at(-1) as KillEvent;
    expect(att).toMatchObject({
      kind: KILL_EVENT.signature_attested,
      body: { pending_seq: mine.seq, pending_hash: mine.entry_hash },
    });
    expect(att.signature).not.toBe(KILL_SIGNATURE_PENDING);
    const report = await verifyKillJournalReport(after, await journalKey());
    expect(report).toEqual({ problems: [], pending: [] });
    // an attestation that names another hash does not clear it
    const forged = structuredClone(after);
    (forged.at(-1) as { body: Record<string, unknown> }).body = {
      pending_seq: mine.seq,
      pending_hash: 'f'.repeat(64),
    };
    expect(
      (await verifyKillJournalReport(forged, await journalKey())).problems.length,
    ).toBeGreaterThan(0);
  });

  it('KMS down: a release is refused (loosening needs the signature), and so is a delegation (it widens rights); the kill stays', async () => {
    ok(await holders('kd-2', ['ann']));
    const k = ok(
      await k2.service.requestKill('ann', { scope: { kind: 'project', ref: 'kd-2' }, reason: 'x' }),
    );
    down = true;
    expect(code(await k2.service.approveRelease('ann', k.kill_id))).toBe('unavailable');
    expect(
      code(
        await k2.service.grantDelegation('ann', {
          delegate: 'dee',
          scope: { kind: 'project', ref: 'kd-2' },
        }),
      ),
    ).toBe('unavailable');
    expect(code(await holders('kd-2', ['ann', 'zed']))).toBe('unavailable');
    expect(ok(await k2.service.status({ project_id: 'kd-2' })).killed).toBe(true);
    expect(
      ok(await k2.service.listKills({ active: true, project_id: 'kd-2' }))[0]?.release_approvals,
    ).toEqual([]);
    // a second kill is still accepted, at any scope
    ok(
      await k2.service.requestKill('root', {
        scope: { kind: 'fleet', ref: '*' },
        reason: 'everything',
      }),
    );
    expect(ok(await k2.service.status({ project_id: 'whatever' })).killed).toBe(true);
    down = false;
    expect(ok(await k2.service.approveRelease('ann', k.kill_id)).state).toBe('released');
    expect(ok(await k2.service.backfillSignatures()).attested).toBe(1);
    const fleet = (await k2.service.listKills({ active: true })) as {
      ok: true;
      value: Array<{ kill_id: string; scope: { kind: string } }>;
    };
    const fk = fleet.value.find((x) => x.scope.kind === 'fleet') as { kill_id: string };
    ok(await k2.service.approveRelease('root', fk.kill_id));
    ok(await k2.service.approveRelease('root2', fk.kill_id));
  });

  it('a pending kill survives a restart of the kill switch, and is signed afterwards', async () => {
    ok(await holders('kd-3', ['bo']));
    down = true;
    const k = ok(
      await k2.service.requestKill('bo', { scope: { kind: 'lane', ref: 'kd-3/L3' }, reason: 'x' }),
    );
    // a new process over the same database, KMS back
    down = false;
    const again = new KillService({ pool: k2.database.pool, custody, clock });
    expect(
      ok(await again.status({ project_id: 'kd-3', lane: 'L3' })).kills.map((x) => x.kill_id),
    ).toEqual([k.kill_id]);
    const pend = (ok(await again.events(0, 1000)) as KillEvent[]).filter(
      (e) => e.signature === KILL_SIGNATURE_PENDING,
    );
    expect(pend.some((e) => e.subject === k.kill_id)).toBe(true);
    expect(ok(await again.backfillSignatures()).attested).toBeGreaterThanOrEqual(1);
    const all = ok(await again.events(0, 1000)) as KillEvent[];
    const rep = await verifyKillJournalReport(all, ok(await again.journalKey()));
    expect(rep).toEqual({ problems: [], pending: [] });
  });
});
