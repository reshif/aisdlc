import {
  GATECHECK_EVENT,
  GATE_EVENT,
  MergeObservedPayload,
  gateCheckStream,
  mergeSubjectId,
  type MergeObservedPayload as Merge,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { readGateState } from '@aisdlc/decisions';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MERGE_REVIEW_OBSERVER, observeBypassMerges } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { approvers, decideGate, loadReports, seedActivePrr } from './work-fixtures.js';

// M14.5, core's side of a bypass merge (DEC-10 as refined): gate-check records every merge it saw without aisdlc/gate
// passing, and core opens its X4 post-hoc review through the decision kernel: a card of its own (slot x), on the merge
// as subject, bound to the recorded payload, the merger barred from deciding it (SoD), exactly once.

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

function merge(project: string, repo: string, n: number, cls: Merge['class']): Merge {
  const head = String(n).padStart(2, '0').repeat(20);
  return MergeObservedPayload.parse({
    merge_id: mergeSubjectId(repo, n, head),
    repo,
    project_id: project,
    pr_number: n,
    head_sha: head,
    head_ref: `feature/${n}`,
    merge_commit_sha: 'f'.repeat(40),
    merged_by: cls === 'bypass' ? 'carol-gh' : 'mallory',
    merged_at: '2026-11-12T12:00:00.000Z',
    author: { login: 'carol-gh', type: 'User' },
    class: cls,
    bypass_person: cls === 'bypass' ? { login: 'carol-gh', principal_id: 'carol' } : null,
    last_verdict: { outcome: 'action_required', reason: 'not_factory_work', profile: 'non_agent' },
    host_check: 'not_success',
    item_id: null,
  });
}

async function record(p: Merge): Promise<void> {
  const type =
    p.class === 'bypass' ? GATECHECK_EVENT.bypass_merge : GATECHECK_EVENT.unauthorised_merge;
  await withTransaction(s.record.pool, async (tx) => {
    const a = await appendEvents(tx, gateCheckStream(p.repo, p.pr_number), 0, [
      {
        type,
        body: p as unknown as JsonObject,
        actor: 'system.gate-check',
        idempotency_key: `merge:${p.merge_id}`,
      },
    ]);
    if (!a.ok) throw new Error(a.error._tag);
  });
}

async function x4Of(mergeId: string): Promise<string[]> {
  const q = await s.record.pool.query<{ stream: string }>(
    `SELECT stream FROM record.record_event WHERE type = $1 AND seq = 1
       AND body ->> 'subject_kind' = 'merge' AND body ->> 'subject_id' = $2 AND body ->> 'gate_id' = 'X4'`,
    [GATE_EVENT.opened, mergeId],
  );
  return q.rows.map((r) => r.stream.slice('gate:'.length));
}

describe('X4 for the merges gate-check recorded', () => {
  it('a listed bypass and an unauthorised merge each get one X4 card; the merger cannot decide their own', async () => {
    const x = await seedActivePrr(s, {});
    approvers(s, x.project, ['bob', 'carol']);
    const bypass = merge(x.project, x.repo, 1, 'bypass');
    const rogue = merge(x.project, x.repo, 2, 'unauthorised');
    await record(bypass);
    await record(rogue);
    const r = ok(await observeBypassMerges({ decisions: s.config }));
    expect(r).toEqual({ seen: 2, opened: 2 });
    // again: nothing new after the cursor, and nothing opened twice
    expect(ok(await observeBypassMerges({ decisions: s.config }))).toEqual({ seen: 0, opened: 0 });
    const [b] = await x4Of(bypass.merge_id);
    const [u] = await x4Of(rogue.merge_id);
    expect(b && u).toBeTruthy();
    const gb = await readGateState(s.record.pool, b as string);
    expect(gb?.status).toBe('pending');
    expect(gb?.open.payload).toMatchObject({
      gate_id: 'X4',
      subject_kind: 'merge',
      requester: 'carol',
      quorum: { slot: 'x' },
      facts: {
        kind: 'bypass_merge_review',
        class: 'bypass',
        security: false,
        bypass_principal: 'carol',
      },
    });
    const gu = await readGateState(s.record.pool, u as string);
    expect(gu?.open.payload.facts).toMatchObject({
      class: 'unauthorised',
      security: true,
      merged_by: 'mallory',
    });
    // SoD: the person who bypassed does not review their own bypass; another holder of slot x does
    const own = await decideGate(s, b as string, 'carol', 'approve');
    expect(own.ok).toBe(false);
    ok(await decideGate(s, b as string, 'bob', 'approve'));
    const led = await s.record.pool.query(
      `SELECT gate_id, subject_kind, subject_id, decision FROM ledger.ledger_entry
        WHERE entry_type = 'decision' AND gate_instance_id = $1`,
      [b],
    );
    expect(led.rows).toEqual([
      { gate_id: 'X4', subject_kind: 'merge', subject_id: bypass.merge_id, decision: 'approve' },
    ]);
    const cur = await s.record.pool.query('SELECT name FROM core.observer_cursor WHERE name = $1', [
      MERGE_REVIEW_OBSERVER,
    ]);
    expect(cur.rows).toHaveLength(1);
  });

  it('a gated merge (the check passed) is not reviewed', async () => {
    const x = await seedActivePrr(s, {});
    approvers(s, x.project, ['bob']);
    const p = MergeObservedPayload.parse({
      ...merge(x.project, x.repo, 3, 'unauthorised'),
      class: 'gated',
    });
    await withTransaction(s.record.pool, async (tx) => {
      const a = await appendEvents(tx, gateCheckStream(p.repo, 3), 0, [
        {
          type: GATECHECK_EVENT.merge_gated,
          body: p as unknown as JsonObject,
          actor: 'system.gate-check',
          idempotency_key: `merge:${p.merge_id}`,
        },
      ]);
      if (!a.ok) throw new Error(a.error._tag);
    });
    expect(ok(await observeBypassMerges({ decisions: s.config })).opened).toBe(0);
    expect(await x4Of(p.merge_id)).toEqual([]);
  });
});
