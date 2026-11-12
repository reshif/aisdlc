import {
  GATE_EVENT,
  ITEM_EVENT,
  PrrGatingProfile,
  Tier,
  itemStream,
  type GateCheckVerdict,
  type GateStatus,
} from '@aisdlc/contracts';
import { readGateState } from '@aisdlc/decisions';
import type pg from 'pg';

// What gate-check reads from the record database (PLAN M14.5), as its own least-privilege role: the registered repos,
// which pull requests and heads the Push Broker wrote, where the signed pack of a head is, the item's G3 from the
// ledger, and its own verdicts and merges. Every read throws on a database error; the caller turns that into
// "pending" for the PR (unknown is unmet), never into a pass.

export type OnboardingLevel = 'none' | 'census' | 'light' | 'full';

export interface RepoRow {
  readonly repo: string;
  readonly project_id: string;
  readonly onboarding_level: OnboardingLevel;
  /** The default branch core recorded (its head is the watch start's). */
  readonly default_branch?: string | null;
}

/** When gate-check started watching a repo (`gatecheck.repo_watched`). */
export interface RepoWatch {
  readonly watched_at: string;
  readonly head_sha: string;
}

/** What an item pinned at intake (`item.created`): the gating profile and tier the engine routes it by. */
export interface ItemPin {
  readonly gating_profile: PrrGatingProfile;
  readonly tier: Tier;
}

/** `core.pull_request`: a PR the Push Broker opened, as core recorded it from the receipt. */
export interface AgentPrRow {
  readonly item_id: string;
  readonly unit_key: string;
  readonly head_ref: string;
  readonly head_sha: string;
}

/** `core.evidence_pack`: where a pack's signed bytes are. */
export interface PackRow {
  readonly pack_sha256: string;
  readonly item_id: string;
  readonly unit_key: string;
  readonly head_sha: string;
  readonly passing: boolean;
  readonly bucket: string;
  readonly object_key: string;
}

export interface G3State {
  readonly gate_instance_id: string;
  readonly status: GateStatus;
  readonly outcome: string | null;
}

export interface LastVerdict {
  readonly seq: number;
  readonly verdict_sha256: string;
  readonly check_verdict_sha256: string;
  readonly check_run_id: number | null;
  readonly verdict: GateCheckVerdict;
}

export interface FactsPort {
  repos(): Promise<RepoRow[]>;
  agentPr(repo: string, number: number): Promise<AgentPrRow | null>;
  /** Every pack of an item, in record order. */
  packsOf(itemId: string): Promise<PackRow[]>;
  /** Which of `shas` are heads the Push Broker wrote in this repo (applied receipts). */
  agentHeads(repo: string, shas: readonly string[]): Promise<Set<string>>;
  /** Which of `hexes` (64-hex) are a pack id or a pack's object key. */
  packsCited(hexes: readonly string[]): Promise<Set<string>>;
  /** The item's newest G3 instance, its status folded from the ledger's decisions; `null`: none was opened. */
  latestG3(itemId: string): Promise<G3State | null>;
  lastVerdict(repo: string, number: number): Promise<LastVerdict | null>;
  mergeRecorded(mergeId: string): Promise<boolean>;
  repoWatch(repo: string): Promise<RepoWatch | null>;
  /** The item's pin from its `item.created` event; `null` when there is none or it does not parse. */
  itemPin(itemId: string): Promise<ItemPin | null>;
}

export class RecordFacts implements FactsPort {
  constructor(private readonly pool: Pick<pg.Pool, 'query'>) {}

  async repos(): Promise<RepoRow[]> {
    const q = await this.pool.query<{
      repo: string;
      project_id: string;
      onboarding_level: string;
      default_branch: string | null;
    }>(
      `SELECT owner || '/' || name AS repo, project_id, onboarding_level, default_branch FROM core.repo
        ORDER BY repo_key`,
    );
    return q.rows.map((r) => ({
      repo: r.repo,
      project_id: r.project_id,
      onboarding_level: r.onboarding_level as OnboardingLevel,
      default_branch: r.default_branch,
    }));
  }

  async agentPr(repo: string, number: number): Promise<AgentPrRow | null> {
    const q = await this.pool.query<AgentPrRow>(
      `SELECT item_id::text AS item_id, unit_key, head_ref, head_sha FROM core.pull_request
        WHERE lower(repo) = lower($1) AND number = $2`,
      [repo, number],
    );
    return q.rows[0] ?? null;
  }

