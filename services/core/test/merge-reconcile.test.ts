import {
  EVIDENCE_BUCKET,
  EVIDENCE_EVENT,
  GATECHECK_EVENT,
  GATE_EVENT,
  G4Review,
  G4_REVIEW_FACT,
  ITEM_EVENT,
  MergeObservedPayload,
  PUSH_EVENT,
  evidenceStream,
  gateCheckStream,
  mergeSubjectId,
  pushStream,
  type PrrGatingProfile,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { readGateState } from '@aisdlc/decisions';
import { sha256Hex } from '@aisdlc/kernel';
import { observeAgentPulls } from '@aisdlc/loops';
import { FakeGitHub, emptySeed, readUnknown } from '@aisdlc/ports';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  DbWatchedPulls,
  FakePrincipalLinks,
  driveWork,
  inCoreTx,
  listMergeReconciled,
  listPullRequests,
  lockKeys,
  observeBypassMerges,
  readG4Standing,
  readItem,
  readItemEvents,
  rebuildEvidencePacks,
  rebuildPushes,
  reconcileMerges,
  submitRequest,
  type ReviewPorts,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M15.2 8.2 merge observed, on the real record, ledger and Notary, through the work driver and the decision kernel,
// with the fake GitHub behind the code-host port. A person merges the agent PR on the host (the fake's `landPull`, the
// test's hand); the `agent_pulls` poll records what the host says (record first); `reconcileMerges` reconciles it with
// the item: the merged head is the one the approved G4 and its passing pack bind -> S9 (or S8b where the project
// releases); a merge before G4, or of another head -> X4 post-hoc review, never a completion, and never a second X4 when
// gate-check already opened one; the base moved and the PR was rebased cleanly -> B15a, S7 again on the rebased head
// with a new pack and a new G4; a conflict -> B15b back to S6; an unreadable merge state -> no completion.

vi.setConfig({ testTimeout: 180_000 });

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const BASE = 'b'.repeat(40);
const BASE2 = 'c'.repeat(40);
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);

interface World {
  readonly project: string;
  readonly repo: string;
  readonly itemId: string;
  readonly d: WorkDriverDeps;
  readonly gh: FakeGitHub;
  /** The agent PR's number on the host (and in core's record). */
  pr: number;
}

let n = 0;
async function world(o: { gating?: PrrGatingProfile } = {}): Promise<World> {
  n += 1;
  const seeded = await seedActivePrr(s, {
    level: 'full',
    gating: o.gating ?? GATING_OFF,
    autonomy: {
      tier_cap: 'A3',
      level_cap: 'A3',
      readiness_cap: 'A2',
      posture_cap: null,
      probation_until: null,
      effective: 'A2',
      r3_zones: [],
    },
  });
  approvers(s, seeded.project, ['bob']);
  s.elig.setHolders(pid(seeded.project), 'g4', [pr('bob')]);
  const sub = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L3',
      requester: pr('alice'),
      channel: 'N1',
      text: `merge reconcile test ${n}`,
    }),
  );
  const gh = new FakeGitHub(
    emptySeed({
      repos: [{ full_name: seeded.repo, default_branch: 'main', private: true, archived: false }],
      heads: [{ repo: seeded.repo, branch: 'main', sha: BASE }],
      files: [{ repo: seeded.repo, sha: BASE, path: '.github/CODEOWNERS', content: '* @evan\n' }],
    }),
  );
  const review: ReviewPorts = { source: gh, links: new FakePrincipalLinks().link('evan', 'evan') };
  return {
    ...seeded,
    itemId: sub.item_id as string,
    d: { ...driverOver(s), review } as WorkDriverDeps,
    gh,
    pr: 0,
  };
}

const deps = () => ({ pool: s.record.pool, clock: s.clock });

/** The passing Evidence Pack of a head, as 7.6 leaves it. */
async function pack(w: World, head: string, base = BASE): Promise<string> {
  const sha = sha256Hex(`pack-${w.itemId}-${head}`);
  ok(
    await inCoreTx(deps(), async (j, tx) => {
      await lockKeys(tx, [`evidence:${w.itemId}`]);
      const b = await j.emitAll(evidenceStream(w.itemId), [
        {
          type: EVIDENCE_EVENT.pack_signed,
          body: {
            command_key: `s7-${w.itemId}-${head}`,
            item_id: w.itemId,
            unit_key: 'main',
            base_sha: base,
            head_sha: head,
            pack_sha256: sha,
            bucket: EVIDENCE_BUCKET,
            object_key: sha256Hex(`bytes-${w.itemId}-${head}`),
            disposition: { kind: 'passed' },
            passing: true,
            key_id: 'notary-evidence-1',
            handoff_pack_sha256: null,
            handoff_object_key: null,
            produced_at: s.clock.now().toISOString(),
          },
          actor: 'system.evidence',
          idempotency_key: `evidence:${head}`,
        },
      ]);
      return b.ok ? { ok: true as const, value: true } : b;
    }),
  );
  await rebuildEvidencePacks(deps(), w.itemId);
  return sha;
}

