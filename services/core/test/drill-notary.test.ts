import { CONTROL_EVENT, opsActionStream, type Sha256Hex } from '@aisdlc/contracts';
import { FakeStepUp } from '@aisdlc/decisions';
import { settingsOf } from '@aisdlc/identity/testing';
import { err } from '@aisdlc/kernel';
import { notaryError, type NotaryPort } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeControls,
  applyControl,
  backfillOpsLedger,
  opsBackfillLoop,
  previewControl,
  proposeProjectSettings,
  readOpsAction,
  requestOnboarding,
} from '../src/index.js';
import {
  decideGate,
  pid,
  pr,
  request,
  setAdmins,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';

// M19, the Notary-down drill (ADR-0003 §9 "notary down"), on a real Postgres and a real Notary behind a switch that
// makes every call fail the way an unreachable Notary does:
//   - a gate decision needs the Notary's signature in the same transaction: it FAILS CLOSED (nothing is decided,
//     nothing is in the ledger, the gate stays open and can be decided once the Notary is back);
//   - an operator's control is executed first (FD-D8): it is in force at once, its action waits `pending` with the
//     step-up it consumed (StepUpUse), and the backfill ledgers both after recovery, marked `backfilled`, once.

let s: CoreStack;
let down = false;
let flaky: NotaryPort;

beforeAll(async () => {
  s = await startCoreStack();
  const real = s.deps.ledger?.notary;
  if (!real) throw new Error('the test stack has no Notary');
  // every method of the port answers `unavailable` while the drill holds the Notary down
  flaky = new Proxy(real, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver) as unknown;
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) =>
        down
          ? Promise.resolve(err(notaryError('unavailable', 'the Notary is unreachable')))
          : (v as (...a: unknown[]) => unknown).apply(target, args);
    },
  });
});
afterAll(async () => {
  await s.stop();
});

const ALICE = pr('alice-drill');
const ledgerHead = async () =>
  Number(
    (
      await s.record.pool.query<{ n: string }>(
        'SELECT coalesce(max(ledger_seq), 0)::text AS n FROM ledger.ledger_entry',
      )
    ).rows[0]?.n,
  );

