import { readReleaseSetting, type ReleaseRead } from '@aisdlc/config';
import { DeployMarker, GATE_EVENT } from '@aisdlc/contracts';
import { readGateState, type GateState } from '@aisdlc/decisions';
import type pg from 'pg';

// What gate-relay reads from the record database (PLAN M15.3), as its own least-privilege role: the approved G5s it has
// not answered yet (their state folded from the ledger, never a projection), the published release setting,
// gate-check's record of a merge, where a signed pack is, and its own markers. Every read throws on a database error:
// the loop retries, and nothing is released meanwhile (unknown is not released).

export interface PackRow {
  readonly pack_sha256: string;
  readonly item_id: string;
  readonly head_sha: string;
  readonly passing: boolean;
  readonly bucket: string;
  readonly object_key: string;
}

export interface GatedMerge {
  readonly pr_number: number;
  readonly head_sha: string;
  readonly merge_commit_sha: string | null;
  readonly class: string;
}

export interface RelayFactsPort {
  /** Each item's newest G5 instance that gate-relay has neither refused nor released (newest first, at most `limit`). */
  openG5s(limit: number): Promise<string[]>;
  gate(id: string): Promise<GateState | null>;
  release(project: string): Promise<ReleaseRead>;
  /** gate-check's merges of the item's PR in the repo (any class; the caller wants `gated`). */
  merges(repo: string, itemId: string): Promise<GatedMerge[]>;
  pack(packSha256: string): Promise<PackRow | null>;
  /** Markers with no health verdict yet. */
  awaitingHealth(limit: number): Promise<DeployMarker[]>;
  /** The newest healthy release to `environment` of `repo` before `marker` (what a rollback goes back to). */
  lastHealthyRelease(
    repo: string,
    environment: string,
    before: string,
  ): Promise<DeployMarker | null>;
  marker(id: string): Promise<DeployMarker | null>;
}

export class RecordRelayFacts implements RelayFactsPort {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async openG5s(limit: number): Promise<string[]> {
    // the gate's own stream says what it is (row-level security lets this role read `gate:%` streams only, besides
    // its own); an instance with a refusal or a release marker has been answered
    const q = await this.pool.query<{ id: string }>(
      `SELECT substr(e.stream, 6) AS id FROM record.record_event e
        WHERE e.type = $1 AND e.seq = 1 AND e.body ->> 'gate_id' = 'G5' AND e.body ->> 'subject_kind' = 'item'
          AND NOT EXISTS (SELECT 1 FROM gaterelay.refusal r WHERE r.gate_instance_id::text = substr(e.stream, 6))
          AND NOT EXISTS (SELECT 1 FROM gaterelay.deploy_marker m
                           WHERE m.kind = 'release' AND m.gate_instance_id::text = substr(e.stream, 6))
          -- only an item's newest G5: an older one was denied, expired or re-requested, and is never released
          AND NOT EXISTS (SELECT 1 FROM record.record_event n
                           WHERE n.type = $1 AND n.seq = 1 AND n.body ->> 'gate_id' = 'G5'
                             AND n.body ->> 'subject_kind' = 'item'
                             AND n.body ->> 'subject_id' = e.body ->> 'subject_id'
                             AND n.global_seq > e.global_seq)
        ORDER BY e.global_seq DESC LIMIT $2`,
      [GATE_EVENT.opened, limit],
    );
    return q.rows.map((r) => r.id);
  }

  gate(id: string): Promise<GateState | null> {
    return readGateState(this.pool as pg.Pool, id);
  }

  release(project: string): Promise<ReleaseRead> {
    return readReleaseSetting(this.pool, project);
  }

  async merges(repo: string, itemId: string): Promise<GatedMerge[]> {
    const q = await this.pool.query<{
      pr_number: number;
      head_sha: string;
      class: string;
      payload: { merge_commit_sha?: string | null };
    }>(
      `SELECT pr_number, head_sha, class, payload FROM gatecheck.merge
        WHERE repo_key = lower($1) AND item_id = $2 ORDER BY event_gseq`,
      [repo, itemId],
    );
    return q.rows.map((r) => ({
      pr_number: r.pr_number,
      head_sha: r.head_sha,
      class: r.class,
      merge_commit_sha: r.payload.merge_commit_sha ?? null,
    }));
  }

  async pack(packSha256: string): Promise<PackRow | null> {
    const q = await this.pool.query<PackRow>(
      `SELECT pack_sha256, item_id::text AS item_id, head_sha, passing, bucket, object_key
         FROM core.evidence_pack WHERE pack_sha256 = $1`,
      [packSha256],
    );
    return q.rows[0] ?? null;
  }

  async awaitingHealth(limit: number): Promise<DeployMarker[]> {
    const q = await this.pool.query<{ payload: unknown }>(
      `SELECT m.payload FROM gaterelay.deploy_marker m
        WHERE NOT EXISTS (SELECT 1 FROM gaterelay.deploy_health h WHERE h.marker_id = m.marker_id)
        ORDER BY m.event_gseq LIMIT $1`,
      [limit],
    );
    return q.rows.map((r) => DeployMarker.parse(r.payload));
  }

  async lastHealthyRelease(
    repo: string,
    environment: string,
    before: string,
  ): Promise<DeployMarker | null> {
    const q = await this.pool.query<{ payload: unknown }>(
      `SELECT m.payload FROM gaterelay.deploy_marker m
         JOIN gaterelay.deploy_health h ON h.marker_id = m.marker_id AND h.health = 'healthy'
        WHERE m.repo_key = lower($1) AND m.environment = $2 AND m.marker_id <> $3
          AND m.event_gseq < (SELECT event_gseq FROM gaterelay.deploy_marker WHERE marker_id = $3)
        ORDER BY m.event_gseq DESC LIMIT 1`,
      [repo, environment, before],
    );
    const r = q.rows[0];
    return r ? DeployMarker.parse(r.payload) : null;
  }

  async marker(id: string): Promise<DeployMarker | null> {
    const q = await this.pool.query<{ payload: unknown }>(
      'SELECT payload FROM gaterelay.deploy_marker WHERE marker_id = $1',
      [id],
    );
    const r = q.rows[0];
    return r ? DeployMarker.parse(r.payload) : null;
  }
}