  async packsOf(itemId: string): Promise<PackRow[]> {
    const q = await this.pool.query<PackRow>(
      `SELECT pack_sha256, item_id::text AS item_id, unit_key, head_sha, passing, bucket, object_key
         FROM core.evidence_pack WHERE item_id = $1 ORDER BY event_gseq`,
      [itemId],
    );
    return q.rows;
  }

  async agentHeads(repo: string, shas: readonly string[]): Promise<Set<string>> {
    if (shas.length === 0) return new Set();
    const q = await this.pool.query<{ head_sha: string }>(
      `SELECT DISTINCT head_sha FROM core.push_receipt
        WHERE lower(repo) = lower($1) AND status = 'applied' AND head_sha = ANY($2::text[])`,
      [repo, [...shas]],
    );
    return new Set(q.rows.map((r) => r.head_sha));
  }

  async packsCited(hexes: readonly string[]): Promise<Set<string>> {
    if (hexes.length === 0) return new Set();
    const q = await this.pool.query<{ pack_sha256: string; object_key: string }>(
      `SELECT pack_sha256, object_key FROM core.evidence_pack
        WHERE pack_sha256 = ANY($1::text[]) OR object_key = ANY($1::text[])`,
      [[...hexes]],
    );
    const want = new Set(hexes);
    const out = new Set<string>();
    for (const r of q.rows) {
      if (want.has(r.pack_sha256)) out.add(r.pack_sha256);
      if (want.has(r.object_key)) out.add(r.object_key);
    }
    return out;
  }

  async latestG3(itemId: string): Promise<G3State | null> {
    // the instances of G3 on the item, from their `gate.opened` events (an index lookup, as the decision kernel's)
    const q = await this.pool.query<{ stream: string }>(
      `SELECT stream FROM record.record_event
        WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2
          AND body ->> 'gate_id' = 'G3' AND body ->> 'subject_kind' = 'item'
        ORDER BY global_seq DESC LIMIT 1`,
      [GATE_EVENT.opened, itemId],
    );
    const stream = q.rows[0]?.stream;
    if (stream === undefined) return null;
    const id = stream.slice('gate:'.length);
    // the authoritative status: the open event and the ledger's decisions, folded now (never the projection)
    const g = await readGateState(this.pool as pg.Pool, id);
    if (!g) return null;
    return { gate_instance_id: id, status: g.status, outcome: g.outcome };
  }

  async lastVerdict(repo: string, number: number): Promise<LastVerdict | null> {
    const q = await this.pool.query<{
      seq: number;
      verdict_sha256: string;
      check_verdict_sha256: string;
      check_run_id: string | null;
      verdict: GateCheckVerdict;
    }>(
      `SELECT seq, verdict_sha256, check_verdict_sha256, check_run_id::text AS check_run_id, verdict FROM gatecheck.verdict
        WHERE repo_key = lower($1) AND pr_number = $2 ORDER BY seq DESC LIMIT 1`,
      [repo, number],
    );
    const r = q.rows[0];
    return r
      ? {
          seq: r.seq,
          verdict_sha256: r.verdict_sha256,
          check_verdict_sha256: r.check_verdict_sha256,
          check_run_id: r.check_run_id === null ? null : Number(r.check_run_id),
          verdict: r.verdict,
        }
      : null;
  }

  async repoWatch(repo: string): Promise<RepoWatch | null> {
    const q = await this.pool.query<{ watched_at: Date; head_sha: string }>(
      'SELECT watched_at, head_sha FROM gatecheck.repo_watch WHERE repo_key = lower($1)',
      [repo],
    );
    const r = q.rows[0];
    return r ? { watched_at: r.watched_at.toISOString(), head_sha: r.head_sha } : null;
  }

  async itemPin(itemId: string): Promise<ItemPin | null> {
    // row-level security lets this role read `item.created` and no other item event
    const q = await this.pool.query<{ body: { gating_profile?: unknown; tier?: unknown } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1 AND type = $2',
      [itemStream(itemId), ITEM_EVENT.created],
    );
    const b = q.rows[0]?.body;
    if (!b) return null;
    const p = PrrGatingProfile.safeParse(b.gating_profile);
    const t = Tier.safeParse(b.tier);
    return p.success && t.success ? { gating_profile: p.data, tier: t.data } : null;
  }

  async mergeRecorded(mergeId: string): Promise<boolean> {
    const q = await this.pool.query('SELECT 1 FROM gatecheck.merge WHERE merge_id = $1', [mergeId]);
    return q.rows.length > 0;
  }
}
