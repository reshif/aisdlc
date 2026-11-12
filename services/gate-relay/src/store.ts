import {
  DeployHealthPayload,
  DeployMarker,
  GATERELAY_EVENT,
  ReleaseIntendedPayload,
  ReleaseRefusedPayload,
  gateRelayStream,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import type { Clock } from '@aisdlc/kernel';
import { systemClock } from '@aisdlc/kernel';
import { appendEvents, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';

// gate-relay's record (PLAN M15.3): every step of a release is a `gaterelay.*` event on the item's stream
// `gaterelay:<item>`, the read model row written in the same transaction, and rebuilt from the events alone
// (`rebuildGateRelay`). Record-first: the intent is recorded before the host is asked, the marker once it answered.
// Each event's idempotency key is its fact (`intent:<marker>`, `marker:<marker>`, `refused:<gate>`, `health:<marker>`),
// so a retry, or a second process, records it once.

export const GATE_RELAY_RECORD_ACTOR = 'system.gate-relay';

type Row = { global_seq: number; occurred_at: string };

async function projectIntent(tx: pg.PoolClient, p: ReleaseIntendedPayload, e: Row) {
  await tx.query(
    `INSERT INTO gaterelay.intent (marker_id, gate_instance_id, kind, item_id, repo_key, environment, merged_sha,
       event_gseq)
     VALUES ($1, $2, $3, $4, lower($5), $6, $7, $8) ON CONFLICT DO NOTHING`,
    [
      p.marker_id,
      p.gate_instance_id,
      p.kind,
      p.item_id,
      p.repo,
      p.environment,
      p.merged_sha,
      e.global_seq,
    ],
  );
}

async function projectRefusal(tx: pg.PoolClient, p: ReleaseRefusedPayload, e: Row) {
  await tx.query(
    `INSERT INTO gaterelay.refusal (gate_instance_id, item_id, project_id, reason, detail, event_gseq, refused_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING`,
    [p.gate_instance_id, p.item_id, p.project_id, p.reason, p.detail, e.global_seq, p.refused_at],
  );
}

async function projectMarker(tx: pg.PoolClient, m: DeployMarker, e: Row) {
  await tx.query(
    `INSERT INTO gaterelay.deploy_marker (marker_id, kind, gate_instance_id, item_id, project_id, repo_key, environment,
       merged_sha, pack_sha256, deployment_id, rollback_of, payload, event_gseq, created_at)
     VALUES ($1, $2, $3, $4, $5, lower($6), $7, $8, $9, $10, $11, $12, $13, $14) ON CONFLICT DO NOTHING`,
    [
      m.marker_id,
      m.kind,
      m.gate_instance_id,
      m.item_id,
      m.project_id,
      m.repo,
      m.environment,
      m.merged_sha,
      m.pack_sha256,
      m.deployment_id,
      m.rollback_of,
      JSON.stringify(m),
      e.global_seq,
      m.created_at,
    ],
  );
}

async function projectHealth(
  tx: pg.PoolClient,
  type: string,
  p: DeployHealthPayload,
  e: Row,
): Promise<void> {
  await tx.query(
    `INSERT INTO gaterelay.deploy_health (marker_id, health, state, rollback_marker_id, event_gseq, observed_at)
     VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT DO NOTHING`,
    [
      p.marker_id,
      type === GATERELAY_EVENT.deploy_healthy ? 'healthy' : 'unhealthy',
      p.state,
      p.rollback_marker_id ?? null,
      e.global_seq,
      p.observed_at,
    ],
  );
}

export interface GateRelayStore {
  intend(p: ReleaseIntendedPayload): Promise<void>;
  refuse(p: ReleaseRefusedPayload): Promise<void>;
  marker(m: DeployMarker): Promise<void>;
  health(type: 'healthy' | 'unhealthy', p: DeployHealthPayload): Promise<void>;
}

export class RecordGateRelayStore implements GateRelayStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly clock: Clock = systemClock,
  ) {}

  private async append(
    stream: string,
    type: string,
    body: JsonObject,
    key: string,
    project: (tx: pg.PoolClient, e: Row) => Promise<void>,
  ): Promise<void> {
    await withTransaction(this.pool, async (tx) => {
      for (let i = 0; i < 8; i++) {
        const head = await tx.query<{ seq: string }>(
          'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
          [stream],
        );
        const a = await appendEvents(
          tx,
          stream,
          Number(head.rows[0]?.seq ?? 0),
          [{ type, body, actor: GATE_RELAY_RECORD_ACTOR, idempotency_key: key }],
          { clock: this.clock },
        );
        if (a.ok) {
          const e = a.value.events[0];
          if (!e) throw new Error('the record appended nothing');
          if (!a.value.duplicate)
            await project(tx, { global_seq: e.global_seq, occurred_at: e.occurred_at });
          return;
        }
        if (a.error._tag === 'IdempotencyMismatch') return;
        if (a.error._tag !== 'ConcurrencyConflict')
          throw new Error(`record append refused: ${a.error._tag}`);
      }
      throw new Error('record append: too many conflicts');
    });
  }

  async intend(raw: ReleaseIntendedPayload): Promise<void> {
    const p = ReleaseIntendedPayload.parse(raw);
    await this.append(
      gateRelayStream(p.item_id),
      GATERELAY_EVENT.release_intended,
      p as unknown as JsonObject,
      `intent:${p.marker_id}`,
      (tx, e) => projectIntent(tx, p, e),
    );
  }

  async refuse(raw: ReleaseRefusedPayload): Promise<void> {
    const p = ReleaseRefusedPayload.parse(raw);
    await this.append(
      gateRelayStream(p.item_id),
      GATERELAY_EVENT.release_refused,
      p as unknown as JsonObject,
      `refused:${p.gate_instance_id}`,
      (tx, e) => projectRefusal(tx, p, e),
    );
  }

  async marker(raw: DeployMarker): Promise<void> {
    const m = DeployMarker.parse(raw);
    await this.append(
      gateRelayStream(m.item_id),
      GATERELAY_EVENT.deployment_created,
      m as unknown as JsonObject,
      `marker:${m.marker_id}`,
      (tx, e) => projectMarker(tx, m, e),
    );
  }

  async health(type: 'healthy' | 'unhealthy', raw: DeployHealthPayload): Promise<void> {
    const p = DeployHealthPayload.parse(raw);
    const t =
      type === 'healthy' ? GATERELAY_EVENT.deploy_healthy : GATERELAY_EVENT.deploy_unhealthy;
    await this.append(
      gateRelayStream(p.item_id),
      t,
      p as unknown as JsonObject,
      `health:${p.marker_id}`,
      (tx, e) => projectHealth(tx, t, p, e),
    );
  }
}

