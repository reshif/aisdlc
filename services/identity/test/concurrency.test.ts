import { SeedIdentityProvider } from '@aisdlc/ports';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  accessSyncLagSeconds,
  addMember,
  createGroup,
  createPrincipal,
  identityProjection,
  reconcileProject,
  syncAccessLedger,
  syncFromIdp,
  updatePrincipal,
} from '../src/index.js';
import {
  pid,
  pr,
  seedPrincipals,
  settingsOf,
  startIdentityStack,
  type IdentityStack,
} from '../src/testing.js';

// Writers of different shapes at once: single-aggregate commands, the role map reconcile, the IdP
// sync and the access-sync loop. None may deadlock or fail; the journal must stay consistent and
// every access event must end up with exactly one ledger entry.

let s: IdentityStack;
beforeAll(async () => {
  s = await startIdentityStack();
  await seedPrincipals(s.deps, ['alice', 'bob', 'carol']);
});
afterAll(async () => {
  await s.stop();
});

describe('identity writers run concurrently', () => {
  it('commands, reconcile, IdP sync and access sync together: no errors, one entry per event', async () => {
    s.settings.set(settingsOf('acme', { admin: ['alice'], intent: ['bob', 'carol'] }), 'T1');
    const idp = SeedIdentityProvider.fromFile(
      join(import.meta.dirname, '..', 'fixtures', 'seed.json'),
    );
    await createGroup(
      s.deps,
      { group_id: 'eng', display: 'Eng', pim_managed: false, protected: false },
      'system.test',
    );
    const ledgerDeps = { pool: s.record.pool, ledger: s.ledger, clock: s.clock };
    const jobs: Array<Promise<{ ok: boolean; error?: unknown }>> = [];
    for (let round = 0; round < 3; round++) {
      jobs.push(syncFromIdp({ ...s.deps, idp }));
      jobs.push(reconcileProject({ ...s.deps, settings: s.settings }, { project_id: pid('acme') }));
      jobs.push(syncAccessLedger(ledgerDeps));
      for (const who of ['alice', 'bob', 'carol']) {
        jobs.push(addMember(s.deps, { group_id: 'eng', principal_id: who }, 'system.test'));
        jobs.push(updatePrincipal(s.deps, who, { role_label: `r${round}` }, 'system.test'));
      }
      jobs.push(
        createPrincipal(
          s.deps,
          {
            principal_id: pr(`n${round}`),
            kind: 'human',
            display_handle: `n${round}`,
            display_name: `N ${round}`,
          },
          'system.test',
        ),
      );
    }
    const results = await Promise.all(jobs);
    const failed = results.filter((r) => !r.ok);
    expect(failed).toEqual([]);

    await s.sync();
    expect(await accessSyncLagSeconds(s.record.pool, s.clock)).toBe(0);
    const events = Number(
      (
        await s.record.pool.query<{ n: string }>(
          `SELECT count(*)::text AS n FROM record.record_event
            WHERE type IN ('group.member_added','group.member_removed','binding.created','binding.updated','binding.revoked','principal.status_changed')`,
        )
      ).rows[0]?.n,
    );
    const entries = await s.record.pool.query<{ n: string; d: string }>(
      `SELECT count(*)::text AS n, count(DISTINCT body ->> 'access_event_id')::text AS d
         FROM ledger.ledger_entry WHERE entry_type LIKE 'access.%'`,
    );
    expect(Number(entries.rows[0]?.n)).toBe(events);
    expect(entries.rows[0]?.d).toBe(entries.rows[0]?.n);
    await expectRebuildEqualsLive(s.record.pool, identityProjection);
  });
});
