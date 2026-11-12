import {
  EVIDENCE_BUCKET,
  G5_ENGINE_HASH_KEY,
  G5_FACTS_KEY,
  ReleaseBinding,
  checkSignedEvidencePack,
  deployMarkerId,
  g5SubjectHash,
  healthOf,
  releaseTargetHolds,
  type DeployMarker,
  type DeploymentTag,
  type ReleaseRefusal,
} from '@aisdlc/contracts';
import type { NotaryKeyPort, PackBytesPort } from '@aisdlc/gate-check';
import { hashCanonical, systemClock, type Clock } from '@aisdlc/kernel';
import type { DeploymentRead, GateRelayHostPort } from '@aisdlc/ports';
import type { RelayFactsPort } from './facts.js';
import type { GateRelayStore } from './store.js';

// The release relay (PLAN M15.3; FL S8b "gate-relay binds/consumes G5, records merged SHA -> evidence SHA", B16). Two
// jobs, each a supervised loop:
//
//   consume   every item's newest G5 that is decided `approve` in the ledger and not yet answered: the binding on its
//             card is checked again HERE (the subject hash is the binding's, the gate wanted a step-up, the project's
//             target is still that environment, gate-check recorded a GATED merge of exactly the pack's head as exactly
//             the merged commit, and the pack verifies offline with the Notary's public key), then ONE deployment of
//             the merged commit is created through gate-relay's own App. Exactly once: the intent is recorded first,
//             the host is asked for a deployment already tagged with this G5 before one is created, and the marker is
//             one per G5 instance. Anything that does not hold is a recorded refusal (core's S8b then holds the
//             release: RELHOLD); a dependency that does not answer is a retry, never a release.
//   observe   every marker with no verdict: the newest status the deploy system wrote. Success is healthy; failure or
//             error is unhealthy, and a release that is unhealthy is rolled back to the environment's last healthy
//             release (a rollback deployment, its own marker), B16. Pending stays pending: unknown is not released.

export interface RelayDeps {
  readonly host: GateRelayHostPort;
  readonly facts: RelayFactsPort;
  readonly packs: PackBytesPort;
  readonly notaryKey: NotaryKeyPort;
  readonly store: GateRelayStore;
  readonly clock?: Clock;
  readonly batch?: number;
}

/** A consume that cannot be decided now (a dependency did not answer): retried next tick, nothing recorded. */
export class RelayRetry extends Error {}

export type ConsumeResult =
  | { readonly kind: 'skipped'; readonly why: string }
  | { readonly kind: 'refused'; readonly reason: ReleaseRefusal }
  | { readonly kind: 'released'; readonly marker: DeployMarker; readonly reused: boolean };

type Bound = Extract<ReleaseBinding, { status: 'bound' }>;

export class GateRelay {
  private readonly clock: Clock;

  constructor(private readonly d: RelayDeps) {
    this.clock = d.clock ?? systemClock;
  }

  /** One consume pass over the open G5s; returns what came of each. */
  async consumeAll(): Promise<ConsumeResult[]> {
    const ids = await this.d.facts.openG5s(this.d.batch ?? 200);
    const out: ConsumeResult[] = [];
    const failed: string[] = [];
    for (const id of ids) {
      try {
        out.push(await this.consume(id));
      } catch (e) {
        failed.push(`${id}: ${e instanceof Error ? e.message : String(e)}`.slice(0, 200));
      }
    }
    if (failed.length > 0) throw new Error(failed.join('; '));
    return out;
  }

