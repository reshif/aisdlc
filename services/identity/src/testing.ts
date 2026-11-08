import {
  PrincipalId,
  ProjectId,
  ProjectSettings,
  RoleSlotValues,
  type RoleSlot,
  type Tier,
} from '@aisdlc/contracts';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { migrateDecisions } from '@aisdlc/decisions';
import { manualClock, type Jwk, type ManualClock } from '@aisdlc/kernel';
import { startTestKms, type TestKms } from '@aisdlc/kms-local/testing';
import { migrateLedger, type LedgerClientDeps } from '@aisdlc/ledger';
import { startTestNotary, type TestNotary } from '@aisdlc/notary/testing';
import { FakeIdentityProvider, FakeProjectSettings, type IdpSnapshot } from '@aisdlc/ports';
import { migrateRecord } from '@aisdlc/record';
import { syncAccessLedger, type AccessSyncReport } from './access-sync.js';
import type { NewPrincipal } from './commands.js';
import { createPrincipal } from './commands.js';
import { migrateIdentity } from './migrations.js';
import type { IdentityDeps } from './tx.js';

// A real identity stack for tests: one Postgres with the record, ledger, decisions and identity
// schemas, a real kms-local and a real Notary over HTTP, and the fakes behind the ports.

export const T_START = '2026-11-09T10:00:00.000Z';

export interface IdentityStack {
  readonly record: TestDatabase;
  readonly clock: ManualClock;
  readonly kms: TestKms;
  readonly notary: TestNotary;
  readonly ledger: LedgerClientDeps;
  readonly keys: { notary: Jwk; witness: Jwk };
  readonly deps: IdentityDeps & { readonly clock: ManualClock };
  readonly settings: FakeProjectSettings;
  readonly idp: FakeIdentityProvider;
  /** One pass of the access-sync loop; throws if it fails. */
  sync(): Promise<AccessSyncReport>;
  stop(): Promise<void>;
}

export const EMPTY_IDP: IdpSnapshot = { issuer: 'local-test', groups: [], subjects: [] };

export async function startIdentityStack(): Promise<IdentityStack> {
  const kms = await startTestKms();
  const stoppers: Array<() => Promise<void>> = [() => kms.stop()];
  try {
    const record = await createTestDatabase();
    stoppers.push(() => record.drop());
    await migrateRecord(record.pool);
    await migrateLedger(record.pool);
    await migrateDecisions(record.pool);
    await migrateIdentity(record.pool);
    const clock = manualClock(T_START);
    const notary = await startTestNotary({ custody: kms.custodyFor('notary'), clock });
    stoppers.push(() => notary.stop());
    const key = async (id: string): Promise<Jwk> => {
      const k = await kms.custodyFor('witness').publicKey(id);
      if (!k.ok) throw new Error(k.error.message);
      return k.value;
    };
    const keys = { notary: await key('dev:notary'), witness: await key('dev:witness') };
    const ledger: LedgerClientDeps = { notary: notary.clientFor('core'), notaryKey: keys.notary };
    return {
      record,
      clock,
      kms,
      notary,
      ledger,
      keys,
      deps: { pool: record.pool, clock },
      settings: new FakeProjectSettings(),
      idp: new FakeIdentityProvider(EMPTY_IDP),
      async sync() {
        const r = await syncAccessLedger({ pool: record.pool, ledger, clock });
        if (!r.ok) throw new Error(`access sync: [${r.error.code}] ${r.error.message}`);
        return r.value;
      },
      async stop() {
        for (const s of stoppers.reverse()) await s();
      },
    };
  } catch (e) {
    for (const s of stoppers.reverse()) await s().catch(() => undefined);
    throw e;
  }
}

export const pr = (s: string): PrincipalId => PrincipalId.parse(s);
export const pid = (s: string): ProjectId => ProjectId.parse(s);

/** Creates human principals `id` with handle `id` and name `Person <id>`; throws on failure. */
export async function seedPrincipals(
  deps: IdentityDeps,
  ids: readonly string[],
  over: Partial<NewPrincipal> = {},
): Promise<void> {
  for (const id of ids) {
    const r = await createPrincipal(
      deps,
      {
        principal_id: pr(id),
        kind: 'human',
        display_handle: id,
        display_name: `Person ${id}`,
        ...over,
      },
      'system.test',
    );
    if (!r.ok) throw new Error(`seed ${id}: ${r.error.message}`);
  }
}

/** Project settings with the given slot holders (unlisted slots empty, `g4` code owners by default). */
export function settingsOf(
  project: string,
  slots: Partial<Record<RoleSlot, readonly string[] | 'codeowners'>>,
  over: {
    two_person?: boolean;
    locked?: boolean;
    delegations?: ProjectSettings['kill_delegations'];
  } = {},
): ProjectSettings {
  const roleMap = Object.fromEntries(
    RoleSlotValues.map((slot) => {
      const v = slots[slot];
      return [
        slot,
        v === 'codeowners' || (v === undefined && slot === 'g4')
          ? { kind: 'codeowners' }
          : { kind: 'principals', principals: [...(v ?? [])] },
      ];
    }),
  );
  return ProjectSettings.parse({
    project_id: project,
    role_map: roleMap,
    two_person: {
      enabled: over.locked === true ? true : (over.two_person ?? true),
      default: 'on_if_2plus',
      locked_on: over.locked ?? false,
    },
    gating_profile: {
      gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: 'auto',
      tier_floor_applied: true,
    },
    kill_delegations: over.delegations ?? [],
    version: 1,
    updated_at: T_START,
  });
}

export type { Tier };
