import {
  ONBOARDING_PROBE_UNIT,
  PROBE_EVENT,
  PROBE_GRANT_LEASE_EPOCH,
  PROBE_GRANT_TTL_S,
  PROBE_NOT_RUN,
  ProbeGrantedPayload,
  ProbeRecordedPayload,
  ProbeRetryRequestedPayload,
  probeStream,
  type OnboardingSandboxImage,
  type ProbeOutcome,
  type ProbeResult,
} from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  notRunResult,
  planProbe,
  probeCommand,
  probeIdOf,
  probeResultHash,
  resultOfRun,
  type ProbeBase,
  type ProbePlan,
} from '@aisdlc/onboarding';
import { checkSessionAllowed, type SandboxPort, type SessionGuardDeps } from '@aisdlc/ports';
import type { Tx } from '@aisdlc/record';
import { scanText } from '@aisdlc/secrets-rules';
import type { LoopContext, LoopSpec } from '@aisdlc/loops';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { GitBundleFiles, type BundleReads } from '@aisdlc/build';
import type { RepoFilesPort } from '../build/source.js';
import type { KnowledgePort } from '../clients.js';
import { activeS0Ids } from '../queries.js';
import { readCardState } from '@aisdlc/decisions';
import { decisionsFor, SLOT_OF_CARD, type CardDeps } from './model.js';
import { loadS0 } from './read.js';

// The onboarding probe, the I/O half (PLAN M16; OB §3.2 LF3, §5.6; ADR-0003 §7 K-exec; DEC-17 refined, DEC-18).
//
// For an S0 record at Light, at the census head card 2 is about, once:
//   1. what runs: the census's `setup` and `test` (detector facts of the census job, read at the census head) and
//      the mirror needs its lockfiles declare (LF8). No test command: nothing runs (recorded `no_test_command`);
//   2. the image: `onboarding.sandbox_image` (M1-gated, by digest). None approved: nothing runs (`no_image`);
//   3. DEC-18 and B1, the same rule every session meets (`checkSessionAllowed`): a repo off the owner allow-list, or
//      one with an open secret finding (or where knowledge cannot tell), runs nothing (`not_allowed`, `b1_blocked`);
//   4. the grant: `probe.granted` is RECORDED before the session is asked for (one at a time per record); the
//      sandbox-controller starts a K-exec session only under it (`core.probe_grant`), with the approved image only;
//   5. the session: the repo copy at the census head, the probe runner, the mirror as the only peer; its output is
//      scanned (canaries, the secret ruleset) and read strictly (`resultOfRun`);
//   6. the result: `probe.recorded`, record-first, secret-scanned before it is stored, folded into
//      `core.onboarding_probe` (rebuilt from the events alone by `rebuildProbes`).
// Every refusal is recorded too: what did not run, and why, is as recorded as what ran.

export const PROBE_ACTOR = 'system.probe';
/** A probe that ran nothing is tried again after this long (the allow-list, the image or B1 may have changed). */
export const PROBE_RETRY_NOT_RUN_MS = 60 * 60 * 1000;

export interface ProbeDeps {
  /** The sandbox-controller (`HttpSandbox`), or a fake in tests. Every session names its probe grant. */
  readonly sandbox: SandboxPort;
  /** The repo copy at the census head (the code host's bundle). */
  readonly files: RepoFilesPort;
  /** `onboarding.sandbox_image` now in force (`null`: none approved, or unreadable). */
  readonly image: () => OnboardingSandboxImage;
  /** DEC-18: `sandbox.exec_allowed_repos` now in force (`null`: unreadable, nothing runs). */
  readonly execAllowedRepos: () => readonly string[] | null;
}

export interface ProbeRunDeps extends CoreDeps {
  readonly knowledge: Pick<KnowledgePort, 'census' | 'detectorFacts' | 'openFindings'>;
  readonly probe: ProbeDeps;
}

