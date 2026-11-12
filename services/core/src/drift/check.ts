import {
  AffirmedFilesValue,
  DRIFT_CAUSE,
  DRIFT_EVENT,
  DRIFT_LEDGER_ENTRY,
  DriftEvaluatedPayload,
  DriftKrlLoweredPayload,
  DriftSuspendedPayload,
  INBOUND_FACT_EVENT,
  InboundFactPayload,
  PRR_EVENT,
  PrrStatusChangedPayload,
  canTransitionReadinessBy,
  driftFindingsHash,
  driftStream,
  inboundFactStream,
  prrStream,
  repoKeyOf,
  type DriftFinding,
  type LedgerEntryDraft,
  type RepoFullName,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION } from '@aisdlc/decisions';
import { deterministicId, err, hashCanonical, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { recordObservation, ONE_HOUR_MS, TEN_MINUTES_MS, type LoopSpec } from '@aisdlc/loops';
import type { CodeHostPort } from '@aisdlc/ports';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreLedgerTx, lockKeys, type CoreDeps } from '../journal.js';
import { readGoverning, repoIdentity } from '../prr-store.js';
import { setPrrStatus } from '../prr-status.js';
import { catchUp } from '../queries.js';
import { evaluateDrift, suspending } from './evaluate.js';
import { krlNow, openKrl } from './krl.js';
import { inputsOf, loadDrift } from './state.js';

// The drift loops' steps (PLAN M16; OB §4.2, §8; DEC-21, DEC-12(a)):
//
//   pollAffirmedFiles  record-first: the hashes of every tracked file at the newest recorded default-branch head, as
//                      ONE `affirmed_files` inbound fact (written only when it changed). The head itself is the head
//                      loop's fact; this step never decides on a head it read live.
//   checkDrift         the fold of the newest facts against the governing record; `drift.evaluated` when the findings
//                      changed, and for a `suspend` finding on an active (or stale) record, in ONE transaction: the
//                      ledger lock before the first append, `prr.status_changed` (mechanical, tighten-only),
//                      `drift.suspended`, and the `prr.suspended` ledger entry last. Never lifted here.
//                      An affirmed instruction file that drifted gives its area KRL −1 in the same transaction:
//                      `drift.krl_lowered` and its `prr.krl_lowered` ledger entry (OB §4.2), once per path until a
//                      person re-affirms it.
//   expireRecords      the `fresh_until` sweep: an active, stale or suspended record past it is `expired` (Census-only
//                      behaviour; the re-sign card). Expiry never approves, and the 1.4 rule already reads it so.
//   recheckRepo        a restore's re-check: the head, the rules and the files read NOW and recorded, then folded.

export const DRIFT_ACTOR = 'system.drift';

/** What the polls read: the read half of the code host. The codehost HTTP client and `FakeGitHub` fit. */
export type DriftSource = Pick<
  CodeHostPort,
  | 'list_repos'
  | 'branch_head'
  | 'rules_for_branch'
  | 'read_at_sha'
  | 'codeowners'
  | 'codeowners_errors'
>;

export interface DriftDeps extends CoreDeps {
  readonly source: DriftSource;
}

const notOk = (what: string, r: { state: string; reason: string; message: string }): CoreError =>
  coreError('unavailable', `${what}: ${r.state}/${r.reason}: ${r.message}`);

