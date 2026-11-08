import { ROLE_CATALOGUE, type PrincipalId, type RoleDef, type Scope } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import {
  pdpEntityError,
  type PdpBindingFact,
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

export class IdentityPdpEntities implements PdpEntityPort {
  constructor(
    private readonly o: { readonly pool: pg.Pool; readonly catalogue?: readonly RoleDef[] },
  ) {}

  async principalFacts(principal: PrincipalId, scopes: readonly Scope[], at: Date) {
    try {
      const fresh = await freshReadModel(this.o.pool);
      if (!fresh.ok) return err(pdpEntityError('unavailable', fresh.error.message));
      const p = await getPrincipal(this.o.pool, principal);
      if (!p) return ok<PdpPrincipalFacts | null>(null);
      const seen = new Map<string, PdpBindingFact>();
      for (const scope of scopes) {
        const found = await effectiveBindings(
          this.o.pool,
          principal,
          scope,
          at,
          this.o.catalogue ?? ROLE_CATALOGUE,
        );
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
