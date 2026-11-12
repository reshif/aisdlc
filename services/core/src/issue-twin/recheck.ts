import { inboundFactStream } from '@aisdlc/contracts';
import type { GapRecheck, GapRecheckPort } from '@aisdlc/ports';
import type pg from 'pg';
import type { KnowledgePort } from '../clients.js';

// The re-check of a gap's criterion at the default branch's head (OB §7 "Sync"), from what the factory already knows:
// the head is the newest `default_branch_head` inbound fact in the record (the poll loop's, every 10 minutes), and the
// verdict is knowledge's newest census, used only when it was taken AT that head. Anything else is `unknown`, and
// unknown is unmet: a twin is verified only by a census of exactly the commit the default branch is at.

export class CensusGapRecheck implements GapRecheckPort {
  constructor(
    private readonly d: {
      readonly pool: pg.Pool;
      readonly knowledge: Pick<KnowledgePort, 'census'>;
    },
  ) {}

  private async head(repo: string): Promise<string | null> {
    const q = await this.d.pool.query<{ sha: string | null }>(
      `SELECT body -> 'value' ->> 'sha' AS sha FROM record.record_event
        WHERE stream = $1 ORDER BY seq DESC LIMIT 1`,
      [inboundFactStream('default_branch_head', repo)],
    );
    const sha = q.rows[0]?.sha ?? null;
    return sha !== null && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  }

  async recheck(req: Parameters<GapRecheckPort['recheck']>[0]): Promise<GapRecheck> {
    const head = await this.head(req.repo);
    if (head === null) {
      return {
        result: 'unknown',
        sha: null,
        reason: 'the head of the default branch is not known',
      };
    }
    const c = await this.d.knowledge.census(req.repo);
    if (!c.ok) return { result: 'unknown', sha: head, reason: 'knowledge did not answer' };
    if (c.value === null)
      return { result: 'unknown', sha: head, reason: 'no census of the repository' };
    if (c.value.census.baseline_sha !== head) {
      return {
        result: 'unknown',
        sha: head,
        reason: 'no census at the head of the default branch',
      };
    }
    const row = c.value.census.criteria.find((x) => x.id === req.criterion);
    if (!row)
      return { result: 'unknown', sha: head, reason: 'the census has no row for the criterion' };
    if (row.status === 'met') return { result: 'pass', sha: head, reason: 'met at the head' };
    if (row.status === 'unmet') return { result: 'fail', sha: head, reason: 'unmet at the head' };
    return { result: 'unknown', sha: head, reason: `the census says ${row.status}` };
  }
}
