import { z } from 'zod';
import type { Brand, Id } from '@aisdlc/kernel';
import { ABANDON_CAUSE_PATTERN } from '../flow.js';

// Shared primitives for the entity schemas. Convention as elsewhere in this package: a Zod schema
// and a TS type with the same name. Ids are strings on the wire; the TS type is the branded type
// from @aisdlc/kernel where one exists, so a `ProjectId` cannot be passed where an item id is wanted.

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * A lowercase canonical UUID typed as the kernel's `Id<K>`. The runtime check is the pattern only
 * (kernel `parseId` lowercases; a record must already be canonical or its hash would not be stable).
 * The cast is type-level: Zod's `.brand()` would give a different brand than the kernel's.
 */
export function uuidId<K extends string>(): z.ZodType<Id<K>, string> {
  return z.string().regex(UUID_LOWER, 'lowercase canonical UUID') as unknown as z.ZodType<
    Id<K>,
    string
  >;
}

/** A slug-like string id typed with a kernel `Brand`. No colon: these ids are joined with `:` elsewhere. */
function tokenId<B extends string>(
  pattern: RegExp,
  what: string,
): z.ZodType<Brand<string, B>, string> {
  return z.string().max(128).regex(pattern, what) as unknown as z.ZodType<Brand<string, B>, string>;
}

export const ProjectId = tokenId<'ProjectId'>(
  /^[a-z0-9][a-z0-9_-]*$/,
  'project slug: lowercase letters, digits, - and _',
);
export type ProjectId = z.infer<typeof ProjectId>;

/** DM leaves `repo_id` unspecified; it appears inside `prr:<project>:<repo_id>` and `gap:<repo_id>:...`, so no colon. */
export const RepoId = tokenId<'RepoId'>(/^[A-Za-z0-9_.-]+$/, 'repo id: letters, digits, . _ -');
export type RepoId = z.infer<typeof RepoId>;

/** DM: Principal id is an Entra oid or a service id, so not always a UUID. */
export const PrincipalId = tokenId<'PrincipalId'>(/^[A-Za-z0-9_.@-]+$/, 'principal id');
export type PrincipalId = z.infer<typeof PrincipalId>;

export const GroupId = tokenId<'GroupId'>(/^[A-Za-z0-9_.@-]+$/, 'group id');
export type GroupId = z.infer<typeof GroupId>;

export const TeamId = tokenId<'TeamId'>(/^[a-z0-9][a-z0-9_-]*$/, 'team slug');
export type TeamId = z.infer<typeof TeamId>;

export const RoleId = tokenId<'RoleId'>(/^[a-z][a-z0-9_.-]*$/, 'role id');
export type RoleId = z.infer<typeof RoleId>;

export const S0RecordId = uuidId<'S0Record'>();
export type S0RecordId = z.infer<typeof S0RecordId>;
export const WorkItemId = uuidId<'WorkItem'>();
export type WorkItemId = z.infer<typeof WorkItemId>;
export const WorkRequestId = uuidId<'WorkRequest'>();
export type WorkRequestId = z.infer<typeof WorkRequestId>;
export const GateInstanceId = uuidId<'GateInstance'>();
export type GateInstanceId = z.infer<typeof GateInstanceId>;
export const LedgerEntryId = uuidId<'LedgerEntry'>();
export type LedgerEntryId = z.infer<typeof LedgerEntryId>;
export const RecordEventId = uuidId<'RecordEvent'>();
export type RecordEventId = z.infer<typeof RecordEventId>;
export const CardId = uuidId<'Card'>();
export type CardId = z.infer<typeof CardId>;
export const BindingId = uuidId<'Binding'>();
export type BindingId = z.infer<typeof BindingId>;

/** Hex digests. sha256 for record hashes, 40-hex for git object ids. */
export const Sha256Hex = z.string().regex(/^[0-9a-f]{64}$/, 'sha256, lowercase hex');
export type Sha256Hex = z.infer<typeof Sha256Hex>;
export const GitSha = z.string().regex(/^[0-9a-f]{40}$/, 'git sha, 40 lowercase hex');
export type GitSha = z.infer<typeof GitSha>;

/** UTC instants only (`Z`), so equal instants have one spelling and hash the same. */
export const IsoDateTime = z.iso.datetime();
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** A JSON object whose members are not described by the contract (event payloads, gate facts, config content). */
export const JsonObject = z.record(z.string(), z.unknown());
export type JsonObject = z.infer<typeof JsonObject>;

/** A cause code, same token shape as an abandon cause (`park.timeout`, `detector_crash`). */
export const CauseCode = z.string().max(64).regex(ABANDON_CAUSE_PATTERN);
export type CauseCode = z.infer<typeof CauseCode>;

/** An area of a repo (a monorepo part). The specs fix no syntax; a non-empty string. */
export const AreaId = z.string().min(1).max(256);
export type AreaId = z.infer<typeof AreaId>;

/** ES256 signature fields as the Notary and Witness produce them (value is base64url). */
export const Signature = z.strictObject({
  key_id: z.string().min(1),
  alg: z.literal('ES256'),
  value: z.string().regex(/^[A-Za-z0-9_-]+$/, 'base64url'),
});
export type Signature = z.infer<typeof Signature>;

export const MS_PER_DAY = 86_400_000;

/** Whole-instant difference in days between two ISO instants (b - a). */
export function daysBetween(a: string, b: string): number {
  return (Date.parse(b) - Date.parse(a)) / MS_PER_DAY;
}

/** `iso` plus `months` calendar months in UTC (day clamped to the target month's length). */
export function addMonthsUtc(iso: string, months: number): number {
  const d = new Date(iso);
  const total = d.getUTCFullYear() * 12 + d.getUTCMonth() + months;
  const y = Math.floor(total / 12);
  const m = total - y * 12;
  const lastDay = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return Date.UTC(
    y,
    m,
    Math.min(d.getUTCDate(), lastDay),
    d.getUTCHours(),
    d.getUTCMinutes(),
    d.getUTCSeconds(),
    d.getUTCMilliseconds(),
  );
}
