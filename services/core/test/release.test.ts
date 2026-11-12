import { configProjection } from '@aisdlc/config';
import { withTransaction } from '@aisdlc/db';
import {
  G5_ENGINE_HASH_KEY,
  G5_FACTS_KEY,
  GATERELAY_EVENT,
  ITEM_EVENT,
  cutGateContext,
  deployMarkerHash,
  deployMarkerId,
  g5SubjectHash,
  gateRelayStream,
  type DeployMarker,
  type ReleaseBinding,
} from '@aisdlc/contracts';
import { readOpened } from '@aisdlc/decisions';
import { hashCanonical, sha256Hex } from '@aisdlc/kernel';
import { FakeStagePorts } from '@aisdlc/ports';
import { appendEvents, runProjection, type JsonObject } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  gateCardContext,
  ingestItem,
  readItem,
  readItemEvents,
  reRequestRelease,
  releaseBindingOf,
  releaseStagePorts,
  storeArtefact,
  submitRequest,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, publishSettings, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_ON,
  approvers,
  cardOfGate,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// PLAN M15.3 on the real record, ledger and Notary: the project's release choice shapes the route the item pins, the
// G5 card binds the merged commit to the Evidence Pack's head and the target, and S8b follows gate-relay's record
// (deployed and healthy: released; refused or rolled back: RELHOLD, with B16's NEW linked item for a rollback).
// gate-relay itself (its consume and its deployments) has its own tests in services/gate-relay; here its record is
// written as gate-relay writes it.

vi.setConfig({ testTimeout: 120_000 });

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
const MERGED = '1'.repeat(40);
const HEAD = '2'.repeat(40);

let n = 0;
async function project(release: { mode: 'off' } | { mode: 'target'; environment: string } | null) {
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_ON });
  approvers(s, seeded.project, ['bob']);
  if (release !== null) await publishSettings(s, seeded.project, { release }, 'bob', 'alice');
  await runProjection(s.record.pool, configProjection);
  return seeded;
}
async function newItem(seeded: { project: string; repo: string }) {
  n += 1;
  const r = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L4',
      requester: pr('alice'),
      channel: 'N1',
      text: `release test request ${n}`,
    }),
  );
  return r.item_id as string;
}
const driver = (): WorkDriverDeps & { ports: FakeStagePorts } => {
  const base = new FakeStagePorts();
  const d = driverOver(s, { ports: base });
  return {
    ...d,
    ports: releaseStagePorts({ pool: s.record.pool, base, deps: s.deps, retryMs: 1 }) as never,
  };
};
const state = async (id: string) => (await readItem(s.record.pool, id))?.state;

/** What S6 and S7 leave in core's read models for the item: a pushed PR at `prHead`, a passing pack for HEAD. */
async function pushedAndVerified(itemId: string, repo: string, prHead = HEAD) {
  await s.record.pool.query(
    `INSERT INTO core.pull_request (repo, number, item_id, unit_key, head_ref, head_sha, state, draft)
     VALUES ($1, $2, $3, 'main', $4, $5, 'open', true)`,
    [repo, n, itemId, `agent/${itemId}/main`, prHead],
  );
  await s.record.pool.query(
    `INSERT INTO core.evidence_pack (pack_sha256, command_key, item_id, unit_key, base_sha, head_sha, disposition,
       passing, detail, bucket, object_key, key_id, produced_at, event_gseq)
     VALUES ($1, $2, $3, 'main', $4, $5, 'passed', true, '{"kind":"passed"}', 'evidence-packs', $1, 'dev:notary', now(), 1)`,
    [sha256Hex(`pack:${itemId}`), `cmd:${itemId}`, itemId, '0'.repeat(40), HEAD],
  );
}

