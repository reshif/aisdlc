import {
  DEFAULT_FLOOR_CONFIG,
  EVAL_EVENT,
  EvalRunRecord,
  FleetView,
  FloorView,
  ItemView,
  SESSION_EVENT,
  collapseFleetRow,
  evalStream,
  type FloorLiveness,
} from '@aisdlc/contracts';
import { AGENT_DEFINITIONS } from '@aisdlc/agents';
import { bindProject, grantFleetRole, grantRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeKillState, FakeStagePorts } from '@aisdlc/ports';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { newId } from '@aisdlc/kernel';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, inboxWorkGates, recordEvalRun, type CoreScope } from '../src/index.js';
import {
  floorKillOf,
  livenessOf,
  sessionActivityProjection,
  verdictOfKillState,
} from '../src/floor-live.js';
import { floorProjection } from '../src/floor.js';
import { opaqueKeyOf } from '../src/fleet.js';
import { setSlots, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
  type Seeded,
} from './work-fixtures.js';

// The floor's live overlays (PLAN M19): SessionActivity and Heartbeat (silence past the threshold is stuck, a beat is
// recorded first), GateFeasibility on the floor and in the inbox, the score chips of the stations, the kill banner
// (AR9: unreachable reads killed) and the fleet. Real Postgres, the real PDP, items driven by the real work driver.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked by their contracts
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let p: Seeded;
let lonely: Seeded;
let coding: string;
let orphan: string;
const kills = new FakeKillState();
const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  runner: 'runner-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard', 'portal', 'work'],
  runner: ['activity'],
};

async function call(token: string, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}
const floor = async (project: string, who = 'ada') => {
  const r = await call(TOKENS.bff, 'GET', `/v1/floor/${project}?on_behalf_of=${who}`);
  if (r.status !== 200) throw new Error(`floor: ${r.status} ${JSON.stringify(r.json)}`);
  return FloorView.parse(r.json);
};
const ask = async (at: Seeded, text: string): Promise<string> => {
  const r = await call(TOKENS.bff, 'POST', '/v1/requests', {
    project_id: at.project,
    repo: at.repo,
    lane: 'L3',
    channel: 'N1',
    text,
    on_behalf_of: 'ria',
  });
  if (r.status !== 201) throw new Error(`request: ${r.status} ${JSON.stringify(r.json)}`);
  return r.json.item_id as string;
};
const advance = (minutes: number) => s.clock.advance(minutes * 60_000);

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'ria', 'vic', 'bob']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  p = await seedActivePrr(s, { level: 'light' });
  lonely = await seedActivePrr(s, { level: 'light' });
  await bindProject(s.id, p.project, { requesters: ['ria'] });
  await bindProject(s.id, lonely.project, { requesters: ['ria'] });
  await grantRole(s.id.deps, 'vic', 'project.viewer', { kind: 'project', ref: p.project });
  approvers(s, p.project);
  approvers(s, lonely.project);
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
    kill: verdictOfKillState(kills),
  });
  url = await listen(app);

  // one item reaches S6 and its coding session is out (the coding port does not answer: the command stays open)
  const ports = new FakeStagePorts();
  // 6.0 and 6.1 answer; from the next coding call on the port is down, so the S6 command stays out
  ports.coding.script((req) => {
    if (req.step !== '6.0' && req.step !== '6.1') ports.coding.breakIt();
    return undefined;
  });
  const d = driverOver(s, { ports });
  coding = await ask(p, 'Add a CSV export');
  await runItem(s, d, coding, {
    stop: (st) =>
      st.phase === 'S6' &&
      st.outstanding.some((c) => c.type === 'run_stage' && c.port === 'coding'),
  });
  // one item waits at G0+G1 of a project whose intent slot is then emptied: nobody can decide it
  orphan = await ask(lonely, 'A request nobody can decide');
  await runItem(s, driverOver(s), orphan, {
    decide: () => 'hold',
    stop: (st) => st.gates.length > 0,
  });
  setSlots(s, lonely.project, { admin: ['bob'], requesters: ['bob', 'alice'] });
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