describe('the Notary-down drill', () => {
  it('a gate decision fails closed while the Notary is down, and is decided once it is back', async () => {
    const project = 'drill-notary-a';
    const r = await requestOnboarding(
      s.deps,
      request({ project_id: pid(project), repo: `acme/${project}` }),
    );
    if (!r.ok) throw new Error(r.error.message);
    setAdmins(s, project, ['alice']);
    const p = await proposeProjectSettings(s.config, {
      project: pid(project),
      change: { role_map: settingsOf('x', { admin: ['alice'], requesters: ['bob'] }).role_map },
      proposed_by: pr('alice'),
    });
    if (!p.ok) throw new Error(p.error.message);
    const flakyConfig = { ...s.config, ledger: { ...s.config.ledger, notary: flaky } };
    const before = await ledgerHead();
    down = true;
    const refused = await decideGate(
      { ...s, config: flakyConfig } as CoreStack,
      p.value.gate_instance_id,
      'alice',
      'approve',
    );
    down = false;
    expect(refused.ok).toBe(false);
    expect(await ledgerHead()).toBe(before);
    const decided = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE gate_instance_id = $1 AND decision IS NOT NULL`,
      [p.value.gate_instance_id],
    );
    expect(decided.rows[0].n).toBe(0);
    // the Notary is back: the same gate is decided, with a fresh look at the evidence
    const ok = await decideGate(s, p.value.gate_instance_id, 'alice', 'approve');
    expect(ok.ok).toBe(true);
    expect(await ledgerHead()).toBeGreaterThan(before);
  });

  it('a halt with its step-up is in force at once, waits pending, and is backfilled with its StepUpUse', async () => {
    const stepUp = new FakeStepUp();
    const deps = { ...s.deps, ledger: { ...s.deps.ledger!, notary: flaky }, stepUp };
    const scope = { kind: 'project', ref: 'drill-notary-b' } as const;
    const pv = await previewControl(s.deps, { kind: 'halt', scope, actor: ALICE });
    if (!pv.ok) throw new Error(pv.error.message);
    const proof = stepUp.issue(pv.value.blast_radius_hash, ALICE);

    // a proof for something else is refused before anything is executed
    const wrong = await applyControl(deps, {
      preview_id: pv.value.preview_id,
      nonce: pv.value.nonce,
      kind: 'halt',
      scope,
      actor: ALICE,
      step_up: { proof: stepUp.issue('0'.repeat(64) as Sha256Hex, ALICE) },
    });
    expect(wrong).toMatchObject({ ok: false, error: { code: 'refused' } });

    const before = await ledgerHead();
    down = true;
    const applied = await applyControl(deps, {
      preview_id: pv.value.preview_id,
      nonce: pv.value.nonce,
      kind: 'halt',
      scope,
      actor: ALICE,
      step_up: { proof },
    });
    if (!applied.ok) throw new Error(applied.error.message);
    const action = applied.value.action;
    expect(action).toMatchObject({ tier: 'R', ledger_state: 'pending', backfilled: false });
    expect(action.step_up).toMatchObject({
      principal: ALICE,
      bound_hash: pv.value.blast_radius_hash,
      used_for: { kind: 'ops_action', id: action.action_id },
    });
    expect(action.step_up?.proof_sha256).toMatch(/^[0-9a-f]{64}$/);
    // the proof itself is never recorded
    const evs = await s.record.pool.query<{ body: unknown }>(
      `SELECT body FROM record.record_event WHERE stream = $1`,
      [opsActionStream(action.action_id)],
    );
    expect(JSON.stringify(evs.rows)).not.toContain(proof);
    // in force at once, nothing in the ledger
    expect(
      (await activeControls(s.record.pool, s.clock.now())).some(
        (c) => c.created_by_action === action.action_id,
      ),
    ).toBe(true);
    expect(await ledgerHead()).toBe(before);
    // while the Notary is down, the backfill fails (a failed tick), and changes nothing
    const loop = opsBackfillLoop({ ...s.deps, ledger: deps.ledger });
    await expect(loop.tick({} as never)).rejects.toThrow(/could not be ledgered/);
    expect((await readOpsAction(s.record.pool, action.action_id))?.ledger_state).toBe('pending');

    // recovery
    down = false;
    const r = await backfillOpsLedger({ ...s.deps, ledger: deps.ledger });
    expect(r.failed).toBe(0);
    expect(r.ledgered).toBeGreaterThanOrEqual(1);
    const after = await readOpsAction(s.record.pool, action.action_id);
    expect(after).toMatchObject({ ledger_state: 'ledgered', backfilled: true });
    const led = await s.record.pool.query<{ body: Record<string, unknown> }>(
      `SELECT body FROM ledger.ledger_entry WHERE entry_id = $1`,
      [after?.ledger_entry_id],
    );
    expect(led.rows[0]?.body).toMatchObject({
      kind: 'ops_action',
      verb: 'control.halt',
      tier: 'R',
      backfilled: true,
      step_up: {
        principal: ALICE,
        bound_hash: pv.value.blast_radius_hash,
        proof_sha256: action.step_up?.proof_sha256,
      },
    });
    // once: the loop now has nothing to do
    expect(await loop.tick({} as never)).toMatchObject({ ok: 0 });
    const ledgered = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1 AND type = $2`,
      [opsActionStream(action.action_id), CONTROL_EVENT.ledgered],
    );
    expect(ledgered.rows[0]).toEqual({ n: 1 });
  });

  it('a step-up with no verifier configured is refused (fail closed)', async () => {
    const scope = { kind: 'project', ref: 'drill-notary-c' } as const;
    const pv = await previewControl(s.deps, { kind: 'halt', scope, actor: ALICE });
    if (!pv.ok) throw new Error(pv.error.message);
    const r = await applyControl(s.deps, {
      preview_id: pv.value.preview_id,
      nonce: pv.value.nonce,
      kind: 'halt',
      scope,
      actor: ALICE,
      step_up: { proof: 'anything' },
    });
    expect(r).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
});
