import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IdpSnapshot } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import {
  DEV_IDP_BASE_USERS,
  FACTORY_ADMIN_ACCOUNT,
  KEYCLOAK_CLIENT_ID,
  KEYCLOAK_DEFAULT_ISSUER,
  PERSONAS,
  PERSONA_GROUPS,
  keycloakIdpSeed,
  keycloakRealm,
  keycloakTestPeopleFtl,
} from '../src/dev-oidc/index.js';

// The Keycloak files of the compose stack are GENERATED from the one IdP seed (itself held to `PERSONAS` by the persona
// tests): `npm run gen -w @aisdlc/bff` rewrites them (vitest -u); this test fails when one is stale.

const COMPOSE = join(import.meta.dirname, '..', '..', '..', 'platform', 'compose');
const dev = IdpSnapshot.parse(
  JSON.parse(readFileSync(join(COMPOSE, 'config', 'idp-seed.json'), 'utf8')),
);
const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the realm is Keycloak's JSON, checked field by field
type Json = any;

describe('the Keycloak realm and IdP seed', () => {
  const realm = keycloakRealm(dev) as Json;
  const seed = keycloakIdpSeed(dev);

  it('matches the committed files (regenerate with npm run gen -w @aisdlc/bff)', async () => {
    await expect(json(realm)).toMatchFileSnapshot(join(COMPOSE, 'keycloak', 'realm-aisdlc.json'));
    await expect(json(seed)).toMatchFileSnapshot(join(COMPOSE, 'config', 'keycloak-idp-seed.json'));
    await expect(keycloakTestPeopleFtl(dev)).toMatchFileSnapshot(
      join(COMPOSE, 'keycloak', 'themes', 'aisdlc', 'login', 'test-people.ftl'),
    );
  });

  it('has alice, bob, the eleven personas and the break-glass account, each with the IdP subject as its id', () => {
    const expected = [
      ...DEV_IDP_BASE_USERS.map((u) => u.subject),
      ...PERSONAS.map((p) => p.subject),
      FACTORY_ADMIN_ACCOUNT.subject,
    ];
    expect(realm.users.map((u: Json) => u.id)).toEqual(expected);
    expect(realm.users.map((u: Json) => u.username)).toEqual([
      'alice',
      'bob',
      ...PERSONAS.map((p) => p.principal_id),
      'factory-admin',
    ]);
    expect(IdpSnapshot.parse(seed).subjects.map((s) => s.subject)).toEqual(expected);
    expect(seed.subjects.every((s) => s.issuer === KEYCLOAK_DEFAULT_ISSUER)).toBe(true);
  });

  it("gives every user a first and last name Keycloak's person-name validator accepts (no profile update at sign-in)", () => {
    for (const u of realm.users as Json[]) {
      for (const n of [u.firstName, u.lastName]) {
        expect(n, u.username).toMatch(/^[^<>&"$%!#?§;*~/\\|^=[\]{}()]+$/);
      }
    }
    expect(realm.users.find((u: Json) => u.username === 'alice')).toMatchObject({
      firstName: 'Alice',
      lastName: 'Example',
    });
  });

  it('puts every persona in the groups the design gives them, the break-glass account among the factory admins', () => {
    for (const g of PERSONA_GROUPS) {
      const members = realm.users
        .filter((u: Json) => u.groups.includes(`/${g.group_id}`))
        .map((u: Json) => u.username);
      const want =
        g.group_id === 'grp-factory-admins' ? [...g.members, 'factory-admin'] : g.members;
      expect(members.sort(), g.group_id).toEqual([...want].sort());
    }
  });

  it('holds no secret: passwords and the client secret are placeholders Keycloak resolves at import', () => {
    const passwords = new Set(
      realm.users.flatMap((u: Json) => u.credentials.map((c: Json) => c.value)),
    );
    expect([...passwords].sort()).toEqual([
      '${KC_FACTORY_ADMIN_PASSWORD}',
      '${KC_PERSONA_PASSWORD}',
    ]);
    const client = realm.clients.find((c: Json) => c.clientId === KEYCLOAK_CLIENT_ID);
    expect(client).toMatchObject({
      publicClient: false,
      secret: '${KC_BFF_CLIENT_SECRET}',
      standardFlowEnabled: true,
      implicitFlowEnabled: false,
      directAccessGrantsEnabled: false,
      redirectUris: ['${KC_BFF_REDIRECT_URI}'],
      attributes: { 'pkce.code.challenge.method': 'S256' },
    });
    expect(realm).toMatchObject({
      bruteForceProtected: true,
      failureFactor: 5,
      registrationAllowed: false,
    });
  });
});
