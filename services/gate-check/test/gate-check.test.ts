import { randomUUID } from 'node:crypto';
import {
  GATE_CHECK_NAME,
  GATE_EVENT,
  MERGE_BYPASS_CONFIG_KEY,
  MergeBypassConfig,
  type GateCheckVerdict,
} from '@aisdlc/contracts';
import { mergeReviewLoop, observeBypassMerges } from '@aisdlc/core';
import { createPool } from '@aisdlc/db';
import { readGateState } from '@aisdlc/decisions';
import { FAKE_PUSH_BROKER_LOGIN, FakeGitHub, emptySeed, readUnknown } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RecordFacts,
  StaticNotaryKey,
  hexTokensOf,
  launderingOf,
  listMerges,
  listVerdicts,
  rebuildGateCheck,
} from '../src/index.js';
import {
  BASE,
  CATALOGUE_REF,
  GC_APP,
  PROJECT,
  profileOf,
  REPO,
  S0_REPO,
  agentPr,
  brokerPush,
  g3,
  proposeBypass,
  pullOf,
  signPack,
  startWorld,
  type World,
} from './fixture.js';

// PLAN M14.5 on a real Postgres with the whole migrate plan, the real Notary and ledger, the fake GitHub (two Apps on
// one host). The SP-FID-1 equivalent (onboarding-roadmap §13: "what gate-check gives an agent/* PR and a human PR under
// protect-main; whether any human or L8 PR can merge") is the first describe: only the genuine agent PR and the L8 PR
// pass; a moved head, a forged pack, a laundered head, a person's PR and an S0 PR never do; every merge without a pass
// is recorded and gets its X4 review, a listed person's as a bypass, anyone else's as unauthorised.

let w: World;
beforeAll(async () => {
  w = await startWorld();
}, 120_000);
afterAll(async () => {
  await w?.stop();
});

const verdict = async (n: number, repo = w.repo, over = {}): Promise<GateCheckVerdict> =>
  w.checker(over).verdictFor(repo, await pullOf(w, repo.repo, n));

/** The newest aisdlc/gate check run gate-check's App wrote on a head. */
const runOn = (head: string, repo = REPO) =>
  w.fake
    .checkRunsOf(repo)
    .filter((r) => r.head_sha === head && r.name === GATE_CHECK_NAME && r.app_id === GC_APP.app_id)
    .at(-1);

