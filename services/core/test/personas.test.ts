import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DEV_IDP_BASE_USERS,
  PERSONAS,
  PERSONA_GROUPS,
  PERSONA_PROJECTS,
  personaRoleMap,
} from '@aisdlc/bff/dev-oidc';
import { signInSubject, startBffStack, type BffStack } from '@aisdlc/bff/testing';
import { ROLE_CATALOGUE, roleForSlot, type Scope } from '@aisdlc/contracts';
import { bindProject, startTestIdentityApi } from '@aisdlc/identity/testing';
import { IdpSnapshot } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { seedIdentity } from '../src/seed.js';

// The design personas on the dev IdP and the local seed (portal-coverage §1; prototype `access.js`). The compose
// files are the source the stack reads: `dev-oidc-users.json` (who can sign in) and `idp-seed.json` (who they are and
// their groups). Here a real dev IdP serves exactly those users, identity syncs exactly that IdP seed (its issuer set
// to the test IdP's), the seed's identity step runs (twice: it is idempotent), the design projects' role maps are
// published through identity's reconcile, and then every persona, alice and bob sign in through the whole OIDC dance
// and `/api/me/access` shows the bindings the design gives them. Real Postgres throughout.

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies are checked field by field
type Json = any;

const CONFIG = join(import.meta.dirname, '..', '..', '..', 'platform', 'compose', 'config');
const users = JSON.parse(readFileSync(join(CONFIG, 'dev-oidc-users.json'), 'utf8')) as Array<{
  subject: string;
  name: string;
  email: string;
}>;
const idpSeed = IdpSnapshot.parse(JSON.parse(readFileSync(join(CONFIG, 'idp-seed.json'), 'utf8')));
const tok = 'seed-identity-token'.padEnd(32, 'x');

/** The design's bindings of a persona as `role@kind:ref`, from the groups and the role maps. */
function expectedOf(principal: string): string[] {
  const key = (role: string, s: Scope) => `${role}@${s.kind}:${s.ref}`;
  const out = PERSONA_GROUPS.filter((g) => g.members.includes(principal)).map((g) =>
    key(g.role, g.scope),
  );
  const persona = PERSONAS.find((p) => p.principal_id === principal);
  for (const [project, slots] of Object.entries(persona?.slots ?? {})) {
    for (const slot of slots ?? []) {
      out.push(key(roleForSlot(slot), { kind: 'project', ref: project }));
    }
  }
  return out.sort();
}

let s: BffStack;
let identity: Awaited<ReturnType<typeof startTestIdentityApi>>;
const logs: string[] = [];

beforeAll(async () => {
  s = await startBffStack({ devUsers: users });
  // the compose IdP seed, issued by this test's dev IdP
  const iss = s.oidc.issuer;
  s.identity.idp.set({
    ...idpSeed,
    issuer: iss,
    subjects: idpSeed.subjects.map((x) => ({ ...x, issuer: iss })),
  });
  identity = await startTestIdentityApi(
    s.identity,
    { seed: { token: tok, scopes: ['read', 'write', 'sync'] } },
    { withIdp: true },
  );
  const cfg = {
    admin: 'alice' as never,
    group: 'grp-factory-admins',
    identityUrl: identity.url,
    identityToken: tok,
    personas: true,
  };
  const now = () => s.identity.clock.now();
  await seedIdentity(cfg, (l) => logs.push(l), now);
  await seedIdentity(cfg, (l) => logs.push(l), now);
  // the design projects' role maps, published (the fake settings) and reconciled by identity
  for (const project of PERSONA_PROJECTS) {
    await bindProject(s.identity, project, personaRoleMap(project));
  }
}, 120_000);

afterAll(async () => {
  await identity?.stop();
  await s?.stop();
}, 120_000);

/** One sign-in per subject for the whole file (each is the full OIDC dance), then its `/api/me` and access. */
const signedIn = new Map<string, Promise<{ me: Json; access: Json }>>();
function meOf(subject: string): Promise<{ me: Json; access: Json }> {
  let got = signedIn.get(subject);
  if (!got) {
    got = (async () => {
      const { browser } = await signInSubject(s, subject);
      const me = (await (await browser.request(`${s.base}/api/me`)).json()) as Json;
      const access = (await (await browser.request(`${s.base}/api/me/access`)).json()) as Json;
      return { me, access };
    })();
    signedIn.set(subject, got);
  }
  return got;
}

const bindingsOf = (access: Json): string[] =>
  (access.bindings as Json[])
    .filter((b) => b.blockers.length === 0)
    .map((b) => `${b.role_id}@${b.scope.kind}:${b.scope.ref}`)
    .sort();

