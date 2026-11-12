import {
  DEFAULT_LIGHT_TESTS,
  LightTestsConfig,
  ONBOARDING_LIGHT_TESTS_KEY,
  SPIKE_EVENT,
  SpikeRecordedPayload,
  spikeStream,
  type SpikeKind,
  type SpikeRecordRequest,
  type SpikeVerdict,
} from '@aisdlc/contracts';
import type { ConfigReader } from '@aisdlc/config';
import { hashCanonical, ok, err, type Result } from '@aisdlc/kernel';
import { isolationVerdict, lintPrecisionVerdict } from '@aisdlc/onboarding';
import type { Tx } from '@aisdlc/record';
import { scanText } from '@aisdlc/secrets-rules';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { inCoreTx, lockKeys, type CoreDeps } from '../journal.js';

// The Light spikes on the record (PLAN M16; onboarding-roadmap §10 SP-STD-1 = LF4's live isolation test, SP-STD-3
// lint precision). A report is produced outside core (the isolation test runs real W sessions on a Docker daemon:
// `services/coding-runner/test/isolation.test.ts`; the lint precision runs the shared ruleset over its corpus:
// `@aisdlc/text-lint`'s `measureLintPrecision`) and posted by an operator (`POST /v1/onboarding/spikes`, scope ops).
// Core does NOT take the report's word for anything: it validates the shape, secret-scans it, computes the verdict
// itself against the thresholds in force (config `onboarding.light_tests`, M1-gated) and records the report, its hash,
// the thresholds and the verdict as one `spike.recorded` event (record-first), folded into `core.light_spike`.

export const SPIKE_ACTOR = 'system.spikes';

/** `onboarding.light_tests` from a config reader (`null`: the published value does not read: LF4 is unknown). */
export function lightTestsFrom(reader: ConfigReader): () => LightTestsConfig | null {
  return () => {
    const c = reader.current();
    if (c.rejected.includes(ONBOARDING_LIGHT_TESTS_KEY)) return null;
    const v = c.get(ONBOARDING_LIGHT_TESTS_KEY);
    if (v === undefined) return DEFAULT_LIGHT_TESTS;
    const p = LightTestsConfig.safeParse(v);
    return p.success ? p.data : null;
  };
}

const subjectOf = (p: SpikeRecordedPayload): string =>
  p.kind === 'sp-std-1'
    ? p.report.worker_image
    : `lint/${p.report.lint_revision}/${p.report.scan_rules_version}`;

export async function applySpikeEvent(
  tx: Pick<Tx, 'query'>,
  e: { type: string; payload: unknown; global_seq: number; at: string },
): Promise<void> {
  if (e.type !== SPIKE_EVENT.recorded) return;
  const p = SpikeRecordedPayload.parse(e.payload);
  await tx.query(
    `INSERT INTO core.light_spike (report_hash, kind, subject, passed, verdict, recorded_at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (report_hash) DO NOTHING`,
    [
      p.report_hash,
      p.kind,
      subjectOf(p),
      p.verdict.passed,
      JSON.stringify(p.verdict),
      e.at,
      e.global_seq,
    ],
  );
}

