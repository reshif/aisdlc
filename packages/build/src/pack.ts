import { validateOutput } from '@aisdlc/agents';
import type { TreeManifest } from '@aisdlc/tripwires';
import { diffManifests } from '@aisdlc/tripwires';
import type { SessionState } from './store.js';

// The Handoff Pack of D1 (FL "A11 Handoff Pack"): what was tried, what is failing, the diffs by hash. A11 is the
// agent of record; its pack is built here from the facts of the session, deterministically, and validated against
// A11's own output schema (`handoff_pack`), so a pack always has the shape the owner at E4 expects. Nothing in it is
// a model's word about itself: every line is a fact the factory holds (a round, a hash, a failing test name).
// The richer record (failing tests, diffs by hash) is stored beside it; the engine binds its hash into the Handoff.

export interface HandoffPackRecord {
  readonly schema: 'handoff-pack/1';
  readonly item_id: string;
  readonly unit_key: string;
  readonly trigger: string;
  readonly reason_code: string;
  /** A11's output (`handoff_pack`), validated. */
  readonly pack: unknown;
  readonly failing_tests: readonly string[];
  /** Each changed file by path and the hashes of both sides: the diff is the two blobs, by hash. */
  readonly diffs: ReadonlyArray<{
    path: string;
    change: 'added' | 'modified' | 'deleted';
    before_sha256: string | null;
    after_sha256: string | null;
  }>;
  readonly base_tree_sha256: string;
  readonly tree_sha256: string;
  readonly rounds: number;
  readonly tainted: boolean;
  readonly snapshot_ref: string | null;
}

export function buildHandoffPack(
  s: SessionState,
  base: TreeManifest,
  now: TreeManifest,
  o: {
    trigger: string;
    reason_code: string;
    failing: readonly string[];
    open_questions?: readonly string[];
  },
): HandoffPackRecord {
  const d = diffManifests(base, now);
  const diffs = [
    ...d.added.map((p) => ({
      path: p,
      change: 'added' as const,
      before_sha256: null,
      after_sha256: now[p]?.sha256 ?? null,
    })),
    ...d.modified.map((p) => ({
      path: p,
      change: 'modified' as const,
      before_sha256: base[p]?.sha256 ?? null,
      after_sha256: now[p]?.sha256 ?? null,
    })),
    ...d.deleted.map((p) => ({
      path: p,
      change: 'deleted' as const,
      before_sha256: base[p]?.sha256 ?? null,
      after_sha256: null,
    })),
  ].slice(0, 500);
  const attempted = s.rounds.length
    ? s.rounds
        .slice(-30)
        .map(
          (r) =>
            `round ${r.round} on task ${r.task_id}: ${r.note}${r.failing.length ? ` (failing: ${r.failing.slice(0, 5).join(', ')})` : ''}`,
        )
    : [`no round finished before ${o.trigger} (${o.reason_code})`];
  const pack = {
    kind: 'handoff_pack',
    attempted: attempted.map((a) => a.slice(0, 1000)),
    current_state: `Stopped by ${o.trigger} (${o.reason_code}) with ${diffs.length} files changed against the base tree ${s.base_tree_sha256.slice(0, 12)}; workspace ${s.tree_sha256.slice(0, 12)}; ${o.failing.length} failing tests.`,
    open_questions: [...(o.open_questions ?? [])].slice(0, 30).map((q) => q.slice(0, 500)),
  };
  const v = validateOutput('A11', pack);
  if (!v.ok)
    throw new Error(
      `the handoff pack does not validate against A11's schema: ${JSON.stringify(v.error)}`,
    );
  return {
    schema: 'handoff-pack/1',
    item_id: s.item_id,
    unit_key: s.unit_key,
    trigger: o.trigger,
    reason_code: o.reason_code,
    pack: v.value,
    failing_tests: [...o.failing].slice(0, 200),
    diffs,
    base_tree_sha256: s.base_tree_sha256,
    tree_sha256: s.tree_sha256,
    rounds: s.rounds.length,
    tainted: s.tainted,
    snapshot_ref: s.snapshot_ref,
  };
}