export interface RecordedProbe {
  readonly project_id: string;
  readonly result: ProbeResult;
  readonly result_hash: string;
}

/** The repo copy at a commit from the code host's bundle route (the same files S6 provisions from). */
export const probeFilesOf = (bundles: BundleReads): RepoFilesPort => new GitBundleFiles(bundles);

// ---------------------------------------------------------------- read models

/** Folds one probe event into its row. Idempotent (an upsert by probe id). */
export async function applyProbeEvent(
  tx: Pick<Tx, 'query'>,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type === PROBE_EVENT.granted) {
    const g = ProbeGrantedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.onboarding_probe
         (probe_id, s0_id, project_id, repo, census_hash, baseline_sha, image, status, granted_at, event_gseq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'granted',$8,$9)
       ON CONFLICT (probe_id) DO NOTHING`,
      [
        g.probe_id,
        g.s0_id,
        g.project_id,
        g.repo,
        g.census_hash,
        g.baseline_sha,
        g.image,
        g.granted_at,
        e.global_seq,
      ],
    );
    return;
  }
  if (e.type !== PROBE_EVENT.recorded) return;
  const p = ProbeRecordedPayload.parse(e.payload);
  const r = p.result;
  await tx.query(
    `INSERT INTO core.onboarding_probe
       (probe_id, s0_id, project_id, repo, census_hash, baseline_sha, image, status, outcome, result, result_hash,
        recorded_at, event_gseq)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'recorded',$8,$9,$10,$11,$12)
     ON CONFLICT (probe_id) DO UPDATE SET status = 'recorded', outcome = EXCLUDED.outcome, result = EXCLUDED.result,
       result_hash = EXCLUDED.result_hash, recorded_at = EXCLUDED.recorded_at, event_gseq = EXCLUDED.event_gseq`,
    [
      r.probe_id,
      r.s0_id,
      p.project_id,
      r.repo,
      r.census_hash,
      r.baseline_sha,
      r.image,
      r.outcome,
      JSON.stringify(r),
      p.result_hash,
      r.recorded_at,
      e.global_seq,
    ],
  );
}

/** Rebuilds a record's probe rows from its probe events alone. Returns how many results. */
export async function rebuildProbes(d: CoreDeps, s0Id: string): Promise<number> {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [probeStream(s0Id)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [`probe:${s0Id}`]);
    await tx.query('DELETE FROM core.onboarding_probe WHERE s0_id = $1', [s0Id]);
    let n = 0;
    for (const e of q.rows) {
      await applyProbeEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
      });
      if (e.type === PROBE_EVENT.recorded) n += 1;
    }
    return ok(n);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

/** The latest recorded probe of a record for a census head (or of any head), or `null`. */
export async function latestProbe(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
  head?: { census_hash: string; baseline_sha: string },
): Promise<RecordedProbe | null> {
  const q = await db.query<{ project_id: string; result: unknown; result_hash: string }>(
    `SELECT project_id, result, result_hash FROM core.onboarding_probe
      WHERE s0_id = $1 AND status = 'recorded'
        AND ($2::text IS NULL OR (census_hash = $2 AND baseline_sha = $3))
      ORDER BY event_gseq DESC LIMIT 1`,
    [s0Id, head?.census_hash ?? null, head?.baseline_sha ?? null],
  );
  const row = q.rows[0];
  if (!row) return null;
  const p = ProbeRecordedPayload.safeParse({
    project_id: row.project_id,
    result: row.result,
    result_hash: row.result_hash,
  });
  return p.success ? p.data : null;
}

// ---------------------------------------------------------------- the step

const hasSecret = (v: unknown): boolean => scanText(JSON.stringify(v)).length > 0;

async function record(
  d: CoreDeps,
  s0Id: string,
  project: string,
  result: ProbeResult,
): Promise<Result<RecordedProbe, CoreError>> {
  // secret-scanned before it is stored: the builder already dropped any log tail the ruleset hits
  if (hasSecret(result)) {
    return err(coreError('refused', 'the probe result would hold a secret; nothing was recorded'));
  }
  const payload = ProbeRecordedPayload.parse({
    project_id: project,
    result,
    result_hash: probeResultHash(result),
  });
  return inCoreTx<RecordedProbe>(d, async (j, tx) => {
    await lockKeys(tx, [`probe:${s0Id}`]);
    const w = await j.emit(probeStream(s0Id), PROBE_EVENT.recorded, payload, PROBE_ACTOR);
    if (!w.ok) return w;
    await applyProbeEvent(tx, { type: w.value.type, payload, global_seq: w.value.global_seq });
    return ok(payload);
  });
}

/**
 * Runs the probe of an S0 record at its census head, or returns the probe already recorded for that head. "One run"
 * (OB §3.2 LF3): a probe that ran (passed, failed, no tests, uncounted, void) is final for the head; one that ran
 * nothing (`PROBE_NOT_RUN`) is tried again after `PROBE_RETRY_NOT_RUN_MS`, or at once with `retry`.
 */
export async function runOnboardingProbe(
  d: ProbeRunDeps,
  s0Id: string,
  o: { readonly retry?: boolean } = {},
): Promise<Result<RecordedProbe, CoreError>> {
  const loaded = await loadS0(d.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const { s0 } = loaded;
  if (!s0.census) return err(coreError('conflict', 'the census is not ready'));
  const latest = await d.knowledge.census(s0.repo);
  if (!latest.ok) return err(coreError('unavailable', `knowledge: ${latest.error.message}`));
  if (latest.value === null || latest.value.census_hash !== s0.census.census_hash) {
    return err(coreError('conflict', 'the census moved on since 0.1; the record needs a new one'));
  }
  const head = {
    census_hash: s0.census.census_hash,
    baseline_sha: latest.value.census.baseline_sha,
  };
  const project = s0.record.project_id;
  const now = clockOf(d).now();
  const prior = await latestProbe(d.pool, s0Id, head);
  if (prior) {
    const ranNothing = PROBE_NOT_RUN.includes(prior.result.outcome);
    const age = now.getTime() - Date.parse(prior.result.recorded_at);
    const asked =
      o.retry === true || (await retryRequestedSince(d.pool, s0Id, prior.result.probe_id));
    if (!ranNothing || (!asked && age < PROBE_RETRY_NOT_RUN_MS)) return ok(prior);
  }
  const attempts = await d.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM core.onboarding_probe WHERE s0_id = $1 AND census_hash = $2',
    [s0Id, head.census_hash],
  );
  const probeId = probeIdOf(s0Id, head.census_hash, Number(attempts.rows[0]?.n ?? 0) + 1);
  const approved = d.probe.image();
  const base: ProbeBase = {
    probe_id: probeId,
    s0_id: s0Id,
    repo: s0.repo,
    ...head,
    image: approved?.image ?? null,
    recorded_at: now.toISOString(),
  };
  const notRun = (plan: ProbePlan | null, outcome: ProbeOutcome, detail: string) =>
    record(d, s0Id, project, notRunResult(base, plan, outcome, detail));

  // 1. what runs
  const facts = await d.knowledge.detectorFacts(s0.census.job_id);
  if (!facts.ok || facts.value === null) {
    return notRun(null, 'unavailable', 'the census job detector facts could not be read');
  }
  const plan = planProbe(facts.value);
  if (plan.test === null) {
    return notRun(
      plan,
      'no_test_command',
      plan.refused[0] ?? 'the census found no test command (RS-BT-1)',
    );
  }
  // 2. the image
  if (approved === null) {
    return notRun(
      plan,
      'no_image',
      'no onboarding probe image is approved (onboarding.sandbox_image)',
    );
  }
  // 3. DEC-18 and B1
  const guard: SessionGuardDeps = {
    execAllowedRepos: d.probe.execAllowedRepos,
    hasOpenSecretFinding: async (repo) => {
      const r = await d.knowledge.openFindings(repo);
      return r.ok ? ok(r.value.length > 0) : err({ message: r.error.message });
    },
  };
  const allowed = await checkSessionAllowed(guard, s0.repo, 'K-exec');
  if (!allowed.ok) {
    const code = allowed.error.code;
    return notRun(
      plan,
      code === 'exec_not_allowed'
        ? 'not_allowed'
        : code === 'b1_blocked'
          ? 'b1_blocked'
          : 'unavailable',
      code === 'exec_not_allowed'
        ? `${s0.repo} is not on the owner allow-list (DEC-18): its code does not run`
        : code === 'b1_blocked'
          ? 'B1: an open secret finding (or one knowledge cannot rule out) blocks K-exec'
          : 'the session guard refused',
    );
  }
  // 4. the repo copy, then the grant (recorded first)
  const files = await d.probe.files.files(s0.repo, head.baseline_sha);
  if (!files.ok)
    return notRun(plan, 'unavailable', 'the repo copy at the census head could not be read');
  const granted = ProbeGrantedPayload.parse({
    probe_id: probeId,
    s0_id: s0Id,
    project_id: project,
    repo: s0.repo,
    ...head,
    image: approved.image,
    granted_at: now.toISOString(),
  });
  const g = await inCoreTx<true>(d, async (j, tx) => {
    await lockKeys(tx, [`probe:${s0Id}`]);
    // one probe at a time per record: a fresh grant still out is a probe running
    const running = await tx.query(
      `SELECT 1 FROM core.onboarding_probe WHERE s0_id = $1 AND status = 'granted'
          AND granted_at > $2::timestamptz - make_interval(secs => $3)`,
      [s0Id, now.toISOString(), PROBE_GRANT_TTL_S],
    );
    if ((running.rowCount ?? 0) > 0)
      return err(coreError('conflict', 'a probe is already running'));
    const w = await j.emit(probeStream(s0Id), PROBE_EVENT.granted, granted, PROBE_ACTOR);
    if (!w.ok) return w;
    await applyProbeEvent(tx, {
      type: w.value.type,
      payload: granted,
      global_seq: w.value.global_seq,
    });
    return ok(true);
  });
  if (!g.ok) return g;

  // 5. the session (the controller checks the grant, the class, the image, the caps)
  const run = await d.probe.sandbox.run({
    repo_full_name: s0.repo,
    session_id: probeId,
    class: 'K-exec',
    image: approved.image,
    command: probeCommand(plan),
    repo: files.value,
    grant: {
      grant_id: probeId,
      item_id: s0Id,
      unit_id: ONBOARDING_PROBE_UNIT,
      lease_epoch: PROBE_GRANT_LEASE_EPOCH,
    },
  });
  const ended = { ...base, recorded_at: clockOf(d).now().toISOString() };
  if (!run.ok) {
    const code = run.error.code;
    const outcome: ProbeOutcome =
      code === 'exec_not_allowed'
        ? 'not_allowed'
        : code === 'b1_blocked'
          ? 'b1_blocked'
          : 'unavailable';
    return record(
      d,
      s0Id,
      project,
      notRunResult(ended, plan, outcome, `the sandbox refused the session: ${code}`),
    );
  }
  // 6. the result
  return record(d, s0Id, project, resultOfRun(ended, plan, run.value));
}

// ---------------------------------------------------------------- a person asks again (card 2)

/** Is there a retry request on the record after the probe `probeId` was recorded? */
async function retryRequestedSince(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
  probeId: string,
): Promise<boolean> {
  const q = await db.query(
    `SELECT 1 FROM record.record_event r
      WHERE r.stream = $1 AND r.type = $2
        AND r.global_seq > (SELECT event_gseq FROM core.onboarding_probe WHERE probe_id = $3)
      LIMIT 1`,
    [probeStream(s0Id), PROBE_EVENT.retry_requested, probeId],
  );
  return (q.rowCount ?? 0) > 0;
}

/**
 * Card 2: a person who holds the card's slot asks for the probe again. Only while card 2 is open, and only when the
 * probe recorded for the proposal's census head ran nothing (the image, the allow-list, B1 or the sandbox was the
 * reason): a probe that RAN is final for its head (OB §3.2 LF3 "one run"), and asking again does not change that.
 * The request is recorded (`probe.retry_requested`); the `onboarding_probe` loop runs the probe on its next tick.
 */
export async function requestProbeRetry(
  deps: CardDeps,
  input: { card_id: string; principal: string },
): Promise<Result<{ requested: true; probe_id: string | null }, CoreError>> {
  const state = await readCardState(deps.pool, input.card_id);
  if (!state || state.open.subject_kind !== 's0_record' || state.open.label !== 'C2') {
    return err(coreError('not_found', 'no such card 2'));
  }
  if (state.status !== 'open') return err(coreError('conflict', 'card 2 is not open'));
  const s0Id = state.open.subject_id;
  const holders = await decisionsFor(deps, s0Id).eligibility.holders(
    state.open.project_id as never,
    SLOT_OF_CARD.C2,
  );
  if (!holders.ok) return err(coreError('unavailable', holders.error.message));
  if (!holders.value.includes(input.principal as never)) {
    return err(
      coreError('forbidden', `${input.principal} does not hold the slot that decides card 2`),
    );
  }
  const loaded = await loadS0(deps.pool, s0Id);
  if (!loaded?.s0.census) return err(coreError('conflict', 'the census is not ready'));
  const latest = await latestProbe(deps.pool, s0Id);
  const prior = latest?.result.census_hash === loaded.s0.census.census_hash ? latest : null;
  if (prior && !PROBE_NOT_RUN.includes(prior.result.outcome)) {
    return err(
      coreError(
        'conflict',
        `the probe ran (${prior.result.outcome}): one run is final for its census head (LF3)`,
      ),
    );
  }
  const payload = ProbeRetryRequestedPayload.parse({
    s0_id: s0Id,
    card_id: input.card_id,
    requested_by: input.principal,
    requested_at: clockOf(deps).now().toISOString(),
  });
  const w = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`probe:${s0Id}`]);
    return j.emit(probeStream(s0Id), PROBE_EVENT.retry_requested, payload, input.principal);
  });
  return w.ok ? ok({ requested: true, probe_id: prior?.result.probe_id ?? null }) : w;
}

// ---------------------------------------------------------------- the loop

export const PROBE_LOOP_INTERVAL_MS = 30_000;

/**
 * The `onboarding_probe` loop: the probe of every S0 record waiting at card 2 (step 0.2 `card`), one record at a
 * time (a probe holds a K-exec session for up to 15 minutes). A record whose probe is already recorded for its
 * census head is a no-op; "a probe is running" (another worker) and "the census moved" are not failures here.
 */
export function probeLoop(d: ProbeRunDeps, o: { intervalMs?: number; startDelayMs?: number } = {}) {
  const intervalMs = o.intervalMs ?? PROBE_LOOP_INTERVAL_MS;
  return {
    name: 'onboarding_probe',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(30_000, intervalMs), maxMs: Math.max(intervalMs, 120_000) },
    async tick(ctx: LoopContext) {
      const ids = await activeS0Ids(d.pool);
      const waiting: string[] = [];
      for (const id of ids) {
        const l = await loadS0(d.pool, id);
        if (l?.s0.steps.get('0.2')?.state === 'card') waiting.push(id);
      }
      return ctx.eachItem(
        waiting,
        (id) => `probe ${id}`,
        async (id) => {
          const r = await runOnboardingProbe(d, id);
          if (!r.ok && r.error.code !== 'conflict') throw new Error(r.error.message);
        },
      );
    },
  } satisfies LoopSpec;
}
