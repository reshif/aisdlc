import {
  ADMIN_OVERRIDE_ENTRY_TYPE,
  ADMIN_OVERRIDE_EVENT,
  LEARN_CONFIG_KEY,
  OVERRIDE_REASON_HEADER,
} from '@aisdlc/contracts';
import { readFactoryM1Policy } from '@aisdlc/config';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FactoryM1Eligibility,
  IdentityFactoryAdmins,
  createCoreApp,
  identityFleetRoleHolders,
  proposeConfigKey,
  proposeProjectSettings,
  type CoreScope,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import { GATING_OFF, approvers, loadReports, seedActivePrr } from './work-fixtures.js';

// Owner decision 2026-11-13 (docs/specs/deletion.md §8): nothing applies to the factory admin, and every override is
// recorded with its reason. Over HTTP with the real PDP over the real identity read model: a settings change applied
// alone (the M1 decided by the override, factory and project layer), an action the PDP permits only through the
// override (refused without a reason, recorded with one), and a person who is not a factory admin unchanged.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let project: string;
let repo: string;
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal', 'work', 'onboard'],
};

const kernel = () => ({
  ...s.config,
  eligibility: new FactoryM1Eligibility(s.elig, {
    policy: () => readFactoryM1Policy(s.record.pool),
    holders: identityFleetRoleHolders(s.record.pool, s.clock),
  }),
  admins: new IdentityFactoryAdmins(s.record.pool, s.clock),
});

beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
  await seedPrincipals(s.id.deps, ['ada', 'ben', 'bob', 'ria']);
  await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
  await grantFleetRole(s.id.deps, 'ben', 'factory.admin');
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
  project = seeded.project;
  repo = seeded.repo;
  approvers(s, project, ['bob']);
  await bindProject(s.id, project, { admin: ['bob'], requesters: ['ria'] });
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
    config: kernel(),
  });
  url = await listen(app);
}, 300_000);
afterAll(async () => {
  await app?.close();
  await s?.stop();
});

const post = async (path: string, body: unknown, reason?: string) => {
  const r = await fetch(`${url}${path}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKENS.bff}`,
      'content-type': 'application/json',
      ...(reason === undefined ? {} : { [OVERRIDE_REASON_HEADER]: encodeURIComponent(reason) }),
    },
    body: JSON.stringify(body),
  });
  return { status: r.status, json: (await r.json()) as Json };
};

/** prepare, evidence, decide of an M1 at `base` as `who`, with the override's reason when given. */
async function decideM1(base: string, who: string, reason?: string) {
  const prep = await post(`${base}/prepare`, { on_behalf_of: who }, reason);
  if (prep.status !== 200) return prep;
  const ev = await post(
    `${base}/evidence`,
    { on_behalf_of: who, nonce: prep.json.nonce, evidence_hash: prep.json.evidence_hash },
    reason,
  );
  if (ev.status !== 200) return ev;
  return post(
    `${base}/decide`,
    { on_behalf_of: who, nonce: prep.json.nonce, decision: 'approve' },
    reason,
  );
}

const decisionOf = async (gate: string) =>
  (
    await s.record.pool.query<{ actor: string; body: Json }>(
      `SELECT actor, body FROM ledger.ledger_entry WHERE entry_type = 'decision' AND gate_instance_id = $1`,
      [gate],
    )
  ).rows;