/** Drives to the human merge, then the factory observes it with the merged commit. */
async function toMerged(d: WorkDriverDeps, itemId: string, repo: string, prHead = HEAD) {
  const at = await runItem(s, d, itemId, {
    stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'merge',
  });
  expect(at?.state.waiting).toMatchObject({ kind: 'human', what: 'merge' });
  await pushedAndVerified(itemId, repo, prHead);
  ok(
    await ingestItem(s.deps, itemId, {
      type: ITEM_EVENT.merge_observed,
      payload: { merged_sha: MERGED },
      actor: 'system.codehost',
      idempotency_key: `merge:${itemId}`,
    }),
  );
}

const g5Of = async (itemId: string) => (await state(itemId))?.gates.filter((g) => g.gate === 'G5');

/** Writes gate-relay's record for an item's G5, as gate-relay does (the service's own tests show how it gets there). */
async function relay(
  itemId: string,
  gate: string,
  binding: Extract<ReleaseBinding, { status: 'bound' }>,
  then: 'healthy' | 'unhealthy' | 'refused',
): Promise<DeployMarker> {
  const marker: DeployMarker = {
    marker_id: deployMarkerId(gate, 'release'),
    kind: 'release',
    item_id: itemId as never,
    project_id: binding.project_id,
    repo: binding.repo,
    environment: binding.environment,
    merged_sha: binding.merged_sha,
    pack_sha256: binding.pack_sha256,
    gate_instance_id: gate as never,
    binding_sha256: sha256Hex('b'),
    deployment_id: 7,
    rollback_of: null,
    created_at: '2026-11-12T12:00:00.000Z',
  };
  const events =
    then === 'refused'
      ? [
          {
            type: GATERELAY_EVENT.release_refused,
            body: {
              item_id: itemId,
              project_id: binding.project_id,
              gate_instance_id: gate,
              reason: 'merged_content_mismatch',
              detail: 'no gated merge',
              refused_at: '2026-11-12T12:00:00.000Z',
            },
          },
        ]
      : [
          { type: GATERELAY_EVENT.deployment_created, body: marker },
          {
            type:
              then === 'healthy'
                ? GATERELAY_EVENT.deploy_healthy
                : GATERELAY_EVENT.deploy_unhealthy,
            body: {
              item_id: itemId,
              marker_id: marker.marker_id,
              deployment_id: 7,
              state: then === 'healthy' ? 'success' : 'failure',
              observed_at: '2026-11-12T12:01:00.000Z',
              ...(then === 'unhealthy' ? { rollback_marker_id: null } : {}),
            },
          },
        ];
  await withTransaction(s.record.pool, async (tx) => {
    const r = await appendEvents(
      tx,
      gateRelayStream(itemId),
      0,
      events.map((e, i) => ({
        type: e.type,
        body: e.body as unknown as JsonObject,
        actor: 'system.gate-relay',
        idempotency_key: `t:${gate}:${i}`,
      })),
      { clock: s.clock },
    );
    if (!r.ok) throw new Error(r.error._tag);
  });
  return marker;
}

describe('the release choice shapes the route the item pins', () => {
  it('release off: no G5, S8b releases nothing, the item goes on to S9 and Done', async () => {
    const p = await project({ mode: 'off' });
    const id = await newItem(p);
    const created = (await readItemEvents(s.record.pool, id)).find(
      (e) => e.type === ITEM_EVENT.created,
    );
    expect(created?.payload).toMatchObject({
      gating_profile: { gates: { g5: 'off' }, project_deploys: false },
    });
    const d = driver();
    const done = await runItem(s, d, id);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.gates.some((g) => g.gate === 'G5')).toBe(false);
    expect(done?.state.gates.some((g) => g.gate === 'G6')).toBe(true);
  });

  it('a target keeps G5 and says the project deploys; not chosen keeps the readiness record’s profile', async () => {
    const t = await newItem(await project({ mode: 'target', environment: 'production' }));
    const pinned = async (id: string) =>
      (await readItemEvents(s.record.pool, id)).find((e) => e.type === ITEM_EVENT.created)?.payload;
    expect(await pinned(t)).toMatchObject({
      gating_profile: { gates: { g5: 'on' }, project_deploys: true },
    });
    const u = await newItem(await project(null));
    expect(await pinned(u)).toMatchObject({ gating_profile: GATING_ON });
  });
});