/** Rebuilds gate-relay's read models from the record alone (as the schema's owner). Returns the events read. */
export async function rebuildGateRelay(pool: pg.Pool): Promise<number> {
  return withTransaction(pool, async (tx) => {
    await tx.query('DELETE FROM gaterelay.deploy_health');
    await tx.query('DELETE FROM gaterelay.deploy_marker');
    await tx.query('DELETE FROM gaterelay.refusal');
    await tx.query('DELETE FROM gaterelay.intent');
    const ev = await tx.query<{
      type: string;
      body: unknown;
      global_seq: string;
      occurred_at: Date;
    }>(
      `SELECT type, body, global_seq::text, occurred_at FROM record.record_event
        WHERE stream LIKE 'gaterelay:%' ORDER BY global_seq`,
    );
    for (const e of ev.rows) {
      const row = { global_seq: Number(e.global_seq), occurred_at: e.occurred_at.toISOString() };
      switch (e.type) {
        case GATERELAY_EVENT.release_intended:
          await projectIntent(tx, ReleaseIntendedPayload.parse(e.body), row);
          break;
        case GATERELAY_EVENT.release_refused:
          await projectRefusal(tx, ReleaseRefusedPayload.parse(e.body), row);
          break;
        case GATERELAY_EVENT.deployment_created:
          await projectMarker(tx, DeployMarker.parse(e.body), row);
          break;
        case GATERELAY_EVENT.deploy_healthy:
        case GATERELAY_EVENT.deploy_unhealthy:
          await projectHealth(tx, e.type, DeployHealthPayload.parse(e.body), row);
          break;
        default:
          break;
      }
    }
    return ev.rows.length;
  });
}

export interface ReleaseView {
  readonly markers: DeployMarker[];
  readonly health: Array<{ marker_id: string; health: string; state: string }>;
  readonly refusals: Array<{ gate_instance_id: string; reason: string; detail: string }>;
}

/** An item's releases (markers, their health, refusals), for the portal and core's views. */
export async function releasesOf(
  pool: Pick<pg.Pool, 'query'>,
  itemId: string,
): Promise<ReleaseView> {
  const m = await pool.query<{ payload: unknown }>(
    'SELECT payload FROM gaterelay.deploy_marker WHERE item_id = $1 ORDER BY event_gseq',
    [itemId],
  );
  const h = await pool.query<{ marker_id: string; health: string; state: string }>(
    `SELECT h.marker_id::text AS marker_id, h.health, h.state FROM gaterelay.deploy_health h
       JOIN gaterelay.deploy_marker m ON m.marker_id = h.marker_id WHERE m.item_id = $1 ORDER BY h.event_gseq`,
    [itemId],
  );
  const r = await pool.query<{ gate_instance_id: string; reason: string; detail: string }>(
    `SELECT gate_instance_id::text AS gate_instance_id, reason, detail FROM gaterelay.refusal
      WHERE item_id = $1 ORDER BY event_gseq`,
    [itemId],
  );
  return {
    markers: m.rows.map((x) => DeployMarker.parse(x.payload)),
    health: h.rows,
    refusals: r.rows,
  };
}