  /** Consumes one G5 instance: refused, released, or skipped (not approved). */
  async consume(gateId: string): Promise<ConsumeResult> {
    const g = await this.d.facts.gate(gateId);
    if (!g) return { kind: 'skipped', why: 'no_gate' };
    const open = g.open.payload;
    if (open.gate_id !== 'G5' || open.subject_kind !== 'item')
      return { kind: 'skipped', why: 'not_g5' };
    // only a decided approval is ever released; pending waits, a denial or an expiry is never one
    if (g.status !== 'decided' || g.outcome !== 'approve')
      return { kind: 'skipped', why: `status_${g.status}` };
    const facts = open.facts as Record<string, unknown>;
    const parsed = ReleaseBinding.safeParse(facts[G5_FACTS_KEY]);
    const refuse = async (reason: ReleaseRefusal, detail: string): Promise<ConsumeResult> => {
      await this.d.store.refuse({
        item_id: open.subject_id as never,
        project_id: open.project_id,
        gate_instance_id: gateId as never,
        reason,
        detail: detail.slice(0, 200),
        refused_at: this.clock.now().toISOString(),
      });
      return { kind: 'refused', reason };
    };
    const engine = facts[G5_ENGINE_HASH_KEY];
    if (
      !parsed.success ||
      typeof engine !== 'string' ||
      g5SubjectHash(engine, parsed.data) !== open.subject_hash ||
      parsed.data.item_id !== open.subject_id ||
      parsed.data.project_id !== open.project_id
    ) {
      return refuse('subject_mismatch', 'the subject hash is not the binding’s');
    }
    if (!open.step_up.required) return refuse('no_step_up', 'G5 was opened without a step-up');
    const b = parsed.data;
    if (b.status === 'unbound') return refuse('unbound', b.reason);

    // the project's target is still this one: the environment (and the service, M17), or for an L5 staging-first
    // release exactly its service's staging environment
    const rel = await this.d.facts.release(b.project_id);
    if (rel.state !== 'ok' || !releaseTargetHolds(b, rel.value)) {
      return refuse(
        'target_changed',
        rel.state === 'ok' ? (rel.value?.mode ?? 'not_chosen') : 'unreadable',
      );
    }
    // gate-check's own observation: the PR was merged GATED at the pack's head, as exactly the merged commit
    const merges = await this.d.facts.merges(b.repo, b.item_id);
    const gated = merges.some(
      (m) =>
        m.class === 'gated' &&
        m.pr_number === b.pr_number &&
        m.head_sha === b.pack_head_sha &&
        m.merge_commit_sha === b.merged_sha,
    );
    if (!gated) {
      return refuse(
        'merged_content_mismatch',
        merges.length === 0 ? 'no merge recorded by gate-check' : 'no gated merge of the pack head',
      );
    }
    const pack = await this.verifiedPack(b);
    if (pack !== null) return refuse('pack_invalid', pack);
    return this.deploy(gateId, b, {
      kind: 'release',
      merged_sha: b.merged_sha,
      pack_sha256: b.pack_sha256,
      rollback_of: null,
    });
  }

  /** `null` when the bound pack verifies offline for the bound head and item; else why not. Throws when unknown. */
  private async verifiedPack(b: Bound): Promise<string | null> {
    const row = await this.d.facts.pack(b.pack_sha256);
    if (!row) return 'no such pack';
    if (!row.passing || row.head_sha !== b.pack_head_sha || row.item_id !== b.item_id)
      return 'the pack is not the passing pack of the bound head';
    const key = await this.d.notaryKey.get();
    if (key === null) throw new RelayRetry('the Notary public key is unavailable');
    if (row.bucket !== EVIDENCE_BUCKET) return 'the pack is not in the evidence bucket';
    const declared = await this.d.packs.declareBucket(EVIDENCE_BUCKET, 'write_once');
    if (!declared.ok) throw new RelayRetry('the object store is unavailable');
    const got = await this.d.packs.get(row.bucket, row.object_key);
    if (!got.ok) {
      if (got.error.code === 'not_found') return 'the pack bytes are gone';
      if (got.error.code === 'hash_mismatch') return 'the pack bytes do not hash to their key';
      throw new RelayRetry('the object store is unavailable');
    }
    const c = await checkSignedEvidencePack(got.value, key, {
      head_sha: b.pack_head_sha,
      item_id: b.item_id,
      object_key: row.object_key,
    });
    if (!c.ok) return `pack: ${c.code}`;
    if (
      c.signed.pack_sha256 !== b.pack_sha256 ||
      c.signed.pack.repo.toLowerCase() !== b.repo.toLowerCase()
    )
      return 'the pack does not bind this repo';
    return null;
  }

