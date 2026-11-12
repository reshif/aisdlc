import { readReleaseSetting } from '@aisdlc/config';
import {
  DeployHealthPayload,
  DeployMarker,
  GATERELAY_EVENT,
  GATE_EVENT,
  G5_ENGINE_HASH_KEY,
  G5_FACTS_KEY,
  GitSha,
  ITEM_EVENT,
  ItemEventPayloads,
  ReleaseBinding,
  ServiceEnvironment,
  g5SubjectHash,
  gateRelayStream,
  type Lane,
  type ServiceEnv,
  type ReleaseUnboundReason,
} from '@aisdlc/contracts';
import { readGateState, type GateState } from '@aisdlc/decisions';
import type { Executor, JsonObject } from '@aisdlc/record';
import { readGoverning } from '../prr-store.js';
import { readItemEvents } from '../work-items.js';

// The G5 card's binding (PLAN M15.3; FL F11 "G5 links merged SHA", S8b "gate-relay binds/consumes G5, records merged
// SHA -> evidence SHA"). When the engine opens G5 for an item, core binds the card to what is being released: the
// merged commit the factory observed at 8.2, the item's newest PASSING Evidence Pack, the PR that carried it (whose head
// must be the pack's head: a merge of other content is not this evidence) and the project's release target. The binding
// rides in the card's facts and in G5's subject hash, so an approval is of exactly this merged commit to exactly this
// environment. What core cannot bind is opened `unbound` with the reason: the card says so, and gate-relay releases
// nothing for it whatever the decision. gate-relay checks the binding again, independently, before it deploys.
//
// M17 (DM §3.2 ServiceEnv; OB §3.2 FF2): a project that declared its services at Full (card 3's ledgered
// `service_envs`, bound into the governing readiness record at M4) releases only to those: the target must be exactly
// one ServiceEnv (the setting's environment, and its service when several deploy there), which the binding names;
// any other target is `target_not_attested`. An L5 change also needs staging separation (FF2 met, a staging
// ServiceEnv of the service): its first G5 binds the service's STAGING environment, and only once the item's release
// of the merged commit there is healthy does a re-requested G5 bind production (staging before production). A project
// that declared none (below Full) keeps the setting's environment, and an L5 item there is unbound.

interface Item {
  readonly item_id: string;
  readonly project_id: string;
  readonly repo: string;
  /** The item's bound lane (L5 releases to staging first). */
  readonly lane?: Lane | null;
}

/** The item's own healthy release of `merged` to `environment` (gate-relay's record of it on `gaterelay:<item>`). */
export async function healthyReleaseOf(
  db: Executor,
  itemId: string,
  merged: string,
  environment: string,
): Promise<boolean> {
  const q = await db.query<{ type: string; body: unknown }>(
    'SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq',
    [gateRelayStream(itemId)],
  );
  const markers = new Set<string>();
  for (const e of q.rows) {
    if (e.type === GATERELAY_EVENT.deployment_created) {
      const m = DeployMarker.safeParse(e.body);
      if (
        m.success &&
        m.data.kind === 'release' &&
        m.data.environment === environment &&
        m.data.merged_sha === merged
      )
        markers.add(m.data.marker_id);
    } else if (e.type === GATERELAY_EVENT.deploy_healthy) {
      const h = DeployHealthPayload.safeParse(e.body);
      if (h.success && markers.has(h.data.marker_id)) return true;
    }
  }
  return false;
}

/**
 * The ServiceEnv a release to `target` binds to, from the attested environments, or why it cannot. Pure but for the
 * staging check, which the caller answers.
 */
export async function serviceEnvOf(
  envs: { readonly envs: readonly ServiceEnv[]; readonly ff2: string },
  target: { readonly environment: string; readonly service?: string | undefined },
  lane: Lane | null | undefined,
  stagingHealthy: (staging: ServiceEnv) => Promise<boolean>,
): Promise<{ env: ServiceEnv } | { unbound: ReleaseUnboundReason }> {
  const environment = ServiceEnvironment.safeParse(target.environment);
  if (!environment.success) return { unbound: 'target_not_attested' };
  const hits = envs.envs.filter(
    (e) =>
      e.environment === environment.data &&
      (target.service === undefined || e.service === target.service),
  );
  // exactly one: several services deploying there need the setting to name one
  const env = hits.length === 1 ? hits[0] : undefined;
  if (!env) return { unbound: 'target_not_attested' };
  if (lane !== 'L5') return { env };
  if (envs.ff2 !== 'met') return { unbound: 'staging_separation_not_attested' };
  if (env.environment !== 'production') return { env };
  const staging = envs.envs.find((e) => e.service === env.service && e.environment === 'staging');
  if (!staging) return { unbound: 'staging_separation_not_attested' };
  return (await stagingHealthy(staging)) ? { env } : { env: staging };
}

/** The binding of an item's G5 now (never throws for a missing fact: that is `unbound`; a database error throws). */
export async function releaseBindingOf(db: Executor, s: Item): Promise<ReleaseBinding> {
  const ids = { item_id: s.item_id, project_id: s.project_id, repo: s.repo } as const;
  const unbound = (reason: ReleaseUnboundReason): ReleaseBinding =>
    ReleaseBinding.parse({ status: 'unbound', ...ids, reason });
  const events = await readItemEvents(db, s.item_id);
  const merged = events.filter((e) => e.type === ITEM_EVENT.merge_observed).at(-1);
  // the one shape M15.2's merge reconcile writes (the PR's merge commit on the host); a short or unparsable sha binds nothing
  const observed = ItemEventPayloads[ITEM_EVENT.merge_observed].safeParse(merged?.payload);
  const sha = observed.success ? GitSha.safeParse(observed.data.merged_sha) : null;
  if (!sha?.success) return unbound('no_merge_observed');
  const mergedSha = sha.data;
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
  const target = release.value;
  const bound = {
    status: 'bound',
    ...ids,
    pr_number: pull.number,
    unit_key: p.unit_key,
    merged_sha: mergedSha,
    pack_sha256: p.pack_sha256,
    pack_head_sha: p.head_sha,
  } as const;
  // M17: the attested environments (card 3's ledgered `service_envs`, as M4 bound them into the governing record)
  const declared = (await readGoverning(db, s.repo))?.governing?.prr.affirmed.full?.service_envs;
  if (!declared) {
    if (s.lane === 'L5') return unbound('staging_separation_not_attested');
    return ReleaseBinding.parse({ ...bound, environment: target.environment });
  }
  const r = await serviceEnvOf(declared, target, s.lane, (staging) =>
    healthyReleaseOf(db, s.item_id, mergedSha, staging.environment),
  );
  if ('unbound' in r) return unbound(r.unbound);
  return ReleaseBinding.parse({
    ...bound,
    environment: r.env.environment,
    service_env: r.env,
    ...(r.env.environment === target.environment ? {} : { target_environment: target.environment }),
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
