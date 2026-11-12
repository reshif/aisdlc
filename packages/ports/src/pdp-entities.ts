import {
  scopeCovers,
  type PdpResource,
  type PrincipalId,
  type PrincipalKind,
  type PrincipalStatus,
  type Scope,
} from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// PdpEntityPort (PLAN M4.3): where the PDP gets the facts of a request. The policies are generated
// from the role catalogue; the entities they run against are the principal and the bindings in
// force for it at the scopes the resource lives in, from identity (`IdentityPdpEntities` in
// `@aisdlc/identity/read`). An error or an unknown principal is a refusal: the PDP denies.

export type PdpEntityErrorCode = 'unavailable' | 'invalid';

export const PdpEntityError = taggedError('PdpEntityError');
export type PdpEntityError = TaggedError<
  'PdpEntityError',
  { code: PdpEntityErrorCode; message: string }
>;
export const pdpEntityError = (code: PdpEntityErrorCode, message: string): PdpEntityError =>
  PdpEntityError({ code, message });

/** One binding in force for the principal (through a group), at a scope that covers the request. */
export interface PdpBindingFact {
  readonly binding_id: string;
  readonly role_id: string;
  readonly group_id: string;
  readonly scope: Scope;
}

export interface PdpPrincipalFacts {
  readonly principal_id: PrincipalId;
  readonly kind: PrincipalKind;
  readonly status: PrincipalStatus;
  readonly breakglass: boolean;
  /** In force at `at` and covering at least one of the asked scopes. */
  readonly bindings: readonly PdpBindingFact[];
}

/**
 * What is being asked, for an entity source that grants narrowly: the bootstrap grant holds the
 * project admin role only for a few actions on a few resources (`BootstrapPdpEntities`). Identity's
 * own source ignores it: a binding covers every action its role holds.
 */
export interface PdpAsk {
  readonly action: string;
  readonly resource: PdpResource;
}

export interface PdpEntityPort {
  /**
   * The principal and its in-force bindings that cover any of `scopes` at `at`. `null`: identity
   * does not know the principal.
   */
  principalFacts(
    principal: PrincipalId,
    scopes: readonly Scope[],
    at: Date,
    ask?: PdpAsk,
  ): Promise<Result<PdpPrincipalFacts | null, PdpEntityError>>;
  /**
   * M19 (the load test's floor hot spot): a view of this source for ONE batch of decisions (`Pdp.decideEach`: one
   * principal, one action, many resources), which may do once what every call would do again (catch the read model up,
   * read the principal, the bindings at a scope seen before in the batch). It answers what this source answers for
   * each ask, as of the batch's start. Absent: the batch asks this source itself, call by call.
   */
  batch?(): PdpEntityPort;
}

interface FakePrincipal {
  kind: PrincipalKind;
  status: PrincipalStatus;
  breakglass: boolean;
}

/**
 * Deterministic in-memory `PdpEntityPort`. Like identity, a principal that is not active has no
 * bindings in force; `leakBindingsWhenInactive` turns that off so a test can prove the policies
 * themselves deny a disabled principal.
 */
export class FakePdpEntities implements PdpEntityPort {
  private readonly principals = new Map<string, FakePrincipal>();
  private readonly bindings = new Map<string, PdpBindingFact[]>();
  private failure: PdpEntityError | null = null;
  leakBindingsWhenInactive = false;

  addPrincipal(
    id: string,
    o: { kind?: PrincipalKind; status?: PrincipalStatus; breakglass?: boolean } = {},
  ): this {
    this.principals.set(id, {
      kind: o.kind ?? 'human',
      status: o.status ?? 'active',
      breakglass: o.breakglass ?? false,
    });
    return this;
  }

  setStatus(id: string, status: PrincipalStatus): this {
    const p = this.principals.get(id);
    if (!p) throw new RangeError(`unknown principal ${id}`);
    p.status = status;
    return this;
  }

  /** Binds `role` at `scope` for the principal (through a group named after the binding). */
  bind(principal: string, role: string, scope: Scope, group = `grp-${role}`): this {
    const list = this.bindings.get(principal) ?? [];
    list.push({
      binding_id: `b-${principal}-${role}-${scope.kind}-${scope.ref}`,
      role_id: role,
      group_id: group,
      scope,
    });
    this.bindings.set(principal, list);
    return this;
  }

  fail(code: PdpEntityErrorCode = 'unavailable'): this {
    this.failure = pdpEntityError(code, `fake entity source ${code}`);
    return this;
  }

  heal(): this {
    this.failure = null;
    return this;
  }

  async principalFacts(principal: PrincipalId, scopes: readonly Scope[], _at: Date) {
    if (this.failure) return err(this.failure);
    const p = this.principals.get(principal);
    if (!p) return ok(null);
    const live = p.status === 'active' || this.leakBindingsWhenInactive;
    const bindings = live
      ? (this.bindings.get(principal) ?? []).filter((b) =>
          scopes.some((s) => scopeCovers(b.scope, s)),
        )
      : [];
    return ok({
      principal_id: principal,
      kind: p.kind,
      status: p.status,
      breakglass: p.breakglass,
      bindings,
    });
  }
}
