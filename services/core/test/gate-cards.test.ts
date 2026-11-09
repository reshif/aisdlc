import type { TestGateway } from '@aisdlc/gateway/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { bindProject, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createCoreApp, driveWork, readItem, type CoreScope } from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { planningRig, sharedProvider, startPlanningGateway } from './planning.js';
import { loadReports, runItem } from './work-fixtures.js';

// Gap B at core: a work-item gate card is decided through /v1/cards/:id/gate/*: the PDP (`card.decide`, and
// `gate.decide` on every gate of the card), then the decision kernel. The card is the one the work engine opened
// for G0 with G1, G2 and G3d; nothing is decided by reading or preparing it, and nothing without the evidence
// being reported as viewed.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let gw: TestGateway;
let app: FastifyInstance;
let url: string;
const provider = sharedProvider();
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), reader: 'reader-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  gw = await startPlanningGateway(s);
  await seedPrincipals(s.id.deps, ['alice', 'bob']);
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
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await gw.stop();
  await s.stop();
});
beforeEach(() => provider.reset());

async function call(token: string | null, method: 'GET' | 'POST', path: string, body?: unknown) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}
const rows = async (sql: string, args: unknown[] = []) =>
  (await s.record.pool.query(sql, args)).rows as Array<Record<string, any>>; // eslint-disable-line @typescript-eslint/no-explicit-any
type St = NonNullable<Awaited<ReturnType<typeof readItem>>>['state'];
const pending = (gate: string) => (st: St) =>
  st.gates.some((g) => g.gate === gate && g.status === 'pending');
const cardOf = async (itemId: string, gate: string) =>
  (
    await rows(
      `SELECT substring(stream from 6) AS id FROM record.record_event WHERE type = 'card.opened' AND body ->> 'subject_id' = $1 AND body::text LIKE $2 ORDER BY global_seq DESC`,
      [itemId, `%${gate}%`],
    )
  )[0]?.id as string;
const led = (itemId: string) =>
  rows(
    `SELECT gate_id, decision, actor FROM ledger.ledger_entry WHERE entry_type = 'decision' AND subject_id = $1 ORDER BY ledger_seq`,
    [itemId],
  );

/** An item whose G0 and G1 card is open and nobody has decided it, and bob holds the slots in identity too. */
async function openCard(gate: 'G0' | 'G2' | 'G3d') {
  const rig = await planningRig(s, gw, { lane: 'L4' });
  await bindProject(s.id, rig.project, {
    admin: ['bob'],
    requesters: ['bob'],
    intent: ['bob'],
    design: ['bob'],
    x: ['bob'],
    g4: ['bob'],
    g5: ['bob'],
    sec: ['bob'],
    m4: ['bob'],
    kill: ['bob'],
  });
  const item = await runItem(s, rig.d, rig.itemId, {
    decide: (g) => (g === gate || (gate === 'G0' && g === 'G1') ? 'hold' : 'approve'),
    stop: pending(gate),
    passes: 150,
  });
  return { rig, item, card: await cardOf(rig.itemId, gate) };
}

describe('a work-item gate card as something to decide', () => {
  it('shows its gates, the subject, who may decide it and what a decision may be, and decides nothing by being read', async () => {
    const { rig, card } = await openCard('G0');
    const v = await call(TOKENS.reader, 'GET', `/v1/cards/${card}/gate`);
    expect(v.status).toBe(200);
    expect(v.json).toMatchObject({
      card_id: card,
      item_id: rig.itemId,
      project_id: rig.project,
      status: 'open',
      proposed_lane: 'L4',
      base_sha: null,
      injection_suspected: true, // the request text in the fixtures is a planted instruction
      deciders: { slots: ['intent'], holders: ['bob'] },
      decisions_allowed: ['approve', 'reject', 'request_changes'],
      decision_reason: null,
    });
    expect(v.json.gates.map((g: Json) => [g.gate, g.status, g.step_up_required])).toEqual([
      ['G0', 'pending', false],
      ['G1', 'pending', false],
    ]);
    expect((await led(rig.itemId)).length).toBe(0);
    // an onboarding card id is not a work-item card, and the other way round
    expect((await call(TOKENS.reader, 'GET', `/v1/cards/${rig.itemId}/gate`)).status).toBe(404);
  });
});