describe('the G5 card binds the merged commit to the Evidence Pack and the target', () => {
  it('binds, in the facts and the subject hash; an approved, healthy release completes S8b', async () => {
    const p = await project({ mode: 'target', environment: 'production' });
    const id = await newItem(p);
    const d = driver();
    await toMerged(d, id, p.repo);
    const at = await runItem(s, d, id, {
      decide: (g) => (g === 'G5' ? 'hold' : 'approve'),
      stop: (st) => st.gates.some((g) => g.gate === 'G5'),
    });
    const g5 = (await g5Of(id))?.[0];
    expect(g5?.status).toBe('pending');
    const opened = await readOpened(s.record.pool, g5?.gate_instance_id as string);
    const binding = opened?.payload.facts[G5_FACTS_KEY] as ReleaseBinding;
    expect(binding).toEqual({
      status: 'bound',
      item_id: id,
      project_id: p.project,
      repo: p.repo,
      pr_number: n,
      unit_key: 'main',
      merged_sha: MERGED,
      pack_sha256: sha256Hex(`pack:${id}`),
      pack_head_sha: HEAD,
      environment: 'production',
    });
    const engine = opened?.payload.facts[G5_ENGINE_HASH_KEY] as string;
    expect(opened?.payload.subject_hash).toBe(g5SubjectHash(engine, binding));
    expect(opened?.payload.step_up.required).toBe(true);
    expect(at?.state.phase).toBe('G5');

    // approved: S8b waits for gate-relay (deferred, never failed, never released on its own)
    await runItem(s, d, id, { stop: (st) => st.phase === 'S8b' });
    for (let i = 0; i < 3; i++) await runItem(s, d, id, { passes: 2, stop: () => true });
    expect((await state(id))?.phase).toBe('S8b');
    expect((await state(id))?.terminal).toBeNull();
    const marker = await relay(
      id,
      g5?.gate_instance_id as string,
      binding as Extract<ReleaseBinding, { status: 'bound' }>,
      'healthy',
    );
    s.clock.advance(1000);
    const done = await runItem(s, d, id);
    expect(done?.state.terminal).toBe('Done');
    const completed = (await readItemEvents(s.record.pool, id)).find(
      (e) =>
        e.type === ITEM_EVENT.stage_completed && (e.payload as { step?: string }).step === 'S8b',
    );
    expect((completed?.payload as { output_hash?: string }).output_hash).toBe(
      deployMarkerHash(marker),
    );
  });

  it('a PR head that is not the pack’s head opens G5 unbound: an approval of it releases nothing', async () => {
    const p = await project({ mode: 'target', environment: 'production' });
    const id = await newItem(p);
    const d = driver();
    await toMerged(d, id, p.repo, '3'.repeat(40));
    const b = await releaseBindingOf(s.record.pool, {
      item_id: id,
      project_id: p.project,
      repo: p.repo,
    });
    expect(b).toMatchObject({ status: 'unbound', reason: 'pack_head_not_pr_head' });
    await runItem(s, d, id, {
      decide: (g) => (g === 'G5' ? 'hold' : 'approve'),
      stop: (st) => st.gates.some((g) => g.gate === 'G5'),
    });
    const g5 = (await g5Of(id))?.[0];
    const opened = await readOpened(s.record.pool, g5?.gate_instance_id as string);
    expect(opened?.payload.facts[G5_FACTS_KEY]).toMatchObject({ status: 'unbound' });
  });
});