/** The newest recorded default-branch head of a repo, or `null`. */
async function recordedHead(
  pool: CoreDeps['pool'],
  repo: string,
): Promise<{ sha: string; project_id: string } | null> {
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 AND type = $2
      ORDER BY record_event.seq DESC LIMIT 1`,
    [inboundFactStream('default_branch_head', repo), INBOUND_FACT_EVENT.observed],
  );
  const e = q.rows[0] ? toRecordEvent(q.rows[0]) : null;
  if (!e) return null;
  const p = InboundFactPayload.parse(e.payload);
  const sha = (p.value as { sha?: unknown }).sha;
  return typeof sha === 'string' ? { sha, project_id: p.project_id } : null;
}

/** Reads the tracked files at `sha` and records them as an `affirmed_files` fact. A read that fails records nothing. */
export async function pollAffirmedFiles(
  d: DriftDeps,
  repo: string,
  o: { intervalMs?: number } = {},
): Promise<Result<'recorded' | 'unchanged' | 'skipped', CoreError>> {
  const loaded = await loadDrift(d.pool, repo);
  const inputs = loaded ? inputsOf(loaded) : null;
  if (!loaded || !inputs) return ok('skipped');
  const head = await recordedHead(d.pool, loaded.repo_ref);
  if (!head) return ok('skipped');
  const full = loaded.repo_ref as RepoFullName;
  const files: AffirmedFilesValue['files'] = [];
  for (const t of inputs.tracked) {
    const r = await d.source.read_at_sha({ repo: full, sha: head.sha, path: t.path });
    if (r.state !== 'ok') return err(notOk(`${t.path} at ${head.sha}`, r));
    files.push({
      path: t.path,
      blob_sha: (r.value?.blob_sha ?? null) as never,
      sha256: (r.value ? sha256Hex(r.value.content) : null) as never,
    });
  }
  const co = await d.source.codeowners({ repo: full, sha: head.sha });
  if (co.state !== 'ok') return err(notOk('CODEOWNERS', co));
  let codeowners: AffirmedFilesValue['codeowners'] = null;
  if (co.value) {
    const errors = await d.source.codeowners_errors({ repo: full, ref: head.sha });
    codeowners = {
      path: co.value.path,
      blob_sha: co.value.blob_sha as never,
      // unknown is never "no errors": the fold suspends on it
      errors: errors.state === 'ok' ? errors.value.length : 'unknown',
    };
  }
  const value = AffirmedFilesValue.parse({ sha: head.sha, files, codeowners });
  const out = await recordObservation(
    d.pool,
    {
      kind: 'affirmed_files',
      repo: full,
      project_id: loaded.project_id as never,
      value: value as unknown as Record<string, unknown>,
      poll_interval_ms: o.intervalMs ?? TEN_MINUTES_MS,
    },
    clockOf(d),
  );
  return ok(out);
}

/** A restore's re-check: the head, the rules and the files, read now and RECORDED, before anything folds them. */
export async function recheckRepo(d: DriftDeps, repo: string): Promise<Result<true, CoreError>> {
  const id = await repoIdentity(d.pool, repo);
  if (!id) return err(coreError('not_found', `core has no repo ${repo}`));
  const full = id.repo_ref as RepoFullName;
  const repos = await d.source.list_repos();
  if (repos.state !== 'ok') return err(notOk('list_repos', repos));
  const info = repos.value.find((r) => repoKeyOf(r.full_name) === repoKeyOf(full));
  if (!info) return err(coreError('unavailable', `${full} is not reached by the installation`));
  const head = await d.source.branch_head({ repo: full, branch: info.default_branch });
  if (head.state !== 'ok') return err(notOk('head', head));
  const rules = await d.source.rules_for_branch({ repo: full, branch: info.default_branch });
  if (rules.state !== 'ok') return err(notOk('rules', rules));
  const clock = clockOf(d);
  const base = { repo: full, project_id: id.project_id as never };
  await recordObservation(
    d.pool,
    {
      ...base,
      kind: 'default_branch_head',
      value: { branch: info.default_branch, sha: head.value },
      poll_interval_ms: TEN_MINUTES_MS,
    },
    clock,
  );
  await recordObservation(
    d.pool,
    {
      ...base,
      kind: 'effective_rules',
      value: rules.value as unknown as Record<string, unknown>,
      poll_interval_ms: ONE_HOUR_MS,
    },
    clock,
  );
  const f = await pollAffirmedFiles(d, full);
  return f.ok ? ok(true) : f;
}

export interface CheckOutcome {
  readonly findings: readonly DriftFinding[];
  readonly findings_hash: string;
  readonly recorded: boolean;
  readonly suspended: boolean;
  /** Paths whose drift lowered their area's KRL in this check (OB §4.2). */
  readonly krl_lowered: number;
}

/** Folds the newest facts for one repo and records what changed (see the header). */
export async function checkDrift(
  d: CoreDeps & { readonly ledger: LedgerClientDeps },
  repo: string,
): Promise<Result<CheckOutcome | null, CoreError>> {
  const id = await repoIdentity(d.pool, repo);
  if (!id) return ok(null);
  const now = clockOf(d).now();
  return inCoreLedgerTx<CheckOutcome | null>(d, async (j, tx) => {
    await lockKeys(tx, [
      `project:${id.project_id}`,
      `repo:${repoKeyOf(id.repo_ref)}`,
      `drift:${repoKeyOf(id.repo_ref)}`,
    ]);
    const loaded = await loadDrift(tx, id.repo_ref);
    const g = loaded?.governing ?? null;
    const inputs = loaded ? inputsOf(loaded) : null;
    if (!loaded || !g || !inputs) return ok({ value: null, pending: [] });
    const findings = evaluateDrift(inputs);
    const hash = driftFindingsHash(findings);
    const last = loaded.drift.evaluated.get(g.version);
    const changed = last?.findings_hash !== hash;
    const susp = suspending(findings);
    // OB §4.2: each drifted affirmed instruction file without an open penalty lowers its area's KRL
    const open = openKrl(loaded.drift, g.version);
    const lower = findings.filter(
      (f) =>
        f.kind === 'instruction_text' &&
        f.subject !== null &&
        f.expected !== null &&
        !open.some((p) => p.path === f.subject),
    );
    // an active record past `fresh_until` is already expired (the sweep writes it): no suspension on top of that
    const live = now.getTime() < Date.parse(g.prr.fresh_until);
    const suspend =
      susp.length > 0 && live && canTransitionReadinessBy('mechanical', g.status, 'suspended');
    if (!changed && !suspend && lower.length === 0) {
      return ok({
        value: {
          findings,
          findings_hash: hash,
          recorded: false,
          suspended: false,
          krl_lowered: 0,
        },
        pending: [],
      });
    }
    const pending: PendingConfirm[] = [];
    const entryId = deterministicId<'LedgerEntry'>(
      `prr.suspended:${g.prr.record_hash}:${g.version}:${loaded.drift.restores.length}:${hash}`,
    );
    if (suspend || lower.length > 0) {
      // the ledger lock before the first record append, the entry last (AGENTS.md lock order)
      await lockLedger(tx);
      const caught = await importUnconfirmed(tx, d.ledger);
      if (!caught.ok) return err(coreError('unavailable', caught.error.message));
      pending.push(...caught.value.pending);
    }
    const facts = {
      repo: loaded.repo_ref,
      project_id: loaded.project_id,
      s0_id: g.s0_id,
      prr_version: g.version,
      record_hash: g.prr.record_hash,
    };
    if (changed) {
      const w = await j.emit(
        driftStream(loaded.repo_ref),
        DRIFT_EVENT.evaluated,
        DriftEvaluatedPayload.parse({
          ...facts,
          head_sha: loaded.files?.value.sha ?? null,
          rules_hash: loaded.rules?.value_hash ?? null,
          findings,
          findings_hash: hash,
        }),
        DRIFT_ACTOR,
      );
      if (!w.ok) return w;
    }
    // KRL −1: one event per path, each with its ledger entry (written after every record append below)
    const krlEntries: LedgerEntryDraft[] = [];
    const areaOf = new Map(g.prr.affirmed.instructions.map((i) => [i.path, i.area]));
    const areas = new Set(open.map((p) => p.area));
    for (const f of lower) {
      const path = f.subject as string;
      const before = krlNow(g.prr, areas.size).current;
      const area = areaOf.get(path) ?? '.';
      areas.add(area);
      const after = krlNow(g.prr, areas.size).current;
      const prior = loaded.drift.events.filter(
        (e) =>
          e.type === DRIFT_EVENT.krl_lowered &&
          (e.payload as { path?: string; prr_version?: number }).path === path &&
          (e.payload as { prr_version?: number }).prr_version === g.version,
      ).length;
      const kid = deterministicId<'LedgerEntry'>(
        `prr.krl_lowered:${g.prr.record_hash}:${g.version}:${path}:${prior}`,
      );
      const body = DriftKrlLoweredPayload.parse({
        ...facts,
        area,
        path,
        expected: f.expected,
        observed: f.observed,
        krl_signed: krlNow(g.prr, 0).signed,
        krl_from: before,
        krl_to: after,
        ledger_entry_id: kid,
      });
      const w = await j.emit(
        driftStream(loaded.repo_ref),
        DRIFT_EVENT.krl_lowered,
        body,
        DRIFT_ACTOR,
      );
      if (!w.ok) return w;
      const { ledger_entry_id: _k, ...krlRest } = body;
      void _k;
      krlEntries.push({
        entry_id: kid,
        entry_type: DRIFT_LEDGER_ENTRY.krl_lowered,
        gate_instance_id: null,
        gate_id: null,
        subject_kind: 's0_record',
        subject_id: g.s0_id as never,
        subject_hash: hashCanonical(krlRest) as never,
        decision: null,
        actor: DRIFT_ACTOR as never,
        sod_waiver: false,
        policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
        body: { kind: 'prr_krl_lowered', ...krlRest } as never,
        created_at: now.toISOString() as never,
      });
    }
    if (suspend) {
      const s = await j.emit(
        prrStream(id.project_id, id.repo_id),
        PRR_EVENT.status_changed,
        PrrStatusChangedPayload.parse({
          version: g.version,
          record_hash: g.prr.record_hash,
          from: g.status,
          to: 'suspended',
          actor: 'mechanical',
          cause: DRIFT_CAUSE.suspended,
        }),
        DRIFT_ACTOR,
      );
      if (!s.ok) return s;
      const body = DriftSuspendedPayload.parse({
        ...facts,
        from: g.status,
        findings: susp,
        findings_hash: driftFindingsHash(susp),
        ledger_entry_id: entryId,
      });
      const w = await j.emit(
        driftStream(loaded.repo_ref),
        DRIFT_EVENT.suspended,
        body,
        DRIFT_ACTOR,
      );
      if (!w.ok) return w;
      const { ledger_entry_id: _drop, ...rest } = body;
      void _drop;
      const draft: LedgerEntryDraft = {
        entry_id: entryId,
        entry_type: DRIFT_LEDGER_ENTRY.suspended,
        gate_instance_id: null,
        gate_id: null,
        subject_kind: 's0_record',
        subject_id: g.s0_id as never,
        subject_hash: body.findings_hash as never,
        decision: null,
        actor: DRIFT_ACTOR as never,
        sod_waiver: false,
        policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
        body: { kind: 'prr_suspended', ...rest } as never,
        created_at: now.toISOString() as never,
      };
      const l = await appendLedgerEntryTx(tx, d.ledger, draft);
      if (!l.ok) return err(coreError('unavailable', l.error.message));
      pending.push(...l.value.pending);
    }
    for (const draft of krlEntries) {
      const l = await appendLedgerEntryTx(tx, d.ledger, draft);
      if (!l.ok) return err(coreError('unavailable', l.error.message));
      pending.push(...l.value.pending);
    }
    return ok({
      value: {
        findings,
        findings_hash: hash,
        recorded: changed,
        suspended: suspend,
        krl_lowered: lower.length,
      },
      pending,
    });
  });
}

/** The registered repos that a readiness record governs (a fresh read each tick). */
export async function governedRepos(pool: CoreDeps['pool']): Promise<string[]> {
  await catchUp(pool);
  const q = await pool.query<{ repo_ref: string }>(
    'SELECT repo_ref FROM core.repo ORDER BY repo_ref',
  );
  const out: string[] = [];
  for (const r of q.rows) {
    const g = await readGoverning(pool, r.repo_ref);
    if (g?.governing) out.push(r.repo_ref);
  }
  return out;
}

/** The `fresh_until` sweep for one repo: `expired` once it has passed (mechanical, tighten-only). */
export async function expireRecord(d: CoreDeps, repo: string): Promise<Result<boolean, CoreError>> {
  const g = await readGoverning(d.pool, repo);
  const v = g?.governing;
  if (!v) return ok(false);
  if (clockOf(d).nowMs() < Date.parse(v.prr.fresh_until)) return ok(false);
  if (!canTransitionReadinessBy('mechanical', v.status, 'expired')) return ok(false);
  const r = await setPrrStatus(d, { repo, to: 'expired', cause: DRIFT_CAUSE.expired });
  return r.ok ? ok(r.value.changed) : r;
}

export interface DriftLoopOptions {
  readonly intervalMs?: number;
  readonly startDelayMs?: number;
}

/**
 * The `onboarding_drift` loop (core-worker): for every governed repo, the files poll at the recorded head, the fold,
 * and the expiry sweep. The head and rules facts are the code-host poll loops' (10 min; hourly or nightly).
 */
export function driftLoop(
  d: DriftDeps & { readonly ledger: LedgerClientDeps },
  o: DriftLoopOptions = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? TEN_MINUTES_MS;
  return {
    name: 'onboarding_drift',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(30_000, intervalMs), maxMs: intervalMs },
    async tick(ctx) {
      const repos = await governedRepos(d.pool);
      return ctx.eachItem(
        repos,
        (r) => r,
        async (r) => {
          const e = await expireRecord(d, r);
          if (!e.ok) throw new Error(e.error.message);
          const p = await pollAffirmedFiles(d, r, { intervalMs });
          // a files read that failed is this repo's failure, but the rules fact can still suspend it
          const c = await checkDrift(d, r);
          if (!c.ok) throw new Error(c.error.message);
          if (!p.ok) throw new Error(p.error.message);
        },
      );
    },
  };
}
