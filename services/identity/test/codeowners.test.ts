import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { runProjection } from '@aisdlc/record';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createGroup,
  createIdentityApp,
  identityProjection,
  reconcileProject,
  setCodeownerMembers,
  type CodeownersDeps,
} from '../src/index.js';
import { addMemberTx } from '../src/commands.js';
import { inIdentityTx } from '../src/tx.js';
import {
  bindProject,
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

let s: IdentityStack;
let deps: CodeownersDeps;
beforeAll(async () => {
  s = await startIdentityStack();
  deps = { ...s.deps, settings: s.settings };
  await seedPrincipals(s.deps, ['alice', 'bob', 'carol', 'dave']);
  await bindProject(s, 'acme', { admin: ['alice'] }); // g4 defaults to codeowners
});
afterAll(async () => {
  await s.stop();
});

const errCode = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);
const events = async (): Promise<number> =>
  Number(
    (
      await s.record.pool.query<{ n: string }>(
        'SELECT count(*)::text AS n FROM record.record_event',
      )
    ).rows[0]?.n,
  );
const members = async (group: string): Promise<Array<{ id: string; source: string }>> => {
  await runProjection(s.record.pool, identityProjection);
  const q = await s.record.pool.query<{ principal_id: string; source: string }>(
    'SELECT principal_id, source FROM identity.membership WHERE group_id = $1 ORDER BY 1',
    [group],
  );
  return q.rows.map((r) => ({ id: r.principal_id, source: r.source }));
};
const set = (project: string, principals: string[], source_ref = 'acme/app@abc') =>
  setCodeownerMembers(deps, {
    project_id: pid(project),
    principals: principals.map(pr),
    source_ref,
  });

