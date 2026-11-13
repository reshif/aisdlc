import { readFactoryM1Policy } from '@aisdlc/config';
import { AccessGrantView, AccessProposeResult } from '@aisdlc/contracts';
import { readGateState, type FakeStepUp } from '@aisdlc/decisions';
import { IdentityPdpEntities, freshReadModel, queryGrants } from '@aisdlc/identity/read';
import {
  bindProject,
  grantFleetRole,
  seedPrincipals,
  startTestIdentityApi,
} from '@aisdlc/identity/testing';
import { ok as okR } from '@aisdlc/kernel';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  FactoryM1Eligibility,
  HttpAccessGrants,
  IdentityFactoryAdmins,
  coreInbox,
  createCoreApp,
  identityFleetRoleHolders,
  decideAccess,
  prepareAccess,
  proposeAccess,
  recordAccessEvidence,
  type CoreScope,
} from '../src/index.js';
import { pr, setAdmins, startCoreStack, type CoreStack } from '../src/testing.js';

// P1-6 on the real record, ledger, Notary, PDP and identity (its HTTP API, scope `grant`):
//   - every grant and revoke asks the PDP for `access.manage` on its scope, and goes through an M1 gate at the scope's
//     admin slot (the project's, or the factory's for the fleet) whose deciders exclude the proposer and the person
//     granted: nobody decides their own grant, and a change nobody else can decide is refused at propose
//   - only an approved M1 writes the binding (identity scope `grant`), recorded as `access_grant.applied` and an
//     `access.grant_applied` ledger entry; a revoke ends the binding, and the next access read no longer has it
//   - the first extra factory admin has no bootstrap exception: a sole factory admin's proposal is refused
//   - an access request is the same path, shown in the inbox of whoever may decide it

vi.setConfig({ testTimeout: 180_000 });

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
let identity: { url: string; stop(): Promise<void> };
const TOKENS = { bff: 'bff-at-core-'.padEnd(32, 'x'), core: 'core-at-identity-'.padEnd(32, 'x') };
const CALLERS: Record<string, readonly CoreScope[]> = { bff: ['read', 'portal'] };

/** The kernel as core wires it: the factory pseudo-project answered from `factory.m1_policy` and identity. */
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
  // root and rita: factory admins; alice and amy: acme's admin slot; dora, vic: nobody yet
  await seedPrincipals(s.id.deps, ['root', 'rita', 'alice', 'amy', 'dora', 'vic']);
  for (const p of ['root', 'rita']) await grantFleetRole(s.id.deps, p, 'factory.admin');
  await bindProject(s.id, 'acme', { admin: ['alice', 'amy'] });
  setAdmins(s, 'acme', ['alice', 'amy']);
  identity = await startTestIdentityApi(s.id, {
    core: { token: TOKENS.core, scopes: ['read', 'grant'] },
  });
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth({ bff: TOKENS.bff }),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: kernel(),
    grants: new HttpAccessGrants({ baseUrl: identity.url, token: TOKENS.core }),
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await identity?.stop();
  await s?.stop();
});

