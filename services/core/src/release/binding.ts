import { readReleaseSetting } from '@aisdlc/config';
import {
  GATE_EVENT,
  G5_ENGINE_HASH_KEY,
  G5_FACTS_KEY,
  ITEM_EVENT,
  ReleaseBinding,
  g5SubjectHash,
  type ReleaseUnboundReason,
} from '@aisdlc/contracts';
import { readGateState, type GateState } from '@aisdlc/decisions';
import type { Executor, JsonObject } from '@aisdlc/record';
import { readItemEvents } from '../work-items.js';

// The G5 card's binding (PLAN M15.3; FL F11 "G5 links merged SHA", S8b "gate-relay binds/consumes G5, records merged
// SHA -> evidence SHA"). When the engine opens G5 for an item, core binds the card to what is being released: the
// merged commit the factory observed at 8.2, the item's newest PASSING Evidence Pack, the PR that carried it (whose head
// must be the pack's head: a merge of other content is not this evidence) and the project's release target. The binding
// rides in the card's facts and in G5's subject hash, so an approval is of exactly this merged commit to exactly this
// environment. What core cannot bind is opened `unbound` with the reason: the card says so, and gate-relay releases
// nothing for it whatever the decision. gate-relay checks the binding again, independently, before it deploys.

interface Item {
  readonly item_id: string;
  readonly project_id: string;
  readonly repo: string;
}

/** The binding of an item's G5 now (never throws for a missing fact: that is `unbound`; a database error throws). */
export async function releaseBindingOf(db: Executor, s: Item): Promise<ReleaseBinding> {
  const ids = { item_id: s.item_id, project_id: s.project_id, repo: s.repo } as const;
  const unbound = (reason: ReleaseUnboundReason): ReleaseBinding =>
    ReleaseBinding.parse({ status: 'unbound', ...ids, reason });
  const events = await readItemEvents(db, s.item_id);
  const merged = events.filter((e) => e.type === ITEM_EVENT.merge_observed).at(-1);
  const mergedSha = (merged?.payload as { merged_sha?: unknown } | undefined)?.merged_sha;
  if (typeof mergedSha !== 'string' || !/^[0-9a-f]{40}$/.test(mergedSha))
    return unbound('no_merge_observed');
  const pack = await db.query<{ pack_sha256: string; head_sha: string; unit_key: string }>(
    `SELECT pack_sha256, head_sha, unit_key FROM core.evidence_pack
      WHERE item_id = $1 AND passing ORDER BY event_gseq DESC LIMIT 1`,
    [s.item_id],
  );
  const p = pack.rows[0];
  if (!p) return unbound('no_passing_pack');
  const pr = await db.query<{ number: number; head_sha: string }>(
    `SELECT number, head_sha FROM core.pull_request WHERE item_id = $1 AND unit_key = $2
      ORDER BY number DESC LIMIT 1`,
    [s.item_id, p.unit_key],
  );
  const pull = pr.rows[0];
  if (!pull) return unbound('no_pull_request');
  if (pull.head_sha !== p.head_sha) return unbound('pack_head_not_pr_head');
  const release = await readReleaseSetting(db, s.project_id);
  if (release.state !== 'ok' || release.value?.mode !== 'target')
    return unbound('no_release_target');
  return ReleaseBinding.parse({
    status: 'bound',
    ...ids,
    pr_number: pull.number,
    unit_key: p.unit_key,
    merged_sha: mergedSha,
    pack_sha256: p.pack_sha256,
    pack_head_sha: p.head_sha,
    environment: release.value.environment,
  });
}

/** G5's card facts and subject hash: the engine's facts with the binding, and both hashes bound together. */
export function g5Card(
  engine: { readonly subject_hash: string; readonly facts: JsonObject },
  binding: ReleaseBinding,
): { subject_hash: string; facts: JsonObject } {
  return {
    subject_hash: g5SubjectHash(engine.subject_hash, binding),
    facts: {
      ...engine.facts,
      [G5_FACTS_KEY]: binding as unknown as JsonObject,
      [G5_ENGINE_HASH_KEY]: engine.subject_hash,
    },
  };
}

/** The item's newest G5 instance with its state folded from the ledger (never a projection), or `null`. */
export async function latestG5(
  db: Executor,
  itemId: string,
): Promise<{ gate_instance_id: string; state: GateState } | null> {
  const q = await db.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2
        AND body ->> 'gate_id' = 'G5' AND body ->> 'subject_kind' = 'item'
      ORDER BY global_seq DESC LIMIT 1`,
    [GATE_EVENT.opened, itemId],
  );
  const stream = q.rows[0]?.stream;
  if (stream === undefined) return null;
  const id = stream.slice('gate:'.length);
  const state = await readGateState(db, id);
  return state ? { gate_instance_id: id, state } : null;
}