describe('setCodeownerMembers', () => {
  it('starts with nobody holding g4, then sets the members with source codeowners', async () => {
    expect(await members('rm.acme.g4')).toEqual([]);
    const r = await set('acme', ['bob', 'alice']);
    expect(r.ok && r.value).toMatchObject({
      group_id: 'rm.acme.g4',
      members: ['alice', 'bob'],
      added: ['alice', 'bob'],
      removed: [],
    });
    expect(await members('rm.acme.g4')).toEqual([
      { id: 'alice', source: 'codeowners' },
      { id: 'bob', source: 'codeowners' },
    ]);
  });

  it('writes nothing when the group already holds exactly those principals', async () => {
    const before = await events();
    const r = await set('acme', ['alice', 'bob', 'alice']);
    expect(r.ok && r.value).toMatchObject({ added: [], removed: [] });
    expect(await events()).toBe(before);
  });

  it('adds and removes to reach the set, and the changes reach the access ledger', async () => {
    const r = await set('acme', ['bob', 'carol'], 'acme/app@def');
    expect(r.ok && r.value).toMatchObject({ added: ['carol'], removed: ['alice'] });
    expect((await members('rm.acme.g4')).map((m) => m.id)).toEqual(['bob', 'carol']);
    await s.sync();
    const q = await s.record.pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ledger.ledger_entry WHERE entry_type = 'access.membership_removed'
         AND body -> 'change' ->> 'reason' LIKE '%acme/app@def%'`,
    );
    expect(Number(q.rows[0]?.n)).toBe(1);
  });

  it('an empty set removes every owner (nobody holds g4)', async () => {
    const r = await set('acme', []);
    expect(r.ok && r.value.removed).toEqual(['bob', 'carol']);
    expect(await members('rm.acme.g4')).toEqual([]);
  });

  it('refuses an unknown or deleted principal and changes nothing', async () => {
    const before = await events();
    expect(errCode(await set('acme', ['bob', 'nobody']))).toBe('unknown_principal');
    expect(await events()).toBe(before);
  });

  it('refuses when the g4 slot is held by named principals', async () => {
    s.settings.set(settingsOf('named', { g4: ['alice'] }), 'T1');
    await reconcileProject(deps, { project_id: pid('named') });
    expect(errCode(await set('named', ['bob']))).toBe('refused');
  });

  it('refuses when the generated group does not exist yet, and when settings are unavailable', async () => {
    s.settings.set(settingsOf('fresh', {}), 'T1');
    expect(errCode(await set('fresh', ['bob']))).toBe('not_found');
    expect(errCode(await set('unknown-project', ['bob']))).toBe('unavailable');
    s.settings.set(settingsOf('flaky', {}), 'T1');
    await reconcileProject(deps, { project_id: pid('flaky') });
    s.settings.breakProject(pid('flaky'));
    expect(errCode(await set('flaky', ['bob']))).toBe('unavailable');
  });

  it('replaces a leftover role-map member: the group ends up holding exactly the set', async () => {
    await inIdentityTx(deps, (j) =>
      addMemberTx(
        deps,
        j,
        { group_id: 'rm.acme.g4', principal_id: 'dave', source: 'role_map' },
        'system.test',
        true,
      ),
    );
    const r = await set('acme', ['bob']);
    expect(r.ok && r.value).toMatchObject({ added: ['bob'], removed: ['dave'] });
    expect(await members('rm.acme.g4')).toEqual([{ id: 'bob', source: 'codeowners' }]);
  });

  it('source codeowners is for a g4 group only, and only for an internal caller', async () => {
    await createGroup(
      deps,
      { group_id: 'plain', display: 'plain', pim_managed: false, protected: false },
      'system.test',
    );
    const plain = await inIdentityTx(deps, (j) =>
      addMemberTx(
        deps,
        j,
        { group_id: 'plain', principal_id: 'bob', source: 'codeowners' },
        'system.test',
        true,
      ),
    );
    expect(errCode(plain)).toBe('invalid_input');
    const external = await addMember(
      deps,
      { group_id: 'rm.acme.g4', principal_id: 'carol', source: 'codeowners' },
      'system.test',
    );
    expect(errCode(external)).toBe('protected_group');
    const otherSlot = await inIdentityTx(deps, (j) =>
      addMemberTx(
        deps,
        j,
        { group_id: 'rm.acme.admin', principal_id: 'bob', source: 'codeowners' },
        'system.test',
        true,
      ),
    );
    expect(errCode(otherSlot)).toBe('invalid_input');
  });

  it('a reconcile does not touch code owner members of a codeowners slot', async () => {
    const before = await members('rm.acme.g4');
    await reconcileProject(deps, { project_id: pid('acme') });
    expect(await members('rm.acme.g4')).toEqual(before);
  });
});

describe('POST /v1/projects/:project/codeowners/members', () => {
  let app: FastifyInstance;
  let url: string;
  const TOKENS = { codehost: 'h'.repeat(32), core: 'c'.repeat(32) };
  beforeAll(async () => {
    app = createIdentityApp({
      pool: s.record.pool,
      auth: new ServiceAuth(TOKENS),
      callers: { codehost: ['read', 'codeowners'], core: ['read', 'write', 'reconcile'] },
      settings: s.settings,
      clock: s.clock,
    });
    url = await listen(app);
  });
  afterAll(async () => {
    await app.close();
  });

  const call = async (token: string | null, body: unknown) => {
    const res = await fetch(new URL('/v1/projects/acme/codeowners/members', url), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };

  it('needs the codeowners scope: a writer with every other scope is refused', async () => {
    expect((await call(null, { principals: [], source_ref: 'x' })).status).toBe(401);
    expect((await call(TOKENS.core, { principals: [], source_ref: 'x' })).status).toBe(403);
  });

  it('sets members for the codehost caller, and validates the body', async () => {
    const ok = await call(TOKENS.codehost, { principals: ['carol'], source_ref: 'acme/app@1' });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ members: ['carol'], group_id: 'rm.acme.g4' });
    expect((await call(TOKENS.codehost, { principals: ['carol'] })).status).toBe(400);
    expect((await call(TOKENS.codehost, { principals: ['x y'], source_ref: 's' })).status).toBe(
      400,
    );
    expect(
      (await call(TOKENS.codehost, { principals: [], source_ref: 's', extra: 1 })).status,
    ).toBe(400);
    expect((await call(TOKENS.codehost, { principals: ['ghost'], source_ref: 's' })).status).toBe(
      422,
    );
  });
});