describe('SP-FID-1 on the fake host: what passes, what never does, and every merge', () => {
  it('end to end', async () => {
    const genuine = await agentPr(w);
    const l8 = await agentPr(w, { lane: 'L8', g3: 'none' });
    const moved = await agentPr(w);
    const forged = await agentPr(w);
    // the head of `moved` moves after its pack (a new push): the pack was for the old head
    const again = await brokerPush(w, {
      item: moved.item,
      lane: 'L3',
      epoch: 1,
      expected_head: moved.head,
      n: 900,
    });
    // `forged` gets a pack for a new head that claims to pass but whose signature is over another pack
    const fpush = await brokerPush(w, {
      item: forged.item,
      lane: 'L3',
      epoch: 1,
      expected_head: forged.head,
      n: 901,
    });
    await signPack(w, {
      item: forged.item,
      head: fpush.head,
      number: forged.number,
      lane: 'L3',
      passing: false,
      g3: forged.g3,
      receipt_id: fpush.receipt_id,
      patch_hash: fpush.patch_hash,
      tamper: (p) => ({
        ...p,
        disposition: { kind: 'passed' },
        passing: true,
        steps: p.steps.map((s) => ({ ...s, verdict: 'passed', met: true })),
      }),
    });
    // a person copies the genuine agent head onto their own branch (laundering)
    const launder = w.fake.openPull(REPO, {
      head_ref: 'feature/borrowed',
      head_sha: genuine.head,
      author: 'mallory',
      commits: [{ sha: genuine.head, message: 'borrowed' }],
    });
    const human = w.fake.openPull(REPO, {
      head_ref: 'feature/readme',
      head_sha: 'd'.repeat(40),
      author: 'carol-gh',
      commits: [{ sha: 'd'.repeat(40), message: 'fix the readme' }],
    });
    const human2 = w.fake.openPull(REPO, {
      head_ref: 'feature/docs',
      head_sha: 'd1'.repeat(20),
      author: 'erin',
    });
    const s0 = w.fake.openPull(S0_REPO, {
      head_ref: 'feature/early',
      head_sha: 'e'.repeat(40),
      author: 'carol-gh',
    });

    const c = w.checker();
    // seven open PRs, six heads (the laundered PR shares the genuine head): one run per head
    expect(await c.syncRepo(w.repo)).toBe(6);
    expect(await c.syncRepo(w.s0repo)).toBe(1);

    expect(runOn(l8.head)).toMatchObject({ status: 'completed', conclusion: 'success' });
    expect(runOn(again.head)).toMatchObject({ conclusion: 'failure' });
    expect(runOn(fpush.head)).toMatchObject({ conclusion: 'failure' });
    expect(runOn('d'.repeat(40))).toMatchObject({ conclusion: 'action_required' });
    expect(runOn('e'.repeat(40), S0_REPO)).toMatchObject({ conclusion: 'action_required' });
    // a check run belongs to the commit: the laundered PR shares the genuine head, and that head's run is the
    // laundering failure (the strictest at that head); the laundering PR never inherits the agent's pass
    expect(runOn(genuine.head)).toMatchObject({ conclusion: 'failure' });
    const byPr = new Map(
      (await listVerdicts(w.rolePool, { repo: REPO })).map((v) => [v.verdict.pr_number, v.verdict]),
    );
    expect(byPr.get(genuine.number)).toMatchObject({ profile: 'agent', reason: 'passed' });
    // L8 is the agent profile under its lane's route, which has no G3 in the pinned catalogue
    expect(byPr.get(l8.number)).toMatchObject({
      profile: 'agent',
      reason: 'passed_no_g3',
      lane: 'L8',
      g3: null,
    });
    expect(byPr.get(moved.number)).toMatchObject({ reason: 'head_moved' });
    expect(byPr.get(forged.number)).toMatchObject({ reason: 'pack_invalid' });
    expect(byPr.get(launder)).toMatchObject({
      profile: 'non_agent',
      outcome: 'failure',
      reason: 'laundering_agent_head',
    });
    expect(byPr.get(human)).toMatchObject({
      outcome: 'action_required',
      reason: 'not_factory_work',
    });
    expect((await listVerdicts(w.rolePool, { repo: S0_REPO, pr: s0 }))[0]?.verdict).toMatchObject({
      profile: 's0',
      reason: 's0_onboarding',
    });
    // nothing changed: a second pass writes no check run and records nothing
    expect(await c.syncRepo(w.repo)).toBe(0);
    // the laundering PR is closed: the genuine head gets its own pass again
    w.fake.closePull(REPO, launder);
    expect(await c.syncRepo(w.repo)).toBe(1);
    expect(runOn(genuine.head)).toMatchObject({ conclusion: 'success' });

    // merges: the genuine one passed (gated); a person's merged by someone not on the (empty) list is unauthorised
    w.fake.landPull(REPO, genuine.number, 'dana-gh');
    w.fake.landPull(REPO, human, 'mallory');
    expect((await c.observeMerges(w.repo)).sort()).toEqual(['gated', 'unauthorised']);
    // carol is put on the list through M1; then her merge of another person's PR is a bypass
    await proposeBypass(w, { [REPO]: [{ login: 'carol-gh', principal_id: 'carol' }] }, true);
    w.fake.landPull(REPO, human2, 'Carol-GH');
    expect(await c.observeMerges(w.repo)).toEqual(['bypass']);
    // nothing twice
    expect(await c.observeMerges(w.repo)).toEqual([]);
    const merges = await listMerges(w.rolePool, REPO);
    expect(merges.map((m) => [m.pr_number, m.class, m.host_check]).sort()).toEqual(
      [
        [genuine.number, 'gated', 'success'],
        [human, 'unauthorised', 'not_success'],
        [human2, 'bypass', 'not_success'],
      ].sort(),
    );
    expect(merges.find((m) => m.pr_number === human2)?.bypass_person).toEqual({
      login: 'carol-gh',
      principal_id: 'carol',
    });

    // core raises X4 for the bypass and the unauthorised merge (never for the gated one)
    const r = await observeBypassMerges({ decisions: w.decisions });
    expect(r.ok && r.value).toEqual({ seen: 2, opened: 2 });
    const x4 = await w.db.pool.query<{ stream: string; body: Record<string, unknown> }>(
      `SELECT stream, body FROM record.record_event WHERE type = $1 AND body ->> 'gate_id' = 'X4'`,
      [GATE_EVENT.opened],
    );
    expect(x4.rows).toHaveLength(2);
    for (const row of x4.rows) {
      const st = await readGateState(w.db.pool, row.stream.slice('gate:'.length));
      expect(st?.status).toBe('pending');
      expect(st?.open.payload.subject_kind).toBe('merge');
    }
    expect(x4.rows.map((x) => (x.body['facts'] as { class: string }).class).sort()).toEqual([
      'bypass',
      'unauthorised',
    ]);
    expect(mergeReviewLoop({ decisions: w.decisions }).name).toBe('gatecheck_merges');

    // the read models are rebuilt from the record alone
    const before = await w.db.pool.query(
      'SELECT repo_key, pr_number, seq, verdict_sha256 FROM gatecheck.verdict ORDER BY 1, 2, 3',
    );
    const mb = await w.db.pool.query('SELECT merge_id, class FROM gatecheck.merge ORDER BY 1');
    await rebuildGateCheck(w.db.pool);
    expect(
      (
        await w.db.pool.query(
          'SELECT repo_key, pr_number, seq, verdict_sha256 FROM gatecheck.verdict ORDER BY 1, 2, 3',
        )
      ).rows,
    ).toEqual(before.rows);
    expect(
      (await w.db.pool.query('SELECT merge_id, class FROM gatecheck.merge ORDER BY 1')).rows,
    ).toEqual(mb.rows);
  });
});

