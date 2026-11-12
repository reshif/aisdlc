import { randomUUID } from 'node:crypto';
import {
  AUDIT_EVENT,
  CLOSEOUT_EVENT,
  CLOSEOUT_SCHEMA,
  CloseOutRecord,
  DEFAULT_LEARN_CONFIG,
  FACTORY_M1_POLICY_KEY,
  FACTORY_PROJECT_ID,
  LEARN_CONFIG_KEY,
  MODE_E_LIFTED_EVENT,
  PROJECT_DEFAULT_ENVELOPE_KEY,
  PROJECT_WIP_LIMIT_KEY,
  SANDBOX_CAPS_KEY,
  auditStream,
  closeOutId,
  closeoutStream,
  type CatalogueRef,
  type LearnConfig,
  type ProjectSettings,
} from '@aisdlc/contracts';
import { configPublish, readFactoryM1Policy } from '@aisdlc/config';
import { withTransaction } from '@aisdlc/db';
import { readGateState } from '@aisdlc/decisions';
import { grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { ok as okR } from '@aisdlc/kernel';
import { FakeEnvelope, FakeProjectSettings, FakeWaitSnapshots } from '@aisdlc/ports';
import { appendEvents } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FactoryM1Eligibility,
  admitUnit,
  decideRevision,
  factoryRevisionView,
  identityFleetRoleHolders,
  learnProposals,
  prepareRevision,
  projectLearnView,
  proposeConfigKey,
  readAuditWindow,
  readEarnedAutonomy,
  readItem,
  readModeESuspension,
  rebuildAudits,
  rebuildCloseOut,
  rebuildLearn,
  recordRevisionEvidence,
  requestModeELift,
  runLearn,
  sessionCapOf,
  submitRequest,
} from '../src/index.js';
import {
  decideGate,
  pid,
  pr,
  publishSettings,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';
import { GATING_OFF, approvers, loadReports, seedActivePrr } from './work-fixtures.js';

// PLAN M15.5 on the real record, ledger, Notary and identity:
//   factory M1  a factory-layer revision is decided by a holder of `factory.m1_policy`'s fleet role who is NOT the
//               proposer (no waiver, not even as the only holder); the policy itself is M1-gated; two approvers when it
//               says two
//   9.4 Learn   close-out evidence becomes META proposals (M1, M2, M3, M5, M6), each a gate on the ledger; only a
//               decided M5 promotes autonomy or lifts B19's mode-E suspension (a rejection changes nothing)
//   admission   the project's WIP limit and default envelope (ADR-0003 §6) hold and cap admission; H2's cap is the
//               published `sandbox.caps` coding cap

vi.setConfig({ testTimeout: 180_000 });

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'ben', 'cyd', 'dee']);
  for (const p of ['ada', 'ben']) await grantFleetRole(s.id.deps, p, 'factory.admin');
  // 9.4's thresholds, small enough for a test (a factory revision like any other: ada proposes, ben decides)
  await setFactoryKey(LEARN_CONFIG_KEY, LEARN, 'ada', 'ben');
});
afterAll(async () => {
  await s.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

/** The kernel as core wires it: the factory pseudo-project answered from `factory.m1_policy` and identity. */
const factoryDeps = () => ({
  ...s.config,
  eligibility: new FactoryM1Eligibility(s.elig, {
    policy: () => readFactoryM1Policy(s.record.pool),
    holders: identityFleetRoleHolders(s.record.pool, s.clock),
  }),
});
const kdeps = () => ({ pool: s.record.pool, config: factoryDeps() });

async function headOfFactory(): Promise<string | null> {
  const q = await s.record.pool.query<{ rev_hash: string }>(
    `SELECT body ->> 'rev_hash' AS rev_hash FROM record.record_event
      WHERE type = 'config.published' AND body ->> 'layer' = 'factory' ORDER BY global_seq DESC LIMIT 1`,
  );
  return q.rows[0]?.rev_hash ?? null;
}

async function decideFactory(gate: string, who: string, decision = 'approve') {
  const p = await prepareRevision(kdeps(), { gate, principal: pr(who) });
  if (!p.ok) return p;
  const v = await recordRevisionEvidence(kdeps(), {
    nonce: p.value.nonce,
    evidence_hash: p.value.evidence_hash,
  });
  if (!v.ok) return v;
  return decideRevision(kdeps(), { nonce: p.value.nonce, decision });
}

/** Proposes a factory key as `proposer` and has `approver` decide it; returns the gate. */
async function setFactoryKey(key: string, value: unknown, proposer: string, approver: string) {
  const p = ok(
    await proposeConfigKey(factoryDeps(), {
      key,
      value,
      principal: pr(proposer),
      parent_rev_hash: await headOfFactory(),
    }),
  );
  const d = ok(await decideFactory(p.gate_instance_id, approver));
  expect(d.published, JSON.stringify(d)).toBe(true);
  return p.gate_instance_id;
}

const LEARN: LearnConfig = {
  window: 50,
  clean_streak: 3,
  variance_rework: 2,
  edge_hotspot: 2,
  break_glass: 1,
  single_approver: 3,
};

describe('factory M1: a factory admin other than the proposer decides', () => {
  it('the proposer is barred; another factory admin decides; a non-admin is refused; the view says who may', async () => {
    const p = ok(
      await proposeConfigKey(factoryDeps(), {
        key: LEARN_CONFIG_KEY,
        value: { ...LEARN, window: 60 },
        principal: pr('ada'),
        parent_rev_hash: await headOfFactory(),
      }),
    );
    const view = ok(await factoryRevisionView(kdeps(), p.gate_instance_id));
    expect(view).toMatchObject({
      proposed_by: 'ada',
      deciders: ['ben'],
      quorum: 1,
      policy: { role: 'factory.admin', approvers: 1 },
      status: 'pending',
    });
    expect(view.changes).toEqual([
      { key: LEARN_CONFIG_KEY, before: LEARN, after: { ...LEARN, window: 60 } },
    ]);
    // the proposer may not decide it, not even through the waiver; cyd holds no factory admin binding
    expect((await decideFactory(p.gate_instance_id, 'ada')).ok).toBe(false);
    expect((await decideFactory(p.gate_instance_id, 'cyd')).ok).toBe(false);
    const d = ok(await decideFactory(p.gate_instance_id, 'ben'));
    expect(d).toMatchObject({ outcome: 'approve', published: true });
    // the decision on the ledger is not stamped with a waiver
    const gs = await readGateState(s.record.pool, p.gate_instance_id);
    expect(gs?.decisions.at(-1)).toMatchObject({ actor: 'ben', sod_waiver: false });
    expect(gs?.open.payload.project_id).toBe(FACTORY_PROJECT_ID);
  });

  it('the only factory admin cannot decide their own proposal: no one decides it, the proposal is refused', async () => {
    const deps = {
      ...s.config,
      eligibility: new FactoryM1Eligibility(s.elig, {
        policy: () => readFactoryM1Policy(s.record.pool),
        holders: async () => okR(['ada' as never]),
      }),
    };
    const r = await proposeConfigKey(deps, {
      key: SANDBOX_CAPS_KEY,
      value: { total: 4, coding: 1, hosts: { other: { total: 2, coding: 1 } } },
      principal: pr('ada'),
      parent_rev_hash: await headOfFactory(),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/other than the proposer/);
  });

  it('factory.m1_policy is itself M1-gated; at two approvers a single other admin is not enough', async () => {
    await setFactoryKey(
      FACTORY_M1_POLICY_KEY,
      { role: 'factory.admin', approvers: 2 },
      'ben',
      'ada',
    );
    // two admins: the proposer and one other cannot reach two approvals: the proposal is refused
    const r = await proposeConfigKey(factoryDeps(), {
      key: LEARN_CONFIG_KEY,
      value: { ...LEARN, window: 40 },
      principal: pr('ada'),
      parent_rev_hash: await headOfFactory(),
    });
    expect(r.ok).toBe(false);
    // a third admin: ben and cyd both approve, the first approval leaves it pending
    await grantFleetRole(s.id.deps, 'cyd', 'factory.admin');
    const p = ok(
      await proposeConfigKey(factoryDeps(), {
        key: FACTORY_M1_POLICY_KEY,
        value: { role: 'factory.admin', approvers: 1 },
        principal: pr('ada'),
        parent_rev_hash: await headOfFactory(),
      }),
    );
    expect(ok(await factoryRevisionView(kdeps(), p.gate_instance_id)).quorum).toBe(2);
    expect(ok(await decideFactory(p.gate_instance_id, 'ben'))).toMatchObject({ published: false });
    expect(ok(await decideFactory(p.gate_instance_id, 'cyd'))).toMatchObject({
      outcome: 'approve',
      published: true,
    });
    const policy = await readFactoryM1Policy(s.record.pool);
    expect(policy).toEqual({ state: 'ok', value: { role: 'factory.admin', approvers: 1 } });
  });
});

// ---------------------------------------------------------------- 9.4 Learn

let cat: CatalogueRef;
async function learnProject() {
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
  approvers(s, seeded.project, ['bob']);
  if (!cat) {
    const r = ok(
      await submitRequest(s.deps, {
        project_id: pid(seeded.project),
        repo: seeded.repo,
        lane: 'L3',
        requester: pr('alice'),
        channel: 'N1',
        text: 'a request for the catalogue ref',
      }),
    );
    cat = (await readItem(s.record.pool, r.item_id as string))?.state.catalogue_ref as CatalogueRef;
  }
  return seeded;
}

/** A close-out record (9.3 has its own tests): written as 9.3 writes it, folded by its own rebuild. */
async function closeOut(
  project: string,
  repo: string,
  o: {
    rework?: Record<string, number>;
    breakGlass?: boolean;
    decider?: string;
  } = {},
) {
  const itemId = randomUUID();
  const by = o.rework ?? {};
  const record = CloseOutRecord.parse({
    schema: CLOSEOUT_SCHEMA,
    item_id: itemId,
    project_id: project,
    repo,
    lane: 'L3',
    requester: 'alice',
    catalogue: cat,
    gates: [],
    merged_sha: null,
    units: [],
    g4: {
      gate_instance_id: randomUUID(),
      mode: 'E',
      deciders: [o.decider ?? `rev-${itemId.slice(0, 4)}`],
    },
    release_output: null,
    acceptance: { outcome: null, by: null },
    break_glass: o.breakGlass
      ? [
          {
            repo,
            pr_number: 7,
            head_sha: 'b'.repeat(40),
            class: 'bypass',
            x4_gate_instance_id: null,
          },
        ]
      : [],
    rework: { total: Object.values(by).reduce((a, b) => a + b, 0), by_edge: by },
  });
  const w = await withTransaction(s.record.pool, (tx) =>
    appendEvents(
      tx,
      closeoutStream(itemId),
      0,
      [
        {
          type: CLOSEOUT_EVENT.recorded,
          body: {
            command_key: `cmd-${itemId}`,
            closeout_sha256: closeOutId(record),
            record,
            recorded_at: s.clock.now().toISOString(),
          } as never,
          actor: 'system.closeout',
        },
      ],
      { clock: s.clock },
    ),
  );
  if (!w.ok) throw new Error(JSON.stringify(w.error));
  await rebuildCloseOut(s.deps, itemId);
  return itemId;
}

const learnDeps = () => ({ ...s.deps, decisions: s.config });

describe('9.4 Learn: close-out evidence into META proposals', () => {
  it('the pure rules: each evidence asks once per topic; nothing while a topic has an open proposal', () => {
    const base = {
      project_id: 'p',
      escaped: new Set<string>(),
      audits: [],
      suspension: null,
      earned: null,
      config: LEARN,
    };
    const rec = (i: number, over: Partial<CloseOutRecord> = {}) => ({
      closeout_sha256: String(i).padStart(64, '0'),
      gseq: i,
      record: {
        item_id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
        lane: 'L3',
        catalogue: { version: '1.0.0', hash: 'a'.repeat(64) },
        break_glass: [],
        rework: { total: 0, by_edge: {} },
        g4: { gate_instance_id: 'x', mode: 'E', deciders: [`r${i}`] },
        ...over,
      } as unknown as CloseOutRecord,
    });
    const clean = [rec(1), rec(2), rec(3)];
    const one = learnProposals({ ...base, closeouts: clean, prior: [] });
    expect(one.map((c) => c.body.kind)).toEqual(['autonomy_promotion']);
    expect(one[0]?.body.change).toMatchObject({ from: 'A1', to: 'A2', clean_streak: 3 });
    // an open promotion: nothing more on that topic
    expect(
      learnProposals({
        ...base,
        closeouts: clean,
        prior: [{ topic: 'autonomy_promotion', pending: true, newest_gseq: 3 }],
      }),
    ).toEqual([]);
    // decided: only newer evidence asks again
    expect(
      learnProposals({
        ...base,
        closeouts: clean,
        prior: [{ topic: 'autonomy_promotion', pending: false, newest_gseq: 3 }],
      }),
    ).toEqual([]);
    // suspended: no promotion, whatever the streak
    expect(
      learnProposals({
        ...base,
        closeouts: clean,
        prior: [],
        suspension: { gseq: 100, sampled: 20, missed: 3 },
      }),
    ).toEqual([]);
    // at the top there is nothing to promote to
    expect(learnProposals({ ...base, earned: 'A3', closeouts: clean, prior: [] })).toEqual([]);
    expect(DEFAULT_LEARN_CONFIG.clean_streak).toBeGreaterThan(LEARN.clean_streak);
  });

  it('variance (M2), catalogue (M3), bypass review (M1) and approver grant (M6), each a gate; a rerun asks nothing new', async () => {
    const p = await learnProject();
    await closeOut(p.project, p.repo, { rework: { B9: 2 }, decider: 'zed' });
    await closeOut(p.project, p.repo, { rework: { B9: 1 }, breakGlass: true, decider: 'zed' });
    await closeOut(p.project, p.repo, { decider: 'zed' });
    const r = ok(await runLearn(learnDeps(), p.project));
    const view = await projectLearnView(s.record.pool, p.project);
    const kinds = view.proposals.map((x) => `${x.proposal.meta_gate}:${x.proposal.kind}`).sort();
    expect(kinds).toEqual([
      'M1:config_review',
      'M2:variance',
      'M3:catalogue_review',
      'M6:approver_grant',
    ]);
    expect(r.proposed).toHaveLength(4);
    for (const x of view.proposals) {
      const gs = await readGateState(s.record.pool, x.gate_instance_id);
      expect(gs?.open.payload).toMatchObject({
        gate_id: x.proposal.meta_gate,
        subject_kind: 'learn',
        subject_hash: x.proposal_id,
        project_id: p.project,
      });
      expect(x.card_id).not.toBeNull();
      expect(x.status).toBe('pending');
    }
    const m3 = view.proposals.find((x) => x.proposal.kind === 'catalogue_review');
    expect(m3?.proposal.change).toMatchObject({ edge: 'B9', items: 2 });
    expect(m3?.proposal.evidence).toHaveLength(2);
    // the same evidence again: nothing new
    expect(ok(await runLearn(learnDeps(), p.project)).proposed).toEqual([]);
    // an approved M1 records acceptance only: no config changes
    const m1 = view.proposals.find((x) => x.proposal.meta_gate === 'M1');
    ok(await decideGate(s, m1?.gate_instance_id as string, 'bob', 'approve'));
    expect(ok(await runLearn(learnDeps(), p.project)).settled).toEqual([m1?.proposal_id]);
    const after = await projectLearnView(s.record.pool, p.project);
    expect(after.proposals.find((x) => x.proposal_id === m1?.proposal_id)).toMatchObject({
      status: 'settled',
      outcome: 'approve',
      effect: 'accepted',
    });
    expect(after.earned_autonomy).toBeNull();
    // the tables are a fold of the stream
    await rebuildLearn(s.deps, p.project);
    expect(await projectLearnView(s.record.pool, p.project)).toEqual(after);
  });
});

describe('M5: a promotion only ever happens through a decided M5', () => {
  it('a rejected M5 promotes nothing; an approved one records the earned autonomy with its ledger entry', async () => {
    const p = await learnProject();
    for (let i = 0; i < 3; i++) await closeOut(p.project, p.repo);
    ok(await runLearn(learnDeps(), p.project));
    let view = await projectLearnView(s.record.pool, p.project);
    const first = view.proposals.find((x) => x.proposal.kind === 'autonomy_promotion');
    expect(first?.proposal.meta_gate).toBe('M5');
    expect(await readEarnedAutonomy(s.record.pool, p.project)).toBeNull();
    // settling before any decision does nothing; a rejection settles with no effect
    expect(ok(await runLearn(learnDeps(), p.project)).settled).toEqual([]);
    ok(await decideGate(s, first?.gate_instance_id as string, 'bob', 'reject'));
    ok(await runLearn(learnDeps(), p.project));
    expect(await readEarnedAutonomy(s.record.pool, p.project)).toBeNull();
    view = await projectLearnView(s.record.pool, p.project);
    expect(view.proposals.find((x) => x.proposal_id === first?.proposal_id)).toMatchObject({
      outcome: 'reject',
      effect: 'none',
    });
    // fresh evidence asks again; this time the project admin approves the M5
    for (let i = 0; i < 3; i++) await closeOut(p.project, p.repo);
    ok(await runLearn(learnDeps(), p.project));
    view = await projectLearnView(s.record.pool, p.project);
    const second = view.proposals.find(
      (x) => x.proposal.kind === 'autonomy_promotion' && x.status === 'pending',
    );
    expect(second).toBeDefined();
    ok(await decideGate(s, second?.gate_instance_id as string, 'bob', 'approve'));
    ok(await runLearn(learnDeps(), p.project));
    const earned = await readEarnedAutonomy(s.record.pool, p.project);
    const gs = await readGateState(s.record.pool, second?.gate_instance_id as string);
    expect(earned).toEqual({
      level: 'A2',
      gate_instance_id: second?.gate_instance_id,
      ledger_entry_id: gs?.decisions.at(-1)?.entry_id,
    });
    // rebuilt from the stream: the same
    await rebuildLearn(s.deps, p.project);
    expect(await readEarnedAutonomy(s.record.pool, p.project)).toEqual(earned);
  });
});

describe('B19 is lifted only through a decided M5', () => {
  async function suspend(project: string) {
    const w = await withTransaction(s.record.pool, (tx) =>
      appendEvents(
        tx,
        auditStream(project),
        0,
        [
          {
            type: AUDIT_EVENT.mode_e_suspended,
            body: {
              project_id: project,
              sampled: 20,
              missed: 3,
              limits: { miss_rate: 10, min_sample: 20 },
              catalogue: cat,
              item_id: randomUUID(),
              at: s.clock.now().toISOString(),
            } as never,
            actor: 'system.closeout',
          },
        ],
        { clock: s.clock },
      ),
    );
    if (!w.ok) throw new Error(JSON.stringify(w.error));
    await rebuildAudits(s.deps, project);
  }

  it('clean close-outs after the suspension propose the lift; approved, mode E is back and a new window starts', async () => {
    const p = await learnProject();
    await closeOut(p.project, p.repo);
    await suspend(p.project);
    expect(await readModeESuspension(s.record.pool, p.project)).not.toBeNull();
    // close-outs before the suspension do not count; two after it are not enough
    for (let i = 0; i < 2; i++) await closeOut(p.project, p.repo);
    expect(ok(await runLearn(learnDeps(), p.project)).proposed).toEqual([]);
    await closeOut(p.project, p.repo);
    ok(await runLearn(learnDeps(), p.project));
    const view = await projectLearnView(s.record.pool, p.project);
    const lift = view.proposals.find((x) => x.proposal.kind === 'mode_e_lift');
    expect(lift?.proposal).toMatchObject({ meta_gate: 'M5', signal: 'clean_since_suspension' });
    // no promotion while suspended
    expect(view.proposals.some((x) => x.proposal.kind === 'autonomy_promotion')).toBe(false);
    // a person's request for the same suspension while one is open: refused, nothing new
    expect((await requestModeELift(learnDeps(), p.project, pr('cyd'))).ok).toBe(false);
    ok(await decideGate(s, lift?.gate_instance_id as string, 'bob', 'approve'));
    ok(await runLearn(learnDeps(), p.project));
    expect(await readModeESuspension(s.record.pool, p.project)).toBeNull();
    expect((await readAuditWindow(s.record.pool, p.project)).epoch).toBe(1);
    const ev = await s.record.pool.query(
      'SELECT 1 FROM record.record_event WHERE stream = $1 AND type = $2',
      [auditStream(p.project), MODE_E_LIFTED_EVENT],
    );
    expect(ev.rows).toHaveLength(1);
    await rebuildAudits(s.deps, p.project);
    expect(await readModeESuspension(s.record.pool, p.project)).toBeNull();
    expect((await readAuditWindow(s.record.pool, p.project)).epoch).toBe(1);
  });

  it('a person asks for the lift: an M5 they may not decide themselves; rejected, the suspension stays', async () => {
    const p = await learnProject();
    expect((await requestModeELift(learnDeps(), p.project, pr('bob'))).ok).toBe(false); // nothing suspended
    await suspend(p.project);
    s.elig.setHolders(pid(p.project), 'admin', [pr('bob'), pr('cyd')]);
    const r = ok(await requestModeELift(learnDeps(), p.project, pr('cyd')));
    expect(r.duplicate).toBe(false);
    expect(ok(await requestModeELift(learnDeps(), p.project, pr('cyd'))).duplicate).toBe(true);
    expect((await decideGate(s, r.gate_instance_id, 'cyd', 'approve')).ok).toBe(false);
    ok(await decideGate(s, r.gate_instance_id, 'bob', 'reject'));
    ok(await runLearn(learnDeps(), p.project));
    expect(await readModeESuspension(s.record.pool, p.project)).not.toBeNull();
    s.elig.setHolders(pid(p.project), 'admin', [pr('bob')]);
  });
});

// ---------------------------------------------------------------- admission (ADR-0003 §6)

const settingsOf = (project: string): ProjectSettings => {
  const slot = (principals: string[]) => ({
    kind: 'principals' as const,
    principals: principals as never,
  });
  return {
    project_id: project as never,
    role_map: {
      admin: slot(['bob']),
      requesters: slot(['bob']),
      intent: slot(['bob']),
      design: slot(['bob']),
      g4: slot(['bob']),
      g5: slot(['bob']),
      x: slot(['bob']),
      sec: slot(['bob']),
      m4: slot(['bob']),
      kill: slot(['bob']),
    },
    two_person: { enabled: false, default: 'on_if_2plus', locked_on: false },
    gating_profile: { gates: GATING_OFF.gates, schedule: 'auto', tier_floor_applied: true },
    kill_delegations: [],
    version: 1,
    updated_at: '2026-11-09T00:00:00.000Z',
  } as ProjectSettings;
};

describe('admission honours the project WIP limit, the default envelope and the published coding cap', () => {
  it('WIP: the second Unit of the project is held at the limit; the default envelope is what an item with no plan reserves', async () => {
    const p = await learnProject();
    await publishSettings(
      s,
      p.project,
      { wip_limit: 1, default_envelope: { max_tokens: 5_000, max_cost_micro_usd: 7_000 } },
      'bob',
    );
    const settings = new FakeProjectSettings();
    settings.set(settingsOf(p.project));
    const envelope = new FakeEnvelope();
    const d = { ...s.deps, settings, envelope, snapshots: new FakeWaitSnapshots(), sessionCap: 10 };
    const items: string[] = [];
    for (let i = 0; i < 2; i++) {
      const r = ok(
        await submitRequest(s.deps, {
          project_id: pid(p.project),
          repo: p.repo,
          lane: 'L3',
          requester: pr('alice'),
          channel: 'N1',
          text: `wip test ${i}`,
        }),
      );
      items.push(r.item_id as string);
    }
    const st = async (id: string) => (await readItem(s.record.pool, id))?.state as never;
    const a = ok(await admitUnit(d, await st(items[0] as string), 'wip-a'));
    expect(a.admitted).toBe(true);
    const grant = await s.record.pool.query<{
      envelope: { max_tokens: number; max_cost_micro_usd: number };
    }>('SELECT envelope FROM core.admission_grant WHERE item_id = $1', [items[0]]);
    expect(grant.rows[0]?.envelope).toMatchObject({ max_tokens: 5_000, max_cost_micro_usd: 7_000 });
    const b = ok(await admitUnit(d, await st(items[1] as string), 'wip-b'));
    expect(b).toMatchObject({ admitted: false, reason: 'WIP' });
    if (!b.admitted) expect(b.why).toMatch(/WIP limit \(1\)/);
    const doc = await s.record.pool.query<{ body: { doc: Record<string, unknown> } }>(
      `SELECT body FROM record.record_event WHERE type = 'config.proposed' AND body -> 'scope' ->> 'ref' = $1
        ORDER BY global_seq DESC LIMIT 1`,
      [p.project],
    );
    expect(doc.rows[0]?.body.doc[PROJECT_WIP_LIMIT_KEY]).toBe(1);
    expect(doc.rows[0]?.body.doc[PROJECT_DEFAULT_ENVELOPE_KEY]).toBeDefined();
  });

  it("H2's cap is the published sandbox.caps coding cap of the runner host (the controller's own reader)", async () => {
    expect(await sessionCapOf({ pool: s.record.pool })).toBe(1);
    await setFactoryKey(
      SANDBOX_CAPS_KEY,
      { total: 6, coding: 3, hosts: { big: { total: 8, coding: 5 } } },
      'ada',
      'ben',
    );
    expect(await sessionCapOf({ pool: s.record.pool })).toBe(3);
    expect(await sessionCapOf({ pool: s.record.pool, runnerHost: 'big' })).toBe(5);
    // a deployment's override still wins (tests, an in-process driver)
    expect(await sessionCapOf({ pool: s.record.pool, sessionCap: 1 })).toBe(1);
    // published, then the same pool reads the same value the controller does
    const pub = await configPublish(s.config, { rev_hash: (await headOfFactory()) as string });
    expect(pub.ok).toBe(true);
  });
});
