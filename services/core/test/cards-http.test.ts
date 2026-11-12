import { PDP_EVENT, s0Stream } from '@aisdlc/contracts';
import { FakeStepUp, type DecisionDeps } from '@aisdlc/decisions';
import { createPool } from '@aisdlc/db';
import { IdentityEligibility, IdentityPdpEntities } from '@aisdlc/identity/read';
import { bindProject, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FakeKnowledge,
  FakePrincipalLinks,
  createCoreApp,
  driveS0,
  requestOnboarding,
  type CardDeps,
  type CoreScope,
} from '../src/index.js';
import { driverDeps, pid, request, startCoreStack, type CoreStack } from '../src/testing.js';
import { cardHost, censusFixture } from './cards-fixtures.js';

// The card routes of core over HTTP (PLAN M7.3), with the REAL identity eligibility (the role map
// bound into identity) and the REAL PDP (`card.decide`). The BFF will proxy these for the portal.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let bare: FastifyInstance;
let url: string;
let bareUrl: string;
let ownPool: pg.Pool;
let cards: CardDeps;
let s0: string;
const cardsUrlProject = 'webp';

const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob']);
  await bindProject(s.id, cardsUrlProject, { admin: ['alice'], sec: ['alice'], m4: ['alice'] });
  // The eligibility adapter catches the identity read model up on every call: its own pool.
  ownPool = createPool(s.record.url, 3);
  const decisions: DecisionDeps = {
    pool: s.record.pool,
    ledger: s.id.ledger,
    eligibility: new IdentityEligibility({
      pool: ownPool,
      settings: s.id.settings,
      clock: s.clock,
    }),
    stepUp: new FakeStepUp(),
    clock: s.clock,
  };
  const repo = 'acme/webp';
  const host = cardHost(repo);
  const census = censusFixture(repo);
  const knowledge = new FakeKnowledge().withCensus((_r, jobId) => ({
    census_id: census.census_id,
    census_hash: census.census_hash,
    job_id: jobId,
    b1_blocked: false,
    secrets_not_met: false,
  }));
  knowledge.setCensusRecord(repo, census);
  knowledge.auto = 'done';
  cards = {
    pool: s.record.pool,
    clock: s.clock,
    decisions,
    config: { ...decisions, registry: s.registry },
    registry: s.registry,
    knowledge,
    source: host,
    links: new FakePrincipalLinks().link('alice-gh', 'alice'),
  };
  const r = await requestOnboarding(
    s.deps,
    request({ project_id: pid('webp'), repo, level: 'census', on_behalf_of: 'alice' as never }),
  );
  if (!r.ok) throw new Error(r.error.message);
  s0 = r.value.s0_id;
  const d = driverDeps(s, host, knowledge);
  for (let i = 0; i < 6; i++) await driveS0(d, s0);
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: ownPool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  const mk = (extra: object) =>
    createCoreApp({
      pool: s.record.pool,
      auth: new ServiceAuth(TOKENS),
      callers: CALLERS,
      registry: s.registry,
      clock: s.clock,
      ...extra,
    });
  app = mk({ pdp, cards });
  url = await listen(app);
  bare = mk({ pdp });
  bareUrl = await listen(bare);
});
afterAll(async () => {
  await app?.close();
  await bare?.close();
  await ownPool?.end();
  await s.stop();
});

