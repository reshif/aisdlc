import {
  migrateDirectory,
  directoryProjection,
  getPrincipal,
  getTeam,
  listPrincipals,
} from '@aisdlc/directory';
import { runProjection } from '@aisdlc/record';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGroup,
  createPrincipal,
  createTeam,
  identityProjection,
  setPrincipalStatus,
  updatePrincipal,
  updateTeam,
} from '../src/index.js';
import { pr, startIdentityStack, type IdentityStack } from '../src/testing.js';

// The directory (core's Principal and Team read models) folds the journal the identity service
// writes; this checks the two real sides together and that they agree with identity's own model.

let s: IdentityStack;
beforeAll(async () => {
  s = await startIdentityStack();
  await migrateDirectory(s.record.pool);
});
afterAll(async () => {
  await s.stop();
});

const A = 'system.test';

describe('directory over the identity service journal', () => {
  it('shows principals and teams as identity wrote them, and agrees with identity on who is active', async () => {
    for (const id of ['alice', 'bob', 'carol']) {
      await createPrincipal(
        s.deps,
        { principal_id: pr(id), kind: 'human', display_handle: id, display_name: `P ${id}` },
        A,
      );
    }
    await createPrincipal(
      s.deps,
      {
        principal_id: pr('svc.x'),
        kind: 'service',
        display_handle: 'svc.x',
        display_name: 'Service X',
      },
      A,
    );
    await updatePrincipal(s.deps, 'alice', { display_name: 'Alice Anders' }, A);
    await setPrincipalStatus(s.deps, 'bob', 'disabled', 'left', A);
    await createGroup(
      s.deps,
      { group_id: 'g-plat', display: 'Platform', pim_managed: false, protected: false },
      A,
    );
    await createTeam(
      s.deps,
      { team_id: 'platform', name: 'Platform', classification: 'internal', idp_group: null },
      A,
    );
    await updateTeam(s.deps, 'platform', { idp_group: 'g-plat' }, A);

    await runProjection(s.record.pool, directoryProjection);
    await runProjection(s.record.pool, identityProjection);
    expect(await getPrincipal(s.record.pool, 'alice')).toEqual({
      principal_id: 'alice',
      display_handle: 'alice',
      display_name: 'Alice Anders',
      kind: 'human',
      status: 'active',
    });
    expect((await listPrincipals(s.record.pool)).map((p) => p.principal_id)).toEqual([
      'alice',
      'carol',
      'svc.x',
    ]);
    expect(await getTeam(s.record.pool, 'platform')).toEqual({
      team_id: 'platform',
      name: 'Platform',
      classification: 'internal',
      idp_group: 'g-plat',
    });
    const idn = await s.record.pool.query<{
      principal_id: string;
      display_handle: string;
      display_name: string;
      status: string;
    }>(
      'SELECT principal_id, display_handle, display_name, status FROM identity.principal ORDER BY principal_id',
    );
    const dir = await s.record.pool.query<{
      principal_id: string;
      handle: string;
      display: string;
      status: string;
    }>(
      'SELECT principal_id, handle, display, status FROM directory.principal ORDER BY principal_id',
    );
    expect(dir.rows.map((r) => [r.principal_id, r.handle, r.display, r.status])).toEqual(
      idn.rows.map((r) => [r.principal_id, r.display_handle, r.display_name, r.status]),
    );
    await expectRebuildEqualsLive(s.record.pool, directoryProjection);
  });
});
