import {
  GATE_NEEDED_FACT,
  ITEM_EVENT,
  cutGateContext,
  gateNeededSubjectHash,
  type GateNeededDetail,
  type StageOutcome,
} from '@aisdlc/contracts';
import { specHashOf } from '@aisdlc/build';
import { readOpened } from '@aisdlc/decisions';
import { hashCanonical } from '@aisdlc/kernel';
import { FakeStagePorts } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  gateCardContext,
  readItem,
  readItemEvents,
  storeArtefact,
  submitRequest,
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

// P1-8 on the real record, ledger and Notary: an X1 (an irreversible operation) and a G3o (an oracle deviation) raised
// in S6 carry what the stage reported (`stage_gate_needed.detail`); the work driver binds it into the gate's facts and
// subject hash, and `GET /v1/cards/:id/gate/context` shows it: X1's command and target, G3o's oracle diff against the
// approved specs. The bff cuts the agent's text by data class (`cutGateContext`). The S6 port is the stage-port fake.

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

let n = 0;
async function item(script: (ports: FakeStagePorts) => void) {
  n += 1;
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
  approvers(s, seeded.project, ['bob', 'carol']);
  s.elig.setHolders(pid(seeded.project), 'x', [pr('bob'), pr('carol')]);
  s.elig.setHolders(pid(seeded.project), 'design', [pr('bob')]);
  const sub = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L3',
      requester: pr('alice'),
      channel: 'N1',
      text: `gate subject test ${n}`,
    }),
  );
  const ports = new FakeStagePorts();
  script(ports);
  return { ...seeded, itemId: sub.item_id as string, d: driverOver(s, { ports }) };
}

const pendingOf = async (itemId: string, gate: string) =>
  (await readItem(s.record.pool, itemId))?.state.gates.find(
    (g) => g.gate === gate && g.status === 'pending',
  );

const waitsOn =
  (gate: string) =>
  (st: { gates: ReadonlyArray<{ gate: string; status: string }> }): boolean =>
    st.gates.some((g) => g.gate === gate && g.status === 'pending');

/** The engine's subject hash of the newest open (before core added its part). */
async function engineHash(itemId: string): Promise<string> {
  const e = (await readItemEvents(s.record.pool, itemId))
    .filter((x) => x.type === ITEM_EVENT.gates_opened)
    .at(-1);
  return (e?.payload as { subject_hash: string }).subject_hash;
}

describe('X1: an irreversible operation', () => {
  const op: GateNeededDetail = {
    kind: 'irreversible_operation',
    source: 'tripwire',
    what: 'a force push',
    command: 'git push --force origin main',
    target: null,
    agent_note: null,
  };

  it('the command and its classification are bound into the gate and shown; the command is cut below D2', async () => {
    const w = await item((p) =>
      p.scriptStep('6.4', [
        {
          outcome: 'gate_needed',
          gate: 'X1',
          reason_code: 'irreversible_operation',
          detail: op,
        } satisfies StageOutcome,
      ]),
    );
    await runItem(s, w.d, w.itemId, { stop: waitsOn('X1') });
    const g = await pendingOf(w.itemId, 'X1');
    expect(g?.station).toBe('6.4!X1');
    const opened = await readOpened(s.record.pool, g?.gate_instance_id as string);
    expect((opened?.payload.facts as Record<string, unknown>)[GATE_NEEDED_FACT]).toEqual(op);
    expect(opened?.payload.subject_hash).toBe(
      gateNeededSubjectHash(await engineHash(w.itemId), op),
    );
    const card = await cardOfGate(s, w.itemId, g?.gate_instance_id as string);
    const ctx = ok(await gateCardContext(s.record.pool, card));
    expect(ctx).toMatchObject({ gate: 'X1', step: '6.4', check: null });
    expect(ctx.binds).toContainEqual({ label: 'stage report', value: hashCanonical(op) });
    expect(ctx.subject).toEqual({
      kind: 'irreversible_operation',
      reason_code: 'irreversible_operation',
      operation: op,
      command_withheld: false,
    });
    // the agent's command line is tripwire evidence: D2 only
    const d1 = cutGateContext(ctx, 'D1').subject;
    expect(d1).toMatchObject({
      operation: { what: 'a force push', command: null },
      command_withheld: true,
    });
    expect(cutGateContext(ctx, 'D2').subject).toEqual(ctx.subject);
  });

  it('a stage that reports no detail: the card says unknown, the subject hash is the engine’s', async () => {
    const w = await item((p) =>
      p.scriptStep('6.4', [{ outcome: 'gate_needed', gate: 'X1', reason_code: 'agent_blocked' }]),
    );
    await runItem(s, w.d, w.itemId, { stop: waitsOn('X1') });
    const g = await pendingOf(w.itemId, 'X1');
    const opened = await readOpened(s.record.pool, g?.gate_instance_id as string);
    expect(opened?.payload.subject_hash).toBe(await engineHash(w.itemId));
    const ctx = ok(
      await gateCardContext(
        s.record.pool,
        await cardOfGate(s, w.itemId, g?.gate_instance_id as string),
      ),
    );
    expect(ctx.subject).toEqual({
      kind: 'irreversible_operation',
      reason_code: 'agent_blocked',
      operation: null,
      command_withheld: false,
    });
  });
});