async function call(
  token: string | null,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  base = url,
) {
  const res = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

/** prepare, evidence, decide over HTTP for one person. */
async function decideOverHttp(cardId: string, who: string, decision: string, content?: unknown) {
  const p = await call(TOKENS.bff, 'POST', `/v1/cards/${cardId}/prepare`, { on_behalf_of: who });
  if (p.status !== 200) return p;
  const e = await call(TOKENS.bff, 'POST', `/v1/cards/${cardId}/evidence`, {
    on_behalf_of: who,
    nonce: p.json.nonce,
    evidence_hash: p.json.evidence_hash,
  });
  if (e.status !== 200) return e;
  return call(TOKENS.bff, 'POST', `/v1/cards/${cardId}/decide`, {
    on_behalf_of: who,
    nonce: p.json.nonce,
    decision,
    ...(content === undefined ? {} : { content }),
  });
}

describe('the onboarding card routes', () => {
  it('guards: no token, no scope, no cards configured, unknown ids', async () => {
    expect((await call(null, 'GET', `/v1/s0/${s0}/cards`)).status).toBe(401);
    expect((await call(TOKENS.reader, 'POST', `/v1/s0/${s0}/cards/sync`)).status).toBe(403);
    expect((await call(TOKENS.reader, 'GET', `/v1/s0/${s0}/cards`)).status).toBe(200);
    expect((await call(TOKENS.bff, 'GET', `/v1/s0/${s0}/cards`, undefined, bareUrl)).status).toBe(
      503,
    );
    expect((await call(TOKENS.bff, 'GET', '/v1/s0/not-a-uuid/cards')).status).toBe(400);
    expect(
      (await call(TOKENS.bff, 'GET', '/v1/cards/00000000-0000-4000-8000-000000000000')).status,
    ).toBe(404);
    expect(
      (
        await call(TOKENS.bff, 'POST', '/v1/cards/00000000-0000-4000-8000-000000000000/prepare', {
          on_behalf_of: 'alice',
        })
      ).status,
    ).toBe(404);
  });

  it('list, detail with the payload schema, prepare / evidence / decide delegating to the decision kernel, guarded by card.decide', async () => {
    const synced = await call(TOKENS.bff, 'POST', `/v1/s0/${s0}/cards/sync`);
    expect(synced.status).toBe(200);
    expect(synced.json.opened).toHaveLength(1);
    const list = await call(TOKENS.reader, 'GET', `/v1/s0/${s0}/cards`);
    expect(list.json).toEqual([
      expect.objectContaining({
        card: 'C1',
        step: '0.1',
        slot: 'admin',
        status: 'open',
        actionable: true,
      }),
    ]);
    const id = list.json[0].card_id as string;
    const summary = await call(TOKENS.reader, 'GET', `/v1/cards/${id}/summary`);
    expect(summary.json).toEqual(list.json[0]);
    expect((await call(null, 'GET', `/v1/cards/${id}/summary`)).status).toBe(401);
    const detail = await call(TOKENS.reader, 'GET', `/v1/cards/${id}`);
    expect(detail.status).toBe(200);
    expect(detail.json.view.card).toBe('C1');
    expect(detail.json.evidence_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(detail.json.decision_schema.properties.gaps).toBeDefined();
    expect(detail.json.decisions_allowed).toEqual(['approve', 'request_changes', 'reject']);
    expect(detail.json.deciders).toMatchObject({
      slot: 'admin',
      holders: ['alice'],
      sod_waiver: true,
    });

    // the PDP denies a person with no role at the project, and logs the deny
    const bob = await call(TOKENS.bff, 'POST', `/v1/cards/${id}/prepare`, { on_behalf_of: 'bob' });
    expect(bob.status).toBe(403);
    expect(bob.json.error).toMatchObject({ code: 'forbidden' });
    const denies = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event
        WHERE type = $1 AND body ->> 'action' = 'card.decide' AND body ->> 'decision' = 'deny'`,
      [PDP_EVENT.decision],
    );
    expect(denies.rows[0].n).toBeGreaterThan(0);
    // a body that is not the contract
    expect(
      (await call(TOKENS.bff, 'POST', `/v1/cards/${id}/prepare`, { on_behalf_of: 'alice', x: 1 }))
        .status,
    ).toBe(400);

    // an unsatisfied decision is refused with the rule's own words and decides nothing
    const content = {
      owners: ['alice'],
      tier: 'T0',
      gaps: detail.json.view.gaps.map((g: Json) => ({
        gap_id: g.gap_id,
        disposition: g.default_disposition,
      })),
    };
    const refused = await decideOverHttp(id, 'alice', 'approve', content);
    expect(refused.status).toBe(422);
    expect(refused.json.error.message).toMatch(/positive attestation/);

    const done = await decideOverHttp(id, 'alice', 'approve', { ...content, t0_attestation: true });
    expect(done.status).toBe(200);
    expect(done.json).toMatchObject({ applied: 'applied', decision: { status: 'decided' } });
    expect(done.json.decision.entries[0]).toMatchObject({
      entry_type: 'card.step_decision',
      sod_waiver: true,
    });
    const after = await call(TOKENS.reader, 'GET', `/v1/s0/${s0}/cards`);
    expect(after.json[0]).toMatchObject({ status: 'decided', actionable: false });
    // the allows are logged too (card.decide logs every allow)
    const allows = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event
        WHERE type = $1 AND body ->> 'action' = 'card.decide' AND body ->> 'decision' = 'allow'`,
      [PDP_EVENT.decision],
    );
    expect(allows.rows[0].n).toBeGreaterThan(0);
  });

  it('card 2 edit route (M16): PDP card.decide first, body checked, and only card 2 has instruction text', async () => {
    const list = await call(TOKENS.reader, 'GET', `/v1/s0/${s0}/cards`);
    const any = list.json[0];
    expect(any).toBeDefined();
    const body = { path: 'AGENTS.md', text: '# app\n', base_text_sha256: null };
    const bob = await call(TOKENS.bff, 'POST', `/v1/cards/${any.card_id}/instructions`, {
      ...body,
      on_behalf_of: 'bob',
    });
    expect(bob.status).toBe(403);
    const bad = await call(TOKENS.bff, 'POST', `/v1/cards/${any.card_id}/instructions`, {
      on_behalf_of: 'alice',
      path: '.mcp.json',
      text: 'x',
      base_text_sha256: null,
    });
    expect(bad.status).toBe(400);
    const notC2 = await call(TOKENS.bff, 'POST', `/v1/cards/${any.card_id}/instructions`, {
      ...body,
      on_behalf_of: 'alice',
    });
    expect(notC2.status).toBe(400);
    expect(JSON.stringify(notC2.json)).toMatch(/only card 2/);
    const reader = await call(TOKENS.reader, 'POST', `/v1/cards/${any.card_id}/instructions`, {
      ...body,
      on_behalf_of: 'alice',
    });
    expect(reader.status).toBe(403);
  });

  it('card 4 over HTTP: re-check, then decide; the settings are proposed as an M1 revision', async () => {
    const d = driverDeps(s, cards.source as never, cards.knowledge);
    for (let i = 0; i < 3; i++) await driveS0(d, s0);
    await call(TOKENS.bff, 'POST', `/v1/s0/${s0}/cards/sync`);
    const list = await call(TOKENS.reader, 'GET', `/v1/s0/${s0}/cards`);
    const c4 = list.json.find((x: Json) => x.card === 'C4' && x.actionable);
    expect(c4).toBeDefined();
    const re = await call(TOKENS.bff, 'POST', `/v1/cards/${c4.card_id}/recheck`, {
      on_behalf_of: 'alice',
    });
    expect(re.status).toBe(200);
    expect(re.json.view.can_decide).toBe(true);
    const nope = await call(TOKENS.bff, 'POST', `/v1/cards/${c4.card_id}/recheck`, {
      on_behalf_of: 'bob',
    });
    expect(nope.status).toBe(403);
    const view = re.json.view;
    const done = await decideOverHttp(c4.card_id, 'alice', 'approve', {
      controls_report_hash: view.controls_report.report_hash,
      attestations: {
        bypass_has_no_factory_app: true,
        app_scope_selected: true,
        github_token_readonly: true,
        actions_cannot_approve_prs: true,
        fork_pr_approval_required: true,
        secret_scanning: 'on',
        plan: 'free',
      },
      role_map: view.role_map.proposed,
      two_person_enabled: true,
      gating_profile: {
        gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
        schedule: 'auto',
        tier_floor_applied: true,
      },
      kill_delegations: [],
    });
    expect(done.status).toBe(200);
    expect(done.json.applied).toBe('applied');
    const proposed = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM record.record_event
        WHERE type = 'config.proposed' AND body ->> 'layer' = 'project' AND body -> 'scope' ->> 'ref' = $1`,
      [cardsUrlProject],
    );
    expect(proposed.rows[0].n).toBe(1);
    const applied = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND type = 's0.card_applied' ORDER BY seq`,
      [s0Stream(s0)],
    );
    expect(applied.rows.map((r) => r.body.card)).toEqual(['C1', 'C4']);
  });
});
