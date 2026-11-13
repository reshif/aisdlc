import {
  PLANNING_EVENT,
  type StepId,
  UNITS_SCHEMA_ID,
  type PrrGatingProfile,
} from '@aisdlc/contracts';
import { catalogueFor, currentCatalogueRef } from '@aisdlc/catalogue';
import type { TestGateway } from '@aisdlc/gateway/testing';
import { buildRoute, effectiveProfile } from '@aisdlc/work';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CODING_SESSION_CAP,
  FixedGrounding,
  boundCapacity,
  SIZE_SHARE,
  budgetEnvelope,
  dagOrder,
  gateArtefactsView,
  latestArtefact,
  listUnits,
  planUnits,
  readItem,
  rebuildUnits,
  submitHumanPlan,
  validateCapacity,
  validateSequence,
  validateTasks,
  validateUnitSplit,
  validateVerification,
} from '../src/index.js';
import { pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  MERGED,
  OTHER_SHA,
  OUTPUTS,
  SPLIT,
  planningRig,
  reply,
  sharedProvider,
  startPlanningGateway,
  type PlanningRig,
  type Seen,
} from './planning.js';
import { GATING_ON, loadReports, runItem } from './work-fixtures.js';

// PLAN M12.4, S5 Plan with the real planning port: 5.1 the Units (a DAG), 5.2 sequence, 5.3 the task plan,
// 5.4 the verification binding, 5.5 the budget envelope (code), 5.6 capacity input, 5.7 scheduling (automatic
// by default), 5.8 plan approval (G3, SHA-bound, with G3s), B5, and the `unit` read model. The provider is
// scripted; no real model call.

let s: CoreStack;
let gw: TestGateway;
const provider = sharedProvider();
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startPlanningGateway(s);
});
afterAll(async () => {
  await gw.stop();
  await s.stop();
});
beforeEach(() => provider.reset());