/** What 6.6 leaves for a head (the push intent, the receipt that made or moved the PR) and the host's PR, then 7.6. */
async function pushed(w: World, head: string): Promise<string> {
  const branch = `agent/${w.itemId}/main`;
  if (w.pr === 0) w.pr = w.gh.openPull(w.repo, { head_ref: branch, head_sha: head, author: 'bot' });
  else w.gh.pushToPull(w.repo, w.pr, head);
  const patch_hash = sha256Hex(`patch-${head}`);
  ok(
    await inCoreTx(deps(), async (j, tx) => {
      await lockKeys(tx, [`push:${w.itemId}`]);
      const a = await j.emitAll(pushStream(w.itemId), [
        {
          type: PUSH_EVENT.intended,
          body: {
            item_id: w.itemId,
            unit_key: 'main',
            repo: w.repo,
            branch,
            lease_epoch: 1,
            base_sha: BASE,
            patch_hash,
            files: 1,
            command_key: `cmd-${w.itemId}-${head}`,
            paths: ['src/app.js'],
          },
          actor: 'system.push',
          idempotency_key: `push:intent:${w.itemId}:${head}`,
        },
        {
          type: PUSH_EVENT.receipt_recorded,
          body: {
            receipt_id: `rcpt-${w.itemId}-${head.slice(0, 8)}`,
            item_id: w.itemId,
            unit_key: 'main',
            repo: w.repo,
            branch,
            lease_epoch: 1,
            patch_hash,
            status: 'applied',
            code: null,
            base_sha: BASE,
            head_sha: head,
            pr_number: w.pr,
            files: 1,
            at: s.clock.now().toISOString(),
          },
          actor: 'system.push',
          idempotency_key: `push:receipt:${w.itemId}:${head}`,
        },
      ]);
      return a.ok ? { ok: true as const, value: true } : a;
    }),
  );
  await rebuildPushes(deps(), w.itemId);
  return pack(w, head);
}

type St = NonNullable<Awaited<ReturnType<typeof readItem>>>['state'];
const atMerge = (st: St) => st.waiting?.kind === 'human' && st.waiting.what === 'merge';
const g4Open = (st: St) =>
  st.waiting?.kind === 'gates' &&
  st.waiting.gates.includes('G4') &&
  st.gates.some((g) => g.gate === 'G4' && g.status === 'pending');

/** Drives the item to 8.2: G4 approved by bob on the head of the pack. */
async function toMerge(w: World): Promise<St> {
  const it = await runItem(s, w.d, w.itemId, { stop: atMerge });
  expect(it && atMerge(it.state), JSON.stringify(it?.state.waiting)).toBe(true);
  return (it as NonNullable<typeof it>).state;
}

/** The poll records, then core reconciles (twice the second time to show it is idempotent). */
async function observe(w: World) {
  const seen = await observeAgentPulls({
    pool: s.record.pool,
    source: w.gh,
    watched: new DbWatchedPulls(s.record.pool),
  });
  const r = ok(await reconcileMerges({ pool: s.record.pool, clock: s.clock, decisions: s.config }));
  return { seen, r };
}

async function state(w: World): Promise<St> {
  return (await readItem(s.record.pool, w.itemId))?.state as St;
}

/** The X4 instances of a merge (subject kind `merge`). */
async function x4s(repo: string, prNumber: number) {
  const q = await s.record.pool.query<{ stream: string }>(
    `SELECT stream FROM record.record_event WHERE type = $1 AND seq = 1 AND body ->> 'gate_id' = 'X4'
       AND body ->> 'subject_kind' = 'merge' AND lower(body -> 'facts' ->> 'repo') = lower($2)
       AND body -> 'facts' ->> 'pr_number' = $3`,
    [GATE_EVENT.opened, repo, String(prNumber)],
  );
  const out = [];
  for (const r of q.rows) {
    const g = await readGateState(s.record.pool, r.stream.slice('gate:'.length));
    if (g) out.push(g);
  }
  return out;
}