/** Rebuilds `core.light_spike` from the spike streams alone. Returns how many rows. */
export async function rebuildSpikes(d: CoreDeps): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string; at: Date }>(
    `SELECT type, body, global_seq::text AS global_seq, occurred_at AS at FROM record.record_event
      WHERE stream LIKE 'spike:%' ORDER BY record_event.global_seq`,
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, ['spikes']);
    await tx.query('DELETE FROM core.light_spike');
    for (const e of q.rows) {
      await applySpikeEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
        at: e.at.toISOString(),
      });
    }
    return ok(q.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

export interface RecordedSpike {
  readonly kind: SpikeKind;
  readonly report_hash: string;
  readonly verdict: SpikeVerdict;
}

/**
 * Records one spike report with the verdict computed here. A report that would hold a secret is refused and nothing
 * is recorded; the same report twice is the same row (its hash), recorded once.
 */
export async function recordSpike(
  d: CoreDeps & { readonly lightTests: () => LightTestsConfig | null },
  req: SpikeRecordRequest,
  by: string,
): Promise<Result<RecordedSpike, CoreError>> {
  const t = d.lightTests();
  if (t === null) {
    return err(
      coreError('unavailable', 'onboarding.light_tests does not read: nothing is recorded'),
    );
  }
  if (scanText(JSON.stringify(req.report)).length > 0) {
    return err(coreError('refused', 'the report would hold a secret; nothing was recorded'));
  }
  const report_hash = hashCanonical(req.report as never);
  const payload = SpikeRecordedPayload.parse(
    req.kind === 'sp-std-1'
      ? {
          kind: req.kind,
          report: req.report,
          report_hash,
          thresholds: { isolation_min_runs: t.isolation_min_runs },
          verdict: isolationVerdict(req.report, t),
          recorded_by: by,
        }
      : {
          kind: req.kind,
          report: req.report,
          report_hash,
          thresholds: {
            lint_max_false_positive_rate: t.lint_max_false_positive_rate,
            lint_min_planted_catch_rate: t.lint_min_planted_catch_rate,
            lint_policy_rules: t.lint_policy_rules,
          },
          verdict: lintPrecisionVerdict(req.report, t),
          recorded_by: by,
        },
  );
  return inCoreTx<RecordedSpike>(d, async (j, tx) => {
    await lockKeys(tx, ['spikes']);
    const prior = await tx.query<{ verdict: SpikeVerdict }>(
      'SELECT verdict FROM core.light_spike WHERE report_hash = $1',
      [report_hash],
    );
    const had = prior.rows[0];
    if (had) return ok({ kind: req.kind, report_hash, verdict: had.verdict });
    const w = await j.emit(spikeStream(req.kind), SPIKE_EVENT.recorded, payload, SPIKE_ACTOR);
    if (!w.ok) return w;
    await applySpikeEvent(tx, {
      type: w.value.type,
      payload,
      global_seq: w.value.global_seq,
      at: w.value.occurred_at,
    });
    return ok({ kind: req.kind, report_hash, verdict: payload.verdict });
  });
}

export interface SpikeRow {
  readonly kind: SpikeKind;
  readonly subject: string;
  readonly report_hash: string;
  readonly passed: boolean;
  readonly verdict: SpikeVerdict;
  readonly recorded_at: string;
}

/** The latest spike of a kind (for SP-STD-1: for exactly this worker image), or `null`. */
export async function latestSpike(
  db: Pick<pg.Pool, 'query'>,
  kind: SpikeKind,
  subject?: string,
): Promise<SpikeRow | null> {
  const q = await db.query<{
    subject: string;
    report_hash: string;
    passed: boolean;
    verdict: SpikeVerdict;
    recorded_at: Date;
  }>(
    `SELECT subject, report_hash, passed, verdict, recorded_at FROM core.light_spike
      WHERE kind = $1 AND ($2::text IS NULL OR subject = $2) ORDER BY event_gseq DESC LIMIT 1`,
    [kind, subject ?? null],
  );
  const r = q.rows[0];
  return r ? { kind, ...r, recorded_at: r.recorded_at.toISOString() } : null;
}

/**
 * LF4's isolation half: the latest SP-STD-1 recorded for the worker image `onboarding.light_tests` names. No image
 * named, no test recorded for it, or the config unreadable: unknown (unmet), with the reason. A later failing test
 * replaces an earlier pass: the newest report is the one that counts.
 */
export async function isolationForLf4(
  db: Pick<pg.Pool, 'query'>,
  t: LightTestsConfig | null,
): Promise<{ passed: boolean | null; reason: string; report_hash: string | null }> {
  if (t === null)
    return { passed: null, reason: 'light_tests_config_unreadable', report_hash: null };
  if (t.worker_image === null) {
    return { passed: null, reason: 'worker_image_not_named', report_hash: null };
  }
  const s = await latestSpike(db, 'sp-std-1', t.worker_image);
  if (!s)
    return { passed: null, reason: 'isolation_test_not_run_for_worker_image', report_hash: null };
  return {
    passed: s.passed,
    reason: s.passed ? 'met' : 'isolation_test_failed',
    report_hash: s.report_hash,
  };
}