describe('agent PRs: pass only on the signed pack of exactly this head, and G3 approved', () => {
  it('passes: pack for the head, signature verifies with the Notary key, G3 approved', async () => {
    const a = await agentPr(w);
    const v = await verdict(a.number);
    expect(v).toMatchObject({
      profile: 'agent',
      outcome: 'success',
      reason: 'passed',
      item_id: a.item,
      pack_sha256: a.pack?.pack_sha256,
      g3: { gate_instance_id: a.g3, status: 'decided', outcome: 'approve' },
    });
  });

  it('no pack, a pack that is not passing, a moved head', async () => {
    const none = await agentPr(w, { pack: 'none' });
    expect(await verdict(none.number)).toMatchObject({ outcome: 'failure', reason: 'no_pack' });
    const np = await agentPr(w, { pack: 'not_passing' });
    expect(await verdict(np.number)).toMatchObject({
      outcome: 'failure',
      reason: 'pack_not_passing',
    });
    const mv = await agentPr(w);
    expect((await verdict(mv.number)).outcome).toBe('success');
    await brokerPush(w, { item: mv.item, lane: 'L3', epoch: 1, expected_head: mv.head, n: 950 });
    expect(await verdict(mv.number)).toMatchObject({ outcome: 'failure', reason: 'head_moved' });
  });

  it('B11 after the push (owner decision 2026-11-13): the same PR, a new head; pending/failure until the new pack of exactly that head verifies under the new G3', async () => {
    const c = w.checker();
    // 7.6 found the approach wrong: the head's pack is a B11 rework, never a pass
    const a = await agentPr(w, { pack: 'none' });
    await signPack(w, {
      item: a.item,
      head: a.head,
      number: a.number,
      lane: 'L3',
      passing: false,
      disposition: { kind: 'rework', edge: 'B11', loop: null, reason_code: 'approach_wrong_7.3' },
      g3: a.g3,
      receipt_id: a.receipt_id,
      patch_hash: a.patch_hash,
    });
    expect(await verdict(a.number)).toMatchObject({
      outcome: 'failure',
      reason: 'pack_not_passing',
    });
    await c.syncRepo(w.repo);
    expect(runOn(a.head)).toMatchObject({ conclusion: 'failure' });
    // the re-plan: G3 again, and the re-planned Unit's push fast-forwards the SAME branch and PR at a higher epoch
    const g3b = await g3(w, a.item, 'approve');
    const p2 = await brokerPush(w, {
      item: a.item,
      lane: 'L3',
      epoch: 2,
      expected_head: a.head,
      n: 960,
    });
    expect(p2.number).toBe(a.number);
    expect(p2.head).not.toBe(a.head);
    // nothing of the old head carries over: its pack is not for this head
    expect(await verdict(a.number)).toMatchObject({ outcome: 'failure', reason: 'head_moved' });
    // a pack for the new head that still carries the old G3 is not enough: the newest G3 is what binds
    await signPack(w, {
      item: a.item,
      head: p2.head,
      number: p2.number,
      lane: 'L3',
      passing: true,
      g3: a.g3,
      receipt_id: p2.receipt_id,
      patch_hash: p2.patch_hash,
    });
    expect(await verdict(a.number)).toMatchObject({ outcome: 'failure', reason: 'g3_changed' });
    // the new pack, signed for exactly the new head under the new G3: green, for that head only
    const pack2 = await signPack(w, {
      item: a.item,
      head: p2.head,
      number: p2.number,
      lane: 'L3',
      passing: true,
      g3: g3b,
      receipt_id: p2.receipt_id,
      patch_hash: p2.patch_hash,
    });
    expect(await verdict(a.number)).toMatchObject({
      outcome: 'success',
      reason: 'passed',
      head_sha: p2.head,
      pack_sha256: pack2.pack_sha256,
      g3: { gate_instance_id: g3b, status: 'decided', outcome: 'approve' },
    });
    await c.syncRepo(w.repo);
    expect(runOn(p2.head)).toMatchObject({ conclusion: 'success' });
    // the old head's run stays what it was: a pass is never carried back to it
    expect(runOn(a.head)).toMatchObject({ conclusion: 'failure' });
  });

  it('a bad signature (the pack changed after signing), a pack for another repo or PR', async () => {
    const a = await agentPr(w, { pack: 'none' });
    await signPack(w, {
      item: a.item,
      head: a.head,
      number: a.number,
      lane: 'L3',
      passing: true,
      g3: a.g3,
      receipt_id: a.receipt_id,
      patch_hash: a.patch_hash,
      tamper: (p) => ({ ...p, oracle_locks: { 'test/x.test.js': 'f'.repeat(64) } }),
    });
    expect(await verdict(a.number)).toMatchObject({ outcome: 'failure', reason: 'pack_invalid' });
    const b = await agentPr(w, { pack: 'none' });
    await signPack(w, {
      item: b.item,
      head: b.head,
      number: b.number + 100,
      lane: 'L3',
      passing: true,
      g3: b.g3,
      receipt_id: b.receipt_id,
      patch_hash: b.patch_hash,
    });
    expect(await verdict(b.number)).toMatchObject({ outcome: 'failure', reason: 'pack_invalid' });
    // the same pack checked under another key does not verify either
    const c = await agentPr(w);
    const other = { ...w.notaryKey, x: w.notaryKey.y, y: w.notaryKey.x };
    expect(
      await verdict(c.number, w.repo, { notaryKey: new StaticNotaryKey(other as never) }),
    ).toMatchObject({ outcome: 'failure', reason: 'pack_invalid' });
  });

  it('G3 pending, rejected, missing, or newer than the evidence', async () => {
    expect(await verdict((await agentPr(w, { g3: 'pending' })).number)).toMatchObject({
      reason: 'g3_pending',
      outcome: 'failure',
      g3: { status: 'pending' },
    });
    expect(await verdict((await agentPr(w, { g3: 'reject' })).number)).toMatchObject({
      reason: 'g3_not_approved',
      g3: { status: 'decided', outcome: 'reject' },
    });
    expect(await verdict((await agentPr(w, { g3: 'none' })).number)).toMatchObject({
      reason: 'g3_missing',
    });
    const a = await agentPr(w);
    await g3(w, a.item, 'approve'); // a new plan approved after the evidence
    expect(await verdict(a.number)).toMatchObject({ reason: 'g3_changed', outcome: 'failure' });
  });

  it('G3 is required only where the item’s pinned route has it (the engine’s rule over the pinned catalogue)', async () => {
    // L3 with the G3 group off in the item's pinned profile: the route has no G3, so none is needed
    const off = await agentPr(w, { g3: 'none', profile: profileOf('off') });
    expect(await verdict(off.number)).toMatchObject({
      profile: 'agent',
      outcome: 'success',
      reason: 'passed_no_g3',
      g3: null,
    });
    // the same lane with the group on: G3 is still required
    expect(await verdict((await agentPr(w, { g3: 'none' })).number)).toMatchObject({
      outcome: 'failure',
      reason: 'g3_missing',
    });
    // a catalogue ref this build does not carry (or whose hash does not match) cannot be read: pending
    for (const ref of [
      { version: '99.0.0', hash: 'e'.repeat(64) },
      { version: CATALOGUE_REF.version, hash: 'e'.repeat(64) },
    ]) {
      const u = await agentPr(w, { catalogue_ref: ref });
      expect(await verdict(u.number)).toMatchObject({
        outcome: 'pending',
        reason: 'dependency_unavailable',
      });
    }
    // the item's recorded profile is not the one the signed pack names: the pack does not bind it
    const m = await agentPr(w, { g3: 'none', pack: 'none', profile: profileOf('on') });
    await signPack(w, {
      item: m.item,
      head: m.head,
      number: m.number,
      lane: 'L3',
      passing: true,
      g3: null,
      receipt_id: m.receipt_id,
      patch_hash: m.patch_hash,
      profile: profileOf('off'),
    });
    expect(await verdict(m.number)).toMatchObject({ outcome: 'failure', reason: 'pack_invalid' });
  });

  it('a PR the Push Broker’s bot authored that core never recorded is refused', async () => {
    const item = randomUUID();
    w.guards.setLease(item, 'main', { held: true, epoch: 1, lane: 'L3' });
    const { writeRequest } = await import('@aisdlc/ports/testing');
    const r = await w.fake.apply_patch(
      writeRequest(
        [
          {
            op: 'put',
            path: 'src/z.js',
            mode: '100644',
            content_b64: Buffer.from('z').toString('base64'),
          },
        ],
        {
          repo: REPO,
          item_id: item as never,
          lane: 'L3',
          lease_epoch: 1,
          branch: `agent/${item}/main`,
          base_sha: BASE,
        },
      ),
    );
    if (r.state !== 'ok') throw new Error(r.message);
    expect(await verdict(r.value.pr.number)).toMatchObject({
      profile: 'agent',
      outcome: 'failure',
      reason: 'unknown_agent_pr',
    });
  });
});

