import { z } from 'zod';
import { Scope } from '../values.js';
import { AccessBindingRow } from './access-grants.js';
import { GroupId, IsoDateTime, PrincipalId, RoleId, Sha256Hex, TeamId } from './ids.js';
import { Classification, PrincipalKind, PrincipalStatus } from './identity.js';
import { LedgerAuditEntry } from './portal.js';

// Portal v2's People, teams & roles reads (docs/design/screen-map.md §2.13, §2.16; N19, N25). The writes are the bff's
// `/api/people|teams|groups|bindings` (identity, PDP-decided) and the deletes core's; these are what the screens read
// to show who is in the factory, which teams, and who holds which role through what. The bff serves them from the
// identity read model (`identity.*`) and the ledger, to fleet readers (`audit.read`, `identity.admin` or
// `access.manage` on the fleet).
//
//   GET /api/people            PeopleListView
//   GET /api/people/:id        PersonDetailView
//   GET /api/teams             TeamListView
//   GET /api/teams/:id         TeamDetailView
//   GET /api/audit/ledger      FleetLedgerView   (audit.read on the fleet)

/** How a person signs in: through the company SSO (Keycloak / OIDC), or a local break-glass account. */
export const PersonSignIn = z.enum(['sso', 'local']);
export type PersonSignIn = z.infer<typeof PersonSignIn>;

/** The id of the group a team's members are in, when the portal creates the team. */
export const teamGroupId = (team: string): string => `team.${team}`;

export const PersonRow = z.strictObject({
  principal_id: PrincipalId,
  display_name: z.string().min(1),
  display_handle: z.string().min(1),
  kind: PrincipalKind,
  status: PrincipalStatus,
  /** The company sign-in name (email or UPN), when the person has one. */
  upn: z.string().nullable(),
  sign_in: PersonSignIn,
  teams: z.array(TeamId),
  /** Role assignments in force that reach the person (direct or through a group). */
  roles: z.number().int().min(0),
});
export type PersonRow = z.infer<typeof PersonRow>;

export const PeopleListView = z.strictObject({ people: z.array(PersonRow) });
export type PeopleListView = z.infer<typeof PeopleListView>;

/** A role assignment that reaches a person, and the group it comes through. */
export const PersonBinding = z.strictObject({
  binding_id: AccessBindingRow.shape.binding_id,
  role_id: RoleId,
  scope: Scope,
  expiry: IsoDateTime.nullable(),
  origin: AccessBindingRow.shape.origin,
  group_id: GroupId,
  /** The team whose group it is, when it is a team's. */
  team_id: TeamId.nullable(),
});
export type PersonBinding = z.infer<typeof PersonBinding>;

export const PersonDetailView = z.strictObject({
  person: PersonRow.extend({
    logins: z.array(z.string()),
    role_label: z.string().nullable(),
    status_changed_at: IsoDateTime,
  }),
  groups: z.array(
    z.strictObject({ group_id: GroupId, display: z.string(), team_id: TeamId.nullable() }),
  ),
  bindings: z.array(PersonBinding),
});
export type PersonDetailView = z.infer<typeof PersonDetailView>;

export const TeamRow = z.strictObject({
  team_id: TeamId,
  name: z.string().min(1),
  classification: Classification,
  /** The group the team's members are in; `null`: the team has no members yet. */
  group_id: GroupId.nullable(),
  members: z.array(PrincipalId),
  roles: z.number().int().min(0),
});
export type TeamRow = z.infer<typeof TeamRow>;

export const TeamListView = z.strictObject({
  teams: z.array(TeamRow),
  /** The members' names. */
  names: z.record(z.string(), z.string()),
});
export type TeamListView = z.infer<typeof TeamListView>;

export const TeamDetailView = z.strictObject({
  team: TeamRow,
  members: z.array(
    z.strictObject({
      principal_id: PrincipalId,
      display_name: z.string().min(1),
      status: PrincipalStatus,
    }),
  ),
  bindings: z.array(AccessBindingRow),
});
export type TeamDetailView = z.infer<typeof TeamDetailView>;

/** One entry of the fleet's decision log, with what the factory admin's override and a deletion add to it. */
export const FleetLedgerEntry = LedgerAuditEntry.extend({
  /** The override's reason: an `admin.override` entry's, or a gate decision's `body.override`. */
  override_reason: z.string().nullable(),
  /** A `deletion.performed` entry: what kind was deleted and how many entries it redacted. */
  deletion: z
    .strictObject({ kind: z.string(), redacted: z.number().int().min(0), override: z.boolean() })
    .nullable(),
});
export type FleetLedgerEntry = z.infer<typeof FleetLedgerEntry>;

export const FleetLedgerFilter = z.enum(['all', 'decisions', 'overrides', 'deletions', 'access']);
export type FleetLedgerFilter = z.infer<typeof FleetLedgerFilter>;

export const FleetLedgerView = z.strictObject({
  /** Newest first. */
  entries: z.array(FleetLedgerEntry),
  head: z.strictObject({ ledger_seq: z.number().int().min(1), entry_hash: Sha256Hex }).nullable(),
  /** Pass as `before` for the next page; `null`: no older entry. */
  next_before: z.number().int().min(1).nullable(),
});
export type FleetLedgerView = z.infer<typeof FleetLedgerView>;
