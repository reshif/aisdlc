import { readFileSync } from 'node:fs';
import { GroupId, PrincipalId, PrincipalKind, PrincipalStatus } from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';
import { z } from 'zod';

// IdentityProviderPort (PLAN M4.1): the identity service reaches an IdP (Entra in the cloud, a
// seed file locally) only through this port. It reads: groups, the subjects in them, and the
// resolution of one subject. It never writes to the IdP, and a failure is a refusal, never an
// empty directory (an unreachable IdP must not look like "everyone left every group").

export type IdpErrorCode = 'unavailable' | 'invalid' | 'refused';

export const IdpError = taggedError('IdpError');
export type IdpError = TaggedError<'IdpError', { code: IdpErrorCode; message: string }>;
export const idpError = (code: IdpErrorCode, message: string): IdpError =>
  IdpError({ code, message });

/** A subject (a person or service account) of the IdP, with the groups it is in. */
export const IdpSubject = z.strictObject({
  issuer: z.string().min(1),
  /** The IdP's stable, opaque subject id (Entra `oid`). */
  subject: z.string().min(1),
  /** The principal this subject is, in the factory (DM: an oid or a service id). */
  principal_id: PrincipalId,
  kind: PrincipalKind,
  status: PrincipalStatus,
  upn: z.string().min(1).nullable(),
  display_handle: z.string().min(1),
  display_name: z.string().min(1),
  logins: z.array(z.string().min(1)),
  /** The groups the subject is a direct member of. */
  groups: z.array(GroupId),
});
export type IdpSubject = z.infer<typeof IdpSubject>;

export const IdpGroup = z.strictObject({
  group_id: GroupId,
  display: z.string().min(1),
  pim_managed: z.boolean(),
  protected: z.boolean(),
});
export type IdpGroup = z.infer<typeof IdpGroup>;

/** Everything `syncGroups` returns: one full snapshot, not a delta. */
export const IdpSnapshot = z
  .strictObject({
    issuer: z.string().min(1),
    groups: z.array(IdpGroup),
    subjects: z.array(IdpSubject),
  })
  .superRefine((s, ctx) => {
    const known = new Set(s.groups.map((g) => g.group_id));
    const seen = new Set<string>();
    s.subjects.forEach((x, i) => {
      if (x.issuer !== s.issuer) {
        ctx.addIssue({ code: 'custom', path: ['subjects', i, 'issuer'], message: 'other issuer' });
      }
      if (seen.has(x.subject)) {
        ctx.addIssue({ code: 'custom', path: ['subjects', i, 'subject'], message: 'duplicate' });
      }
      seen.add(x.subject);
      for (const g of x.groups) {
        if (!known.has(g)) {
          ctx.addIssue({
            code: 'custom',
            path: ['subjects', i, 'groups'],
            message: `unknown group ${g}`,
          });
        }
      }
    });
  });
export type IdpSnapshot = z.infer<typeof IdpSnapshot>;

export interface IdentityProviderPort {
  /** The full set of groups and subjects with their memberships. */
  syncGroups(): Promise<Result<IdpSnapshot, IdpError>>;
  /** One subject, or `null` when the IdP does not know it. */
  resolveSubject(ref: {
    issuer: string;
    subject: string;
  }): Promise<Result<IdpSubject | null, IdpError>>;
}

/**
 * The local seed adapter: reads a JSON file with the shape of `IdpSnapshot` (the repo carries a
 * fixture; it holds no secrets). The file is read on every call, so an edit shows at the next sync.
 */
export class SeedIdentityProvider implements IdentityProviderPort {
  constructor(
    private readonly read: () => string,
    private readonly label = 'seed',
  ) {}

  static fromFile(path: string): SeedIdentityProvider {
    return new SeedIdentityProvider(() => readFileSync(path, 'utf8'), path);
  }

  static fromText(text: string): SeedIdentityProvider {
    return new SeedIdentityProvider(() => text);
  }

  private load(): Result<IdpSnapshot, IdpError> {
    let raw: unknown;
    try {
      raw = JSON.parse(this.read());
    } catch (e) {
      return err(idpError('unavailable', `cannot read ${this.label}: ${(e as Error).message}`));
    }
    const p = IdpSnapshot.safeParse(raw);
    return p.success ? ok(p.data) : err(idpError('invalid', `${this.label}: ${p.error.message}`));
  }

  async syncGroups() {
    return this.load();
  }

  async resolveSubject(ref: { issuer: string; subject: string }) {
    const s = this.load();
    if (!s.ok) return s;
    if (s.value.issuer !== ref.issuer) return ok(null);
    return ok(s.value.subjects.find((x) => x.subject === ref.subject) ?? null);
  }
}

/** Deterministic in-memory IdP for tests; mutable, and can be made to fail. */
export class FakeIdentityProvider implements IdentityProviderPort {
  private snapshot: IdpSnapshot;
  private failure: IdpError | null = null;

  constructor(snapshot: IdpSnapshot) {
    this.snapshot = IdpSnapshot.parse(snapshot);
  }

  set(snapshot: IdpSnapshot): this {
    this.snapshot = IdpSnapshot.parse(snapshot);
    return this;
  }

  /** Every later call fails with this error until `heal`. */
  fail(code: IdpErrorCode = 'unavailable'): this {
    this.failure = idpError(code, `fake IdP ${code}`);
    return this;
  }

  heal(): this {
    this.failure = null;
    return this;
  }

  async syncGroups() {
    return this.failure ? err(this.failure) : ok(structuredClone(this.snapshot));
  }

  async resolveSubject(ref: { issuer: string; subject: string }) {
    if (this.failure) return err(this.failure);
    if (ref.issuer !== this.snapshot.issuer) return ok(null);
    const s = this.snapshot.subjects.find((x) => x.subject === ref.subject);
    return ok(s ? structuredClone(s) : null);
  }
}
