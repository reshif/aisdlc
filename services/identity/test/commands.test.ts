import { IDENTITY_EVENT, type Scope } from '@aisdlc/contracts';
import { runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createBinding,
  createGroup,
  createPrincipal,
  createTeam,
  grantQualification,
  identityProjection,
  linkIdentity,
  removeMember,
  resolveLink,
  revokeBinding,
  revokeQualification,
  setPrincipalStatus,
  unlinkIdentity,
  updatePrincipal,
  updateTeam,
} from '../src/index.js';
import { pr, startIdentityStack, type IdentityStack } from '../src/testing.js';

let s: IdentityStack;
beforeAll(async () => {
  s = await startIdentityStack();
});
afterAll(async () => {
  await s.stop();
});

const A = 'system.test';
const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const code = (r: { ok: boolean; error?: { code: string } }) => (r.ok ? 'ok' : r.error?.code);

async function events(stream: string) {
  const q = await s.record.pool.query<{ type: string }>(
    'SELECT type FROM record.record_event WHERE stream = $1 ORDER BY seq',
    [stream],
  );
  return q.rows.map((r) => r.type);
}

const person = (id: string, over: Record<string, unknown> = {}) => ({
  principal_id: pr(id),
  kind: 'human' as const,
  display_handle: id,
  display_name: `Person ${id}`,
  ...over,
});

describe('principals', () => {
  it('creates once, is idempotent, and journals one event', async () => {
    expect(must(await createPrincipal(s.deps, person('alice'), A)).changed).toBe(true);
    expect(must(await createPrincipal(s.deps, person('alice'), A)).changed).toBe(false);
    expect(await events('principal:alice')).toEqual([IDENTITY_EVENT.principal_created]);
    expect(code(await createPrincipal(s.deps, person('alice', { display_name: 'Other' }), A))).toBe(
      'already_exists',
    );
  });

  it('keeps display handles unique, without case', async () => {
    must(await createPrincipal(s.deps, person('bob'), A));
    const dup = await createPrincipal(s.deps, person('bob2', { display_handle: 'BOB' }), A);
    expect(code(dup)).toBe('already_exists');
    expect(await events('principal:bob2')).toEqual([]);
    must(await createPrincipal(s.deps, person('bob3'), A));
    expect(code(await updatePrincipal(s.deps, 'bob3', { display_handle: 'Bob' }, A))).toBe(
      'already_exists',
    );
  });

  it('refuses bad input: a service with an oid, an update with nothing, a bad actor', async () => {
    expect(
      code(
        await createPrincipal(s.deps, person('svc.x', { kind: 'service', entra_oid: 'oid' }), A),
      ),
    ).toBe('invalid_input');
    must(await createPrincipal(s.deps, person('carol'), A));
    expect(code(await updatePrincipal(s.deps, 'carol', {}, A))).toBe('invalid_input');
    expect(code(await createPrincipal(s.deps, person('dave'), 'not a principal!'))).toBe(
      'invalid_input',
    );
    expect(code(await updatePrincipal(s.deps, 'nobody', { display_name: 'x' }, A))).toBe(
      'not_found',
    );
  });

  it('updates only what changed', async () => {
    must(await createPrincipal(s.deps, person('erin'), A));
    expect(
      must(await updatePrincipal(s.deps, 'erin', { display_name: 'Person erin' }, A)).changed,
    ).toBe(false);
    expect(
      must(await updatePrincipal(s.deps, 'erin', { display_name: 'Erin E', role_label: 'lead' }, A))
        .changed,
    ).toBe(true);
    expect(await events('principal:erin')).toEqual([
      IDENTITY_EVENT.principal_created,
      IDENTITY_EVENT.principal_updated,
    ]);
  });

  it('status: disable, re-enable by a human, deleted is terminal', async () => {
    must(await createPrincipal(s.deps, person('frank'), A));
    expect(must(await setPrincipalStatus(s.deps, 'frank', 'disabled', 'left', A)).changed).toBe(
      true,
    );
    expect(must(await setPrincipalStatus(s.deps, 'frank', 'disabled', 'left', A)).changed).toBe(
      false,
    );
    expect(must(await setPrincipalStatus(s.deps, 'frank', 'active', 'back', A)).changed).toBe(true);
    must(await setPrincipalStatus(s.deps, 'frank', 'deleted', 'gdpr', A));
    expect(code(await setPrincipalStatus(s.deps, 'frank', 'active', 'oops', A))).toBe('refused');
    expect(code(await updatePrincipal(s.deps, 'frank', { display_name: 'F' }, A))).toBe('refused');
  });

  it('qualifications: grant, re-grant is idempotent, revoke', async () => {
    must(await createPrincipal(s.deps, person('gina'), A));
    const q = {
      principal_id: 'gina',
      qual_type: 'release-training',
      valid_from: '2026-11-01T00:00:00Z',
      valid_until: null,
      source: 'lms_import',
      evidence_ref: null,
    };
    expect(must(await grantQualification(s.deps, q, A)).changed).toBe(true);
    expect(must(await grantQualification(s.deps, q, A)).changed).toBe(false);
    expect(
      must(await revokeQualification(s.deps, 'gina', 'release-training', 'expired', A)).changed,
    ).toBe(true);
    expect(
      must(await revokeQualification(s.deps, 'gina', 'release-training', 'expired', A)).changed,
    ).toBe(false);
    expect(code(await grantQualification(s.deps, { ...q, principal_id: 'ghost' }, A))).toBe(
      'not_found',
    );
  });
});

