import type { PrincipalId } from '@aisdlc/contracts';
import { freshReadModel, queryGrants, resolveLink } from '@aisdlc/identity/read';
import { err, ok } from '@aisdlc/kernel';
import type pg from 'pg';
import { remoteError, type MergerLinksPort } from '../clients.js';

/**
 * The real `PrincipalLinksPort`: identity's read model (caught up first) answers which principal a
 * GitHub login is linked to. Give it a pool of its own when it is called inside a transaction.
 */
export class DbPrincipalLinks implements MergerLinksPort {
  constructor(private readonly pool: pg.Pool) {}

  /** The principals with a `factory.admin` binding in force at fleet scope now. */
  async factoryAdmins() {
    const fresh = await freshReadModel(this.pool);
    if (!fresh.ok) return err(remoteError('unreachable', 'the identity read model is not current'));
    try {
      const grants = await queryGrants(this.pool, { role: 'factory.admin' }, null, new Date());
      const out = grants
        .filter((g) => g.blockers.length === 0 && g.scope.kind === 'fleet')
        .map((g) => g.principal.principal_id as PrincipalId);
      return ok([...new Set(out)].sort());
    } catch (e) {
      return err(
        remoteError('unreachable', `identity: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }

  async githubLogins(logins: readonly string[]) {
    const fresh = await freshReadModel(this.pool);
    if (!fresh.ok) return err(remoteError('unreachable', 'the identity read model is not current'));
    try {
      const out: Record<string, PrincipalId | null> = {};
      for (const login of new Set(logins.map((l) => l.toLowerCase()))) {
        const p = await resolveLink(this.pool, {
          kind: 'github_login',
          issuer: null,
          value: login,
        });
        out[login] = p && p.status === 'active' ? (p.principal_id as PrincipalId) : null;
      }
      return ok(out);
    } catch (e) {
      return err(
        remoteError('unreachable', `identity: ${e instanceof Error ? e.message : String(e)}`),
      );
    }
  }
}
