import type { SessionStore } from '@aisdlc/build';
import type { Constitution } from '@aisdlc/contracts';
import { err, ok } from '@aisdlc/kernel';
import type { RunKeyLender, SessionGuardDeps, StagePorts } from '@aisdlc/ports';
import type { VerifyClient } from '@aisdlc/verify';
import type pg from 'pg';
import type { KnowledgePort } from '../clients.js';
import { AgentVerifyPort } from './port.js';

/**
 * The stage ports of a deployment that verifies with the verify service (PLAN M14.3): `verify` is the
 * `AgentVerifyPort` (S7 7.1 to 7.5, and the 7.6 guard in front of `base.verify` until M14.4), the rest are `base`.
 * The DEC-18 owner allow-list and B1 are asked before any check, as in front of every S6 session.
 */
export function verifyStagePorts(o: {
  readonly pool: pg.Pool;
  readonly base: StagePorts;
  readonly client: VerifyClient;
  readonly keys: RunKeyLender;
  readonly constitution: () => Constitution | null;
  readonly execAllowedRepos: () => readonly string[] | null;
  readonly knowledge: Pick<KnowledgePort, 'openFindings'>;
  /** S6's session store (the session's locks), when this process runs S6 too. */
  readonly store?: SessionStore;
}): StagePorts {
  const guard: SessionGuardDeps = {
    execAllowedRepos: o.execAllowedRepos,
    hasOpenSecretFinding: async (repo) => {
      const r = await o.knowledge.openFindings(repo);
      // knowledge unreachable is "cannot tell": B1 blocks (fail closed)
      return r.ok ? ok(r.value.length > 0) : err({ message: r.error.message });
    },
  };
  const verify = new AgentVerifyPort({
    pool: o.pool,
    client: o.client,
    keys: o.keys,
    fallback: o.base.verify,
    constitution: o.constitution,
    guard,
    ...(o.store ? { store: o.store } : {}),
  });
  return { ...o.base, verify };
}