const rows = async (sql: string, args: unknown[] = []) =>
  (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
type St = NonNullable<Awaited<ReturnType<typeof readItem>>>['state'];
const pending = (gate: string) => (st: St) =>
  st.gates.some((g) => g.gate === gate && g.status === 'pending');
const handoff = (st: St) => st.waiting?.kind === 'handoff';
const asked = (step: StepId) => provider.of(step);
const holdG3 = (g: string) => (g === 'G3' ? ('hold' as const) : ('approve' as const));
const gateOpens = (itemId: string, gate: string) =>
  rows(
    `SELECT body FROM record.record_event WHERE type = 'gate.opened' AND body ->> 'subject_id' = $1 AND body ->> 'gate_id' = $2 ORDER BY global_seq`,
    [itemId, gate],
  );
const versions = async (rig: PlanningRig, type: string) =>
  (
    await rows(
      'SELECT version FROM core.artefact WHERE item_id = $1 AND type = $2 ORDER BY version',
      [rig.itemId, type],
    )
  ).map((r) => r.version as number);
const S5 = ['5.1', '5.2', '5.3', '5.4', '5.5', '5.6'] as StepId[];

describe('L4: S1 to S5 with real agents, to the plan approval (G3)', () => {
  let rig: PlanningRig;
  let item: Awaited<ReturnType<typeof runItem>>;
  let seen: Seen[] = [];
  beforeAll(async () => {
    provider.reset();
    rig = await planningRig(s, gw, { lane: 'L4' });
    item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3,
      stop: pending('G3'),
      passes: 250,
    });
    seen = [...provider.seen];
  });

  it('runs every step of the lane in order, each once: S1 (1.3, 1.5), S2, S3, S4, S5; 3.3 and 5.5 are code', () => {
    expect(seen.map((c) => c.step)).toEqual([
      '1.3', '1.5', '2.1', '2.1b', '2.2', '2.3', '3.1', '3.2', '3.4', '3.5',
      '4.1', '4.2', '4.3', '4.4', '4.5',
      '5.1', '5.2', '5.3', '5.4', '5.6',
    ]); // prettier-ignore
    expect(item?.state.waiting).toMatchObject({ kind: 'gates', gates: ['G3', 'G3s'] });
    for (const step of S5) expect(item?.state.outputs[step], step).toMatch(/^[0-9a-f]{64}$/);
    expect(item?.state.plan_base_sha).toBe(MERGED);
  });

  it('5.5 is deterministic: no model call, the envelope comes from the lane profile and the sizes of the Units', async () => {
    expect(seen.some((c) => c.step === '5.5')).toBe(false);
    const env = await latestArtefact(s.record.pool, rig.itemId, 'budget_envelope');
    const c = env?.content as {
      units: Array<{
        unit_key: string;
        size: string;
        max_tokens: number;
        max_cost_micro_usd: number;
      }>;
      total: { max_cost_micro_usd: number };
      capped: boolean;
      base_sha: string;
    };
    expect(c.base_sha).toBe(MERGED);
    expect(c.capped).toBe(false);
    // small is a quarter of the coding contract's per-Unit budget (25 USD, 2M tokens), medium a half
    expect(c.units).toEqual([
      {
        unit_key: 'export-route',
        size: 'small',
        max_tokens: 500_000,
        max_cost_micro_usd: 6_250_000,
      },
      {
        unit_key: 'export-ui',
        size: 'medium',
        max_tokens: 1_000_000,
        max_cost_micro_usd: 12_500_000,
      },
    ]);
    expect(c.total.max_cost_micro_usd).toBe(18_750_000);
    expect(env?.markdown).toContain('# Budget envelope');
  });

  it('5.6 stores the capacity the factory will use of what was asked: bounded by the Units and by one coding session (M13.2)', async () => {
    const cap = (await latestArtefact(s.record.pool, rig.itemId, 'capacity_input'))
      ?.content as Record<string, unknown>;
    expect(cap).toMatchObject({
      proposed_parallel_units: 2,
      max_parallel_units: 1,
      base_sha: MERGED,
    });
    expect(cap['bounded_by']).toEqual({ units: 2, coding_sessions: CODING_SESSION_CAP });
  });

  it('the task plan is plan.md: one section per Unit with its tasks and how each is verified', async () => {
    const plan = await latestArtefact(s.record.pool, rig.itemId, 'plan');
    expect(plan?.markdown).toContain('# Plan');
    expect(plan?.markdown).toContain('## Unit export-route');
    expect(plan?.markdown).toContain('- [ ] **t1** Add GET /export');
    expect(plan?.markdown).toContain('verified by: npm test');
  });

  it('every plan step reads the ones before it as data; 5.1 sees the design, and no step is given a budget or a lane to change', () => {
    const text = (step: StepId) => JSON.stringify(seen.find((c) => c.step === step)?.req.messages);
    expect(text('5.1')).toContain('adr@');
    expect(text('5.1')).toContain('oracle_specs@');
    expect(text('5.2')).toContain('unit_split@');
    expect(text('5.3')).toContain('unit_sequence@');
    expect(text('5.4')).toContain('oracle_specs@');
    expect(text('5.6')).toContain('budget_envelope@');
  });

  it('G3 opened with the six plan artefacts and the base commit; G3s opened beside it on the same subject', async () => {
    const [g3] = await gateOpens(rig.itemId, 'G3');
    const [g3s] = await gateOpens(rig.itemId, 'G3s');
    const refs = g3?.body.facts.artefacts as Array<{ step: string; type: string; sha256: string }>;
    expect(refs.map((r) => r.type)).toEqual([
      'unit_split',
      'unit_sequence',
      'plan',
      'verification_binding',
      'budget_envelope',
      'capacity_input',
    ]);
    for (const r of refs) expect(item?.state.outputs[r.step]).toBe(r.sha256);
    expect(g3?.body.facts.base_sha).toBe(MERGED);
    expect(g3s?.body.subject_hash).toBe(g3?.body.subject_hash);
    const card = (
      await rows(
        `SELECT substring(stream from 6) AS id FROM record.record_event WHERE type = 'card.opened' AND body ->> 'subject_id' = $1 AND body::text LIKE '%G3s%'`,
        [rig.itemId],
      )
    )[0]?.id as string;
    const view = await gateArtefactsView(s.record.pool, card);
    expect(view.ok && view.value.intact).toBe(true);
    if (view.ok) expect(view.value.gates).toEqual(expect.arrayContaining(['G3', 'G3s']));
  });

  it('the Units are in the `unit` read model as Planned, in DAG order, with scope and envelope; the record has the event', async () => {
    const units = await listUnits(s.record.pool, rig.itemId);
    expect(units.map((u) => [u.unit_key, u.position, u.state, u.depends_on])).toEqual([
      ['export-route', 0, 'Planned', []],
      ['export-ui', 1, 'Planned', ['export-route']],
    ]);
    expect(units[0]).toMatchObject({
      unit_id: `${rig.itemId}:export-route`,
      repo: rig.repo,
      paths: ['src/audit/'],
      size: 'small',
      base_sha: MERGED,
      branch: null,
      lease_epoch: null,
      envelope: { max_tokens: 500_000, max_cost_micro_usd: 6_250_000 },
    });
    const ev = await rows(`SELECT body FROM record.record_event WHERE stream = $1 AND type = $2`, [
      `planning:${rig.itemId}`,
      PLANNING_EVENT.units_planned,
    ]);
    expect(ev).toHaveLength(1);
    expect(ev[0]?.body.schema).toBe(UNITS_SCHEMA_ID);
    expect(ev[0]?.body.units.map((u: { unit_key: string }) => u.unit_key)).toEqual([
      'export-route',
      'export-ui',
    ]);
  });

  it('the read model is derived: dropping and rebuilding it from the events gives the same rows', async () => {
    const before = await listUnits(s.record.pool, rig.itemId);
    // every column, the fold's time included (the restore drill compares whole rows)
    const raw = async () =>
      (
        await s.record.pool.query(
          'SELECT row_to_json(u)::text AS r FROM core.unit u WHERE item_id = $1 ORDER BY unit_key',
          [rig.itemId],
        )
      ).rows.map((x: { r: string }) => x.r);
    const rawBefore = await raw();
    await s.record.pool.query('DELETE FROM core.unit WHERE item_id = $1', [rig.itemId]);
    expect(await listUnits(s.record.pool, rig.itemId)).toEqual([]);
    expect(await rebuildUnits({ pool: s.record.pool, clock: s.clock }, rig.itemId)).toBe(1);
    expect(await listUnits(s.record.pool, rig.itemId)).toEqual(before);
    expect(await raw()).toEqual(rawBefore);
  });

  it('scheduling is automatic by default: no 5.7 station, and an approved plan goes straight on to scheduling (6.0 admission)', async () => {
    const cat = catalogueFor(currentCatalogueRef());
    if (!cat.ok) throw new Error('no catalogue');
    const keys = (profile: PrrGatingProfile) =>
      buildRoute(cat.value.lanes.L4, effectiveProfile(profile, 'T1')).map((st) => st.key);
    expect(keys(GATING_ON)).not.toContain('h:5.7');
    expect(keys({ ...GATING_ON, schedule: 'human' })).toContain('h:5.7');
    // 6.0 is held for lack of capacity: the item rests in Scheduling, and nobody was asked to schedule it
    rig.base.coding.scriptStep('6.0', [{ outcome: 'held', reason: 'H2' }]);
    const after = await runItem(s, rig.d, rig.itemId, {
      stop: (st) => st.underlying === 'Scheduling',
      passes: 80,
    });
    expect(after?.state.underlying).toBe('Scheduling');
    expect(after?.state.waiting === null || after?.state.waiting.kind !== 'human').toBe(true);
    const sched = await rows(
      `SELECT 1 FROM record.record_event WHERE stream = $1 AND type = 'item.scheduled'`,
      [`item:${rig.itemId}`],
    );
    expect(sched).toHaveLength(0);
  });
});

