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
import {
  FakeIdentityProvider,
  FakeProjectSettings,
  type IdpSnapshot,
  type ProjectSettingsPort,
} from '@aisdlc/ports';
import { migrateRecord } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import { syncAccessLedger, type AccessSyncReport } from './access-sync.js';
import type { NewPrincipal } from './commands.js';
import {
  addMember,
  createBinding,
  createGroup,
  createPrincipal,
  linkIdentity,
  setPrincipalStatus,
} from './commands.js';
import { createIdentityApp, type IdentityScope } from './app.js';
import { reconcileProject } from './reconcile.js';
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

// ---------------------------------------------------------------- helpers for other services' tests

/** Links `idp_subject` identities (issuer, subject) to principals; throws on failure. */
export async function seedLinks(
  deps: IdentityDeps,
  links: ReadonlyArray<{ principal: string; issuer: string; subject: string }>,
): Promise<void> {
  for (const l of links) {
    const r = await linkIdentity(
      deps,
      { principal_id: l.principal, kind: 'idp_subject', issuer: l.issuer, value: l.subject },
      'system.test',
    );
    if (!r.ok) throw new Error(`link ${l.principal}: ${r.error.message}`);
  }
}

/** Disables (or re-enables) a principal; throws on failure. */
export async function setStatusForTest(
  deps: IdentityDeps,
  id: string,
  status: 'active' | 'disabled' | 'deleted',
): Promise<void> {
  const r = await setPrincipalStatus(deps, id, status, 'test', 'system.test');
  if (!r.ok) throw new Error(`status ${id}: ${r.error.message}`);
}

/** Gives a principal a role at the fleet (through a group named after the role); throws on failure. */
export async function grantFleetRole(
  deps: IdentityDeps,
  principal: string,
  role: 'factory.admin' | 'factory.auditor',
): Promise<void> {
  const group = `grp-${role}`;
  const g = await createGroup(
    deps,
    { group_id: group, display: role, pim_managed: false, protected: false },
    'system.test',
  );
  if (!g.ok && g.error.code !== 'already_exists') throw new Error(g.error.message);
  const m = await addMember(
    deps,
    { group_id: group as never, principal_id: pr(principal) },
    'system.test',
  );
  if (!m.ok) throw new Error(m.error.message);
  const b = await createBinding(
    deps,
    { group_id: group, role_id: role, scope: { kind: 'fleet', ref: '*' } },
    'system.test',
  );
  if (!b.ok) throw new Error(b.error.message);
}

/** Sets a project's role map in the fake settings and reconciles it into bindings; throws on failure. */
export async function bindProject(
  s: Pick<IdentityStack, 'deps' | 'settings'>,
  project: string,
  slots: Partial<Record<RoleSlot, readonly string[]>>,
): Promise<void> {
  s.settings.set(settingsOf(project, slots), 'T1');
  const r = await reconcileProject(
    { ...s.deps, settings: s.settings },
    { project_id: pid(project) },
  );
  if (!r.ok) throw new Error(`reconcile ${project}: ${r.error.message}`);
}

/** Links a GitHub login to a principal (`github_login`); throws on failure. */
export async function linkGithubLogin(
  deps: IdentityDeps,
  principal: string,
  login: string,
): Promise<void> {
  const r = await linkIdentity(
    deps,
    { principal_id: principal, kind: 'github_login', issuer: null, value: login },
    'system.test',
  );
  if (!r.ok) throw new Error(`link ${login}: ${r.error.message}`);
}

/** The identity HTTP API over a stack, on a loopback port, for tests of other services. */
export async function startTestIdentityApi(
  s: IdentityStack,
  callers: Record<string, { token: string; scopes: readonly IdentityScope[] }>,
  /**
   * Another source of project settings than the stack's fake (core's HTTP adapter, say); the stack's
   * IdP and ledger on request (`POST /v1/idp/sync` and the access-sync routes need them).
   */
  over: { settings?: ProjectSettingsPort; withIdp?: boolean; withLedger?: boolean } = {},
): Promise<{ url: string; stop(): Promise<void> }> {
  const app = createIdentityApp({
    pool: s.record.pool,
    auth: new ServiceAuth(
      Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.token])),
    ),
    callers: Object.fromEntries(Object.entries(callers).map(([n, c]) => [n, c.scopes])),
    settings: over.settings ?? s.settings,
    ...(over.withIdp ? { idp: s.idp } : {}),
    ...(over.withLedger ? { ledger: s.ledger } : {}),
    clock: s.clock,
  });
  const url = await listen(app);
  return { url, stop: () => app.close() };
}
