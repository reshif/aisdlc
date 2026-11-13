import { IdpSnapshot } from '@aisdlc/ports';
import { PERSONAS } from './personas.js';

// Keycloak for local prod (portal v2 intent, 2026-11-13: "sign-in via Keycloak OIDC, local username and password
// accounts in Keycloak for factory admins"). ONE source for the people: the IdP seed the dev IdP and identity already
// use (platform/compose/config/idp-seed.json, which the persona tests hold to `PERSONAS`). From it this file makes
//
//   - the realm import `aisdlc` (platform/compose/keycloak/realm-aisdlc.json): every person as a Keycloak user whose id
//     IS the IdP subject (so identity's subject links hold), their groups, the bff as a confidential client with
//     PKCE (S256), brute-force protection, OTP available (optional: a person may enrol it), and one break-glass local
//     account `factory-admin`;
//   - identity's IdP seed for that issuer (platform/compose/config/keycloak-idp-seed.json): the same subjects with
//     Keycloak's issuer, plus the `factory-admin` account in `grp-factory-admins`;
//   - the sign-in page's "Test people" list (the theme's test-people.ftl).
//
// Secrets are never in these files: the realm names them as placeholders Keycloak resolves from its environment at
// import (`${KC_...}`), and the compose entrypoint fills the environment from secret files. `npm run gen -w
// @aisdlc/bff` rewrites the three files; a test fails when they are stale.

export const KEYCLOAK_REALM = 'aisdlc';
export const KEYCLOAK_CLIENT_ID = 'aisdlc-bff';

/** The issuer of the realm at `base` (e.g. http://keycloak.localhost:8390). */
export const keycloakIssuer = (base: string): string =>
  `${base.replace(/\/$/, '')}/realms/${KEYCLOAK_REALM}`;

/** The issuer the committed files name (the default published port); other ports get a rewritten copy. */
export const KEYCLOAK_DEFAULT_ISSUER = keycloakIssuer('http://keycloak.localhost:8390');

/** The break-glass local account of the factory admins (its password is generated into secrets/ by init-secrets). */
export const FACTORY_ADMIN_ACCOUNT = {
  subject: '00000000-0000-4000-8000-000000000014',
  username: 'factory-admin',
  principal_id: 'factory-admin',
  display_name: 'Factory admin (local account)',
  email: 'factory-admin@example.test',
} as const;

/**
 * The ENTERPRISE profile's one person: the system administrator every other account is made through. Default username
 * and password `admin` / `admin`, TEMPORARY: Keycloak forces a new password (UPDATE_PASSWORD) at the first sign-in.
 * A factory admin (`grp-factory-admins`), like the break-glass `factory-admin` of the local profile. No test people.
 */
export const ENTERPRISE_ADMIN = {
  subject: '00000000-0000-4000-8000-000000000100',
  username: 'admin',
  principal_id: 'admin',
  display_name: 'System Administrator',
  email: 'admin@aisdlc.local',
  /** The default password the realm import sets (temporary: changed at the first sign-in). */
  default_password: 'admin',
} as const;

/** The two sign-in profiles: `local` keeps the test people, `enterprise` has the system administrator only. */
export type IdpProfile = 'local' | 'enterprise';
export const ENTERPRISE_LOGIN_THEME = 'aisdlc-enterprise';

/** The placeholders the realm import resolves from Keycloak's environment (compose: from secret files). */
export const KEYCLOAK_ENV = {
  personaPasswordName: 'KC_PERSONA_PASSWORD',
  factoryAdminPasswordName: 'KC_FACTORY_ADMIN_PASSWORD',
  clientSecretName: 'KC_BFF_CLIENT_SECRET',
  redirectUri: 'KC_BFF_REDIRECT_URI',
  portalUrl: 'KC_BFF_PUBLIC_URL',
} as const;
const ph = (name: string): string => `\${${name}}`;