describe('identity links', () => {
  it('links an external identity to one principal at a time', async () => {
    await createPrincipal(s.deps, person('hank'), A);
    await createPrincipal(s.deps, person('iris'), A);
    const link = { principal_id: 'hank', kind: 'idp_subject', issuer: 'idp', value: 'Sub-1' };
    expect(must(await linkIdentity(s.deps, link, A)).changed).toBe(true);
    expect(must(await linkIdentity(s.deps, link, A)).changed).toBe(false);
    expect(code(await linkIdentity(s.deps, { ...link, principal_id: 'iris' }, A))).toBe(
      'already_exists',
    );
    // Logins compare without case.
    const gh = { principal_id: 'hank', kind: 'github_login', issuer: null, value: 'HankGH' };
    must(await linkIdentity(s.deps, gh, A));
    expect(
      code(await linkIdentity(s.deps, { ...gh, principal_id: 'iris', value: 'hankgh' }, A)),
    ).toBe('already_exists');
    expect(
      must(
        await unlinkIdentity(
          s.deps,
          { kind: 'idp_subject', issuer: 'idp', value: 'Sub-1' },
          'moved',
          A,
        ),
      ).changed,
    ).toBe(true);
    must(await linkIdentity(s.deps, { ...link, principal_id: 'iris' }, A));
    await runProjection(s.record.pool, identityProjection);
    const found = await resolveLink(s.record.pool, {
      kind: 'idp_subject',
      issuer: 'idp',
      value: 'Sub-1',
    });
    expect(found?.principal_id).toBe('iris');
    const gh2 = await resolveLink(s.record.pool, {
      kind: 'github_login',
      issuer: null,
      value: 'HANKGH',
    });
    expect(gh2?.principal_id).toBe('hank');
  });
});

