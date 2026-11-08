import type { CensusLatest, CensusRecord } from '@aisdlc/contracts';
import { CensusAssembledPayload, KNOWLEDGE_EVENT, type RecordEvent } from '@aisdlc/contracts';
import type { Executor, Projection, Tx } from '@aisdlc/record';

// The `census` read model (PLAN M6.5): a pure fold of `census.assembled` events on the
// `census:<repo_id>:<baseline_sha>` streams. Drop `knowledge.census`, refold, same rows. The
// record is authoritative; the table only makes "the latest census of a repo" a query.

export interface CensusRow {
  readonly stream: string;
  readonly seq: number;
  readonly global_seq: number;
  readonly repo: string;
  readonly baseline_sha: string;
  readonly census_hash: string;
  readonly job_id: string;
  readonly assembled_at: string;
  readonly census: CensusRecord;
}

interface DbRow {
  stream: string;
  seq: string;
  global_seq: string;
  repo: string;
  baseline_sha: string;
  census_hash: string;
  job_id: string;
  assembled_at: Date;
  census: CensusRecord;
}

const toRow = (r: DbRow): CensusRow => ({
  stream: r.stream,
  seq: Number(r.seq),
  global_seq: Number(r.global_seq),
  repo: r.repo,
  baseline_sha: r.baseline_sha,
  census_hash: r.census_hash,
  job_id: r.job_id,
  assembled_at: r.assembled_at.toISOString(),
  census: r.census,
});

export const censusProjection: Projection<CensusRow[]> = {
  name: 'knowledge-census',
  version: 1,
  tables: ['knowledge.census'],
  async apply(tx: Tx, e: RecordEvent) {
    if (!e.stream_id.startsWith('census:') || e.type !== KNOWLEDGE_EVENT.census_assembled) return;
    const p = CensusAssembledPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO knowledge.census
         (stream, seq, global_seq, repo, baseline_sha, census_hash, job_id, assembled_at, census)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb) ON CONFLICT (stream, seq) DO NOTHING`,
      [
        e.stream_id,
        e.stream_seq,
        e.global_seq,
        p.repo.toLowerCase(),
        p.census.baseline_sha,
        p.census_hash,
        p.job_id,
        e.occurred_at,
        JSON.stringify(p.census),
      ],
    );
  },
  async reset(tx: Tx) {
    await tx.query('DELETE FROM knowledge.census');
  },
  async snapshot(db: Executor) {
    const r = await db.query<DbRow>('SELECT * FROM knowledge.census ORDER BY global_seq');
    return r.rows.map(toRow);
  },
};

/** The newest census of a repo (by record order), as the HTTP API returns it, or null. */
export async function getLatestCensus(db: Executor, repo: string): Promise<CensusLatest | null> {
  const r = await db.query<DbRow>(
    'SELECT * FROM knowledge.census WHERE repo = $1 ORDER BY global_seq DESC LIMIT 1',
    [repo.toLowerCase()],
  );
  const row = r.rows[0];
  if (!row) return null;
  const c = toRow(row);
  return {
    census_id: c.census.census_id,
    census_hash: c.census_hash,
    job_id: c.job_id,
    assembled_at: c.assembled_at,
    census: c.census,
    gaps: c.census.gaps,
  };
}