describe('8.2 the human merges the approved head: the item leaves S8', () => {
  it('merged with exactly the G4-approved head: completed, S9; seeing it again changes nothing', async () => {
    const w = await world();
    const p1 = await pushed(w, H1);
    await toMerge(w);
    // nothing merged yet: the fact is recorded, nothing is concluded
    const before = await observe(w);
    expect(before.seen.recorded).toEqual([{ repo: w.repo, outcome: 'recorded' }]);
    expect(before.r).toMatchObject({ recorded: 0, completed: 0 });

    w.gh.landPull(w.repo, w.pr, 'carol-gh');
    const merge = w.gh.prOf(w.repo, w.pr)?.merge_commit_sha as string;
    const { r } = await observe(w);
    expect(r).toMatchObject({ recorded: 1, completed: 1, x4_opened: 0, rework: 0 });
    const [rec] = await listMergeReconciled(s.record.pool, w.itemId);
    expect(rec).toMatchObject({
      outcome: 'completed',
      reason: 'approved_head',
      head_sha: H1,
      merge_commit_sha: merge,
      merged_by: 'carol-gh',
      approved: { head_sha: H1, pack_sha256: p1 },
    });
    const ev = (await readItemEvents(s.record.pool, w.itemId)).filter(
      (e) => e.type === ITEM_EVENT.merge_observed,
    );
    expect(ev.map((e) => e.payload)).toEqual([{ merged_sha: merge }]);
    // past 8.2: S8b (here a step of the factory's, the project has no G5) and then S9
    const st = await state(w);
    expect(atMerge(st)).toBe(false);
    expect(['S8b', 'S9'].includes(st.underlying) || st.terminal === 'Done', st.underlying).toBe(
      true,
    );
    await driveWork(w.d);

    // the same fact again, and a fresh poll: nothing new
    const again = await observe(w);
    expect(again.r).toMatchObject({ recorded: 0, completed: 0, x4_opened: 0, rework: 0 });
    expect(await listMergeReconciled(s.record.pool, w.itemId)).toHaveLength(1);
    expect(await x4s(w.repo, w.pr)).toEqual([]);
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');
  });

  it('a project that releases: S8b with G5 after the merge', async () => {
    const w = await world({
      gating: { ...GATING_OFF, gates: { ...GATING_OFF.gates, g5: 'on' }, project_deploys: true },
    });
    await pushed(w, H1);
    await toMerge(w);
    w.gh.landPull(w.repo, w.pr, 'carol-gh');
    expect((await observe(w)).r.completed).toBe(1);
    await driveWork(w.d);
    const st = await state(w);
    // S8b: G5 production release is what the item waits for now
    expect(st.waiting?.kind === 'gates' && st.waiting.gates, JSON.stringify(st.waiting)).toEqual([
      'G5',
    ]);
    expect(st.terminal).toBeNull();
  });
});

describe('a merge that is not the approved one: X4 post-hoc review, no completion', () => {
  it('merged before G4 was decided: X4 (no approved G4), the item still waits at G4', async () => {
    const w = await world();
    await pushed(w, H1);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    w.gh.landPull(w.repo, w.pr, 'mallory');
    const { r } = await observe(w);
    expect(r).toMatchObject({ recorded: 1, completed: 0, x4_opened: 1 });
    const [rec] = await listMergeReconciled(s.record.pool, w.itemId);
    expect(rec).toMatchObject({
      outcome: 'post_hoc_review',
      reason: 'no_approved_g4',
      approved: null,
    });
    const [x4] = await x4s(w.repo, w.pr);
    expect(x4?.status).toBe('pending');
    expect(x4?.open.payload).toMatchObject({
      gate_id: 'X4',
      subject_kind: 'merge',
      subject_id: mergeSubjectId(w.repo, w.pr, H1),
      quorum: { slot: 'x' },
      facts: { kind: 'merge_reconcile_review', reason: 'no_approved_g4', head_sha: H1 },
    });
    const st = await state(w);
    expect(g4Open(st)).toBe(true);
    expect(
      (await readItemEvents(s.record.pool, w.itemId)).some(
        (e) => e.type === ITEM_EVENT.merge_observed,
      ),
    ).toBe(false);
    // approving G4 afterwards does not turn the merge into a completion
    const g = st.gates.find((x) => x.gate === 'G4' && x.status === 'pending');
    ok(await decideGate(s, g?.gate_instance_id as string, 'bob', 'approve'));
    await driveWork(w.d);
    const again = await observe(w);
    expect(again.r).toMatchObject({ completed: 0, x4_opened: 0, recorded: 0 });
    expect(atMerge(await state(w))).toBe(true);
    expect(await x4s(w.repo, w.pr)).toHaveLength(1);
  });

  it('merged content is not the approved head (a push after G4): X4 (head not approved), no completion', async () => {
    const w = await world();
    await pushed(w, H1);
    await toMerge(w);
    // a person pushes to the agent branch after the approval and merges that
    w.gh.pushToPull(w.repo, w.pr, H2);
    w.gh.landPull(w.repo, w.pr, 'carol-gh');
    const { r } = await observe(w);
    expect(r).toMatchObject({ completed: 0, x4_opened: 1 });
    const [rec] = await listMergeReconciled(s.record.pool, w.itemId);
    expect(rec).toMatchObject({
      outcome: 'post_hoc_review',
      reason: 'head_not_approved',
      head_sha: H2,
      approved: { head_sha: H1 },
    });
    const [x4] = await x4s(w.repo, w.pr);
    expect(x4?.open.payload.facts).toMatchObject({
      reason: 'head_not_approved',
      head_sha: H2,
      approved_head_sha: H1,
    });
    expect(atMerge(await state(w))).toBe(true);
  });
});

