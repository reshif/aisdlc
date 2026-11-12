import {
  ControlsAttestation,
  S0_EVENT,
  S0ControlsRecordedPayload,
  type LightFloorReport,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { evaluateLightFloors } from '@aisdlc/onboarding';
import type pg from 'pg';
import type { KnowledgePort } from '../clients.js';
import { coreError, type CoreError } from '../errors.js';
import { latestProbe } from './probe.js';
import { approvedPayload, loadS0, s0Cards } from './read.js';

// The Light floors of an S0 record (PLAN M16; OB §3.2 LF1 to LF8), from what the record, knowledge and the decided
// cards say now. Each input that cannot be read, or that is not there yet, is `null` and its floor is unknown (unmet
// for every decision). LF4's live planted-instruction isolation test (SP-STD-1) is a later M16 task: until it is
// recorded, LF4 reads unknown and Light cannot be signed on the floors alone.

const BLOCKING = ['B1', 'B2', 'B5'] as const;

export async function lightFloorsOf(
  d: {
    readonly pool: pg.Pool;
    readonly knowledge: Pick<KnowledgePort, 'census' | 'detectorFacts' | 'openFindings'>;
  },
  s0Id: string,
): Promise<Result<LightFloorReport, CoreError>> {
  const loaded = await loadS0(d.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const { s0 } = loaded;
  if (!s0.census) return err(coreError('conflict', 'the census is not ready'));
  const latest = await d.knowledge.census(s0.repo);
  const census =
    latest.ok && latest.value !== null && latest.value.census_hash === s0.census.census_hash
      ? latest.value.census
      : null;
  const head = {
    census_hash: s0.census.census_hash,
    baseline_sha: census?.baseline_sha ?? '0'.repeat(40),
  };

  // LF1: open findings now, and the census's blocking set
  const findings = await d.knowledge.openFindings(s0.repo);
  const blockers = census
    ? census.blockers.filter((b) => (BLOCKING as readonly string[]).includes(b.id))
    : null;
  const blockedAtCensus = blockers?.filter((b) => b.status === 'blocked').length ?? 0;
  const scanComplete =
    blockers === null || blockers.length < BLOCKING.length
      ? null
      : blockers.every((b) => b.status === 'met' || b.status === 'blocked');

  // LF2, LF7: card 4 as decided, and the controls report it was decided on
  const cards = await s0Cards(d.pool, s0Id);
  const c4 = approvedPayload(cards, 'C4');
  const att = c4?.payload.find((p) => p.kind === 'controls_attestation');
  const attestation =
    att?.kind === 'controls_attestation' ? ControlsAttestation.safeParse(att.attestation) : null;
  const reportRow = c4?.payload.find((p) => p.kind === 'controls_report');
  const report =
    reportRow?.kind === 'controls_report'
      ? [...loaded.events]
          .reverse()
          .map((e) =>
            e.type === S0_EVENT.controls_recorded
              ? S0ControlsRecordedPayload.safeParse(e.payload)
              : null,
          )
          .find((p) => p?.success && p.data.report.report_hash === reportRow.report_hash)
      : undefined;

  // LF4: the census's harness inventory
  const facts = await d.knowledge.detectorFacts(s0.census.job_id);
  // the inventory detector reports every kind (present or absent): no such fact at all means it did not run
  const inventoried =
    facts.ok && facts.value !== null && facts.value.some((f) => f.kind === 'instruction_file')
      ? true
      : null;

  // LF5, LF6: card 2 as decided
  const c2 = approvedPayload(cards, 'C2');
  const summary = c2?.payload.find((p) => p.kind === 'claims_summary');

  const probe = census ? await latestProbe(d.pool, s0Id, head) : null;
  return ok(
    evaluateLightFloors({
      blocking_findings: findings.ok ? findings.value.length + blockedAtCensus : null,
      scan_complete: scanComplete,
      controls_blocking_open: report?.success ? report.data.report.blocking_open.length : null,
      controls_attested: c4 ? attestation?.success === true : null,
      head,
      probe: probe?.result ?? null,
      harness_inventoried: inventoried,
      isolation_test_passed: null,
      instructions_affirmed: c2
        ? c2.payload.some((p) => p.kind === 'instruction_affirmation' && p.path === 'AGENTS.md')
        : null,
      claims_share:
        summary?.kind === 'claims_summary'
          ? summary.total_high_impact === 0
            ? 0
            : (summary.affirmed + summary.unknown) / summary.total_high_impact
          : null,
      intent_attested: c2 ? c2.payload.some((p) => p.kind === 'intent_answers') : null,
      practices_attested: c2 ? c2.payload.some((p) => p.kind === 'practices_attestation') : null,
      operations_attested: attestation?.success ? attestation.data.operations_md === true : null,
      // "never deploys" is fine: what operations.md attests is that apply-on-merge is known
      apply_on_merge_known: attestation?.success ? attestation.data.operations_md === true : null,
    }),
  );
}