/** identity's IdP seed of the enterprise profile: the system administrator and the factory admins' group, nobody else. */
export function keycloakEnterpriseIdpSeed(
  dev: IdpSnapshot,
  issuer = KEYCLOAK_DEFAULT_ISSUER,
): IdpSnapshot {
  return IdpSnapshot.parse({
    issuer,
    groups: dev.groups.filter((g) => g.group_id === 'grp-factory-admins'),
    subjects: [
      {
        issuer,
        subject: ENTERPRISE_ADMIN.subject,
        principal_id: ENTERPRISE_ADMIN.principal_id,
        kind: 'human',
        status: 'active',
        upn: ENTERPRISE_ADMIN.email,
        display_handle: ENTERPRISE_ADMIN.username,
        display_name: ENTERPRISE_ADMIN.display_name,
        logins: [],
        groups: ['grp-factory-admins'],
      },
    ],
  });
}

/** identity's IdP seed for Keycloak: the dev seed's people with Keycloak's issuer, and the break-glass account. */
export function keycloakIdpSeed(dev: IdpSnapshot, issuer = KEYCLOAK_DEFAULT_ISSUER): IdpSnapshot {
  return {
    issuer,
    groups: dev.groups,
    subjects: [
      ...dev.subjects.map((s) => ({ ...s, issuer })),
      {
        issuer,
        subject: FACTORY_ADMIN_ACCOUNT.subject,
        principal_id: FACTORY_ADMIN_ACCOUNT.principal_id,
        kind: 'human',
        status: 'active',
        upn: FACTORY_ADMIN_ACCOUNT.email,
        display_handle: FACTORY_ADMIN_ACCOUNT.username,
        display_name: FACTORY_ADMIN_ACCOUNT.display_name,
        logins: [],
        groups: ['grp-factory-admins'],
      },
    ],
  } as IdpSnapshot;
}

/**
 * First word, rest: Keycloak's user profile asks for both, and its person-name validator refuses characters such as
 * parentheses (a refused name sends the person to "update your profile" at every sign-in), so a note in parentheses
 * ("Alice Example (factory admin)") is left out and any other refused character is dropped.
 */