describe('prepare, evidence viewed, decide: with the PDP first and the kernel second', () => {
  it('a person who does not hold the slot is refused by the PDP and nothing is prepared', async () => {
    const { card } = await openCard('G0');
    const r = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'alice',
    });
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('forbidden');
    const n = await rows('SELECT count(*)::int AS n FROM decisions.gate_nonce');
    const again = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'alice',
    });
    expect(again.status).toBe(403);
    expect((await rows('SELECT count(*)::int AS n FROM decisions.gate_nonce'))[0]?.n).toBe(n[0]?.n);
    // a caller without the onboard scope may read but never decide
    const ro = await call(TOKENS.reader, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'bob',
    });
    expect(ro.status).toBe(403);
  });

  it('prepare gives one nonce per pending gate bound to the subject; deciding before the evidence is reported is refused', async () => {
    const { rig, card } = await openCard('G0');
    const view = (await call(TOKENS.reader, 'GET', `/v1/cards/${card}/gate`)).json;
    const p = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'bob',
    });
    expect(p.status).toBe(200);
    expect(p.json.gates.map((g: Json) => g.gate)).toEqual(['G0', 'G1']);
    for (const g of p.json.gates) expect(g.subject_hash).toBe(view.subject_hash);
    const votes = p.json.gates.map((g: Json) => ({ nonce: g.nonce }));
    const early = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: 'bob',
      decision: 'approve',
      votes,
    });
    expect(early.status).toBe(422);
    expect(early.json.error.message).toContain('evidence_not_viewed');
    // a hash that is not the one the nonce is bound to is refused too
    const wrong = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/evidence`, {
      on_behalf_of: 'bob',
      views: p.json.gates.map((g: Json) => ({ nonce: g.nonce, evidence_hash: 'f'.repeat(64) })),
    });
    expect(wrong.status).toBe(422);
    expect((await led(rig.itemId)).length).toBe(0);
  });

  it('approve G0 and G1 on one card: two ledger entries by the person, a receipt, and the item goes on to S2', async () => {
    const { rig, card } = await openCard('G0');
    const p = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'bob',
    });
    const ev = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/evidence`, {
      on_behalf_of: 'bob',
      views: p.json.gates.map((g: Json) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
    });
    expect(ev.json).toEqual({ evidence_viewed: true });
    const d = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: 'bob',
      decision: 'approve',
      votes: p.json.gates.map((g: Json) => ({ nonce: g.nonce })),
    });
    expect(d.status).toBe(200);
    expect(d.json.entries.map((e: Json) => [e.gate_id, e.decision])).toEqual([
      ['G0', 'approve'],
      ['G1', 'approve'],
    ]);
    expect(d.json.entries[0].ledger_seq).toBeGreaterThan(0);
    expect(await led(rig.itemId)).toEqual([
      { gate_id: 'G0', decision: 'approve', actor: 'bob' },
      { gate_id: 'G1', decision: 'approve', actor: 'bob' },
    ]);
    expect((await call(TOKENS.reader, 'GET', `/v1/cards/${card}/gate`)).json.status).toBe(
      'decided',
    );
    // the nonce is single-use
    const again = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: 'bob',
      decision: 'approve',
      votes: p.json.gates.map((g: Json) => ({ nonce: g.nonce })),
    });
    expect(again.status).toBeGreaterThanOrEqual(400);
    expect((await led(rig.itemId)).length).toBe(2);
    // the engine takes the decision from the ledger and the agents of S2 run
    const item = await runItem(s, rig.d, rig.itemId, {
      stop: pending('G2'),
      decide: (g) => (g === 'G2' ? 'hold' : 'approve'),
      passes: 120,
    });
    expect(provider.seen.some((c) => c.step === '2.1')).toBe(true);
    expect(item?.state.lane).toBe('L4');
  });

  it('reject needs a reason: without one it is refused; with one it is on the ledger bound to the card payload and G2 goes back to 3.2 (B23)', async () => {
    const { rig, card } = await openCard('G2');
    const p = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'bob',
    });
    expect(p.json.gates.map((g: Json) => g.gate)).toEqual(['G2']);
    await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/evidence`, {
      on_behalf_of: 'bob',
      views: p.json.gates.map((g: Json) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
    });
    const votes = p.json.gates.map((g: Json) => ({ nonce: g.nonce }));
    const none = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: 'bob',
      decision: 'reject',
      votes,
    });
    expect(none.status).toBe(400);
    expect((await led(rig.itemId)).filter((l) => l.gate_id === 'G2')).toEqual([]);
    const d = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: 'bob',
      decision: 'request_changes',
      reason: 'REQ-12 must also say what the header row holds',
      votes,
    });
    expect(d.status).toBe(200);
    expect(d.json.entries[0]).toMatchObject({ gate_id: 'G2', decision: 'request_changes' });
    const v = (await call(TOKENS.reader, 'GET', `/v1/cards/${card}/gate`)).json;
    expect(v.decision_reason).toBe('REQ-12 must also say what the header row holds');
    // the reason is a card payload row whose hash the ledger entry binds
    const payload = await rows(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'card.payload_recorded'`,
      [`card:${card}`],
    );
    expect(payload[0]?.body.payload).toEqual([
      { kind: 'decision_reason', text: 'REQ-12 must also say what the header row holds' },
    ]);
    const entry = await rows(
      `SELECT body FROM ledger.ledger_entry WHERE entry_type = 'decision' AND gate_id = 'G2' AND subject_id = $1`,
      [rig.itemId],
    );
    expect(JSON.stringify(entry[0]?.body)).toContain(payload[0]?.body.payload_hash);
    await driveWork(rig.d);
    const item = await readItem(s.record.pool, rig.itemId);
    expect(item?.state.rework.by_edge['B23']).toBe(1);
  });

  it('G3d: the design card is decided the same way; a rejection goes back to 4.1 (B24)', async () => {
    const { rig, card } = await openCard('G3d');
    const p = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/prepare`, {
      on_behalf_of: 'bob',
    });
    await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/evidence`, {
      on_behalf_of: 'bob',
      views: p.json.gates.map((g: Json) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
    });
    const d = await call(TOKENS.bff, 'POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: 'bob',
      decision: 'reject',
      reason: 'the migration is not reversible',
      votes: p.json.gates.map((g: Json) => ({ nonce: g.nonce })),
    });
    expect(d.status).toBe(200);
    await driveWork(rig.d);
    expect((await readItem(s.record.pool, rig.itemId))?.state.rework.by_edge['B24']).toBe(1);
  });
});