describe('not released is RELHOLD; a rollback is B16’s NEW linked item; a re-request opens G5 again', () => {
  it('gate-relay refused: RELHOLD; re-request: G5 again on a new instance', async () => {
    const p = await project({ mode: 'target', environment: 'production' });
    const id = await newItem(p);
    const d = driver();
    await toMerged(d, id, p.repo);
    await runItem(s, d, id, { stop: (st) => st.phase === 'S8b' });
    const g5 = (await g5Of(id))?.[0];
    const opened = await readOpened(s.record.pool, g5?.gate_instance_id as string);
    await relay(
      id,
      g5?.gate_instance_id as string,
      opened?.payload.facts[G5_FACTS_KEY] as never,
      'refused',
    );
    s.clock.advance(1000);
    const held = await runItem(s, d, id, { stop: (st) => st.waiting?.kind === 'release_held' });
    expect(held?.state).toMatchObject({ phase: 'S8b', waiting: { kind: 'release_held' } });
    ok(await reRequestRelease(s.deps, id, pr('bob'), 'rr1'));
    await runItem(s, d, id, {
      decide: (g) => (g === 'G5' ? 'hold' : 'approve'),
      stop: (st) => st.gates.filter((g) => g.gate === 'G5').length >= 2,
    });
    expect(await g5Of(id)).toHaveLength(2);
  });

  it('unhealthy: B16 makes a NEW linked rollback item (L0) and the origin holds its release', async () => {
    const p = await project({ mode: 'target', environment: 'production' });
    const id = await newItem(p);
    const d = driver();
    await toMerged(d, id, p.repo);
    await runItem(s, d, id, { stop: (st) => st.phase === 'S8b' });
    const g5 = (await g5Of(id))?.[0];
    const opened = await readOpened(s.record.pool, g5?.gate_instance_id as string);
    await relay(
      id,
      g5?.gate_instance_id as string,
      opened?.payload.facts[G5_FACTS_KEY] as never,
      'unhealthy',
    );
    s.clock.advance(1000);
    const held = await runItem(s, d, id, {
      stop: (st) => st.waiting?.kind === 'release_held' && st.spawns.length > 0,
    });
    expect(held?.state.waiting).toMatchObject({ kind: 'release_held' });
    expect(held?.state.spawns[0]).toMatchObject({ edge: 'B16', kind: 'rollback', lane: 'L0' });
    expect(held?.state.rework.by_edge['B16']).toBe(1);
  });
});