describe('non-agent PRs: never a pass; the laundering check', () => {
  it('a person’s PR on an agent/* branch, carrying an agent commit, citing a pack, with factory trailers', async () => {
    const a = await agentPr(w);
    const open = (o: Parameters<World['fake']['openPull']>[1]) => w.fake.openPull(REPO, o);
    const branch = open({
      head_ref: `agent/${randomUUID()}/main`,
      head_sha: '1'.repeat(40),
      author: 'mallory',
    });
    const contains = open({
      head_ref: 'feature/on-top',
      head_sha: '2'.repeat(40),
      author: 'mallory',
      commits: [
        { sha: a.head, message: 'theirs' },
        { sha: '2'.repeat(40), message: 'mine' },
      ],
    });
    const cites = open({
      head_ref: 'feature/cites',
      head_sha: '3'.repeat(40),
      author: 'mallory',
      body: `Verified, see evidence pack ${a.pack?.pack_sha256.toUpperCase()}`,
    });
    const marker = open({
      head_ref: 'feature/marker',
      head_sha: '4'.repeat(40),
      author: 'mallory',
      body: 'Here is an aisdlc-signed-evidence-pack/1 from somewhere',
    });
    const trailer = open({
      head_ref: 'feature/trailer',
      head_sha: '5'.repeat(40),
      author: 'mallory',
      commits: [
        {
          sha: '5'.repeat(40),
          message: `x\n\nAisdlc-Item: ${a.item}\nAisdlc-Patch: ${'a'.repeat(64)}\n`,
        },
      ],
    });
    const clean = open({ head_ref: 'feature/clean', head_sha: '6'.repeat(40), author: 'carol-gh' });
    const reasons = await Promise.all(
      [branch, contains, cites, marker, trailer, clean].map(async (n) => {
        const v = await verdict(n);
        return [v.profile, v.outcome, v.reason];
      }),
    );
    expect(reasons).toEqual([
      ['non_agent', 'failure', 'laundering_agent_branch'],
      ['non_agent', 'failure', 'laundering_agent_head'],
      ['non_agent', 'failure', 'laundering_pack_cited'],
      ['non_agent', 'failure', 'laundering_pack_cited'],
      ['non_agent', 'failure', 'laundering_trailer'],
      ['non_agent', 'action_required', 'not_factory_work'],
    ]);
  });

  it('the S0 profile: the factory’s evidence does not apply; laundering still fails', async () => {
    const clean = w.fake.openPull(S0_REPO, {
      head_ref: 'feature/s0',
      head_sha: '7'.repeat(40),
      author: 'carol-gh',
    });
    expect(await verdict(clean, w.s0repo)).toMatchObject({
      profile: 's0',
      outcome: 'action_required',
      reason: 's0_onboarding',
    });
    const bad = w.fake.openPull(S0_REPO, {
      head_ref: `agent/${randomUUID()}/onboarding`,
      head_sha: '8'.repeat(40),
      author: 'carol-gh',
    });
    expect(await verdict(bad, w.s0repo)).toMatchObject({
      profile: 's0',
      reason: 'laundering_agent_branch',
    });
  });

  it('pure helpers: tokens are found in any case; a commit list is enough to see a borrowed head', () => {
    const t = hexTokensOf({ title: 'A'.repeat(64), body: `x ${'b'.repeat(64)} y` }, []);
    expect(t).toEqual(['a'.repeat(64), 'b'.repeat(64)]);
    expect(
      launderingOf(
        { head_ref: 'f', head_sha: '9'.repeat(40), title: '', body: '' },
        [{ sha: 'a'.repeat(40), message: '' }],
        new Set(['a'.repeat(40)]),
        new Set(),
      ),
    ).toBe('laundering_agent_head');
  });
});