describe('L6: the full path S1 to S5 with G1f, G3d and G3', () => {
  it('reaches Scheduling with 2.4 and G1f, S4 and S5 all decided by people and every gate in the ledger', async () => {
    const rig = await planningRig(s, gw, { lane: 'L6' });
    rig.base.coding.scriptStep('6.0', [{ outcome: 'held', reason: 'H2' }]);
    const item = await runItem(s, rig.d, rig.itemId, {
      stop: (st) => st.underlying === 'Scheduling',
      passes: 300,
    });
    expect(item?.state.underlying).toBe('Scheduling');
    expect(item?.state.proposed_lane).toBe('L6');
    const steps = provider.seen.map((c) => c.step);
    expect(steps.slice(0, 7)).toEqual(['1.3', '1.5', '2.1', '2.1b', '2.2', '2.3', '2.4']);
    for (const step of [
      '3.1',
      '3.2',
      '3.4',
      '3.5',
      '4.1',
      '4.2',
      '4.3',
      '4.4',
      '4.5',
      '5.1',
      '5.2',
      '5.3',
      '5.4',
      '5.6',
    ] as StepId[]) {
      expect(steps, step).toContain(step);
    }
    const led = await rows(
      `SELECT gate_id, decision FROM ledger.ledger_entry WHERE entry_type = 'decision' AND subject_id = $1 ORDER BY created_at`,
      [rig.itemId],
    );
    const decided = led.map((l) => l.gate_id as string);
    for (const g of ['G0', 'G1', 'G1f', 'G2', 'G3d', 'G3', 'G3s']) expect(decided, g).toContain(g);
    expect(led.every((l) => l.decision === 'approve')).toBe(true);
    expect((await listUnits(s.record.pool, rig.itemId)).map((u) => u.state)).toEqual([
      'Planned',
      'Planned',
    ]);
  });
});