describe('no double X4 with gate-check (one per repo, PR and merge commit)', () => {
  function gateCheckMerge(w: World, head: string): MergeObservedPayload {
    const p = w.gh.prOf(w.repo, w.pr);
    return MergeObservedPayload.parse({
      merge_id: mergeSubjectId(w.repo, w.pr, head),
      repo: w.repo,
      project_id: w.project,
      pr_number: w.pr,
      head_sha: head,
      head_ref: `agent/${w.itemId}/main`,
      merge_commit_sha: p?.merge_commit_sha,
      merged_by: 'mallory',
      merged_at: '2026-11-12T12:00:00.000Z',
      author: { login: 'bot', type: 'User' },
      class: 'unauthorised',
      bypass_person: null,
      last_verdict: null,
      host_check: 'absent',
      item_id: w.itemId,
    });
  }
  async function recordGateCheck(p: MergeObservedPayload): Promise<void> {
    await withTransaction(s.record.pool, async (tx) => {
      const a = await appendEvents(tx, gateCheckStream(p.repo, p.pr_number), 0, [
        {
          type: GATECHECK_EVENT.unauthorised_merge,
          body: p as unknown as JsonObject,
          actor: 'system.gate-check',
          idempotency_key: `merge:${p.merge_id}`,
        },
      ]);
      if (!a.ok) throw new Error(a.error._tag);
    });
  }

  it('gate-check saw it first: its X4 stands, the reconcile records the merge and opens none', async () => {
    const w = await world();
    await pushed(w, H1);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    w.gh.landPull(w.repo, w.pr, 'mallory');
    await recordGateCheck(gateCheckMerge(w, H1));
    ok(await observeBypassMerges({ decisions: s.config }));
    expect(await x4s(w.repo, w.pr)).toHaveLength(1);
    const { r } = await observe(w);
    expect(r).toMatchObject({ recorded: 1, x4_opened: 0 });
    const all = await x4s(w.repo, w.pr);
    expect(all).toHaveLength(1);
    expect(all[0]?.open.payload.facts).toMatchObject({ kind: 'bypass_merge_review' });
  });

  it('the reconcile saw it first: gate-check opens none', async () => {
    const w = await world();
    await pushed(w, H1);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    w.gh.landPull(w.repo, w.pr, 'mallory');
    expect((await observe(w)).r.x4_opened).toBe(1);
    await recordGateCheck(gateCheckMerge(w, H1));
    const g = ok(await observeBypassMerges({ decisions: s.config }));
    expect(g.opened).toBe(0);
    const all = await x4s(w.repo, w.pr);
    expect(all).toHaveLength(1);
    expect(all[0]?.open.payload.facts).toMatchObject({ kind: 'merge_reconcile_review' });
  });
});

