import { buildSourceError, sha256, type SessionStore } from '@aisdlc/build';
import type {
  ArtefactType,
  StageRequest,
  VerifyArtefact,
  VerifyRunRequest,
  VerifyStep,
} from '@aisdlc/contracts';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import type { ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { CoreBuildSource } from '../build/source.js';
import { listPullRequests, listPushReceipts } from '../build/push.js';
import { designFactsOf } from '../planning/design.js';
import { latestArtefact } from '../planning/store.js';
import { listUnits } from '../planning/units.js';
import { readItem } from '../work-items.js';

// What S7 verifies, from core's own record (PLAN M14.3): the Unit (the one whose grant is live, as S6 had it), its base
// commit (G3 bound it) and its head (the Push Broker's applied receipt, the Unit's `head_sha`), the locked oracles (the
// coding session's locks; without a session, the oracle files bound to the Unit, as 6.3 locked them), the oracles G2
// approved, and the approvals the checks weigh: an X2 the Push Broker wrote this exact head under, an X3, and the egress
// hosts the approved design names with an approval reference.

export type SubjectFields = Pick<
  VerifyRunRequest,
  | 'unit_key'
  | 'base_sha'
  | 'head_sha'
  | 'locks'
  | 'oracles'
  | 'repro'
  | 'x2_covered'
  | 'x3_approved'
  | 'approved_hosts'
  | 'grant'
>;

/** A conditional gate raised at `step` and decided `approve` (its station is `<step>!<gate>`). */
export const gateApprovedAt = (s: ItemState, gate: string, step: string): boolean =>
  s.gates.some(
    (g) =>
      g.gate === gate &&
      g.station === `${step}!${gate}` &&
      g.status === 'decided' &&
      g.outcome === 'approve',
  );

/** What each review reads beside the change (as data, already secret-scanned when it was stored). */
const REVIEW_ARTEFACTS: Readonly<Record<'7.3' | '7.5', readonly ArtefactType[]>> = {
  '7.3': ['spec_delta', 'oracle_specs'],
  '7.5': ['adr', 'contracts', 'data_migration', 'nfr_threat_ops'],
};

export class CoreVerifySubjects {
  private readonly source: CoreBuildSource;

  constructor(private readonly d: { readonly pool: pg.Pool; readonly store?: SessionStore }) {
    this.source = new CoreBuildSource({
      pool: d.pool,
      // S7 reads the repo in the verify service, never here
      repo: {
        files: async () =>
          err(buildSourceError('unavailable', 'S7 reads the repo in the verify service')),
      },
    });
  }

  /** The subject of a check, or the code the step fails with (no Unit, no head: nothing to verify is never a pass). */
  async subject(req: StageRequest): Promise<Result<SubjectFields, string>> {
    const item = await readItem(this.d.pool, req.item_id);
    if (!item) return err('no_item');
    const plan = await this.source.unitPlan({
      item_id: req.item_id,
      repo: req.repo,
      lane: req.lane,
    });
    if (!plan.ok) return err(plan.error.code === 'not_found' ? 'no_unit' : 'no_plan_base');
    const unitKey = plan.value.unit_key;
    const unit = (await listUnits(this.d.pool, req.item_id)).find((u) => u.unit_key === unitKey);
    const receipts = (await listPushReceipts(this.d.pool, req.item_id)).filter(
      (r) => r.unit_key === unitKey && r.status === 'applied' && r.head_sha !== null,
    );
    // the PR's head: the Unit's last push, or the commit a clean rebase on the host made of it (B15a, M15.2)
    const pull = (await listPullRequests(this.d.pool, req.item_id)).find(
      (p) => p.unit_key === unitKey && p.state === 'open',
    );
    const head = pull?.head_sha ?? unit?.head_sha ?? receipts.at(-1)?.head_sha ?? null;
    if (head === null || !/^[0-9a-f]{40}$/.test(head)) return err('no_unit_head');

    // the locks: the coding session's own (they moved after an approved E6 and G3o), else the bound oracle files
    let locks: Record<string, string>;
    const session = this.d.store?.load(req.item_id) ?? null;
    if (session !== null && session.unit_key === unitKey && Object.keys(session.locks).length > 0) {
      locks = { ...session.locks };
    } else {
      const of = await this.source.oracleFiles({
        item_id: req.item_id,
        repo: req.repo,
        unit_key: unitKey,
      });
      if (!of.ok) throw new Error(`the oracle files: ${of.error.message}`);
      locks = Object.fromEntries(of.value.map((f) => [f.path, sha256(f.content)]));
    }

    const grant = await this.source.sessionGrant(req.item_id);
    if (!grant.ok) throw new Error(`the admission grant: ${grant.error.message}`);

    const s = item.state;
    // the Push Broker writes a protected path only under an X2 bound to exactly that patch: its applied head is covered
    const x2_covered = gateApprovedAt(s, 'X2', '6.6') && receipts.some((r) => r.head_sha === head);
    const facts = designFactsOf({
      contracts: (await latestArtefact(this.d.pool, req.item_id, 'contracts'))?.content,
      nfr_threat_ops: (await latestArtefact(this.d.pool, req.item_id, 'nfr_threat_ops'))?.content,
    });
    const approved_hosts = [
      ...new Set(
        facts.network_calls
          .filter((n) => typeof n.approval_ref === 'string' && n.approval_ref.trim() !== '')
          .map((n) => (typeof n.host === 'string' ? n.host.toLowerCase().trim() : ''))
          .filter((h) => h !== ''),
      ),
    ].sort();
    return ok({
      unit_key: unitKey,
      base_sha: plan.value.base_sha,
      head_sha: head,
      locks,
      oracles: plan.value.oracles.map((o) => ({
        oracle_id: o.oracle_id,
        requirement_id: o.requirement_id,
        spec_sha256: o.spec_sha256,
      })),
      repro: req.lane === 'L0',
      x2_covered,
      x3_approved: gateApprovedAt(s, 'X3', '6.4'),
      approved_hosts,
      grant: grant.value,
    });
  }

  /** The approved artefacts a review step reads (the latest of each type the item has), as data. */
  async reviewArtefacts(itemId: string, step: VerifyStep): Promise<VerifyArtefact[]> {
    if (step !== '7.3' && step !== '7.5') return [];
    const out: VerifyArtefact[] = [];
    for (const type of REVIEW_ARTEFACTS[step]) {
      const a = await latestArtefact(this.d.pool, itemId, type);
      if (!a) continue;
      out.push({
        type,
        sha256: a.row.sha256,
        text: canonicalJson(a.content as never).slice(0, 200_000),
      });
    }
    return out;
  }
}