describe('the design personas (portal-coverage §1)', () => {
  it('the compose files list alice and bob first, then the eleven personas, the same in both', () => {
    expect(PERSONAS.map((p) => p.principal_id)).toEqual([
      'lt',
      'oh',
      'rb',
      'ar',
      'pm',
      'dn',
      'ks',
      'jm',
      'mw',
      'nf',
      'tb',
    ]);
    expect(users).toEqual([
      ...DEV_IDP_BASE_USERS,
      ...PERSONAS.map((p) => ({ subject: p.subject, name: p.name, email: p.email })),
    ]);
    expect(idpSeed.subjects.map((x) => x.principal_id)).toEqual([
      'alice',
      'bob',
      ...PERSONAS.map((p) => p.principal_id),
    ]);
    for (const p of PERSONAS) {
      const subject = idpSeed.subjects.find((x) => x.principal_id === p.principal_id);
      expect(subject?.subject).toBe(p.subject);
      expect(subject?.display_name).toBe(p.name);
      expect([...(subject?.groups ?? [])].sort()).toEqual(
        PERSONA_GROUPS.filter((g) => g.members.includes(p.principal_id))
          .map((g) => g.group_id)
          .sort(),
      );
    }
    expect(idpSeed.groups.map((g) => g.group_id).sort()).toEqual(
      PERSONA_GROUPS.map((g) => g.group_id).sort(),
    );
    // a persona group binds a role no slot maps to (slot roles come only from a role map), at a scope it allows
    for (const g of PERSONA_GROUPS) {
      const def = ROLE_CATALOGUE.find((r) => r.role_id === g.role);
      expect(def?.slot, g.group_id).toBeNull();
      expect(def?.scope_kinds, g.group_id).toContain(g.scope.kind);
    }
  });

  it('the seed binds the persona groups once; a second run changes nothing', () => {
    expect(logs.filter((l) => l.includes("design personas' groups are bound"))).toHaveLength(2);
    expect(logs).toContain('seed: alice already holds factory.admin');
  });

  for (const p of PERSONAS) {
    it(
      `${p.principal_id} (${p.persona}) signs in on the dev IdP and holds the design's bindings`,
      { timeout: 60_000 },
      async () => {
        const { me, access } = await meOf(p.subject);
        expect(me.principal.principal_id).toBe(p.principal_id);
        expect(me.principal.display_name).toBe(p.name);
        expect(bindingsOf(access)).toEqual(expectedOf(p.principal_id));
        expect(expectedOf(p.principal_id).length).toBeGreaterThan(0);
      },
    );
  }

  it('what the design says each kind of persona sees', { timeout: 120_000 }, async () => {
    const lt = await meOf('00000000-0000-4000-8000-000000000003');
    expect(lt.me.actions.fleet).toEqual(
      expect.arrayContaining(['project.onboard', 'identity.admin', 'ops.read', 'quality.read']),
    );
    const nf = await meOf('00000000-0000-4000-8000-000000000012');
    expect(nf.me.actions.fleet).toEqual(
      expect.arrayContaining(['audit.read', 'ops.read', 'quality.read']),
    );
    expect(nf.me.actions.fleet).not.toContain('identity.admin');
    expect(nf.me.actions.fleet).not.toContain('project.onboard');
    // tb: a guest viewer of payments, at D0, whose access ends
    const tb = await meOf('00000000-0000-4000-8000-000000000013');
    expect(tb.access.bindings[0].expiry).not.toBeNull();
    const pay = (tb.access.projects as Json[]).find((x) => x.project_id === 'payments');
    expect(pay).toMatchObject({ view_level: 'V1', data_class: 'D0' });
    expect(tb.me.actions.fleet).toEqual([]);
    // ar decides on payments (G0-G4), reads ledger
    const ar = await meOf('00000000-0000-4000-8000-000000000006');
    const arPay = (ar.me.actions.projects as Json[]).find((x) => x.project_id === 'payments');
    expect(arPay.actions).toContain('assistant.use');
    expect(arPay.actions).not.toContain('project.settings.edit');
    // rb administers payments: settings and bindings there, nothing at the fleet
    const rb = await meOf('00000000-0000-4000-8000-000000000005');
    const rbPay = (rb.me.actions.projects as Json[]).find((x) => x.project_id === 'payments');
    expect(rbPay.actions).toEqual(
      expect.arrayContaining(['project.settings.edit', 'access.manage', 'session.stop']),
    );
    expect(rb.me.actions.fleet).toEqual([]);
    // mw may start an onboarding for the web team only (team scope, not the fleet)
    const mw = await meOf('00000000-0000-4000-8000-000000000011');
    expect(mw.me.actions.fleet).not.toContain('project.onboard');
    expect(bindingsOf(mw.access)).toContain('factory.onboarder@team:web');
  });

  it(
    'alice and bob still sign in (the compose e2e): alice is the factory admin, bob holds nothing yet',
    { timeout: 60_000 },
    async () => {
      const alice = await meOf(DEV_IDP_BASE_USERS[0].subject);
      expect(alice.me.principal.principal_id).toBe('alice');
      expect(bindingsOf(alice.access)).toEqual(['factory.admin@fleet:*']);
      const bob = await meOf(DEV_IDP_BASE_USERS[1].subject);
      expect(bob.me.principal.principal_id).toBe('bob');
      expect(bindingsOf(bob.access)).toEqual([]);
    },
  );
});