describe('groups, memberships, bindings', () => {
  const scope: Scope = { kind: 'project', ref: 'acme' };

  it('adds and removes members idempotently; unknown principals and groups are refused', async () => {
    await createPrincipal(s.deps, person('jo'), A);
    must(
      await createGroup(
        s.deps,
        { group_id: 'eng', display: 'Engineering', pim_managed: false, protected: false },
        A,
      ),
    );
    expect(must(await addMember(s.deps, { group_id: 'eng', principal_id: 'jo' }, A)).changed).toBe(
      true,
    );
    expect(code(await addMember(s.deps, { group_id: 'eng', principal_id: 'ghost' }, A))).toBe(
      'unknown_principal',
    );
    expect(code(await addMember(s.deps, { group_id: 'nope', principal_id: 'jo' }, A))).toBe(
      'not_found',
    );
    expect(must(await removeMember(s.deps, 'eng', 'jo', 'left', A)).changed).toBe(true);
    expect(must(await removeMember(s.deps, 'eng', 'jo', 'left', A)).changed).toBe(false);
  });

  it('generated groups and slot bindings change only through the role map', async () => {
    expect(
      code(
        await createGroup(
          s.deps,
          { group_id: 'rm.acme.admin', display: 'x', pim_managed: false, protected: true },
          A,
        ),
      ),
    ).toBe('protected_group');
    await createGroup(
      s.deps,
      { group_id: 'viewers', display: 'Viewers', pim_managed: false, protected: false },
      A,
    );
    expect(
      code(
        await createBinding(s.deps, { group_id: 'viewers', role_id: 'project.admin', scope }, A),
      ),
    ).toBe('generated_only');
    expect(
      code(
        await createBinding(
          s.deps,
          {
            group_id: 'viewers',
            role_id: 'project.kill_holder',
            scope: { kind: 'lane', ref: 'acme/L4' },
          },
          A,
        ),
      ),
    ).toBe('generated_only');
    expect(
      code(
        await createBinding(
          s.deps,
          { group_id: 'viewers', role_id: 'project.admin', scope: { kind: 'fleet', ref: '*' } },
          A,
        ),
      ),
    ).toBe('invalid_input'); // project.admin is not a fleet role
    expect(
      code(await createBinding(s.deps, { group_id: 'viewers', role_id: 'nonsense', scope }, A)),
    ).toBe('invalid_input');
    expect(
      code(
        await createBinding(
          s.deps,
          {
            group_id: 'viewers',
            role_id: 'project.viewer',
            scope,
            constraints: { origin: 'role_map' },
          },
          A,
        ),
      ),
    ).toBe('invalid_input');
  });

  it('binds a group to a non-slot role: idempotent by (group, role, scope), revocable, then re-bindable', async () => {
    const input = { group_id: 'viewers', role_id: 'project.viewer', scope };
    const first = must(await createBinding(s.deps, input, A));
    expect(first.changed).toBe(true);
    expect(must(await createBinding(s.deps, input, A))).toEqual({
      changed: false,
      binding_id: first.binding_id,
    });
    expect(must(await revokeBinding(s.deps, first.binding_id, 'not needed', A)).changed).toBe(true);
    expect(must(await revokeBinding(s.deps, first.binding_id, 'not needed', A)).changed).toBe(
      false,
    );
    expect(must(await createBinding(s.deps, input, A)).changed).toBe(true);
    expect(await events(`binding:${first.binding_id}`)).toEqual([
      IDENTITY_EVENT.binding_created,
      IDENTITY_EVENT.binding_revoked,
      IDENTITY_EVENT.binding_created,
    ]);
    expect(code(await createBinding(s.deps, { ...input, expiry: '2020-01-01T00:00:00Z' }, A))).toBe(
      'invalid_input',
    );
  });
});

describe('teams', () => {
  it('a team is factory-owned with an optional IdP group mapping', async () => {
    const t = {
      team_id: 'platform',
      name: 'Platform',
      classification: 'internal',
      idp_group: null,
    };
    expect(must(await createTeam(s.deps, t, A)).changed).toBe(true);
    expect(must(await createTeam(s.deps, t, A)).changed).toBe(false);
    expect(code(await updateTeam(s.deps, 'platform', { idp_group: 'missing' }, A))).toBe(
      'not_found',
    );
    await createGroup(
      s.deps,
      { group_id: 'g-platform', display: 'Platform', pim_managed: false, protected: false },
      A,
    );
    expect(
      must(
        await updateTeam(s.deps, 'platform', { idp_group: 'g-platform', name: 'Platform team' }, A),
      ).changed,
    ).toBe(true);
    expect(code(await updateTeam(s.deps, 'nope', { name: 'x' }, A))).toBe('not_found');
  });
});

describe('the read model', () => {
  it('rebuild equals live', async () => {
    const snap = await expectRebuildEqualsLive(s.record.pool, identityProjection);
    expect(snap.principals.length).toBeGreaterThan(5);
    expect(snap.teams).toHaveLength(1);
    expect(snap.links.length).toBeGreaterThan(0);
  });
});
