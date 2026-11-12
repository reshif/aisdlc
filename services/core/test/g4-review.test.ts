import {
  EVIDENCE_BUCKET,
  EVIDENCE_EVENT,
  G4Review,
  G4_REVIEW_FACT,
  GATE_EVENT,
  ITEM_EVENT,
  PUSH_EVENT,
  evidenceStream,
  pushStream,
  type Lane,
} from '@aisdlc/contracts';
import { decide, prepare, recordEvidenceViewed, readGateState } from '@aisdlc/decisions';
import { hashCanonical, sha256Hex } from '@aisdlc/kernel';
import { FakeGitHub, emptySeed, readUnreadable } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakePrincipalLinks,
  gateCardContext,
  inCoreTx,
  lockKeys,
  readG4Standing,
  readItem,
  readItemEvents,
  rebuildEvidencePacks,
  rebuildPushes,
  reviewerUnsure,
  submitRequest,
  type ReviewPorts,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  cardOfGate,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// M15.1 G4 review on the real record, ledger and Notary, through the work driver and the decision kernel, with the
// stage-port fakes for S6/S7 and the fake GitHub behind the code-host port. What S6 and S7 leave in the record (the
// push intent with its paths, the push receipt that made the PR, the passing Evidence Pack of the head) is written as
// those events, and the read models are rebuilt from them. Mode E (the g4 slot on the pack), mode C after B14 (only
// the code owners of the changed paths), a sensitive path (codeowner and D37 step-up), the human author barred (L8),
// B13 back to S6 within ET7 and then D3, no pack for the head (G4 does not open), a new push after approval.

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
const H1 = '1'.repeat(40);
const H2 = '2'.repeat(40);
const H3 = '3'.repeat(40);
const CODEOWNERS = '* @evan\nsrc/billing/ @olga\ndb/ @olga\n';

interface World {
  readonly project: string;
  readonly repo: string;
  readonly itemId: string;
  readonly d: WorkDriverDeps;
  readonly links: FakePrincipalLinks;
}

let n = 0;
async function world(
  o: { lane?: Lane; codeowners?: string | 'unreadable'; g4?: string[] } = {},
): Promise<World> {
  n += 1;
  // a repo whose record lets the factory review on evidence (A2, green): what asks for mode C is then the item's
  const seeded = await seedActivePrr(s, {
    level: 'full',
    gating: GATING_OFF,
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
  // the g4 slot: the code owners (identity syncs them from CODEOWNERS); bob holds it too
  s.elig.setHolders(pid(seeded.project), 'g4', (o.g4 ?? ['bob', 'evan', 'olga']).map(pr));
  const sub = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: o.lane ?? 'L3',
      requester: pr('alice'),
      channel: 'N1',
      text: `g4 review test ${n}`,
    }),
  );
  const gh = new FakeGitHub(
    emptySeed({
      repos: [{ full_name: seeded.repo, default_branch: 'main', private: true, archived: false }],
      heads: [{ repo: seeded.repo, branch: 'main', sha: BASE }],
      files:
        o.codeowners === 'unreadable'
          ? []
          : [
              {
                repo: seeded.repo,
                sha: BASE,
                path: '.github/CODEOWNERS',
                content: o.codeowners ?? CODEOWNERS,
              },
            ],
    }),
  );
  const links = new FakePrincipalLinks().link('evan', 'evan').link('olga', 'olga');
  const review: ReviewPorts = {
    source:
      o.codeowners === 'unreadable'
        ? { codeowners: async () => readUnreadable('forbidden', 'no contents permission') }
        : gh,
    links,
  };
  return {
    ...seeded,
    itemId: sub.item_id as string,
    d: { ...driverOver(s), review } as WorkDriverDeps,
    links,
  };
}