export function keycloakNames(display: string): { firstName: string; lastName: string } {
  const clean = display
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[<>&"$%!#?§;*~/\\|^=[\]{}()]/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
  const [first, ...rest] = clean.split(' ');
  return { firstName: first || 'Person', lastName: rest.join(' ') || first || 'Person' };
}

/** The realm import (Keycloak 26 JSON). */
export function keycloakRealm(
  dev: IdpSnapshot,
  profile: IdpProfile = 'local',
): Record<string, unknown> {
  const enterprise = profile === 'enterprise';
  const seed = enterprise ? keycloakEnterpriseIdpSeed(dev) : keycloakIdpSeed(dev);
  const users = seed.subjects.map((s) => {
    if (enterprise) {
      // the default credentials the owner asked for: `admin` / `admin`, temporary (Keycloak forces UPDATE_PASSWORD)
      return {
        id: s.subject,
        username: s.principal_id,
        enabled: true,
        emailVerified: true,
        email: s.upn ?? ENTERPRISE_ADMIN.email,
        firstName: 'System',
        lastName: 'Administrator',
        credentials: [
          { type: 'password', value: ENTERPRISE_ADMIN.default_password, temporary: true },
        ],
        groups: s.groups.map((g) => `/${g}`),
        requiredActions: ['UPDATE_PASSWORD'],
      };
    }
    const breakGlass = s.principal_id === FACTORY_ADMIN_ACCOUNT.principal_id;
    return {
      id: s.subject,
      username: s.principal_id,
      enabled: true,
      emailVerified: true,
      email: s.upn ?? `${s.principal_id}@example.test`,
      ...keycloakNames(s.display_name),
      credentials: [
        {
          type: 'password',
          value: ph(
            breakGlass ? KEYCLOAK_ENV.factoryAdminPasswordName : KEYCLOAK_ENV.personaPasswordName,
          ),
          temporary: false,
        },
      ],
      groups: s.groups.map((g) => `/${g}`),
      requiredActions: [],
    };
  });
  return {
    realm: KEYCLOAK_REALM,
    displayName: 'AISDLC',
    enabled: true,
    loginTheme: enterprise ? ENTERPRISE_LOGIN_THEME : 'aisdlc',
    // plain http is allowed from loopback and private addresses only (the browser on localhost, the bff on the
    // compose network); behind TLS in production this is `all`
    sslRequired: 'external',
    registrationAllowed: false,
    resetPasswordAllowed: false,
    rememberMe: false,
    editUsernameAllowed: false,
    loginWithEmailAllowed: false,
    duplicateEmailsAllowed: false,
    // five wrong tries lock the account for 15 minutes (the sign-in page says so)
    bruteForceProtected: true,
    failureFactor: 5,
    waitIncrementSeconds: 900,
    maxFailureWaitSeconds: 900,
    maxDeltaTimeSeconds: 43_200,
    permanentLockout: false,
    passwordPolicy: 'length(12) and notUsername',
    // OTP is available and optional: a person may enrol an authenticator app (the browser flow's conditional OTP
    // then asks for it at every sign-in); nobody is forced to
    otpPolicyType: 'totp',
    otpPolicyAlgorithm: 'HmacSHA1',
    otpPolicyDigits: 6,
    otpPolicyPeriod: 30,
    // the portal's own session is 12 h, 30 min idle (the bff); Keycloak's SSO session matches it
    ssoSessionIdleTimeout: 1_800,
    ssoSessionMaxLifespan: 43_200,
    accessTokenLifespan: 300,
    groups: seed.groups.map((g) => ({
      name: g.group_id,
      path: `/${g.group_id}`,
      attributes: { display: [g.display] },
    })),
    users,
    clients: [
      {
        clientId: KEYCLOAK_CLIENT_ID,
        name: 'AISDLC portal',
        enabled: true,
        protocol: 'openid-connect',
        publicClient: false,
        clientAuthenticatorType: 'client-secret',
        secret: ph(KEYCLOAK_ENV.clientSecretName),
        standardFlowEnabled: true,
        implicitFlowEnabled: false,
        directAccessGrantsEnabled: false,
        serviceAccountsEnabled: false,
        frontchannelLogout: false,
        rootUrl: ph(KEYCLOAK_ENV.portalUrl),
        baseUrl: ph(KEYCLOAK_ENV.portalUrl),
        redirectUris: [ph(KEYCLOAK_ENV.redirectUri)],
        webOrigins: ['+'],
        attributes: {
          'pkce.code.challenge.method': 'S256',
          // the callback (`+`) and the portal's root, where a sign-out lands (the bff's IdP logout)
          'post.logout.redirect.uris': `+##${ph(KEYCLOAK_ENV.portalUrl)}/`,
        },
        protocolMappers: [
          {
            name: 'groups',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-group-membership-mapper',
            consentRequired: false,
            config: {
              'claim.name': 'groups',
              'full.path': 'false',
              'id.token.claim': 'true',
              'access.token.claim': 'false',
              'userinfo.token.claim': 'true',
            },
          },
        ],
      },
    ],
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The sign-in page's "Test people" buttons (fill the username; the password is the local stack's, in secrets/). */
export function keycloakTestPeopleFtl(dev: IdpSnapshot): string {
  const label = new Map(PERSONAS.map((p) => [p.principal_id, p.persona]));
  const people = keycloakIdpSeed(dev).subjects.map((s) => {
    const role =
      s.principal_id === FACTORY_ADMIN_ACCOUNT.principal_id
        ? 'break-glass local account'
        : (label.get(s.principal_id) ??
          (s.principal_id === 'alice' ? 'Factory admin (setup)' : 'Test person'));
    return `      <button type="button" data-username="${esc(s.principal_id)}">${esc(
      s.display_name.replace(/ \(.*\)$/, ''),
    )}<small>${esc(role)}</small></button>`;
  });
  return [
    '<#-- GENERATED by services/bff/src/dev-oidc/keycloak.ts (npm run gen -w @aisdlc/bff): do not edit -->',
    '<#macro testPeople>',
    '  <details class="people-list">',
    '    <summary>Test people (local stack only)</summary>',
    '    <p class="people-note">Fills the username. The password of the test people is in <code>platform/compose/secrets/keycloak-persona-password</code>.</p>',
    '    <div class="people">',
    ...people,
    '    </div>',
    '  </details>',
    '</#macro>',
    '',
  ].join('\n');
}