describe('fail closed', () => {
  it('an unreachable record, object store or Notary key is pending, never success', async () => {
    const a = await agentPr(w);
    expect((await verdict(a.number)).outcome).toBe('success');
    const broken = createPool(w.db.url.replace(/\/\/[^@]*@/, '//nobody:wrong@'), 1);
    try {
      expect(await verdict(a.number, w.repo, { facts: new RecordFacts(broken) })).toMatchObject({
        outcome: 'pending',
        reason: 'dependency_unavailable',
      });
    } finally {
      await broken.end();
    }
    const down = {
      declareBucket: async () => ({ ok: true as const, value: undefined }),
      get: async () => ({
        ok: false as const,
        error: { code: 'unavailable', message: 'down' } as never,
      }),
    };
    expect(await verdict(a.number, w.repo, { packs: down })).toMatchObject({ outcome: 'pending' });
    expect(await verdict(a.number, w.repo, { notaryKey: new StaticNotaryKey(null) })).toMatchObject(
      {
        outcome: 'pending',
      },
    );
    // a person's PR whose commits cannot be read is not cleared of laundering: pending
    const n = w.fake.openPull(REPO, {
      head_ref: 'feature/fc',
      head_sha: 'aa'.repeat(20),
      author: 'carol-gh',
    });
    const v = await verdict(n);
    expect(v.outcome).toBe('action_required');
    const h = w.host;
    const flaky = {
      app_id: h.app_id,
      list_pulls: h.list_pulls.bind(h),
      check_runs: h.check_runs.bind(h),
      write_check_run: h.write_check_run.bind(h),
      pull_commits: async () => readUnknown('timeout', 'no answer'),
    };
    expect(await verdict(n, w.repo, { host: flaky })).toMatchObject({
      profile: 'non_agent',
      outcome: 'pending',
      reason: 'dependency_unavailable',
    });
    w.fake.breakChecksApi(readUnknown('server_error', 'down'));
    try {
      // the code host down: the open PRs cannot be read: the tick fails, nothing is written or recorded
      const before = w.fake.checkRunsOf(REPO).length;
      await expect(w.checker().syncRepo(w.repo)).rejects.toThrow(/open PRs/);
      expect(w.fake.checkRunsOf(REPO).length).toBe(before);
    } finally {
      w.fake.unbreak();
    }
  });

  it('the check run is written only through gate-check’s own App: the Push Broker’s credential cannot', async () => {
    const a = await agentPr(w);
    const broker = w.fake.asApp(w.fake.pushApp);
    const before = w.fake.checkRunsOf(REPO).length;
    await expect(w.checker({ host: broker }).syncRepo(w.repo)).rejects.toThrow(/forbidden/);
    expect(w.fake.checkRunsOf(REPO).length).toBe(before);
    // through its own App, the run carries gate-check's App id (what protect-main pins the required check to)
    await w.checker().syncRepo(w.repo);
    expect(runOn(a.head)?.app_id).toBe(GC_APP.app_id);
    // a check of the same name by another App does not make a merge gated
    expect(w.fake.pushApp.app_id).not.toBe(GC_APP.app_id);
  });
});