/** What 6.6 and 7.6 leave in the record for a head: the push intent (its paths), the receipt (the PR), the pack. */
async function pushed(w: World, head: string, paths: string[] | null, passing = true) {
  const patch_hash = sha256Hex(`patch-${head}-${(paths ?? []).join(',')}`);
  const deps = { pool: s.record.pool, clock: s.clock };
  ok(
    await inCoreTx(deps, async (j, tx) => {
      await lockKeys(tx, [`push:${w.itemId}`, `evidence:${w.itemId}`]);
      const a = await j.emitAll(pushStream(w.itemId), [
        {
          type: PUSH_EVENT.intended,
          body: {
            item_id: w.itemId,
            unit_key: 'main',
            repo: w.repo,
            branch: `agent/${w.itemId}/main`,
            lease_epoch: 1,
            base_sha: BASE,
            patch_hash,
            files: paths?.length ?? 1,
            command_key: `cmd-${w.itemId}-${head}`,
            ...(paths ? { paths } : {}),
          },
          actor: 'system.push',
          idempotency_key: `push:intent:cmd-${head}`,
        },
        {
          type: PUSH_EVENT.receipt_recorded,
          body: {
            receipt_id: `rcpt-${w.itemId}-${head.slice(0, 8)}`,
            item_id: w.itemId,
            unit_key: 'main',
            repo: w.repo,
            branch: `agent/${w.itemId}/main`,
            lease_epoch: 1,
            patch_hash,
            status: 'applied',
            code: null,
            base_sha: BASE,
            head_sha: head,
            pr_number: 7,
            files: paths?.length ?? 1,
            at: s.clock.now().toISOString(),
          },
          actor: 'system.push',
          idempotency_key: `push:receipt:${head}`,
        },
      ]);
      if (!a.ok) return a;
      const pack = sha256Hex(`pack-${w.itemId}-${head}`);
      const b = await j.emitAll(evidenceStream(w.itemId), [
        {
          type: EVIDENCE_EVENT.pack_signed,
          body: {
            command_key: `s7-${w.itemId}-${head}`,
            item_id: w.itemId,
            unit_key: 'main',
            base_sha: BASE,
            head_sha: head,
            pack_sha256: pack,
            bucket: EVIDENCE_BUCKET,
            object_key: sha256Hex(`bytes-${w.itemId}-${head}`),
            disposition: passing
              ? { kind: 'passed' }
              : { kind: 'handoff', trigger: 'ET4', step: '7.6', reason_code: 'unknown' },
            passing,
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
  await rebuildPushes(deps, w.itemId);
  await rebuildEvidencePacks(deps, w.itemId);
  return sha256Hex(`pack-${w.itemId}-${head}`);
}

/** The item waits at 8.1 and its G4 instance is open. */
const g4Open = (st: {
  waiting: unknown;
  gates: ReadonlyArray<{ gate: string; status: string }>;
}) => {
  const w = st.waiting as { kind?: string; gates?: string[] } | null;
  return (
    w?.kind === 'gates' &&
    (w.gates ?? []).includes('G4') &&
    st.gates.some((g) => g.gate === 'G4' && g.status === 'pending')
  );
};

/** The item's G4 instances, oldest first, with their open payloads. */
async function g4s(itemId: string) {
  const q = await s.record.pool.query<{ stream: string }>(
    `SELECT stream FROM record.record_event WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2
        AND body ->> 'gate_id' = 'G4' ORDER BY global_seq`,
    [GATE_EVENT.opened, itemId],
  );
  const out = [];
  for (const r of q.rows) {
    const g = await readGateState(s.record.pool, r.stream.slice('gate:'.length));
    if (!g) throw new Error('no gate');
    out.push({
      id: g.open.gate_instance_id,
      status: g.status,
      outcome: g.outcome,
      payload: g.open.payload,
      review: G4Review.parse((g.open.payload.facts as Record<string, unknown>)[G4_REVIEW_FACT]),
    });
  }
  return out;
}

const pendingG4 = async (itemId: string) => {
  const p = (await g4s(itemId)).filter((g) => g.status === 'pending');
  const errors = await s.record.pool.query<{ last_error: string }>(
    `SELECT last_error FROM record.outbox WHERE last_error IS NOT NULL AND payload ->> 'item_id' = $1`,
    [itemId],
  );
  expect(p, JSON.stringify(errors.rows)).toHaveLength(1);
  return p[0] as Awaited<ReturnType<typeof g4s>>[number];
};

describe('G4 review mode E (the evidence approver)', () => {
  it('every input known: mode E, bound to the passing pack of exactly the PR head; any g4 holder decides', async () => {
    const w = await world();
    const pack = await pushed(w, H1, ['src/app.js', 'test/app.test.js']);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g = await pendingG4(w.itemId);
    expect(g.review).toMatchObject({
      mode: 'E',
      reasons: ['evidence_sufficient'],
      units: [{ unit_key: 'main', pr_number: 7, head_sha: H1, base_sha: BASE, pack_sha256: pack }],
      evidence_sha256: pack,
      changed_paths: { count: 2 },
      step_up: false,
      deciders: { basis: 'g4_slot', principals: [] },
      codeowners: { read: 'ok', at_sha: BASE },
    });
    // the card shows the pack as its evidence and binds the review into its subject hash; no narrowing, no step-up
    expect(g.payload.evidence_pack_hash).toBe(pack);
    expect(g.payload.deciders).toBeUndefined();
    expect(g.payload.step_up.required).toBe(false);
    const opened = (await readItemEvents(s.record.pool, w.itemId)).filter(
      (e) => e.type === ITEM_EVENT.gates_opened,
    );
    const engineHash = (opened.at(-1)?.payload as { subject_hash: string }).subject_hash;
    expect(g.payload.subject_hash).toBe(
      hashCanonical({ engine: engineHash, [G4_REVIEW_FACT]: g.review }),
    );
    const p = ok(await prepare(s.config, { gate_instance_id: g.id, principal: pr('bob') }));
    expect(p.evidence_hash).toBe(pack);
    // the requester never decides (alice does not hold g4 either way)
    const alice = await decideGate(s, g.id, 'alice', 'approve');
    expect(!alice.ok && alice.error.code).toBe('not_eligible');
    // bob holds g4 but owns none of the paths: in mode E that is enough
    ok(await decideGate(s, g.id, 'bob', 'approve'));
    expect((await readG4Standing(s.record.pool, w.itemId)).state).toBe('approved');
    const done = await runItem(s, w.d, w.itemId);
    expect(done?.state.terminal).toBe('Done');
  });
});

describe('B14 the mode-E approver is unsure: mode C, the code owners of the changed paths', () => {
  it('the same review opens again in mode C; only an owner of the changed paths decides it; once', async () => {
    const w = await world();
    await pushed(w, H1, ['src/billing/charge.js']);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const e = await pendingG4(w.itemId);
    expect(e.review.mode).toBe('E');
    // someone who cannot decide G4 cannot be unsure of it
    const zed = await reviewerUnsure({ ...s.deps, decisions: s.config }, w.itemId, pr('zed'), 'k0');
    expect(!zed.ok && zed.error.code).toBe('forbidden');
    ok(await reviewerUnsure({ ...s.deps, decisions: s.config }, w.itemId, pr('bob'), 'k1'));
    await runItem(s, w.d, w.itemId, { stop: (st) => g4Open(st) && st.review_mode === 'C' });
    const all = await g4s(w.itemId);
    const c = await pendingG4(w.itemId);
    expect(all.find((x) => x.id === e.id)?.status).not.toBe('pending');
    expect(c.review).toMatchObject({
      mode: 'C',
      reasons: ['b14_unsure'],
      deciders: { basis: 'path_owners', principals: ['olga'] },
    });
    expect(c.payload.deciders).toEqual(['olga']);
    // B14 is taken once: the review is already with a codeowner
    const again = await reviewerUnsure(
      { ...s.deps, decisions: s.config },
      w.itemId,
      pr('olga'),
      'k2',
    );
    expect(!again.ok && again.error.code).toBe('conflict');
    // bob and evan hold g4 but do not own src/billing/: not eligible in mode C
    for (const who of ['bob', 'evan']) {
      const r = await decideGate(s, c.id, who, 'approve');
      expect(!r.ok && r.error.code, who).toBe('not_eligible');
    }
    ok(await decideGate(s, c.id, 'olga', 'approve'));
    expect((await readG4Standing(s.record.pool, w.itemId)).state).toBe('approved');
  });
});

describe('a sensitive path: codeowner plus the D37 step-up', () => {
  it('mode C with the step-up bound to the card; no proof, no decision', async () => {
    const w = await world();
    await pushed(w, H1, ['src/app.js', 'db/migrations/0002_orders.sql']);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g = await pendingG4(w.itemId);
    expect(g.review).toMatchObject({
      mode: 'C',
      reasons: ['sensitive_path'],
      sensitive_paths: ['db/migrations/0002_orders.sql'],
      step_up: true,
      deciders: { basis: 'path_owners', principals: ['evan', 'olga'] },
    });
    expect(g.payload.step_up).toEqual({ required: true, bound_hash: g.payload.subject_hash });
    const p = ok(await prepare(s.config, { gate_instance_id: g.id, principal: pr('olga') }));
    ok(await recordEvidenceViewed(s.config, { nonce: p.nonce, evidence_hash: p.evidence_hash }));
    const bare = await decide(s.config, { nonce: p.nonce, decision: 'approve' });
    expect(!bare.ok && bare.error.code).toBe('step_up_required');
    // with the proof bound to the card's hash (the fixture issues it)
    ok(await decideGate(s, g.id, 'olga', 'approve'));
    const e = await s.record.pool.query<{ body: { step_up: unknown } }>(
      `SELECT body FROM ledger.ledger_entry WHERE gate_instance_id = $1 AND entry_type = 'decision'`,
      [g.id],
    );
    expect(e.rows[0]?.body.step_up).not.toBeNull();
  });

  it('paths not in the record are unsure and sensitive; CODEOWNERS unreadable is unsure (the g4 slot decides)', async () => {
    const w = await world({ codeowners: 'unreadable' });
    await pushed(w, H1, null);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g = await pendingG4(w.itemId);
    expect(g.review).toMatchObject({
      mode: 'C',
      reasons: ['paths_unknown', 'codeowners_unreadable'],
      step_up: true,
      changed_paths: { count: null, sha256: null },
      deciders: { basis: 'g4_slot', principals: [] },
      codeowners: { read: 'unreadable' },
    });
  });
});

describe('the author never approves', () => {
  it('L8: the developer who did the work is barred from G4 like the requester (mode C, human_led)', async () => {
    const w = await world({ lane: 'L8', codeowners: '* @olga @bob\n' });
    s.elig.setHolders(pid(w.project), 'g4', [pr('bob'), pr('olga')]);
    w.links.link('bob', 'bob');
    await pushed(w, H1, ['src/app.js']);
    await runItem(s, w.d, w.itemId, { stop: g4Open, approver: 'bob' });
    const g = await pendingG4(w.itemId);
    expect(g.review).toMatchObject({
      mode: 'C',
      reasons: ['human_led'],
      authors: ['bob'],
      deciders: { basis: 'path_owners', principals: ['bob', 'olga'] },
    });
    expect(g.payload.authors).toEqual(['bob']);
    const own = await decideGate(s, g.id, 'bob', 'approve');
    expect(!own.ok && own.error.code).toBe('own_request');
    ok(await decideGate(s, g.id, 'olga', 'approve'));
  });
});

describe('B13 changes requested: back to S6 within ET7, then D3', () => {
  it('two rounds go back to 6.4 and each new head is a new G4; the third request is the D3 handoff (ET7)', async () => {
    const w = await world();
    await pushed(w, H1, ['src/app.js']);
    for (const next of [H2, H3, null]) {
      await runItem(s, w.d, w.itemId, { stop: g4Open });
      const g = await pendingG4(w.itemId);
      ok(await decideGate(s, g.id, 'bob', 'request_changes'));
      // S6 runs again and pushes: the next head, with its own pack
      if (next !== null) await pushed(w, next, ['src/app.js']);
    }
    await runItem(s, w.d, w.itemId, { stop: (st) => st.handoffs.some((h) => h.code === 'D3') });
    const st = (await readItem(s.record.pool, w.itemId))?.state;
    const d3 = st?.handoffs.find((h) => h.code === 'D3');
    expect(d3, JSON.stringify(st?.waiting)).toMatchObject({ code: 'D3', origin_phase: 'G4' });
    expect(st?.rework.by_edge['B13']).toBe(3);
    const all = await g4s(w.itemId);
    // three G4 reviews, each bound to the head of its round, each decided request_changes
    expect(all.map((g) => [g.review.units[0]?.head_sha, g.outcome])).toEqual([
      [H1, 'request_changes'],
      [H2, 'request_changes'],
      [H3, 'request_changes'],
    ]);
    expect(new Set(all.map((g) => g.payload.subject_hash)).size).toBe(3);
  });
});

describe('fail closed', () => {
  it('no passing pack for the PR head: G4 does not open (the command is delivered again), never a plain card', async () => {
    const w = await world();
    await pushed(w, H1, ['src/app.js'], false);
    await runItem(s, w.d, w.itemId, { stop: g4Open, passes: 6 });
    expect(await g4s(w.itemId)).toEqual([]);
    const st = (await readItem(s.record.pool, w.itemId))?.state;
    expect(st?.outstanding.some((c) => c.type === 'open_gates')).toBe(true);
  });

  it('a new push after the approval: G4 no longer stands for the PR (head moved)', async () => {
    const w = await world();
    await pushed(w, H1, ['src/app.js']);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g = await pendingG4(w.itemId);
    ok(await decideGate(s, g.id, 'bob', 'approve'));
    expect((await readG4Standing(s.record.pool, w.itemId)).state).toBe('approved');
    await pushed(w, H2, ['src/app.js', 'src/other.js']);
    const st = await readG4Standing(s.record.pool, w.itemId);
    expect(st).toMatchObject({ state: 'head_moved', heads: { main: H2 } });
    expect(st.review?.units[0]?.head_sha).toBe(H1);
  });
});

describe('the G4 card in the portal (P1-3): what the gate context says it decides', () => {
  it('the review, the PR link, the pack of exactly the head, the diff by path flagged, step-up, B13 rounds left', async () => {
    const w = await world();
    const pack = await pushed(w, H1, ['src/app.js', 'db/migrations/0002_orders.sql', 'AGENTS.md']);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g = await pendingG4(w.itemId);
    const ctx = ok(await gateCardContext(s.record.pool, await cardOfGate(s, w.itemId, g.id)));
    expect(ctx).toMatchObject({ gate: 'G4', gate_instance_id: g.id, step: null });
    expect(ctx.step_up).toEqual({ required: true, bound_hash: g.payload.subject_hash });
    // the review core added to the engine's subject is one of the things the hash binds
    expect(ctx.binds).toContainEqual({ label: 'G4 review', value: hashCanonical(g.review) });
    const sub = ctx.subject;
    if (sub?.kind !== 'merge_review') throw new Error(`not a merge review: ${sub?.kind}`);
    expect(sub.review).toEqual(g.review);
    expect(sub.review).toMatchObject({ mode: 'C', step_up: true });
    expect(sub.standing).toBe('pending');
    const [u] = sub.units;
    expect(u).toMatchObject({
      unit_key: 'main',
      head_sha: H1,
      pack_sha256: pack,
      pr: { repo: w.repo, number: 7, state: 'open', url: `https://github.com/${w.repo}/pull/7` },
      pack: { pack_sha256: pack, head_sha: H1, passing: true },
      paths_truncated: false,
    });
    expect(u?.paths).toEqual([
      { path: 'AGENTS.md', sensitive: true, protected: true },
      { path: 'db/migrations/0002_orders.sql', sensitive: true, protected: false },
      { path: 'src/app.js', sensitive: false, protected: false },
    ]);
    // no S7 result is in the record for this head: every step is not run (unknown, never a pass)
    expect(u?.steps.map((x) => x.status)).toEqual(Array(5).fill('not_run'));
    // B13 under the pinned catalogue: ET7, two rounds, then D3
    expect(sub.b13).toEqual({ used: 0, limit: 2, left: 2, exhausted_to: 'D3' });
    ok(await decideGate(s, g.id, 'olga', 'request_changes'));
    await pushed(w, H2, ['src/app.js']);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g2 = await pendingG4(w.itemId);
    const next = ok(await gateCardContext(s.record.pool, await cardOfGate(s, w.itemId, g2.id)));
    if (next.subject?.kind !== 'merge_review') throw new Error('not a merge review');
    expect(next.subject.b13).toMatchObject({ used: 1, left: 1 });
    expect(next.step_up.required).toBe(false);
    // the first card says its G4 ended with changes requested
    const first = ok(await gateCardContext(s.record.pool, await cardOfGate(s, w.itemId, g.id)));
    expect(first.subject?.kind === 'merge_review' && first.subject.standing).toBe(
      'changes_requested',
    );
  });

  it('paths not in the record are unknown on the card, never an empty diff', async () => {
    const w = await world();
    await pushed(w, H1, null);
    await runItem(s, w.d, w.itemId, { stop: g4Open });
    const g = await pendingG4(w.itemId);
    const ctx = ok(await gateCardContext(s.record.pool, await cardOfGate(s, w.itemId, g.id)));
    if (ctx.subject?.kind !== 'merge_review') throw new Error('not a merge review');
    expect(ctx.subject.units[0]?.paths).toBeNull();
    expect(ctx.subject.review.reasons).toContain('paths_unknown');
  });
});