describe('a settings change applied by the factory admin alone', () => {
  it('factory layer: the proposer applies it alone; the M1 is decided by the override with the reason', async () => {
    const p = await proposeConfigKey(kernel(), {
      key: LEARN_CONFIG_KEY,
      value: {
        window: 41,
        clean_streak: 10,
        variance_rework: 3,
        edge_hotspot: 5,
        break_glass: 3,
        single_approver: 10,
      },
      principal: pr('ada'),
      parent_rev_hash: null,
    });
    if (!p.ok) throw new Error(p.error.message);
    const base = `/v1/config/revisions/${p.value.gate_instance_id}`;
    // without the override the proposer is barred, as before
    const plain = await decideM1(base, 'ada');
    expect(plain.status).toBe(422);
    const d = await decideM1(base, 'ada', 'apply now: the window was wrong');
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ outcome: 'approve', published: true });
    const [e] = await decisionOf(p.value.gate_instance_id);
    expect(e?.actor).toBe('ada');
    expect(e?.body.override.reason).toBe('apply now: the window was wrong');
    expect(e?.body.override.bypassed).toContain('own_request');
  });

  it('project layer: a factory admin who holds no slot of the project applies it alone', async () => {
    const p = await proposeProjectSettings(kernel(), {
      project: pid(project),
      change: { wip_limit: 3 },
      proposed_by: pr('bob'),
    });
    if (!p.ok) throw new Error(p.error.message);
    const base = `/v1/revisions/${p.value.gate_instance_id}`;
    const without = await post(`${base}/prepare`, { on_behalf_of: 'ada' });
    expect(without.status).toBe(403);
    expect(without.json.error.code).toBe('override_reason_required');
    const d = await decideM1(base, 'ada', 'the project admin is on leave');
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ outcome: 'approve', published: true });
    const [e] = await decisionOf(p.value.gate_instance_id);
    expect(e?.body.override).toMatchObject({ reason: 'the project admin is on leave' });
    expect(e?.body.override.bypassed).toContain('slot');
  });
});

describe('an action only the override permits', () => {
  const body = () => ({
    on_behalf_of: 'ada',
    project_id: project,
    repo,
    lane: 'L3',
    channel: 'N1',
    text: 'an admin asks for work on a project it is no requester of',
  });

  it('is refused without a reason, and nothing is recorded', async () => {
    const before = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE entry_type = $1`,
      [ADMIN_OVERRIDE_ENTRY_TYPE],
    );
    const r = await post('/v1/requests', body());
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe('override_reason_required');
    const after = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM ledger.ledger_entry WHERE entry_type = $1`,
      [ADMIN_OVERRIDE_ENTRY_TYPE],
    );
    expect(after.rows[0].n).toBe(before.rows[0].n);
  });

  it('with a reason, goes through and is an admin.override ledger entry and record event', async () => {
    const r = await post('/v1/requests', body(), 'filing it for the team');
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const e = await s.record.pool.query<{ actor: string; body: Json }>(
      `SELECT actor, body FROM ledger.ledger_entry WHERE entry_type = $1 AND body ->> 'action' = 'work.request'`,
      [ADMIN_OVERRIDE_ENTRY_TYPE],
    );
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0]?.actor).toBe('ada');
    expect(e.rows[0]?.body).toMatchObject({
      reason: 'filing it for the team',
      bypassed: ['pdp_grant'],
      resource: { type: 'Project', id: project },
    });
    const ev = await s.record.pool.query(
      `SELECT 1 FROM record.record_event WHERE type = $1 AND body ->> 'override_id' = $2`,
      [ADMIN_OVERRIDE_EVENT, e.rows[0]?.body.override_id],
    );
    expect(ev.rowCount).toBe(1);
  });

  it('a person who is not a factory admin is unchanged: no override, a header changes nothing', async () => {
    const r = await post('/v1/requests', { ...body(), on_behalf_of: 'bob' }, 'please');
    expect(r.status).toBe(201); // bob holds the admin slot: work.request is his anyway, no override
    const none = await s.record.pool.query(
      `SELECT 1 FROM ledger.ledger_entry WHERE entry_type = $1 AND actor = 'bob'`,
      [ADMIN_OVERRIDE_ENTRY_TYPE],
    );
    expect(none.rowCount).toBe(0);
    // a person without the action is denied as before, reason or not: the header grants nothing
    const denied = await post(
      '/v1/requests',
      { ...body(), on_behalf_of: 'ria', project_id: 'not-hers' },
      'x',
    );
    expect(denied.status).toBe(403);
    expect(denied.json.error.code).toBe('forbidden');
  });
});