describe('B15: the base moved before the merge', () => {
  it('B15a a clean rebase on the host: S7 again on the rebased head, a new pack and a new G4, then the merge', async () => {
    const w = await world();
    await pushed(w, H1);
    await toMerge(w);
    // main moves; the PR is rebased onto it on the host without a conflict: its head is a new commit
    w.gh.moveBranch(w.repo, 'main', BASE2);
    w.gh.pushToPull(w.repo, w.pr, H2, 'rebase onto main');
    const { r } = await observe(w);
    expect(r).toMatchObject({ recorded: 1, rework: 1, completed: 0, x4_opened: 0 });
    const [rec] = await listMergeReconciled(s.record.pool, w.itemId);
    expect(rec).toMatchObject({
      outcome: 'rebased',
      reason: 'base_moved_clean_rebase',
      head_sha: H2,
      base_sha: BASE2,
      approved: { head_sha: H1 },
      // the pinned catalogue's limit, through limits.ts
      b15a: { taken: 0, limit: 2 },
    });
    let st = await state(w);
    expect(st.rework.by_edge['B15']).toBe(1);
    expect(st.outstanding.some((c) => c.type === 'run_stage' && c.step === '7.1')).toBe(true);
    // the PR's head in core is the rebased commit (and stays so when rebuilt from the record): the old approval no
    // longer stands
    expect((await listPullRequests(s.record.pool, w.itemId))[0]?.head_sha).toBe(H2);
    await rebuildPushes(deps(), w.itemId);
    expect((await listPullRequests(s.record.pool, w.itemId))[0]?.head_sha).toBe(H2);
    expect((await readG4Standing(s.record.pool, w.itemId)).state).toBe('head_moved');
    // seen again: one round, not two
    expect((await observe(w)).r).toMatchObject({ recorded: 0, rework: 0 });

    // S7 runs again; with no pack for the rebased head G4 does not open (a new pack is needed)
    await runItem(s, w.d, w.itemId, { stop: g4Open, passes: 6 });
    st = await state(w);
    expect(g4Open(st)).toBe(false);
    expect(st.outstanding.some((c) => c.type === 'open_gates')).toBe(true);
    // 7.6 signs the rebased head's pack: G4 opens on it, bob approves, the item waits for the merge again
    const p2 = await pack(w, H2, BASE2);
    // the refused open is delivered again after its backoff
    s.clock.advance(10 * 60_000);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g4 = (await state(w)).gates.find((g) => g.gate === 'G4' && g.status === 'pending');
    const open = await readGateState(s.record.pool, g4?.gate_instance_id as string);
    const review = G4Review.parse(
      (open?.open.payload.facts as Record<string, unknown>)[G4_REVIEW_FACT],
    );
    expect(review.units[0]).toMatchObject({ head_sha: H2, pack_sha256: p2, base_sha: BASE2 });
    await toMerge(w);
    // merging the rebased head completes
    w.gh.landPull(w.repo, w.pr, 'carol-gh');
    expect((await observe(w)).r).toMatchObject({ completed: 1, x4_opened: 0 });
    expect((await listMergeReconciled(s.record.pool, w.itemId)).at(-1)).toMatchObject({
      outcome: 'completed',
      head_sha: H2,
      approved: { head_sha: H2, pack_sha256: p2 },
    });
  });

  it('B15b a merge conflict: back to S6 (6.4); seeing it again asks once', async () => {
    const w = await world();
    await pushed(w, H1);
    await toMerge(w);
    w.gh.moveBranch(w.repo, 'main', BASE2);
    w.gh.setPullBaseState(w.repo, w.pr, 'conflict');
    const { r } = await observe(w);
    expect(r).toMatchObject({ recorded: 1, rework: 1 });
    const [rec] = await listMergeReconciled(s.record.pool, w.itemId);
    expect(rec).toMatchObject({
      outcome: 'conflict',
      reason: 'merge_conflict',
      head_sha: H1,
      b15a: null,
    });
    const st = await state(w);
    expect(st.underlying).toBe('S6');
    expect(st.rework.by_edge['B15']).toBe(1);
    expect((await observe(w)).r).toMatchObject({ recorded: 0, rework: 0 });
    expect((await state(w)).rework.by_edge['B15']).toBe(1);
    // S6 resolves the conflict and pushes; the stale fact of the old head (still in conflict) changes nothing
    await pushed(w, H3);
    const again = ok(
      await reconcileMerges({ pool: s.record.pool, clock: s.clock, decisions: s.config }),
    );
    expect(again).toMatchObject({ recorded: 0, rework: 0 });
  });
});

describe('fail closed', () => {
  it('an unreadable merge state is no completion', async () => {
    const w = await world();
    await pushed(w, H1);
    await toMerge(w);
    await observe(w);
    w.gh.landPull(w.repo, w.pr, 'carol-gh');
    w.gh.breakMethod('pr_status', readUnknown('network', 'the host did not answer'));
    const { seen, r } = await observe(w);
    expect(seen.recorded).toEqual([]);
    expect(seen.failed.map((f) => f.repo)).toContain(w.repo);
    expect(r).toMatchObject({ recorded: 0, completed: 0 });
    expect(atMerge(await state(w))).toBe(true);
    expect(await listMergeReconciled(s.record.pool, w.itemId)).toEqual([]);
    // once the host answers, the merge is reconciled
    w.gh.unbreak();
    expect((await observe(w)).r.completed).toBe(1);
  });
});