describe('the merge cutoff: merges before gate-check watched a repo', () => {
  it('a repo with old merges at first sight opens no X4; a later unchecked merge does', async () => {
    // a repo the factory registers after it already had history: two merges from before any check could run
    const repo = 'acme/old';
    const host = new FakeGitHub(
      emptySeed({
        repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
        heads: [{ repo, branch: 'main', sha: 'f0'.repeat(20) }],
      }),
    );
    const row = {
      repo,
      project_id: PROJECT,
      onboarding_level: 'light' as const,
      default_branch: 'main',
    };
    const old1 = host.openPull(repo, {
      head_ref: 'f/1',
      head_sha: 'a1'.repeat(20),
      author: 'carol-gh',
    });
    const old2 = host.openPull(repo, {
      head_ref: 'f/2',
      head_sha: 'a2'.repeat(20),
      author: 'mallory',
    });
    host.landPull(repo, old1, 'carol-gh', '2026-01-05T09:00:00Z');
    host.landPull(repo, old2, 'mallory', '2026-03-01T09:00:00Z');
    const c = w.checker({ host: host.asApp(GC_APP) });
    // the first sight starts the watch (at the clock's now, with the default branch's head) and classes nothing
    expect((await c.observeMerges(row)).sort()).toEqual(['pre_watch', 'pre_watch']);
    const watch = await w.rolePool.query(
      'SELECT watched_at, default_branch, head_sha FROM gatecheck.repo_watch WHERE repo_key = $1',
      [repo],
    );
    expect(watch.rows[0]).toMatchObject({ default_branch: 'main', head_sha: 'f0'.repeat(20) });
    const ev = await w.rolePool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1 AND type = 'gatecheck.repo_watched'`,
      [`gatecheck:${repo}`],
    );
    expect(ev.rows[0]).toEqual({ n: 1 });
    // a later merge that no check passed is unauthorised
    const later = host.openPull(repo, {
      head_ref: 'f/3',
      head_sha: 'a3'.repeat(20),
      author: 'mallory',
    });
    host.landPull(repo, later, 'mallory', '2026-11-12T12:00:00Z');
    expect(await c.observeMerges(row)).toEqual(['unauthorised']);
    // core reviews the later one only
    const before = await w.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM record.record_event WHERE type = $1 AND body ->> 'gate_id' = 'X4'`,
      [GATE_EVENT.opened],
    );
    const r = await observeBypassMerges({ decisions: w.decisions });
    expect(r.ok && r.value.opened).toBe(1);
    const x4 = await w.db.pool.query<{ body: { subject_id: string } }>(
      `SELECT body FROM record.record_event WHERE type = $1 AND body ->> 'gate_id' = 'X4' ORDER BY global_seq DESC LIMIT 1`,
      [GATE_EVENT.opened],
    );
    const { mergeSubjectId } = await import('@aisdlc/contracts');
    expect(x4.rows[0]?.body.subject_id).toBe(mergeSubjectId(repo, later, 'a3'.repeat(20)));
    const after = await w.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM record.record_event WHERE type = $1 AND body ->> 'gate_id' = 'X4'`,
      [GATE_EVENT.opened],
    );
    expect((after.rows[0]?.n ?? 0) - (before.rows[0]?.n ?? 0)).toBe(1);
    // rebuilt from the record: the watch and the pre_watch merges come back as they were
    const m1 = await w.db.pool.query(
      'SELECT class FROM gatecheck.merge WHERE repo_key = $1 ORDER BY 1',
      [repo],
    );
    await rebuildGateCheck(w.db.pool);
    expect(
      (
        await w.db.pool.query('SELECT class FROM gatecheck.merge WHERE repo_key = $1 ORDER BY 1', [
          repo,
        ])
      ).rows,
    ).toEqual(m1.rows);
    expect(
      (
        await w.db.pool.query('SELECT head_sha FROM gatecheck.repo_watch WHERE repo_key = $1', [
          repo,
        ])
      ).rows,
    ).toEqual([{ head_sha: 'f0'.repeat(20) }]);
  });
});

describe('the bypass list (DEC-10 as refined): config, M1-gated, never an App', () => {
  it('refuses an App or bot login, a repeated login; empty by default', async () => {
    for (const bad of [
      { [REPO]: [{ login: FAKE_PUSH_BROKER_LOGIN, principal_id: 'x' }] },
      { [REPO]: [{ login: 'app/aisdlc', principal_id: 'x' }] },
      {
        [REPO]: [
          { login: 'Carol', principal_id: 'c' },
          { login: 'carol', principal_id: 'c2' },
        ],
      },
      { [REPO]: [{ login: '-x', principal_id: 'x' }] },
    ]) {
      expect(MergeBypassConfig.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      const p = await proposeBypass(w, bad, false);
      expect(p.ok).toBe(false);
    }
    expect(w.config.registry?.get(MERGE_BYPASS_CONFIG_KEY)).toMatchObject({
      default: {},
      overridable: false,
    });
  });

  it('a proposed list is not in force until its M1 decision; a person’s merge before that is unauthorised', async () => {
    const n = w.fake.openPull(REPO, {
      head_ref: 'feature/m1',
      head_sha: 'ab'.repeat(20),
      author: 'erin',
    });
    const c = w.checker();
    await c.syncRepo(w.repo);
    const p = await proposeBypass(
      w,
      { [REPO]: [{ login: 'erin-gh', principal_id: 'erin' }] },
      false,
    );
    expect(p.ok).toBe(true);
    w.fake.landPull(REPO, n, 'erin-gh');
    expect(await c.observeMerges(w.repo)).toEqual(['unauthorised']);
    const m = (await listMerges(w.rolePool, REPO)).find((x) => x.pr_number === n);
    expect(m).toMatchObject({ class: 'unauthorised', merged_by: 'erin-gh', bypass_person: null });
  });
});

describe('the database role', () => {
  it('reads what it needs and nothing else; appends only its own streams; changes no read model', async () => {
    const tables = (
      await w.db.pool.query<{ s: string; t: string }>(
        `SELECT table_schema AS s, table_name AS t FROM information_schema.tables
          WHERE table_schema NOT IN ('pg_catalog', 'information_schema', 'public')`,
      )
    ).rows.map((r) => `${r.s}.${r.t}`);
    const allowed = new Set([
      'gatecheck.verdict',
      'gatecheck.merge',
      'gatecheck.repo_watch',
      'record.record_event',
      'record.global_counter',
      'ledger.ledger_entry',
      'config.genuine_publish',
      'core.repo',
      'core.pull_request',
      'core.push_receipt',
      'core.evidence_pack',
    ]);
    const readable: string[] = [];
    for (const t of tables) {
      if (allowed.has(t)) continue;
      try {
        await w.rolePool.query(`SELECT 1 FROM ${t} LIMIT 1`);
        readable.push(t);
      } catch (e) {
        if ((e as { code?: string }).code !== '42501') readable.push(`${t}:${String(e)}`);
      }
    }
    expect(readable).toEqual([]);
    await expect(
      w.rolePool.query('UPDATE gatecheck.verdict SET reason = reason'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(w.rolePool.query('DELETE FROM core.evidence_pack')).rejects.toMatchObject({
      code: '42501',
    });
    // row-level security: it sees no item stream and cannot append to one
    // row-level security: of the other streams it sees exactly the items' `item.created` (their pin) and nothing else
    const seen = await w.rolePool.query(
      `SELECT count(*)::int AS n FROM record.record_event
        WHERE stream NOT LIKE 'gatecheck:%' AND stream NOT LIKE 'gate:%' AND type <> 'item.created'`,
    );
    expect(seen.rows[0]).toEqual({ n: 0 });
    const others = await w.db.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM record.record_event
        WHERE stream NOT LIKE 'gatecheck:%' AND stream NOT LIKE 'gate:%' AND type <> 'item.created'`,
    );
    expect(others.rows[0]?.n).toBeGreaterThan(0);
    await expect(
      w.rolePool.query(
        `INSERT INTO record.record_event (stream, seq, global_seq, event_id, type, body, actor, occurred_at, prev_hash, hash)
         VALUES ('item:x', 9, 999999, gen_random_uuid(), 'item.created', '{}', 'x', now(), $1, $1)`,
        ['0'.repeat(64)],
      ),
    ).rejects.toBeTruthy();
  });
});

