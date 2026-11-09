import { readPrompt } from '@aisdlc/agents/files';
import {
  AgentCodingPort,
  GitBundleFiles,
  SessionStore,
  StoreWaitSnapshots,
  type BundleReads,
} from '@aisdlc/build';
import { err, ok } from '@aisdlc/kernel';
import {
  type RunKeyLender,
  type SandboxPort,
  type SessionGuardDeps,
  type StagePorts,
  type WaitSnapshotPort,
} from '@aisdlc/ports';
import type pg from 'pg';
import type { KnowledgePort } from '../clients.js';
import { CoreBuildSource } from './source.js';

/**
 * The stage ports of a deployment that builds with real sessions: `coding` is the `AgentCodingPort` (S6 6.1 to 6.5; 6.0
 * is the driver's admission and 6.6 is the Push Broker's, M13.6: both stay with `base.coding`), the rest are `base`.
 *
 *   sandbox   the `SandboxPort` in front of the coding proxy (the `DockerSandboxDriver`), wrapped here in the DEC-18 owner
 *             allow-list and B1 (`GuardedSandbox`): a caller that forgets a check is still stopped
 *   store     the session store (workspaces, locks, snapshots, packs): a scratch directory, nothing in it is authoritative
 *   guard     `sandbox.exec_allowed_repos` from the config reader (M1-gated) and knowledge's open findings (B1)
 *
 * It also answers HUMAN-WAIT's snapshots from the same store (`snapshots`): hand it to the work driver's admission.
 */
export function buildStagePorts(o: {
  readonly pool: pg.Pool;
  readonly base: StagePorts;
  readonly sandbox: SandboxPort;
  readonly storeDir: string;
  readonly keys: RunKeyLender;
  /** The code host's bundle route (`HttpBundleSource`): the repo at the Unit's base commit. */
  readonly bundles: BundleReads;
  readonly knowledge: Pick<KnowledgePort, 'openFindings'>;
  readonly execAllowedRepos: () => readonly string[] | null;
  readonly model: string;
  readonly now?: () => number;
}): { stagePorts: StagePorts; snapshots: WaitSnapshotPort; store: SessionStore } {
  const store = new SessionStore(o.storeDir);
  const guard: SessionGuardDeps = {
    execAllowedRepos: o.execAllowedRepos,
    hasOpenSecretFinding: async (repo) => {
      const r = await o.knowledge.openFindings(repo);
      // knowledge unreachable is "cannot tell": B1 blocks (fail closed)
      return r.ok ? ok(r.value.length > 0) : err({ message: r.error.message });
    },
  };
  const coding = new AgentCodingPort({
    sandbox: o.sandbox,
    store,
    source: new CoreBuildSource({ pool: o.pool, repo: new GitBundleFiles(o.bundles) }),
    guard,
    keys: o.keys,
    fallback: o.base.coding,
    model: o.model,
    prompt: readPrompt,
    ...(o.now ? { now: o.now } : {}),
  });
  return { stagePorts: { ...o.base, coding }, snapshots: new StoreWaitSnapshots(store), store };
}