describe('human scheduling is only for a project whose gating profile opts in', () => {
  it('with schedule `human` the item waits at 5.7 for a person after G3d; the person schedules it and 6.0 follows', async () => {
    const rig = await planningRig(s, gw, {
      lane: 'L4',
      gating: { ...GATING_ON, schedule: 'human' },
    });
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3,
      stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'schedule',
      passes: 250,
    });
    expect(item?.state.waiting).toEqual({ kind: 'human', what: 'schedule' });
    // the plan is approved by then? In the route 5.7 comes before 5.8 (G3): the plan is not approved yet
    expect(item?.state.gates.some((g) => g.gate === 'G3' && g.status === 'decided')).toBe(false);
  });
});

describe('5.1: the Units are a DAG with ids, each with a scope; a cycle is refused', () => {
  const split = (units: unknown[]) => reply({ kind: 'plan_split', units, assumptions: [] });
  const unit = (unit_key: string, depends_on: string[] = [], over: object = {}) => ({
    unit_key,
    title: unit_key,
    paths: ['src/'],
    size: 'small',
    depends_on,
    ...over,
  });

  it('pure: a cycle, a dangling or self dependency, a duplicate id, a bad id, a missing or escaping scope are findings; a DAG has an order', () => {
    const codes = (units: unknown[]) => validateUnitSplit({ units }).map((f) => f.code);
    expect(codes([unit('a', ['b']), unit('b', ['a'])])).toEqual(['dependency_cycle']);
    expect(codes([unit('a', ['b']), unit('b', ['c']), unit('c', ['a'])])).toEqual([
      'dependency_cycle',
    ]);
    expect(codes([unit('a', ['a'])])).toContain('self_dependency');
    expect(codes([unit('a', ['zzz'])])).toContain('dangling_dependency');
    expect(codes([unit('a'), unit('a')])).toContain('duplicate_unit');
    expect(codes([unit('A B')])).toContain('bad_unit_key');
    expect(codes([unit('a', [], { paths: [] })])).toContain('empty_scope');
    expect(codes([unit('a', [], { paths: ['../etc/passwd'] })])).toContain('bad_path');
    expect(codes([unit('a', [], { paths: ['/etc'] })])).toContain('bad_path');
    expect(codes([unit('a', [], { paths: ['src/**'] })])).toContain('bad_path');
    expect(codes([unit('b', ['a']), unit('a'), unit('c', ['a', 'b'])])).toEqual([]);
    expect(dagOrder([unit('b', ['a']), unit('a'), unit('c', ['a', 'b'])])).toEqual(['a', 'b', 'c']);
    expect(dagOrder([unit('a', ['b']), unit('b', ['a'])])).toBeNull();
    // a Unit of the same rank: ties are by key, so the order is the same however the agent listed them
    expect(dagOrder([unit('z'), unit('m'), unit('a')])).toEqual(['a', 'm', 'z']);
  });

  it('driven: a plan with a cycle is refused field by field (B3) and the redraft is accepted; nothing is stored or planned from the cycle', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on('5.1', split([unit('a', ['b']), unit('b', ['a'])]));
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3,
      stop: pending('G3'),
      passes: 250,
    });
    expect(asked('5.1')).toHaveLength(2);
    expect(await versions(rig, 'unit_split')).toEqual([1]);
    const p = await rows(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'proposal.recorded' AND body ->> 'step' = '5.1' ORDER BY seq`,
      [`planning:${rig.itemId}`],
    );
    expect(p.map((x) => x.body.status)).toEqual(['rejected', 'accepted']);
    expect(p[0]?.body.reasons).toEqual([{ path: 'units', code: 'dependency_cycle' }]);
    expect(item?.state.underlying).toBe('S5');
    expect((await listUnits(s.record.pool, rig.itemId)).map((u) => u.unit_key)).toEqual([
      'export-route',
      'export-ui',
    ]);
  });

  it('driven: four cyclic answers are B3 (3 automatic rounds) and then ET8: no plan reaches G3', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const cyc = split([unit('a', ['b']), unit('b', ['a'])]);
    provider.on('5.1', cyc, cyc, cyc);
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3,
      stop: handoff,
      passes: 250,
    });
    expect(asked('5.1')).toHaveLength(3);
    expect(item?.state.handoffs.at(-1)).toMatchObject({ status: 'open', trigger: 'ET8' });
    expect(await listUnits(s.record.pool, rig.itemId)).toEqual([]);
    expect(item?.state.gates.some((g) => g.gate === 'G3')).toBe(false);
  });

  it('5.2 to 5.6 are checked against the split: a sequence before a dependency, a missing task plan, an unbound or unknown oracle', () => {
    const sp = SPLIT;
    expect(
      validateSequence({ order: ['export-ui', 'export-route'] }, sp).map((f) => f.code),
    ).toEqual(['before_dependency']);
    expect(validateSequence({ order: ['export-route'] }, sp).map((f) => f.code)).toEqual([
      'missing_unit',
    ]);
    expect(
      validateSequence({ order: ['export-route', 'nope', 'export-ui'] }, sp).map((f) => f.code),
    ).toEqual(['unknown_unit']);
    expect(validateSequence(OUTPUTS['5.2'], sp)).toEqual([]);
    expect(
      validateTasks(
        {
          units: [
            {
              unit_key: 'export-route',
              tasks: [{ task_id: 't', description: 'd', verification: 'v' }],
            },
          ],
        },
        sp,
      ).map((f) => f.code),
    ).toEqual(['missing_unit']);
    expect(validateTasks(OUTPUTS['5.3'], sp)).toEqual([]);
    const oracles = { oracles: [{ oracle_id: 'o1' }, { oracle_id: 'o2' }] };
    expect(validateVerification(OUTPUTS['5.4'], sp, oracles).map((f) => f.code)).toEqual([
      'unbound_oracle',
    ]);
    expect(
      validateVerification(
        { bindings: [{ unit_key: 'export-route', oracle_ids: ['o9'] }] },
        sp,
        oracles,
      ).map((f) => f.code),
    ).toEqual(expect.arrayContaining(['unknown_oracle', 'unbound_unit', 'unbound_oracle']));
    expect(validateVerification(OUTPUTS['5.4'], sp, { oracles: [{ oracle_id: 'o1' }] })).toEqual(
      [],
    );
    expect(
      validateCapacity({ review_minutes: [{ unit_key: 'ghost', minutes: 5 }] }, sp).map(
        (f) => f.code,
      ),
    ).toEqual(['unknown_unit']);
    expect(boundCapacity({ max_parallel_units: 9, review_minutes: [] }, sp)).toMatchObject({
      proposed_parallel_units: 9,
      max_parallel_units: 1,
    });
  });

  it('driven: 5.4 binding an oracle that G2 never approved is refused; the redraft binds the approved one', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    provider.on(
      '5.4',
      reply({
        kind: 'plan_verification',
        bindings: [
          { unit_key: 'export-route', oracle_ids: ['o-made-up'] },
          { unit_key: 'export-ui', oracle_ids: ['o1'] },
        ],
        assumptions: [],
      }),
    );
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3,
      stop: pending('G3'),
      passes: 250,
    });
    expect(asked('5.4')).toHaveLength(2);
    expect(item?.state.underlying).toBe('S5');
    expect(await versions(rig, 'verification_binding')).toEqual([1]);
  });
});

describe('5.5: the budget envelope is a pure function of the lane profile and the Units', () => {
  const input = {
    lane: 'L4',
    lane_default_budget_cents: null,
    coder_budget: { max_tokens: 2_000_000, max_cost_micro_usd: 25_000_000 },
    units: [
      { unit_key: 'a', size: 'small' as const },
      { unit_key: 'b', size: 'large' as const },
    ],
    base_sha: MERGED,
  };

  it('same input, same envelope; larger Units get larger envelopes; the Unit sizes are the only input beside the lane', () => {
    const a = budgetEnvelope(input);
    expect(budgetEnvelope(input).content).toEqual(a.content);
    expect(a.envelopes.get('a')).toEqual({ max_tokens: 500_000, max_cost_micro_usd: 6_250_000 });
    expect(a.envelopes.get('b')).toEqual({ max_tokens: 2_000_000, max_cost_micro_usd: 25_000_000 });
  });

  it('planning.size_share (H15): the default is today’s shares, a published share is used', () => {
    expect(SIZE_SHARE).toEqual({ small: 0.25, medium: 0.5, large: 1 });
    const half = budgetEnvelope({ ...input, size_share: { small: 0.1, medium: 0.5, large: 0.5 } });
    expect(half.envelopes.get('b')).toEqual({
      max_tokens: 1_000_000,
      max_cost_micro_usd: 12_500_000,
    });
    expect((half.content as { basis: { size_share: unknown } }).basis.size_share).toEqual({
      small: 0.1,
      medium: 0.5,
      large: 0.5,
    });
  });

  it('a lane default the catalogue gives only CAPS the plan: every Unit is scaled down so the total fits', () => {
    const capped = budgetEnvelope({ ...input, lane_default_budget_cents: 1_000 }); // 10 USD
    expect((capped.content as { capped: boolean }).capped).toBe(true);
    const total = (capped.content as { total: { max_cost_micro_usd: number } }).total
      .max_cost_micro_usd;
    expect(total).toBeLessThanOrEqual(10_000_000);
    expect(total).toBeGreaterThan(9_990_000);
    expect(budgetEnvelope({ ...input, lane_default_budget_cents: 100_000 }).content).toMatchObject({
      capped: false,
    });
  });
});

describe('B5: two rejections of the plan go back to 5.1; then a human writes the plan', () => {
  it('G3 rejected: each rejection redoes S5 (the Units are replaced, never duplicated); the third gives the plan to a person', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'G3' || g === 'G3s' ? 'reject' : 'approve'),
      stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'plan',
      passes: 300,
    });
    expect(item?.state.rework.by_edge['B5']).toBe(3);
    expect(item?.state.human_plan).toBe(true);
    expect(item?.state.waiting).toEqual({ kind: 'human', what: 'plan' });
    expect(asked('5.1')).toHaveLength(3);
    const hashes = (await gateOpens(rig.itemId, 'G3')).map((g) => g.body.subject_hash as string);
    expect(hashes).toHaveLength(3);
    // the agent answered the same each time: the same bytes are the same subject (a hash names content, not a visit)
    expect(new Set(hashes).size).toBe(1);
    // the Units of the plan that was rejected are replaced by each re-plan, never duplicated
    expect((await listUnits(s.record.pool, rig.itemId)).map((u) => u.unit_key)).toEqual([
      'export-route',
      'export-ui',
    ]);
  });

  it('the human plan goes through the same checks, is stored as the artefacts G3 binds, replaces the Units, and G3 decides it', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    await runItem(s, rig.d, rig.itemId, {
      decide: (g) => (g === 'G3' || g === 'G3s' ? 'reject' : 'approve'),
      stop: (st) => st.waiting?.kind === 'human' && st.waiting.what === 'plan',
      passes: 300,
    });
    const deps = {
      pool: s.record.pool,
      clock: s.clock,
      grounding: new FixedGrounding({ merged_sha: OTHER_SHA, policy: [] }),
    };
    const plan = {
      split: {
        units: [
          { unit_key: 'only', title: 'Everything', paths: ['src/'], size: 'large', depends_on: [] },
        ],
      },
      sequence: { order: ['only'], rationale: 'one Unit' },
      tasks: {
        units: [
          {
            unit_key: 'only',
            tasks: [{ task_id: 't1', description: 'Do it', verification: 'npm test' }],
          },
        ],
      },
      verification: { bindings: [{ unit_key: 'only', oracle_ids: ['o1'] }] },
    };
    // a plan with a cycle, a plan nobody is waiting for, and a bad oracle are all refused and change nothing
    const cyc = await submitHumanPlan(
      deps,
      rig.itemId,
      pr('bob'),
      {
        ...plan,
        split: {
          units: [
            { unit_key: 'a', title: 'a', paths: ['src/'], size: 'small', depends_on: ['b'] },
            { unit_key: 'b', title: 'b', paths: ['src/'], size: 'small', depends_on: ['a'] },
          ],
        },
      },
      'try-1',
    );
    expect(cyc.ok).toBe(false);
    if (!cyc.ok) expect(cyc.error.message).toContain('dependency_cycle');
    const bad = await submitHumanPlan(
      deps,
      rig.itemId,
      pr('bob'),
      { ...plan, verification: { bindings: [{ unit_key: 'only', oracle_ids: ['zz'] }] } },
      'try-2',
    );
    expect(bad.ok).toBe(false);
    expect((await readItem(s.record.pool, rig.itemId))?.state.waiting).toEqual({
      kind: 'human',
      what: 'plan',
    });
    expect((await listUnits(s.record.pool, rig.itemId)).map((u) => u.unit_key)).toEqual([
      'export-route',
      'export-ui',
    ]);

    const done = await submitHumanPlan(deps, rig.itemId, pr('bob'), plan, 'write-1');
    expect(done.ok).toBe(true);
    if (!done.ok) return;
    expect(done.value.base_sha).toBe(OTHER_SHA);
    expect(Object.keys(done.value.outputs)).toEqual(S5);
    expect(
      (await listUnits(s.record.pool, rig.itemId)).map((u) => [u.unit_key, u.size, u.base_sha]),
    ).toEqual([['only', 'large', OTHER_SHA]]);

    // the engine now waits at G3 for the plan the human wrote, bound by the hashes they stored
    const item = await runItem(s, rig.d, rig.itemId, {
      decide: holdG3,
      stop: (st) => st.gates.filter((g) => g.gate === 'G3').length >= 4 && pending('G3')(st),
      passes: 80,
    });
    const last = (await gateOpens(rig.itemId, 'G3')).at(-1);
    expect(last?.body.facts.base_sha).toBe(OTHER_SHA);
    // SoD: the person who wrote the plan is on G3's open event as an author, so the kernel bars them like the requester
    expect((last?.body as { authors?: string[] }).authors).toEqual([pr('bob')]);
    expect(
      (last?.body.facts.artefacts as Array<{ step: string; sha256: string }>).map((a) => [
        a.step,
        a.sha256,
      ]),
    ).toEqual(S5.map((st) => [st, done.value.outputs[st]]));
    expect(item?.state.plan_base_sha).toBe(OTHER_SHA);
    // a second submit is refused: nobody is waiting for a plan any more
    const again = await submitHumanPlan(deps, rig.itemId, pr('bob'), plan, 'write-2');
    expect(again.ok).toBe(false);
    // and it is approved like any plan: a person decides it, and the item goes on
    const fin = await runItem(s, rig.d, rig.itemId, {
      stop: (st) => st.underlying === 'Scheduling',
      passes: 80,
    });
    expect(['Scheduling', 'Done']).toContain(fin?.state.underlying);
  });
});

describe('the `unit` read model', () => {
  it('a plan replaces the Units still Planned and never touches a Unit that has moved on (M13 owns Admitted and after)', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    const d = { pool: s.record.pool, clock: s.clock };
    const u = (key: string, position: number, dep: string[] = []) => ({
      unit_key: key,
      title: key,
      paths: ['src/'],
      size: 'small' as const,
      depends_on: dep,
      position,
      envelope: { max_tokens: 10, max_cost_micro_usd: 10 },
    });
    const base = { item_id: rig.itemId, project_id: rig.project, repo: rig.repo, base_sha: MERGED };
    await planUnits(d, {
      ...base,
      plan_sha256: 'a'.repeat(64),
      units: [u('one', 0), u('two', 1, ['one'])],
    });
    await s.record.pool.query(
      `UPDATE core.unit SET state = 'Admitted' WHERE item_id = $1 AND unit_key = 'one'`,
      [rig.itemId],
    );
    await planUnits(d, {
      ...base,
      plan_sha256: 'b'.repeat(64),
      units: [u('two', 0), u('three', 1, ['two'])],
    });
    const units = await listUnits(s.record.pool, rig.itemId);
    expect(units.map((x) => [x.unit_key, x.state, x.plan_sha256[0]])).toEqual([
      ['one', 'Admitted', 'a'],
      ['two', 'Planned', 'b'],
      ['three', 'Planned', 'b'],
    ]);
    // the same plan again is the same event: nothing is added
    await planUnits(d, {
      ...base,
      plan_sha256: 'b'.repeat(64),
      units: [u('two', 0), u('three', 1, ['two'])],
    });
    expect(
      (
        await rows(`SELECT 1 FROM record.record_event WHERE stream = $1 AND type = $2`, [
          `planning:${rig.itemId}`,
          PLANNING_EVENT.units_planned,
        ])
      ).length,
    ).toBe(2);
  });

  it('the fold time of a plan is its event time, so the live rows equal the rebuilt ones under a clock that moves', async () => {
    const rig = await planningRig(s, gw, { lane: 'L4' });
    // every read of this clock is a millisecond later (a real clock between the fold and the append)
    let t = Date.parse('2026-11-13T00:00:00.000Z');
    const d = {
      pool: s.record.pool,
      clock: { now: () => new Date((t += 1)), nowMs: () => (t += 1) },
    };
    const planned = await planUnits(d, {
      item_id: rig.itemId,
      project_id: rig.project,
      repo: rig.repo,
      base_sha: MERGED,
      plan_sha256: 'c'.repeat(64),
      units: [
        {
          unit_key: 'only',
          title: 'only',
          paths: ['src/'],
          size: 'small' as const,
          depends_on: [],
          position: 0,
          envelope: { max_tokens: 10, max_cost_micro_usd: 10 },
        },
      ],
    });
    expect(planned.ok).toBe(true);
    const raw = async () =>
      (
        await rows(`SELECT row_to_json(u)::text AS r FROM core.unit u WHERE item_id = $1`, [
          rig.itemId,
        ])
      ).map((x) => (x as { r: string }).r);
    const live = await raw();
    expect(await rebuildUnits(d, rig.itemId)).toBe(1);
    expect(await raw()).toEqual(live);
  });
});