describe('G3o: the oracle code deviates from the approved specs', () => {
  const O1 = {
    oracle_id: 'O1',
    requirement_id: 'R1',
    description: 'add adds',
    expected_failure: 'add(2, 2) is 5',
  };
  const O2 = {
    oracle_id: 'O2',
    requirement_id: 'R2',
    description: 'mul multiplies',
    expected_failure: 'mul(2, 3) is 5',
  };

  it('the oracle diff: each approved spec with its status, then the files no spec approved; decided, 6.3 is done', async () => {
    const detail: GateNeededDetail = {
      kind: 'oracle_deviation',
      deviations: [
        { kind: 'spec_mismatch', oracle_id: 'O2', path: 'test/oracle-mul.test.js' },
        { kind: 'no_marker', oracle_id: null, path: 'test/extra.test.js' },
      ],
    };
    const w = await item((p) =>
      p.scriptStep('6.3', [
        {
          outcome: 'gate_needed',
          gate: 'G3o',
          reason_code: 'oracle_deviation',
          detail,
        } satisfies StageOutcome,
      ]),
    );
    ok(
      await storeArtefact(s.deps, {
        item_id: w.itemId,
        project_id: w.project,
        type: 'oracle_specs',
        step: '3.4',
        command_key: `seed/3.4/${w.itemId}`,
        run_id: null,
        content: { kind: 'oracle_specs', oracles: [O1, O2] },
      }),
    );
    await runItem(s, w.d, w.itemId, { stop: waitsOn('G3o') });
    const g = await pendingOf(w.itemId, 'G3o');
    expect(g?.station).toBe('6.3!G3o');
    const card = await cardOfGate(s, w.itemId, g?.gate_instance_id as string);
    const ctx = ok(await gateCardContext(s.record.pool, card));
    const sub = ctx.subject;
    if (sub?.kind !== 'oracle_deviation') throw new Error(`not an oracle deviation: ${sub?.kind}`);
    expect(sub).toMatchObject({
      reason_code: 'oracle_deviation',
      chained_from: null,
      deviations_known: true,
      text_withheld: false,
      // GATING_OFF: no G2 was decided, so the specs shown are the newest, bound by no gate (said so)
      approved: { gate_instance_id: null, intact: true },
    });
    expect(sub.approved.oracles).toEqual([
      { ...O1, spec_sha256: specHashOf(O1) },
      { ...O2, spec_sha256: specHashOf(O2) },
    ]);
    expect(sub.diff).toEqual([
      { oracle_id: 'O1', path: null, status: 'as_approved' },
      { oracle_id: 'O2', path: 'test/oracle-mul.test.js', status: 'spec_mismatch' },
      { oracle_id: null, path: 'test/extra.test.js', status: 'no_marker' },
    ]);
    // the spec text is the content of the work: D1
    const d0 = cutGateContext(ctx, 'D0').subject;
    expect(d0).toMatchObject({ text_withheld: true });
    expect(d0?.kind === 'oracle_deviation' && d0.approved.oracles[0]?.description).toBeNull();
    // the design approver decides; approved, 6.3 is done and the item goes on
    ok(await decideGate(s, g?.gate_instance_id as string, 'bob', 'approve'));
    const after = await runItem(s, w.d, w.itemId, {
      stop: (st) => st.approved['6.3'] !== undefined,
    });
    expect(after?.state.approved['6.3']).toContain('G3o');
  });
});
