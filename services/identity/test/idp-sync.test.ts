import { join } from 'node:path';
import { GroupId } from '@aisdlc/contracts';
import { SeedIdentityProvider, type IdpSnapshot } from '@aisdlc/ports';
import { runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  addMember,
  createGroup,
  createPrincipal,
  identityProjection,
  resolveLink,
  setPrincipalStatus,
  syncFromIdp,
  type IdpSyncDeps,
} from '../src/index.js';
import { pr, startIdentityStack, type IdentityStack } from '../src/testing.js';

let s: IdentityStack;
let seed: SeedIdentityProvider;
let deps: IdpSyncDeps;
const SEED = join(import.meta.dirname, '..', 'fixtures', 'seed.json');

beforeAll(async () => {
  s = await startIdentityStack();
  seed = SeedIdentityProvider.fromFile(SEED);
  deps = { ...s.deps, idp: seed };
});
afterAll(async () => {
  await s.stop();
});

const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const members = async (group: string): Promise<string[]> => {
  await runProjection(s.record.pool, identityProjection);
  const q = await s.record.pool.query<{ principal_id: string }>(
    'SELECT principal_id FROM identity.membership WHERE group_id = $1 ORDER BY 1',
    [group],
  );
  return q.rows.map((r) => r.principal_id);
};
const status = async (id: string): Promise<string | undefined> => {
  await runProjection(s.record.pool, identityProjection);
  return (
    await s.record.pool.query<{ status: string }>(
      'SELECT status FROM identity.principal WHERE principal_id = $1',
      [id],
    )
  ).rows[0]?.status;
};

describe('the local seed identity provider (fixture file)', () => {
  it('reads the repo fixture: groups, subjects, resolution of one subject, an unknown subject, a wrong issuer', async () => {
    const snap = must(await seed.syncGroups());
    expect(snap.issuer).toBe('local-dev');
    expect(snap.groups.map((g) => g.group_id)).toEqual([
      'grp-engineering',
      'grp-operations',
      'grp-release-managers',
    ]);
    const one = must(await seed.resolveSubject({ issuer: 'local-dev', subject: 'svc-runner' }));
    expect(one).toMatchObject({ principal_id: 'svc.runner', kind: 'service' });
    expect(must(await seed.resolveSubject({ issuer: 'local-dev', subject: 'nobody' }))).toBeNull();
    expect(must(await seed.resolveSubject({ issuer: 'other', subject: 'svc-runner' }))).toBeNull();
  });
});