describe('SessionActivity and Heartbeat', () => {
  it('an item in a session is working while it beats and stuck once it is silent past the threshold', async () => {
    let f = await floor(p.project);
    let it = f.items.find((i) => i.item_id === coding)!;
    expect(it).toMatchObject({ stage: 'S6', in_session: true, status: 'working' });
    expect(it.activity).toMatchObject({ silent: false, stuck_after_s: 30 * 60 });
    expect(f.liveness).toMatchObject({ silence_minutes: 30, source: 'default' });

    advance(31);
    f = await floor(p.project);
    it = f.items.find((i) => i.item_id === coding)!;
    expect(it).toMatchObject({ status: 'stuck', waiting: 'stuck:silent' });
    expect(it.activity?.silent).toBe(true);
    expect(it.activity?.silent_for_s).toBeGreaterThan(30 * 60);

    // the session beats: recorded first, then folded; the item is working again
    const beat = {
      item_id: coding,
      project_id: p.project,
      session_id: 'sess-1',
      unit_id: 'main',
      sandbox_class: 'W',
      at: s.clock.now().toISOString(),
    };
    expect((await call(TOKENS.runner, 'POST', '/v1/sessions/heartbeat', beat)).status).toBe(201);
    // the same session in the same minute is the same fact
    expect((await call(TOKENS.runner, 'POST', '/v1/sessions/heartbeat', beat)).status).toBe(200);
    const ev = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event WHERE stream = $1 AND type = $2`,
      [`session:${coding}`, SESSION_EVENT.heartbeat],
    );
    expect(ev.rows[0].n).toBe(1);
    f = await floor(p.project);
    it = f.items.find((i) => i.item_id === coding)!;
    expect(it.status).toBe('working');
    expect(it.activity).toMatchObject({ source: 'heartbeat', silent: false });
    await expectRebuildEqualsLive(s.record.pool, sessionActivityProjection);
    await expectRebuildEqualsLive(s.record.pool, floorProjection);
  });

  it('refuses a heartbeat without the scope, from the future, for another project or an unknown item', async () => {
    const beat = {
      item_id: coding,
      project_id: p.project,
      session_id: 'sess-1',
      unit_id: null,
      sandbox_class: null,
      at: s.clock.now().toISOString(),
    };
    expect((await call(TOKENS.bff, 'POST', '/v1/sessions/heartbeat', beat)).status).toBe(403);
    const future = { ...beat, at: new Date(s.clock.now().getTime() + 3_600_000).toISOString() };
    expect((await call(TOKENS.runner, 'POST', '/v1/sessions/heartbeat', future)).status).toBe(400);
    const elsewhere = { ...beat, project_id: lonely.project };
    expect((await call(TOKENS.runner, 'POST', '/v1/sessions/heartbeat', elsewhere)).status).toBe(
      400,
    );
    const nobody = { ...beat, item_id: '0190f0f0-0000-7000-8000-000000000000' };
    expect((await call(TOKENS.runner, 'POST', '/v1/sessions/heartbeat', nobody)).status).toBe(404);
    expect((await call(TOKENS.runner, 'POST', '/v1/sessions/heartbeat', { at: 1 })).status).toBe(
      400,
    );
  });

  it('reads the threshold of the station from the config, and activity before the session does not count', () => {
    const cfg: FloorLiveness = { ...DEFAULT_FLOOR_CONFIG, by_stage: { S7: 5 }, source: 'config' };
    const now = new Date('2026-11-12T12:00:00Z');
    const since = new Date('2026-11-12T11:50:00Z');
    const before = { last_at: new Date('2026-11-12T11:40:00Z'), source: 'heartbeat' as const };
    const s7 = livenessOf(since, before, 'S7', cfg, now);
    expect(s7).toMatchObject({ last_at: null, stuck_after_s: 300, silent: true });
    expect(livenessOf(since, before, 'S6', cfg, now)).toMatchObject({
      stuck_after_s: 1800,
      silent: false,
    });
  });
});

describe('GateFeasibility', () => {
  it('flags a waiting gate with no eligible decider on the floor, and a decidable one is feasible', async () => {
    const f = await floor(lonely.project);
    const it = f.items.find((i) => i.item_id === orphan)!;
    expect(it.node).toEqual({ kind: 'gate', key: 'G0+G1' });
    expect(it.waiting_gates.map((g) => [g.gate, g.deciders, g.feasibility])).toEqual([
      ['G0', [], 'infeasible'],
      ['G1', [], 'infeasible'],
    ]);
    expect(it.waiting_gates[0]?.feasibility_reason).toMatch(/nobody holds the slot/);
  });

  it('lists the work gates in the inbox with their feasibility, an identity outage reading unknown', async () => {
    const all = await inboxWorkGates({ cards: { pool: s.record.pool } as never, config: s.config });
    const mine = all.filter((i) => i.item_id === orphan);
    expect(mine.map((i) => [i.kind, i.gate, i.feasibility])).toEqual([
      ['work_gate', 'G0', 'infeasible'],
      ['work_gate', 'G1', 'infeasible'],
    ]);
    s.elig.breakProject(lonely.project as never);
    try {
      const down = await inboxWorkGates({
        cards: { pool: s.record.pool } as never,
        config: s.config,
      });
      expect(down.filter((i) => i.item_id === orphan).map((i) => i.feasibility)).toEqual([
        'unknown',
        'unknown',
      ]);
    } finally {
      s.elig.breakProject(lonely.project as never, false);
    }
  });
});

describe('P1-2: where a work gate is decided', () => {
  it('the inbox and the item name the card each gate is decided on, and a decided gate its ledger entry', async () => {
    const all = await inboxWorkGates({ cards: { pool: s.record.pool } as never, config: s.config });
    const mine = all.filter((i) => i.item_id === orphan);
    const card = mine[0]?.card_id ?? null;
    expect(card).toMatch(/^[0-9a-f-]{36}$/);
    // G0 and G1 are opened on one card, and the record says so
    expect(mine.map((i) => [i.gate, i.card_id])).toEqual([
      ['G0', card],
      ['G1', card],
    ]);
    const opened = await s.record.pool.query(
      `SELECT body -> 'targets' AS targets FROM record.record_event WHERE stream = $1 AND type = 'card.opened'`,
      [`card:${card}`],
    );
    expect(opened.rows[0].targets.map((t: Json) => t.gate_instance_id)).toEqual(
      mine.map((i) => i.id),
    );

    const pending = await call(TOKENS.bff, 'GET', `/v1/items/${orphan}?on_behalf_of=ria`);
    expect(pending.status).toBe(200);
    expect(
      ItemView.parse(pending.json).gates.map((g) => [
        g.gate,
        g.status,
        g.card_id,
        g.ledger_entry_id,
      ]),
    ).toEqual([
      ['G0', 'pending', card, null],
      ['G1', 'pending', card, null],
    ]);

    // the item that went on to S6: every gate it passed is decided, on a card, with its ledger entry
    const done = ItemView.parse(
      (await call(TOKENS.bff, 'GET', `/v1/items/${coding}?on_behalf_of=ria`)).json,
    );
    const decided = done.gates.filter((g) => g.status === 'decided');
    expect(decided.map((g) => g.gate)).toEqual(expect.arrayContaining(['G0', 'G1']));
    for (const g of decided) {
      expect(g.card_id).not.toBeNull();
      const entry = await s.record.pool.query(
        'SELECT 1 FROM ledger.ledger_entry WHERE entry_id = $1',
        [g.ledger_entry_id],
      );
      expect(entry.rowCount).toBe(1);
    }
  });
});

describe('the score chips', () => {
  it('shows every agent at its stations, unknown without a score, and marks a low one from an eval run', async () => {
    let f = await floor(p.project);
    const a1 = AGENT_DEFINITIONS.find((d) => d.steps.some((st) => st.startsWith('1.')))!;
    const chip = f.scores.find((c) => c.agent_id === a1.agent_id && c.stage === 'S1')!;
    expect(chip).toMatchObject({ status: 'unknown', low: false, score_id: null });

    // an eval run of that agent under its current prompt that passes 1 of 4
    const at = s.clock.now().toISOString();
    const run = EvalRunRecord.parse({
      eval_run_id: newId<'EvalRun'>(s.clock.now().getTime()),
      suite_id: 'suite-floor',
      project_tag: null,
      agent_id: a1.agent_id,
      profile: 'floor',
      prompt_ref: a1.prompt.ref,
      prompt_sha256: a1.prompt.sha256,
      contract_version: a1.contract.contract_version,
      provider: 'fake',
      model: 'fake-model',
      harness_version: 'aisdlc-evals/1',
      trigger: 'ci',
      git_sha: null,
      store_id: 'store-1',
      manifest_digest: 'b'.repeat(64),
      k: 4,
      cases: [
        {
          case_id: 'floor-c1',
          kind: 'regression',
          security_tagged: false,
          trials: [1, 2, 3, 4].map((t) => ({
            trial: t,
            passed: t === 1,
            failure_code: t === 1 ? null : 'grader_failed',
            infra_error: false,
            tokens_in: 10,
            tokens_out: 2,
            cost_micro_usd: 7,
          })),
        },
      ],
      cost_micro_usd: 28,
      errored: 0,
      started_at: at,
      ended_at: at,
    });
    const r = await recordEvalRun({ pool: s.record.pool, clock: s.clock }, run);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const ev = await s.record.pool.query(
      `SELECT 1 FROM record.record_event WHERE stream = $1 AND type = $2`,
      [evalStream('suite-floor'), EVAL_EVENT.run_recorded],
    );
    expect(ev.rows).toHaveLength(1);
    f = await floor(p.project);
    const low = f.scores.find((c) => c.agent_id === a1.agent_id && c.stage === 'S1')!;
    expect(low).toMatchObject({ pass_rate: 0.25, low: true, eval_signals: 4, provider: 'fake' });
    expect(['fail', 'flaky']).toContain(low.status);
  });
});

describe('the kill banner (AR9)', () => {
  it('is clear, then killed by a project kill, and unreachable reads killed', async () => {
    expect((await floor(p.project)).kill).toMatchObject({ state: 'clear', killed: false });
    const id = kills.kill({ kind: 'project', ref: p.project } as never);
    try {
      expect((await floor(p.project)).kill).toMatchObject({
        state: 'killed',
        killed: true,
        kill_ids: [id],
      });
      // another project is not covered
      expect((await floor(lonely.project)).kill.killed).toBe(false);
    } finally {
      kills.release(id);
    }
    kills.breakIt();
    try {
      expect((await floor(p.project)).kill).toMatchObject({ state: 'unreachable', killed: true });
    } finally {
      kills.breakIt(false);
    }
    expect(await floorKillOf(undefined, { project_id: p.project })).toMatchObject({
      state: 'unreachable',
      killed: true,
    });
  });
});

describe('the fleet', () => {
  it('has one row per project with counts only, flagged gates and its kill', async () => {
    const r = await call(TOKENS.bff, 'GET', '/v1/fleet');
    expect(r.status).toBe(200);
    const v = FleetView.parse(r.json);
    const row = v.projects.find((x) => x.project_id === lonely.project)!;
    expect(row).toMatchObject({
      opaque_key: opaqueKeyOf(lonely.project),
      collapsed: null,
      gates: { 'G0+G1': 1 },
      infeasible_gates: 2,
      kill: { killed: false },
    });
    expect(row.in_flight).toBeGreaterThanOrEqual(1);
    const mine = v.projects.find((x) => x.project_id === p.project)!;
    expect(mine.stations.S6).toBe(1);
    expect(mine.status.working + mine.status.stuck).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(v)).not.toContain('Add a CSV export');
    // collapsing keeps the name and how many are in flight, nothing else
    const c = collapseFleetRow(mine, 'confidential');
    expect(c).toMatchObject({ collapsed: 'confidential', in_flight: mine.in_flight, stations: {} });
    expect((await call(TOKENS.runner, 'GET', '/v1/fleet')).status).toBe(403);
  });
});
