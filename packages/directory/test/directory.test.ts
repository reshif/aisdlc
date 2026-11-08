import {
  IDENTITY_EVENT,
  groupStream,
  principalStream,
  teamStream,
  type Principal,
  type Team,
} from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { withTransaction } from '@aisdlc/db';
import { manualClock } from '@aisdlc/kernel';
import { appendEvents, migrateRecord, runProjection, type NewEvent } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  directoryProjection,
  findPrincipalByHandle,
  getPrincipal,
  getPrincipals,
  getTeam,
  listPrincipals,
  listTeams,
  migrateDirectory,
  teamByIdpGroup,
} from '../src/index.js';

let db: TestDatabase;
const clock = manualClock('2026-11-09T10:00:00.000Z');

beforeAll(async () => {
  db = await createTestDatabase();
  await migrateRecord(db.pool);
  await migrateDirectory(db.pool);
});
afterAll(async () => {
  await db.drop();
});

/** Appends to a stream at its head, as the identity service does (the payload shapes are the contracts'). */
async function append(
  stream: string,
  type: string,
  body: object,
  actor = 'system.test',
): Promise<void> {
  await withTransaction(db.pool, async (tx) => {
    const head = await tx.query<{ seq: string }>(
      'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
      [stream],
    );
    const e: NewEvent = { type, body: body as Record<string, unknown>, actor };
    const r = await appendEvents(tx, stream, Number(head.rows[0]?.seq), [e], { clock });
    if (!r.ok) throw new Error(JSON.stringify(r.error));
  });
}

const principal = (id: string, over: Partial<Principal> = {}): Principal => ({
  principal_id: id as never,
  kind: 'human',
  status: 'active',
  entra_oid: null,
  upn: null,
  logins: [],
  machine_actions: [],
  breakglass: false,
  display_handle: id,
  display_name: `Person ${id}`,
  role_label: null,
  status_changed_at: '2026-11-09T10:00:00.000Z',
  ...over,
});
const team = (id: string, over: Partial<Team> = {}): Team => ({
  team_id: id as never,
  name: id,
  classification: 'internal',
  idp_group: null,
  ...over,
});

describe('Principal read model', () => {
  it('folds created, updated and status events; holds only what a lookup needs', async () => {
    await append(principalStream('alice'), IDENTITY_EVENT.principal_created, principal('alice'));
    await append(principalStream('bob'), IDENTITY_EVENT.principal_created, principal('bob'));
    await append(
      principalStream('svc.runner'),
      IDENTITY_EVENT.principal_created,
      principal('svc.runner', { kind: 'service', display_name: 'Runner' }),
    );
    await append(
      principalStream('zed'),
      IDENTITY_EVENT.principal_created,
      principal('zed', { display_handle: 'Zed_100%' }),
    );
    await runProjection(db.pool, directoryProjection);
    expect(await getPrincipal(db.pool, 'alice')).toEqual({
      principal_id: 'alice',
      display_handle: 'alice',
      display_name: 'Person alice',
      kind: 'human',
      status: 'active',
    });
    await append(principalStream('alice'), IDENTITY_EVENT.principal_updated, {
      display_name: 'Alice A.',
      display_handle: 'alice.a',
      upn: 'a@x.test',
    });
    await append(principalStream('bob'), IDENTITY_EVENT.principal_status_changed, {
      status: 'disabled',
      reason: 'left',
    });
    await runProjection(db.pool, directoryProjection);
    expect(await getPrincipal(db.pool, 'alice')).toMatchObject({
      display_handle: 'alice.a',
      display_name: 'Alice A.',
    });
    expect(await getPrincipal(db.pool, 'bob')).toMatchObject({ status: 'disabled' });
    expect(await getPrincipal(db.pool, 'nobody')).toBeNull();
  });

  it('finds by handle without case, resolves many ids at once, and omits the unknown', async () => {
    expect((await findPrincipalByHandle(db.pool, 'ALICE.A'))?.principal_id).toBe('alice');
    expect(await findPrincipalByHandle(db.pool, 'alice')).toBeNull(); // the old handle is gone
    const m = await getPrincipals(db.pool, ['alice', 'svc.runner', 'ghost']);
    expect([...m.keys()].sort()).toEqual(['alice', 'svc.runner']);
    expect((await getPrincipals(db.pool, [])).size).toBe(0);
  });

  it('lists for a picker: active by default, by kind, by status, by prefix (LIKE characters are literal)', async () => {
    expect((await listPrincipals(db.pool)).map((p) => p.principal_id)).toEqual([
      'alice',
      'svc.runner',
      'zed',
    ]);
    expect((await listPrincipals(db.pool, { kind: 'service' })).map((p) => p.principal_id)).toEqual(
      ['svc.runner'],
    );
    expect(
      (await listPrincipals(db.pool, { status: 'disabled' })).map((p) => p.principal_id),
    ).toEqual(['bob']);
    expect((await listPrincipals(db.pool, { q: 'PERSON' })).map((p) => p.principal_id)).toEqual([
      'zed',
    ]);
    expect((await listPrincipals(db.pool, { q: 'zed_100%' })).map((p) => p.principal_id)).toEqual([
      'zed',
    ]);
    expect(await listPrincipals(db.pool, { q: '%' })).toEqual([]);
    expect(await listPrincipals(db.pool, { q: '_' })).toEqual([]);
    expect(await listPrincipals(db.pool, { limit: 1 })).toHaveLength(1);
  });
});

describe('Team read model', () => {
  it('folds created and updated; maps an optional IdP group', async () => {
    await append(teamStream('platform'), IDENTITY_EVENT.team_created, team('platform'));
    await append(
      teamStream('data'),
      IDENTITY_EVENT.team_created,
      team('data', { name: 'Data', classification: 'confidential', idp_group: 'g-data' as never }),
    );
    await runProjection(db.pool, directoryProjection);
    expect(await getTeam(db.pool, 'platform')).toEqual(team('platform'));
    await append(teamStream('platform'), IDENTITY_EVENT.team_updated, {
      name: 'Platform team',
      idp_group: 'g-platform',
    });
    await append(teamStream('data'), IDENTITY_EVENT.team_updated, { idp_group: null });
    await runProjection(db.pool, directoryProjection);
    expect(await getTeam(db.pool, 'platform')).toEqual(
      team('platform', { name: 'Platform team', idp_group: 'g-platform' as never }),
    );
    expect(await getTeam(db.pool, 'data')).toMatchObject({
      idp_group: null,
      classification: 'confidential',
    });
    expect((await listTeams(db.pool)).map((t) => t.team_id)).toEqual(['data', 'platform']);
    expect((await teamByIdpGroup(db.pool, 'g-platform'))?.team_id).toBe('platform');
    expect(await teamByIdpGroup(db.pool, 'g-data')).toBeNull();
    expect(await getTeam(db.pool, 'nope')).toBeNull();
  });
});

describe('the directory is rebuildable', () => {
  it('ignores streams that are not principals or teams, and rebuild equals live', async () => {
    await append(groupStream('g1'), IDENTITY_EVENT.group_created, {
      group_id: 'g1',
      display: 'G',
      pim_managed: false,
      protected: false,
    });
    await append('gate:018f3c1e-7b2a-7c3d-8e4f-0123456789ab', 'gate.opened', { not: 'identity' });
    await append(principalStream('carol'), IDENTITY_EVENT.principal_created, principal('carol'));
    const snap = await expectRebuildEqualsLive(db.pool, directoryProjection);
    expect(snap.principals).toHaveLength(5);
    expect(snap.teams).toHaveLength(2);
  });
});
