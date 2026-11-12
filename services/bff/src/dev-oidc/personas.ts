import type { RoleSlot, Scope } from '@aisdlc/contracts';

// The design personas of the portal (docs/design/portal-prototype/src/access.js, portal-coverage §1), as the local
// dev IdP and the local seed know them. LOCAL ONLY: the dev IdP refuses to start unless FACTORY_ENV=local, and the
// seed likewise. alice and bob stay as they are (the compose e2e signs in as them); the personas come after.
//
// Three kinds of access, because the factory grants them three ways:
//   - fleet and team roles (factory.admin, factory.auditor, factory.onboarder) and a direct `project.viewer`: IdP
//     groups (`PERSONA_GROUPS`, the "SCIM groups" of the design) that the seed binds to their role through identity;
//   - project slot roles (admin, intent, g4, ...): only ever generated from a project's published role map, never
//     bound by hand (identity refuses). `personaRoleMap(project)` is the role map each design project would carry;
//     the bindings appear once a project of that id is onboarded and its card 4 role map is published with it.

/** The design's example projects (prototype `core.js`); `identity` is the confidential one. */
export const PERSONA_PROJECTS = ['payments', 'ledger', 'web', 'identity', 'mobile'] as const;
export type PersonaProject = (typeof PERSONA_PROJECTS)[number];

export interface Persona {
  readonly principal_id: string;
  /** The dev IdP's subject (the `sub` claim); the identity seed links it to the principal. */
  readonly subject: string;
  readonly name: string;
  readonly email: string;
  /** The account's label on the design's sign-in list. */
  readonly persona: string;
  /** The project slots this persona holds on each design project (the role maps). */
  readonly slots: Partial<Record<PersonaProject, readonly RoleSlot[]>>;
}

const sub = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const p = (
  n: number,
  principal_id: string,
  name: string,
  persona: string,
  slots: Persona['slots'] = {},
): Persona => ({
  principal_id,
  subject: sub(n),
  name,
  email: `${name.toLowerCase().replace(' ', '.')}@example.test`,
  persona,
  slots,
});

/** The eleven personas, in the design's sign-in order. Subjects 3..13 (alice is 1, bob 2). */
export const PERSONAS: readonly Persona[] = [
  p(3, 'lt', 'Luis Torres', 'Factory owner'),
  p(4, 'oh', 'Omar Haddad', 'Deputy factory admin', { identity: ['kill'] }),
  p(5, 'rb', 'Rana Begum', 'Project admin', {
    payments: ['admin', 'kill', 'design', 'm4'],
    ledger: ['m4'],
  }),
  p(6, 'ar', 'Alex Rivera', 'Approver and code owner', { payments: ['intent', 'design', 'g4'] }),
  p(7, 'pm', 'Priya Menon', 'Product owner', { payments: ['intent', 'requesters', 'g5', 'm4'] }),
  p(8, 'dn', 'Daniel Novak', 'Engineer (requester)', {
    payments: ['requesters'],
    ledger: ['requesters'],
  }),
  p(9, 'ks', 'Keiko Sato', 'Security', {
    payments: ['sec'],
    web: ['sec'],
    ledger: ['sec'],
    identity: ['admin', 'sec'],
  }),
  p(10, 'jm', 'Jonas Meyer', 'Exception approver', { payments: ['x'], ledger: ['x'] }),
  p(11, 'mw', 'Mei Wong', 'Web lead, onboarding a repo', {
    web: ['admin', 'g4', 'intent', 'design'],
    mobile: ['m4'],
  }),
  p(12, 'nf', 'Nora Field', 'Auditor'),
  p(13, 'tb', 'Tom Becker', 'Viewer guest'),
];

export interface PersonaGroup {
  readonly group_id: string;
  readonly display: string;
  /** A role no slot maps to (a slot role is only ever generated from a role map). */
  readonly role: 'factory.admin' | 'factory.auditor' | 'factory.onboarder' | 'project.viewer';
  readonly scope: Scope;
  /** Days from the seed's run to the binding's expiry (a guest's access ends); `null`: no expiry. */
  readonly expires_in_days: number | null;
  readonly members: readonly string[];
}

/**
 * The IdP groups of the personas and the role each is bound to. The IdP seed lists the members (the sync keeps
 * them); the seed binds each group to its role. `grp-factory-admins` is the seed's own admin group (alice is added to
 * it by the seed, the personas by the IdP).
 */
export const PERSONA_GROUPS: readonly PersonaGroup[] = [
  {
    group_id: 'grp-factory-admins',
    display: 'Factory admins',
    role: 'factory.admin',
    scope: { kind: 'fleet', ref: '*' },
    expires_in_days: null,
    members: ['lt', 'oh'],
  },
  {
    group_id: 'grp-factory-auditors',
    display: 'Internal audit',
    role: 'factory.auditor',
    scope: { kind: 'fleet', ref: '*' },
    expires_in_days: null,
    members: ['nf'],
  },
  {
    group_id: 'grp-web-onboarders',
    display: 'Web team onboarders',
    role: 'factory.onboarder',
    scope: { kind: 'team', ref: 'web' },
    expires_in_days: null,
    members: ['mw'],
  },
  {
    group_id: 'grp-ledger-viewers',
    display: 'Ledger Service readers',
    role: 'project.viewer',
    scope: { kind: 'project', ref: 'ledger' },
    expires_in_days: null,
    members: ['ar'],
  },
  {
    group_id: 'grp-web-viewers',
    display: 'Web Checkout readers',
    role: 'project.viewer',
    scope: { kind: 'project', ref: 'web' },
    expires_in_days: null,
    members: ['pm'],
  },
  {
    group_id: 'grp-payments-guests',
    display: 'Payments API guests',
    role: 'project.viewer',
    scope: { kind: 'project', ref: 'payments' },
    expires_in_days: 90,
    members: ['tb'],
  },
];

/** The role map of a design project: each slot's holders, from `PERSONAS`. */
export function personaRoleMap(project: PersonaProject): Partial<Record<RoleSlot, string[]>> {
  const out: Partial<Record<RoleSlot, string[]>> = {};
  for (const persona of PERSONAS) {
    for (const slot of persona.slots[project] ?? []) {
      (out[slot] ??= []).push(persona.principal_id);
    }
  }
  return out;
}

/** The dev IdP's users: alice and bob first (the e2e's), then the personas. */
export const DEV_IDP_BASE_USERS = [
  {
    subject: sub(1),
    name: 'Alice Example (factory admin)',
    email: 'alice@example.test',
  },
  { subject: sub(2), name: 'Bob Example', email: 'bob@example.test' },
] as const;