async function call(
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: {
      ...headers,
      authorization: `Bearer ${TOKENS.bff}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: text ? (JSON.parse(text) as Json) : null };
}

const ACME = { kind: 'project', ref: 'acme' } as const;
const FLEET = { kind: 'fleet', ref: '*' } as const;
const grant = (principal: string, role: string, scope: object, expiry: string | null = null) => ({
  op: 'grant',
  target: { kind: 'principal', principal_id: principal },
  role_id: role,
  scope,
  expiry,
});
const propose = (who: string, change: object, reason = 'needs it') =>
  call('POST', '/v1/access/grants', { on_behalf_of: who, change, reason });

/** prepare, evidence, decide as `who`; the decide answer (or the first refusal). */
async function decideAs(who: string, grantId: string, decision = 'approve') {
  const p = await call('POST', `/v1/access/grants/${grantId}/prepare`, { on_behalf_of: who });
  if (p.status !== 200) return p;
  const e = await call('POST', `/v1/access/grants/${grantId}/evidence`, {
    on_behalf_of: who,
    nonce: p.json.nonce,
    evidence_hash: p.json.evidence_hash,
  });
  if (e.status !== 200) return e;
  return call('POST', `/v1/access/grants/${grantId}/decide`, {
    on_behalf_of: who,
    nonce: p.json.nonce,
    decision,
  });
}

async function rolesOf(principal: string): Promise<string[]> {
  expect((await freshReadModel(s.record.pool)).ok).toBe(true);
  const g = await queryGrants(s.record.pool, { principal }, null, s.clock.now());
  return g
    .filter((x) => x.blockers.length === 0)
    .map((x) => `${x.role_id}@${x.scope.kind}:${x.scope.ref}`);
}

describe('the PDP decides who may propose', () => {
  it('access.manage on the scope: a project admin on their project, never on the fleet; a person with no role never', async () => {
    const none = await propose('vic', grant('dora', 'project.viewer', ACME));
    expect(none.status).toBe(403);
    expect(none.json.error.message).toMatch(/access.manage denied/);
    const fleet = await propose('alice', grant('dora', 'factory.auditor', FLEET));
    expect(fleet.status).toBe(403);
    // a slot role is the role map's (card 4): refused even for an admin
    const slot = await propose('alice', grant('dora', 'project.admin', ACME));
    expect(slot.status).toBe(400);
  });
});

let doraViewer: string;

describe('a project grant: decided by another holder of the admin slot', () => {
  it('the proposer cannot decide it; another admin approves; the binding is in force with its decision', async () => {
    const r = await propose('alice', grant('dora', 'project.viewer', ACME));
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    const p = AccessProposeResult.parse(r.json);
    expect(p.deciders).toEqual(['amy']);
    // a second identical proposal while the first waits is refused
    expect((await propose('amy', grant('dora', 'project.viewer', ACME))).status).toBe(409);
    // self-approval: the proposer is not a decider of their own grant (no single-holder waiver)
    const self = await decideAs('alice', p.grant_id);
    expect(self.status).toBe(403);
    expect(self.json.error.message).toMatch(/not_eligible/);
    // somebody without access.manage on acme is refused by the PDP before the kernel
    expect((await decideAs('vic', p.grant_id)).status).toBe(403);
    expect(await rolesOf('dora')).not.toContain('project.viewer@project:acme');
    // a nonce alice did not prepare (amy's) is refused for alice
    const amyPrep = await call('POST', `/v1/access/grants/${p.grant_id}/prepare`, {
      on_behalf_of: 'amy',
    });
    expect(amyPrep.status).toBe(200);
    const stolen = await call('POST', `/v1/access/grants/${p.grant_id}/decide`, {
      on_behalf_of: 'alice',
      nonce: amyPrep.json.nonce,
      decision: 'approve',
    });
    expect(stolen.status).toBe(422);
    expect(stolen.json.error.message).toMatch(/not yours/);
    const d = await decideAs('amy', p.grant_id);
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ outcome: 'approve', status: 'applied', applied: true });
    expect(await rolesOf('dora')).toContain('project.viewer@project:acme');
    // the record and the ledger: the decision entry, then the applied event and its entry, bound to the decision
    const v = AccessGrantView.parse(
      (await call('GET', `/v1/access/grants/${p.grant_id}?on_behalf_of=dora`)).json,
    );
    expect(v).toMatchObject({ status: 'applied', proposed_by: 'alice', origin: 'admin' });
    const gs = await readGateState(s.record.pool, p.gate_instance_id);
    expect(gs?.decisions.at(-1)).toMatchObject({
      actor: 'amy',
      decision: 'approve',
      sod_waiver: false,
    });
    expect(v.applied?.decision_entry_id).toBe(gs?.decisions.at(-1)?.entry_id);
    const entry = await s.record.pool.query<{ subject_kind: string; actor: string }>(
      `SELECT subject_kind, actor FROM ledger.ledger_entry WHERE entry_type = 'access.grant_applied' AND subject_id = $1`,
      [p.grant_id],
    );
    expect(entry.rows).toEqual([{ subject_kind: 'access', actor: 'amy' }]);
    doraViewer = v.applied?.binding_id as string;
    // dora may see it (it names her); vic may not (one answer for missing and invisible)
    expect((await call('GET', `/v1/access/grants/${p.grant_id}?on_behalf_of=vic`)).status).toBe(
      404,
    );
  });

  it('the person granted never decides it either: with only the two admins, one granting the other is refused', async () => {
    const r = await propose('amy', grant('alice', 'project.viewer', ACME));
    expect(r.status).toBe(422);
    expect(r.json.error.message).toMatch(/nobody can decide this/);
  });

  it('a revoke goes the same way and takes effect on the next access read; a role-map binding is not revoked here', async () => {
    const rows = await call('GET', '/v1/access/bindings?on_behalf_of=alice&scope=project:acme');
    expect(rows.status).toBe(200);
    const mine = rows.json.bindings.find((b: Json) => b.binding_id === doraViewer);
    expect(mine).toMatchObject({
      origin: 'access_grant',
      members: ['dora'],
      role_id: 'project.viewer',
    });
    const rm = rows.json.bindings.find((b: Json) => b.origin === 'role_map');
    expect(rm).toBeDefined();
    const refuse = await propose('alice', {
      op: 'revoke',
      binding_id: rm.binding_id,
      group_id: rm.group_id,
      role_id: rm.role_id,
      scope: rm.scope,
    });
    expect(refuse.status).toBe(422);
    // vic cannot even list them
    expect(
      (await call('GET', '/v1/access/bindings?on_behalf_of=vic&scope=project:acme')).status,
    ).toBe(403);
    const r = await propose(
      'amy',
      {
        op: 'revoke',
        binding_id: doraViewer,
        group_id: mine.group_id,
        role_id: 'project.viewer',
        scope: ACME,
      },
      'left the project',
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.deciders).toEqual(['alice']);
    expect(await rolesOf('dora')).toContain('project.viewer@project:acme');
    const d = await decideAs('alice', r.json.grant_id);
    expect(d.json).toMatchObject({ status: 'applied', applied: true });
    expect(await rolesOf('dora')).not.toContain('project.viewer@project:acme');
  });

  it('a rejection writes nothing', async () => {
    const r = await propose('alice', grant('vic', 'project.viewer', ACME));
    const d = await decideAs('amy', r.json.grant_id, 'reject');
    expect(d.json).toMatchObject({ outcome: 'reject', status: 'rejected', applied: false });
    expect(await rolesOf('vic')).toEqual([]);
    expect(
      (await call('POST', `/v1/access/grants/${r.json.grant_id}/apply`, { on_behalf_of: 'alice' }))
        .status,
    ).toBe(409);
  });
});

describe('the fleet: a factory admin other than the proposer decides', () => {
  it('a second factory admin is granted by one admin and decided by another', async () => {
    const r = await propose('root', grant('vic', 'factory.admin', FLEET), 'on call');
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.deciders).toEqual(['rita']);
    const self = await decideAs('root', r.json.grant_id);
    expect(self.status).toBe(403);
    expect(self.json.error.message).toMatch(/not_eligible/);
    const d = await decideAs('rita', r.json.grant_id);
    expect(d.json).toMatchObject({ status: 'applied' });
    expect(await rolesOf('vic')).toContain('factory.admin@fleet:*');
  });

  it('bootstrap: the only factory admin cannot propose the first extra one (no exception exists)', async () => {
    const only = {
      ...s.config,
      eligibility: new FactoryM1Eligibility(s.elig, {
        policy: () => readFactoryM1Policy(s.record.pool),
        holders: async () => okR([pr('root')]),
      }),
    };
    const r = await proposeAccess(
      { pool: s.record.pool, decisions: only },
      {
        by: pr('root'),
        change: grant('dora', 'factory.admin', FLEET) as never,
        reason: 'second admin',
        origin: 'admin',
      },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.message).toMatch(/no bootstrap exception/);
  });
});

describe('access requests', () => {
  it('a person asks for a role for themselves; it waits in the inbox of whoever may decide it; deciding it grants it', async () => {
    const r = await call('POST', '/v1/access/requests', {
      on_behalf_of: 'dora',
      role_id: 'factory.auditor',
      scope: FLEET,
      expiry: '2027-06-01T00:00:00.000Z',
      reason: 'quarterly audit',
    });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.deciders).toEqual(['rita', 'root', 'vic']);
    const inbox = await coreInbox({
      cards: { pool: s.record.pool, decisions: kernel() } as never,
      config: kernel(),
      clock: s.clock,
    });
    const item = inbox.find((i) => i.id === r.json.grant_id);
    expect(item).toMatchObject({
      kind: 'access_grant',
      project_id: 'factory',
      gate: 'M1',
      holders: ['rita', 'root', 'vic'],
      feasibility: 'feasible',
    });
    // the requester sees their own request; the list of a factory admin has it too
    const mine = await call('GET', '/v1/access/grants?on_behalf_of=dora');
    expect(mine.json.grants.map((g: Json) => g.grant_id)).toContain(r.json.grant_id);
    expect((await decideAs('dora', r.json.grant_id)).status).toBe(403);
    const d = await decideAs('rita', r.json.grant_id);
    expect(d.json).toMatchObject({ status: 'applied' });
    expect(await rolesOf('dora')).toContain('factory.auditor@fleet:*');
    const after = await coreInbox({
      cards: { pool: s.record.pool, decisions: kernel() } as never,
      config: kernel(),
      clock: s.clock,
    });
    expect(after.find((i) => i.id === r.json.grant_id)).toBeUndefined();
  });

  it('a request is only ever for the person asking', async () => {
    const r = await proposeAccess(
      { pool: s.record.pool, decisions: kernel() },
      {
        by: pr('dora'),
        change: grant('vic', 'project.viewer', ACME) as never,
        reason: 'x',
        origin: 'request',
      },
    );
    expect(r.ok).toBe(false);
  });
});

describe('two people decide: each vote needs a step-up (RC-SEC-4)', () => {
  it('under a factory M1 of two approvers, a vote without a verified step-up is refused; with one it counts', async () => {
    // root, rita and vic are factory admins by now; the policy asks for two approvers
    const two = {
      ...s.config,
      eligibility: new FactoryM1Eligibility(s.elig, {
        policy: async () => ({
          state: 'ok' as const,
          value: { role: 'factory.admin', approvers: 2 } as never,
        }),
        holders: identityFleetRoleHolders(s.record.pool, s.clock),
      }),
    };
    const d = {
      pool: s.record.pool,
      decisions: two,
      writer: new HttpAccessGrants({ baseUrl: identity.url, token: TOKENS.core }),
    };
    const p = await proposeAccess(d, {
      by: pr('root'),
      change: grant('dora', 'factory.onboarder', FLEET) as never,
      reason: 'onboards repos',
      origin: 'admin',
    });
    if (!p.ok) throw new Error(JSON.stringify(p.error));
    expect(p.value.deciders).toEqual(['rita', 'vic']);
    const vote = async (who: string, withProof: boolean) => {
      const prep = await prepareAccess(d, { grant_id: p.value.grant_id, principal: pr(who) });
      if (!prep.ok) throw new Error(JSON.stringify(prep.error));
      expect(prep.value.step_up.required).toBe(true);
      const ev = await recordAccessEvidence(d, {
        grant_id: p.value.grant_id,
        principal: pr(who),
        nonce: prep.value.nonce,
        evidence_hash: prep.value.evidence_hash,
      });
      expect(ev.ok).toBe(true);
      const proof = (s.config.stepUp as FakeStepUp).issue(prep.value.step_up.bound_hash, who);
      return decideAccess(d, {
        grant_id: p.value.grant_id,
        principal: pr(who),
        nonce: prep.value.nonce,
        decision: 'approve',
        ...(withProof ? { step_up: { proof } } : {}),
      });
    };
    const bare = await vote('rita', false);
    expect(bare.ok).toBe(false);
    if (!bare.ok) expect(bare.error.message).toMatch(/step_up_required/);
    const first = await vote('rita', true);
    expect(first.ok && first.value.status).toBe('pending');
    const second = await vote('vic', true);
    expect(second.ok && second.value).toMatchObject({ status: 'applied', applied: true });
    expect(await rolesOf('dora')).toContain('factory.onboarder@fleet:*');
  });
});

describe('the factory admin answers an access request outside the slot (docs/specs/deletion.md 8)', () => {
  it('refused without a reason; with one it decides alone and the reason is in the decision ledger entry', async () => {
    const asked = await call('POST', '/v1/access/requests', {
      on_behalf_of: 'vic',
      role_id: 'project.viewer',
      scope: ACME,
      expiry: null,
      reason: 'joining the acme team',
    });
    expect(asked.status, JSON.stringify(asked.json)).toBe(201);
    const p = AccessProposeResult.parse(asked.json);
    // root is a factory admin but not one of acme's deciders
    expect(p.deciders).not.toContain('root');
    expect((await decideAs('root', p.grant_id)).status).toBe(403);
    const why = 'acme admins are away; the owner asked';
    const h = { 'x-aisdlc-override-reason': encodeURIComponent(why) };
    const prep = await call(
      'POST',
      `/v1/access/grants/${p.grant_id}/prepare`,
      { on_behalf_of: 'root' },
      h,
    );
    expect(prep.status, JSON.stringify(prep.json)).toBe(200);
    const ev = await call(
      'POST',
      `/v1/access/grants/${p.grant_id}/evidence`,
      { on_behalf_of: 'root', nonce: prep.json.nonce, evidence_hash: prep.json.evidence_hash },
      h,
    );
    expect(ev.status).toBe(200);
    const d = await call(
      'POST',
      `/v1/access/grants/${p.grant_id}/decide`,
      { on_behalf_of: 'root', nonce: prep.json.nonce, decision: 'approve' },
      h,
    );
    expect(d.status, JSON.stringify(d.json)).toBe(200);
    expect(d.json).toMatchObject({ outcome: 'approve', applied: true });
    expect(await rolesOf('vic')).toContain('project.viewer@project:acme');
    const e = await s.record.pool.query<{ actor: string; reason: string | null }>(
      `SELECT actor, body -> 'override' ->> 'reason' AS reason FROM ledger.ledger_entry
        WHERE gate_instance_id = $1 AND decision = 'approve'`,
      [p.gate_instance_id],
    );
    expect(e.rows).toEqual([{ actor: 'root', reason: why }]);
  });
});
