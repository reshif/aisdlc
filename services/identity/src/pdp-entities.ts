import {
  IDENTITY_STREAM_PREFIXES,
  ROLE_CATALOGUE,
  type PrincipalId,
  type RoleDef,
  type Scope,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  pdpEntityError,
  type PdpBindingFact,
  type PdpEntityError,
  type PdpEntityPort,
  type PdpPrincipalFacts,
} from '@aisdlc/ports';
import type pg from 'pg';
import { freshReadModel } from './eligibility.js';
import { effectiveBindings, getPrincipal } from './queries.js';

// The real `PdpEntityPort` (PLAN M4.3): the principal and the bindings in force for it, read from
// the identity read model after catching it up with the journal, so a binding revoked a moment ago
// is already gone. Answers the same shapes as `FakePdpEntities`. Anything that goes wrong is an
// error, which the PDP turns into a deny.
//
// `freshness: 'check'` (PLAN M19, for a service whose database role may READ identity's read model but not fold it,
// such as the audit service): instead of folding, it checks that the identity projection has folded every identity
// event in the record, and answers `unavailable` (a deny) when it is behind. It never answers from a stale model.

/** Is the identity read model caught up with the record? Read-only (no fold). */
export async function identityReadModelCurrent(pool: pg.Pool): Promise<Result<void, string>> {
  const q = await pool.query<{ folded: string | null; head: string | null }>(
    `SELECT (SELECT last_global_seq::text FROM record.projection_checkpoint WHERE name = 'identity') AS folded,
            (SELECT max(global_seq)::text FROM record.record_event
              WHERE stream LIKE ANY($1::text[])) AS head`,
    [IDENTITY_STREAM_PREFIXES.map((p) => `${p}%`)],
  );
  const row = q.rows[0];
  const folded = row?.folded == null ? -1 : Number(row.folded);
  const head = row?.head == null ? 0 : Number(row.head);
  return folded >= head ? ok(undefined) : err('the identity read model is behind the record');
}

export class IdentityPdpEntities implements PdpEntityPort {
  constructor(
    private readonly o: {
      readonly pool: pg.Pool;
      readonly catalogue?: readonly RoleDef[];
      /** `fold` (default): catch the read model up first. `check`: refuse when it is behind (read-only roles). */
      readonly freshness?: 'fold' | 'check';
    },
  ) {}

  /** One batch (M19): the read model caught up once, the principal and the bindings of each scope read once. */
  batch(): PdpEntityPort {
    let fresh: Promise<Result<void, string>> | null = null;
    const principals = new Map<string, ReturnType<typeof getPrincipal>>();
    const scoped = new Map<string, ReturnType<typeof effectiveBindings>>();
    return {
      principalFacts: (principal, scopes, at) =>
        this.facts(principal, scopes, at, {
          fresh: () => (fresh ??= this.catchUp()),
          principal: (id) => {
            let p = principals.get(id);
            if (!p) principals.set(id, (p = getPrincipal(this.o.pool, id)));
            return p;
          },
          bindings: (id, scope, t) => {
            const k = `${id}|${scope.kind}:${scope.ref}|${t.toISOString()}`;
            let b = scoped.get(k);
            if (!b) {
              scoped.set(
                k,
                (b = effectiveBindings(
                  this.o.pool,
                  id,
                  scope,
                  t,
                  this.o.catalogue ?? ROLE_CATALOGUE,
                )),
              );
            }
            return b;
          },
        }),
    };
  }

  private async catchUp(): Promise<Result<void, string>> {
    if (this.o.freshness === 'check') {
      const cur = await identityReadModelCurrent(this.o.pool);
      return cur.ok ? ok(undefined) : err(cur.error);
    }
    const fresh = await freshReadModel(this.o.pool);
    return fresh.ok ? ok(undefined) : err(fresh.error.message);
  }

  principalFacts(principal: PrincipalId, scopes: readonly Scope[], at: Date) {
    return this.facts(principal, scopes, at, {
      fresh: () => this.catchUp(),
      principal: (id) => getPrincipal(this.o.pool, id),
      bindings: (id, scope, t) =>
        effectiveBindings(this.o.pool, id, scope, t, this.o.catalogue ?? ROLE_CATALOGUE),
    });
  }

  private async facts(
    principal: PrincipalId,
    scopes: readonly Scope[],
    at: Date,
    r: {
      fresh: () => Promise<Result<void, string>>;
      principal: (id: string) => ReturnType<typeof getPrincipal>;
      bindings: (id: string, scope: Scope, at: Date) => ReturnType<typeof effectiveBindings>;
    },
  ): Promise<Result<PdpPrincipalFacts | null, PdpEntityError>> {
    try {
      const fresh = await r.fresh();
      if (!fresh.ok) return err(pdpEntityError('unavailable', fresh.error));
      const p = await r.principal(principal);
      if (!p) return ok<PdpPrincipalFacts | null>(null);
      const seen = new Map<string, PdpBindingFact>();
      for (const scope of scopes) {
        const found = await r.bindings(principal, scope, at);
        for (const b of found) {
          seen.set(b.binding_id, {
            binding_id: b.binding_id,
            role_id: b.role_id,
            group_id: b.group_id,
            scope: b.scope,
          });
        }
      }
      return ok<PdpPrincipalFacts | null>({
        principal_id: p.principal_id,
        kind: p.kind,
        status: p.status,
        breakglass: p.breakglass,
        bindings: [...seen.values()].sort((a, b) => (a.binding_id < b.binding_id ? -1 : 1)),
      });
    } catch (e) {
      return err(pdpEntityError('unavailable', e instanceof Error ? e.message : String(e)));
    }
  }
}