describe('the G5 and G6 cards in the portal (P1-7): what the gate context says they decide', () => {
  it('G5: the binding, the target now, the PR and the release evidence, gate-relay’s state; G6: the intent against what merged', async () => {
    const p = await project({ mode: 'target', environment: 'production' });
    const id = await newItem(p);
    const intent = ok(
      await storeArtefact(s.deps, {
        item_id: id,
        project_id: p.project,
        type: 'intent_block',
        step: '1.5',
        command_key: `seed/1.5/${id}`,
        run_id: null,
        content: {
          kind: 'intent_block',
          goal: 'Admins can export orders',
          non_goals: ['No PDF'],
          acceptance_criteria: ['An admin can download a CSV', 'The CSV has one row per order'],
          open_questions: [],
          assumptions: [],
        },
      }),
    );
    const d = driver();
    // 1.5 answers with the stored intent block: G0 and G1 bind it, and G6 shows what they approved
    (d.ports as unknown as FakeStagePorts).planning.scriptStep('1.5', [
      { outcome: 'completed', output_hash: intent.sha256 as never },
    ]);
    await toMerged(d, id, p.repo);
    await runItem(s, d, id, {
      decide: (g) => (g === 'G5' ? 'hold' : 'approve'),
      stop: (st) => st.gates.some((g) => g.gate === 'G5'),
    });
    const g5 = (await g5Of(id))?.[0];
    const g5card = await cardOfGate(s, id, g5?.gate_instance_id as string);
    const c5 = ok(await gateCardContext(s.record.pool, g5card));
    expect(c5).toMatchObject({ gate: 'G5', step_up: { required: true } });
    const opened = await readOpened(s.record.pool, g5?.gate_instance_id as string);
    expect(c5.binds).toContainEqual({
      label: 'release binding',
      value: hashCanonical(opened?.payload.facts[G5_FACTS_KEY] as never),
    });
    if (c5.subject?.kind !== 'release') throw new Error('not a release');
    expect(c5.subject).toMatchObject({
      binding: {
        status: 'bound',
        merged_sha: MERGED,
        pack_head_sha: HEAD,
        environment: 'production',
      },
      target_now: { state: 'ok', setting: { mode: 'target', environment: 'production' } },
      target_changed: false,
      pr: { repo: p.repo, number: n, url: `https://github.com/${p.repo}/pull/${n}` },
      pack: { pack_sha256: sha256Hex(`pack:${id}`), passing: true },
      deployment: { state: 'none', refusal: null, marker: null },
    });
    // approved; gate-relay deploys and the deploy system says healthy: the card shows it
    ok(await decideGate(s, g5?.gate_instance_id as string, 'bob', 'approve'));
    const marker = await relay(
      id,
      g5?.gate_instance_id as string,
      opened?.payload.facts[G5_FACTS_KEY] as never,
      'healthy',
    );
    const again = ok(await gateCardContext(s.record.pool, g5card));
    expect(again.subject?.kind === 'release' && again.subject.deployment).toEqual({
      state: 'healthy',
      refusal: null,
      marker: {
        marker_id: marker.marker_id,
        environment: 'production',
        merged_sha: MERGED,
        deployment_id: 7,
        created_at: marker.created_at,
      },
      rollback_marker_id: null,
    });

    // S8b released: G6 opens for the requester, of the merged commit and the release
    s.clock.advance(1000);
    await runItem(s, d, id, {
      decide: (g) => (g === 'G6' ? 'hold' : 'approve'),
      stop: (st) => st.gates.some((g) => g.gate === 'G6' && g.status === 'pending'),
    });
    const g6 = (await state(id))?.gates.find((g) => g.gate === 'G6');
    const c6 = ok(
      await gateCardContext(s.record.pool, await cardOfGate(s, id, g6?.gate_instance_id as string)),
    );
    if (c6.subject?.kind !== 'acceptance') throw new Error('not an acceptance');
    expect(c6.subject.acceptance).toEqual({
      requester: 'alice',
      merged_sha: MERGED,
      release_output: deployMarkerHash(marker),
    });
    expect(c6.subject.intent).toMatchObject({
      sha256: intent.sha256,
      bound_by: expect.stringMatching(/^gate:/),
      intact: true,
      goal: 'Admins can export orders',
      acceptance_criteria: ['An admin can download a CSV', 'The CSV has one row per order'],
      non_goals: ['No PDF'],
      withheld: false,
    });
    expect(c6.subject.merged).toEqual([
      expect.objectContaining({
        unit_key: 'main',
        head_sha: HEAD,
        pr: expect.objectContaining({ number: n }),
        pack: expect.objectContaining({ passing: true }),
      }),
    ]);
    expect(c6.subject.release).toEqual({ environment: 'production', state: 'healthy' });
    // the intent's text is the content of the work: withheld below D1
    const d0 = cutGateContext(c6, 'D0').subject;
    expect(d0?.kind === 'acceptance' && d0.intent).toMatchObject({
      goal: null,
      acceptance_criteria: [],
      withheld: true,
    });
  });

  it('G5 when the project’s target moved since the card opened: target_changed (gate-relay would refuse)', async () => {
    const p = await project({ mode: 'target', environment: 'production' });
    const id = await newItem(p);
    const d = driver();
    await toMerged(d, id, p.repo);
    await runItem(s, d, id, {
      decide: (g) => (g === 'G5' ? 'hold' : 'approve'),
      stop: (st) => st.gates.some((g) => g.gate === 'G5'),
    });
    await publishSettings(
      s,
      p.project,
      { release: { mode: 'target', environment: 'staging' } },
      'bob',
      'alice',
    );
    await runProjection(s.record.pool, configProjection);
    const g5 = (await g5Of(id))?.[0];
    const c5 = ok(
      await gateCardContext(s.record.pool, await cardOfGate(s, id, g5?.gate_instance_id as string)),
    );
    expect(c5.subject).toMatchObject({
      kind: 'release',
      target_now: { setting: { environment: 'staging' } },
      target_changed: true,
    });
  });
});