  /** Record-first: the intent, then the host (a deployment already tagged with this G5 is reused), then the marker. */
  private async deploy(
    gateId: string,
    b: Bound,
    o: {
      kind: 'release' | 'rollback';
      merged_sha: string;
      pack_sha256: string;
      rollback_of: string | null;
    },
  ): Promise<ConsumeResult> {
    const marker_id = deployMarkerId(gateId, o.kind);
    const binding_sha256 = hashCanonical(b);
    await this.d.store.intend({
      item_id: b.item_id,
      gate_instance_id: gateId as never,
      binding_sha256,
      marker_id,
      kind: o.kind,
      repo: b.repo,
      environment: b.environment,
      merged_sha: o.merged_sha,
    });
    const tag: DeploymentTag = {
      aisdlc: {
        item_id: b.item_id,
        gate_instance_id: gateId as never,
        kind: o.kind,
        binding_sha256,
      },
    };
    const listed = await this.d.host.list_deployments({
      repo: b.repo,
      sha: o.merged_sha,
      environment: b.environment,
    });
    // no answer is asked again; a definite refusal (no permission, no such repo) is the host's refusal
    if (listed.state === 'unknown') throw new RelayRetry(`list deployments: ${listed.reason}`);
    let dep: DeploymentRead | undefined =
      listed.state === 'ok'
        ? listed.value.find(
            (x) => x.tag?.aisdlc.gate_instance_id === gateId && x.tag.aisdlc.kind === o.kind,
          )
        : undefined;
    const reused = dep !== undefined;
    if (!dep) {
      const made =
        listed.state === 'ok'
          ? await this.d.host.create_deployment({
              repo: b.repo,
              sha: o.merged_sha,
              environment: b.environment,
              description:
                o.kind === 'release'
                  ? `aisdlc G5 release ${gateId}`
                  : `aisdlc B16 rollback ${gateId}`,
              tag,
            })
          : listed;
      if (made.state === 'unknown') throw new RelayRetry(`create deployment: ${made.reason}`);
      if (made.state !== 'ok') {
        if (o.kind === 'release') {
          await this.d.store.refuse({
            item_id: b.item_id,
            project_id: b.project_id,
            gate_instance_id: gateId as never,
            reason: 'host_refused',
            detail: `${made.reason}`.slice(0, 200),
            refused_at: this.clock.now().toISOString(),
          });
          return { kind: 'refused', reason: 'host_refused' };
        }
        throw new RelayRetry(`rollback refused by the host: ${made.reason}`);
      }
      dep = made.value;
    }
    const marker: DeployMarker = {
      marker_id,
      kind: o.kind,
      item_id: b.item_id,
      project_id: b.project_id,
      repo: b.repo,
      environment: b.environment,
      merged_sha: o.merged_sha as never,
      pack_sha256: o.pack_sha256 as never,
      gate_instance_id: gateId as never,
      binding_sha256: binding_sha256 as never,
      deployment_id: dep.id,
      rollback_of: o.rollback_of,
      created_at: this.clock.now().toISOString(),
    };
    await this.d.store.marker(marker);
    return { kind: 'released', marker, reused };
  }

  /** One observe pass: the health of every marker that has no verdict yet. Returns the verdicts recorded. */
  async observeAll(): Promise<Array<{ marker_id: string; health: 'healthy' | 'unhealthy' }>> {
    const markers = await this.d.facts.awaitingHealth(this.d.batch ?? 200);
    const out: Array<{ marker_id: string; health: 'healthy' | 'unhealthy' }> = [];
    for (const m of markers) {
      const st = await this.d.host.deployment_statuses({
        repo: m.repo,
        deployment_id: m.deployment_id,
      });
      if (st.state !== 'ok') continue; // no answer is not a verdict
      const newest = st.value[0]?.state ?? null;
      const health = healthOf(newest);
      if (health === 'pending' || newest === null) continue;
      const base = {
        item_id: m.item_id,
        marker_id: m.marker_id,
        deployment_id: m.deployment_id,
        state: newest,
        observed_at: this.clock.now().toISOString(),
      };
      if (health === 'healthy') {
        await this.d.store.health('healthy', base);
      } else {
        const rollback = m.kind === 'release' ? await this.rollback(m) : null;
        await this.d.store.health('unhealthy', { ...base, rollback_marker_id: rollback });
      }
      out.push({ marker_id: m.marker_id, health });
    }
    return out;
  }

  /** B16: deploys the environment's last healthy release again; its marker id, or `null` when there is none. */
  private async rollback(m: DeployMarker): Promise<string | null> {
    const prev = await this.d.facts.lastHealthyRelease(m.repo, m.environment, m.marker_id);
    if (!prev) return null;
    const g = await this.d.facts.gate(m.gate_instance_id);
    const b = ReleaseBinding.safeParse(
      (g?.open.payload.facts as Record<string, unknown> | undefined)?.[G5_FACTS_KEY],
    );
    if (!b.success || b.data.status !== 'bound') return null;
    const r = await this.deploy(m.gate_instance_id, b.data, {
      kind: 'rollback',
      merged_sha: prev.merged_sha,
      pack_sha256: prev.pack_sha256,
      rollback_of: m.marker_id,
    });
    return r.kind === 'released' ? r.marker.marker_id : null;
  }
}
