import { scopeCovers, type PrincipalId, type Scope } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  pdpEntityError,
  type PdpBindingFact,
  type PdpEntityError,
  type PdpEntityPort,
  type PdpPrincipalFacts,
} from '@aisdlc/ports';
import type pg from 'pg';

/**
 * The PDP's entities for the kill switch, read from the kill switch's OWN tables: factory admins (its
 * configuration), the project holders core-worker pushed, and the delegations granted here. The same
 * Cedar policies as everywhere (`kill.request`, `kill.release`, the fleet rule) decide; only the facts
 * are the kill switch's own, so a stopped or compromised core cannot change who may kill.
 *
 *   factory admin        -> role factory.admin at the fleet
 *   admin slot holder    -> role project.admin at the project
 *   kill slot holder     -> role project.kill_holder at the project
 *   active delegation    -> role project.kill_holder at the delegated project or lane
 *
 * An unknown principal (no row anywhere) has no facts: the PDP denies.
 */
export class KillswitchEntities implements PdpEntityPort {
  constructor(private readonly pool: pg.Pool) {}

  async principalFacts(
    principal: PrincipalId,
    scopes: readonly Scope[],
    at: Date,
  ): Promise<Result<PdpPrincipalFacts | null, PdpEntityError>> {
    try {
      const all: PdpBindingFact[] = [];
      const fa = await this.pool.query(
        'SELECT 1 FROM killswitch.factory_admin WHERE principal = $1',
        [principal],
      );
      if (fa.rowCount) {
        all.push({
          binding_id: `fa:${principal}`,
          role_id: 'factory.admin',
          group_id: 'killswitch.factory_admin',
          scope: { kind: 'fleet', ref: '*' },
        });
      }
      const h = await this.pool.query<{ project_id: string; slot: string }>(
        'SELECT project_id, slot FROM killswitch.holder WHERE principal = $1',
        [principal],
      );
      for (const r of h.rows) {
        all.push({
          binding_id: `h:${r.project_id}:${r.slot}:${principal}`,
          role_id: r.slot === 'admin' ? 'project.admin' : 'project.kill_holder',
          group_id: `killswitch.${r.slot}`,
          scope: { kind: 'project', ref: r.project_id },
        });
      }
      const d = await this.pool.query<{
        delegation_id: string;
        scope_kind: 'project' | 'lane';
        scope_ref: string;
      }>(
        `SELECT delegation_id, scope_kind, scope_ref FROM killswitch.delegation
          WHERE delegate = $1 AND granted_at <= $2 AND (revoked_at IS NULL OR revoked_at > $2)`,
        [principal, at.toISOString()],
      );
      for (const r of d.rows) {
        all.push({
          binding_id: `d:${r.delegation_id}`,
          role_id: 'project.kill_holder',
          group_id: 'killswitch.delegation',
          scope: { kind: r.scope_kind, ref: r.scope_ref },
        });
      }
      if (all.length === 0) return ok(null);
      return ok({
        principal_id: principal,
        kind: 'human',
        status: 'active',
        breakglass: false,
        bindings: all.filter((b) => scopes.some((s) => scopeCovers(b.scope, s))),
      });
    } catch (e) {
      return err(pdpEntityError('unavailable', e instanceof Error ? e.message : String(e)));
    }
  }
}