describe('the booted service', () => {
  it('runs its loops as its own role, writes aisdlc/gate, and serves the verdicts to a caller with scope read', async () => {
    const { bootGateCheck } = await import('../src/boot.js');
    const { dbUrlRef } = await import('@aisdlc/db/testing');
    const a = await agentPr(w);
    const token = 'b'.repeat(48);
    const svc = await bootGateCheck(
      {
        ...dbUrlRef('GATE_CHECK_DATABASE_URL', w.roleDbUrl),
        GATE_CHECK_CALLERS: JSON.stringify({ bff: { token_ref: 'env:GC_TOK', scopes: ['read'] } }),
        GC_TOK: token,
        GATE_CHECK_PUSH_BROKER_LOGIN: FAKE_PUSH_BROKER_LOGIN,
        GATE_CHECK_VERDICT_INTERVAL_MS: '100',
        GATE_CHECK_MERGE_INTERVAL_MS: '200',
        GATE_CHECK_CONFIG_RELOAD_MS: '1000',
      },
      {
        host: w.host,
        packs: w.objects,
        notaryKey: new StaticNotaryKey(w.notaryKey),
        log: () => undefined,
      },
    );
    try {
      for (let i = 0; i < 100 && runOn(a.head)?.conclusion !== 'success'; i++) {
        await new Promise((r) => setTimeout(r, 50));
      }
      expect(runOn(a.head)).toMatchObject({ conclusion: 'success', app_id: GC_APP.app_id });
      const res = await fetch(new URL(`/v1/verdicts?item=${a.item}`, svc.url), {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { verdicts: Array<{ verdict: GateCheckVerdict }> };
      expect(body.verdicts[0]?.verdict).toMatchObject({ reason: 'passed', item_id: a.item });
      expect((await fetch(new URL(`/v1/verdicts?item=${a.item}`, svc.url))).status).toBe(401);
      const h = await fetch(new URL('/healthz', svc.url));
      const report = (await h.json()) as { loops: Array<{ name: string }> };
      expect(report.loops.map((l) => l.name).sort()).toEqual([
        'gate_check_merges',
        'gate_check_verdicts',
      ]);
    } finally {
      await svc.close();
    }
  });
});