describe('syncFromIdp', () => {
  it('creates principals, links, groups and memberships from the seed', async () => {
    const r = must(await syncFromIdp(deps));
    expect(r).toMatchObject({
      principals_created: 5,
      links_created: 5,
      groups_created: 3,
      members_added: 6,
      principals_disabled: 1,
      skipped: [],
    });
    expect(await members('grp-engineering')).toEqual(['alice', 'bob']);
    expect(await members('grp-release-managers')).toEqual(['alice', 'carol']);
    expect(await status('dave')).toBe('disabled'); // disabled at the IdP
    const p = await resolveLink(s.record.pool, {
      kind: 'idp_subject',
      issuer: 'local-dev',
      value: '00000000-0000-4000-8000-000000000001',
    });
    expect(p?.principal_id).toBe('alice');
    const svc = await s.record.pool.query<{ kind: string; entra_oid: string | null }>(
      "SELECT kind, entra_oid FROM identity.principal WHERE principal_id = 'svc.runner'",
    );
    expect(svc.rows[0]).toEqual({ kind: 'service', entra_oid: null });
  });

  it('a pim-managed group records membership via pim_activation', async () => {
    const q = await s.record.pool.query<{ via: string; source: string }>(
      "SELECT via, source FROM identity.membership WHERE group_id = 'grp-release-managers' AND principal_id = 'alice'",
    );
    expect(q.rows[0]).toEqual({ via: 'pim_activation', source: 'sync' });
  });

  it('is idempotent', async () => {
    const r = must(await syncFromIdp(deps));
    expect(r.events).toBe(0);
  });

  it('an unreachable or invalid IdP changes nothing', async () => {
    const before = Number(
      (
        await s.record.pool.query<{ n: string }>(
          'SELECT count(*)::text AS n FROM record.record_event',
        )
      ).rows[0]?.n,
    );
    const bad = SeedIdentityProvider.fromText('{ not json');
    const r = await syncFromIdp({ ...s.deps, idp: bad });
    expect(!r.ok && r.error.code).toBe('unavailable');
    const invalid = await syncFromIdp({
      ...s.deps,
      idp: SeedIdentityProvider.fromText('{"issuer":"x","groups":[],"subjects":[{"nope":1}]}'),
    });
    expect(!invalid.ok && invalid.error.code).toBe('unavailable');
    const down = await syncFromIdp({
      ...s.deps,
      idp: {
        syncGroups: async () => s.idp.fail().syncGroups(),
        resolveSubject: async () => ({ ok: true as const, value: null }),
      },
    });
    expect(!down.ok && down.error.code).toBe('unavailable');
    s.idp.heal();
    expect(
      Number(
        (
          await s.record.pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM record.record_event',
          )
        ).rows[0]?.n,
      ),
    ).toBe(before);
  });

  it('follows the IdP: a left group removes the sync membership only, a removed subject is disabled', async () => {
    const snap = must(await seed.syncGroups());
    // The factory's own membership (not from the sync) in the same group must survive.
    await createGroup(
      s.deps,
      { group_id: 'manual', display: 'Manual', pim_managed: false, protected: false },
      'system.test',
    );
    must(
      await addMember(
        s.deps,
        { group_id: 'grp-engineering', principal_id: 'carol' },
        'system.test',
      ),
    );
    const next: IdpSnapshot = {
      ...snap,
      subjects: snap.subjects
        .filter((x) => x.principal_id !== 'bob')
        .map((x) =>
          x.principal_id === 'alice'
            ? { ...x, groups: [GroupId.parse('grp-release-managers')] }
            : x,
        ),
    };
    s.idp.set(next);
    const r = must(await syncFromIdp({ ...s.deps, idp: s.idp }));
    expect(r.principals_disabled).toBe(1); // bob left the IdP
    expect(await status('bob')).toBe('disabled');
    expect(await members('grp-engineering')).toEqual(['carol']); // alice and bob out; carol's manual one stays
    expect(await members('grp-release-managers')).toEqual(['alice', 'carol']);
  });

  it('never re-enables: loosening needs a human', async () => {
    s.idp.set(must(await seed.syncGroups())); // bob is back, active, at the IdP
    must(await syncFromIdp({ ...s.deps, idp: s.idp }));
    expect(await status('bob')).toBe('disabled');
    must(await setPrincipalStatus(s.deps, 'bob', 'active', 'rehired', 'system.test'));
    expect(await status('bob')).toBe('active');
  });

  it('skips a subject whose link or handle belongs to someone else, and syncs the rest', async () => {
    await createPrincipal(
      s.deps,
      {
        principal_id: pr('mallory'),
        kind: 'human',
        display_handle: 'erin',
        display_name: 'Squatter',
      },
      'system.test',
    );
    const snap = must(await seed.syncGroups());
    s.idp.set({
      ...snap,
      subjects: [
        ...snap.subjects,
        {
          issuer: 'local-dev',
          subject: 'sub-erin',
          principal_id: pr('erin'),
          kind: 'human',
          status: 'active',
          upn: null,
          display_handle: 'erin',
          display_name: 'Erin',
          logins: [],
          groups: [GroupId.parse('grp-engineering')],
        },
      ],
    });
    const r = must(await syncFromIdp({ ...s.deps, idp: s.idp }));
    expect(r.skipped).toEqual([
      { subject: 'sub-erin', reason: expect.stringContaining('belongs to mallory') },
    ]);
    expect(await members('grp-engineering')).not.toContain('erin');
  });

  it('refuses to create generated groups', async () => {
    const snap = must(await seed.syncGroups());
    s.idp.set({
      ...snap,
      groups: [
        ...snap.groups,
        { group_id: 'rm.evil.admin' as never, display: 'x', pim_managed: false, protected: true },
      ],
    });
    const r = must(await syncFromIdp({ ...s.deps, idp: s.idp }));
    expect(r.skipped.some((x) => x.subject === 'rm.evil.admin')).toBe(true);
    const g = await s.record.pool.query(
      "SELECT 1 FROM record.record_event WHERE stream = 'group:rm.evil.admin'",
    );
    expect(g.rows).toHaveLength(0);
  });

  it('rebuild equals live', async () => {
    await expectRebuildEqualsLive(s.record.pool, identityProjection);
  });
});
