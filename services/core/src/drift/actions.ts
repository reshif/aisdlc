import {
  DRIFT_CAUSE,
  DRIFT_EVENT,
  DRIFT_LEDGER_ENTRY,
  DriftReaffirmedPayload,
  DriftRestoredPayload,
  DriftVersionRequestedPayload,
  LevelValues,
  PRR_EVENT,
  PrrStatusChangedPayload,
  REAFFIRM_TEXT_MAX,
  bypassListFor,
  bypassListHash,
  canTransitionReadinessBy,
  driftFindingsHash,
  driftStream,
  gatePolicy,
  prrStream,
  repoKeyOf,
  type DriftFinding,
  type LedgerEntryDraft,
  type Level,
  type MergeBypassConfig,
  type OnboardingVersionRequest,
  type OnboardingVersionResult,
  type ProjectId,
  type ReaffirmRequest,
  type ReaffirmResult,
  type RepoFullName,
  type RestoreRequest,
  type RestoreResult,
} from '@aisdlc/contracts';
import {
  DEFAULT_POLICY_BUNDLE_VERSION,
  type EligibilityPort,
  type StepUpPort,
} from '@aisdlc/decisions';
import { deterministicId, err, hashCanonical, ok, sha256Hex, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { scanText } from '@aisdlc/secrets-rules';
import { lintAgentsFormat, lintText } from '@aisdlc/text-lint';
import type { Tx } from '@aisdlc/record';
import { decidersFrom } from '../cards/views.js';
import { coreError, type CoreError } from '../errors.js';
import {
  clockOf,
  inCoreLedgerTx,
  inCoreTx,
  lockKeys,
  type CoreDeps,
  type Journal,
} from '../journal.js';
import { repoIdentity } from '../prr-store.js';
import { requestOnboarding } from '../s0.js';
import { checkDrift, recheckRepo, type DriftDeps } from './check.js';
import { baselineOf, evaluateDrift } from './evaluate.js';
import { openKrl } from './krl.js';
import { baselineFor, inputsOf, loadDrift, type LoadedDrift } from './state.js';

// What a person does after onboarding (PLAN M16; OB §4.1 item 4, §4.2, §8; DEC-21(b), DEC-10 refined, DEC-11 refined):
//
//   restoreRecord        lifts a drift suspension: only a holder of the project's admin slot (card 4's, who attested
//                        the controls), only when the re-check passes (read NOW, recorded first, folded clean of the
//                        controls that suspended it; a CODEOWNERS whose content changed is accepted as the new baseline),
//                        and only with the bypass re-attestation against the exact config list the person was shown.
//                        One transaction: the ledger lock, `prr.status_changed` (actor `restore`), `drift.restored`
//                        with the baseline it accepted, the `prr.restored` ledger entry last. Never automatic.
//   reaffirmInstruction  card 2's slot accepts a drifted file's new text: the repo bytes at the recorded head (hash
//                        checked against the fact), secret-scanned (a hit blocks, no override) and linted (a blocking
//                        finding blocks), the step-up bound to the text hash; the text goes INTO the record
//                        (`drift.reaffirmed`, the copy agents receive) and the `instructions.reaffirmed` ledger entry.
//   requestVersion       a level-up (Census -> Light -> Full) or the re-sign of an expired record: a new S0 record
//                        through the normal onboarding request (0.1 re-runs at the current head, then the cards and M4
//                        make a new version); the governing version stays in force until that M4.

export interface DriftActionDeps extends DriftDeps {
  readonly ledger: LedgerClientDeps;
  readonly eligibility: EligibilityPort;
  readonly stepUp?: StepUpPort;
  /** Config `codehost.merge_bypass` now in force; `null`: unreadable (no restore: the list cannot be re-attested). */
  readonly bypass: () => MergeBypassConfig | null;
}

/** The slot that restores and re-affirms: card 4's and card 2's (the M1 slot, the project admin). */
export const AFTER_ONBOARDING_SLOT = gatePolicy('M1').slot;

async function holder(
  d: Pick<DriftActionDeps, 'eligibility'>,
  project: string,
  who: string,
): Promise<CoreError | null> {
  const h = await decidersFrom(d.eligibility, project, AFTER_ONBOARDING_SLOT);
  if (h.error !== null)
    return coreError('unavailable', `who holds the slot is unknown: ${h.error}`);
  return h.holders.includes(who as never)
    ? null
    : coreError(
        'refused',
        `only a holder of the project's ${AFTER_ONBOARDING_SLOT} slot may do this`,
      );
}

/** The repo in the project, or a refusal. */
async function repoOf(
  d: CoreDeps,
  project: ProjectId,
  repo: string,
): Promise<Result<{ repo_ref: string; repo_id: string }, CoreError>> {
  const id = await repoIdentity(d.pool, repo);
  if (!id || id.project_id !== project) {
    return err(coreError('not_found', `no repository ${repo} in project ${project}`));
  }
  return ok({ repo_ref: id.repo_ref, repo_id: id.repo_id });
}

/** The bypass list of a repo as config holds it now: logins and their hash. */
export function bypassShown(
  cfg: MergeBypassConfig | null,
  repo: string,
): { logins: string[]; list_hash: string } | null {
  if (cfg === null) return null;
  const logins = bypassListFor(cfg, repo)
    .map((p) => p.login)
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1));
  return { logins, list_hash: bypassListHash(logins) };
}

/** The suspend findings a restore still refuses on: everything but a CODEOWNERS whose content (only) changed. */
export function blocksRestore(f: readonly DriftFinding[]): DriftFinding[] {
  return f.filter(
    (x) =>
      x.effect === 'suspend' &&
      !(x.kind === 'codeowners' && x.reasons.every((r) => r === 'codeowners_changed')),
  );
}

/** Why the newest facts do not let a restore happen, or `null` (the re-check runs again on the restore itself). */
export function restoreWhyNot(l: LoadedDrift): string | null {
  const g = l.governing;
  if (!g) return 'no readiness record governs this repository';
  if (g.status !== 'suspended') return `the record is ${g.status}, not suspended`;
  const inputs = inputsOf(l);
  if (!inputs) return 'no readiness record governs this repository';
  const left = blocksRestore(evaluateDrift(inputs));
  if (left.length === 0) return null;
  return `still loosened: ${left.map((x) => `${x.kind}${x.subject ? ` ${x.subject}` : ''} (${x.reasons.join(', ')})`).join('; ')}`.slice(
    0,
    300,
  );
}

async function ledgerStart(
  tx: Tx,
  ledger: LedgerClientDeps,
): Promise<Result<PendingConfirm[], CoreError>> {
  await lockLedger(tx);
  const caught = await importUnconfirmed(tx, ledger);
  if (!caught.ok) return err(coreError('unavailable', caught.error.message));
  return ok([...caught.value.pending]);
}

const lockRepo = (tx: Tx, project: string, repo: string) =>
  lockKeys(tx, [`project:${project}`, `repo:${repoKeyOf(repo)}`, `drift:${repoKeyOf(repo)}`]);

// ---------------------------------------------------------------- restore (DEC-21(b))

export async function restoreRecord(
  d: DriftActionDeps,
  project: ProjectId,
  req: RestoreRequest,
): Promise<Result<RestoreResult, CoreError>> {
  const r = await repoOf(d, project, req.repo);
  if (!r.ok) return r;
  const who = req.on_behalf_of;
  const notHolder = await holder(d, project, who);
  if (notHolder) return err(notHolder);
  const shown = bypassShown(d.bypass(), r.value.repo_ref);
  if (!shown) {
    return err(
      coreError('unavailable', 'the bypass list cannot be read: nothing can be re-attested'),
    );
  }
  if (
    shown.list_hash !== req.bypass.list_hash ||
    bypassListHash(req.bypass.logins) !== shown.list_hash
  ) {
    return err(coreError('conflict', 'the bypass list changed since it was shown: read it again'));
  }
  const before = await loadDrift(d.pool, r.value.repo_ref);
  if (before?.governing?.status !== 'suspended') {
    return err(coreError('conflict', 'the readiness record of this repository is not suspended'));
  }
  // the re-check: read now, recorded first; the fold below works from those facts only
  const rc = await recheckRepo(d, r.value.repo_ref);
  if (!rc.ok) return rc;
  const c = await checkDrift(d, r.value.repo_ref);
  if (!c.ok) return c;
  const at = clockOf(d).now().toISOString();
  return inCoreLedgerTx<RestoreResult>(d, async (j: Journal, tx) => {
    await lockRepo(tx, project, r.value.repo_ref);
    const l = await loadDrift(tx, r.value.repo_ref);
    const g = l?.governing;
    const inputs = l ? inputsOf(l) : null;
    if (!l || !g || !inputs)
      return err(coreError('conflict', 'no readiness record governs this repo'));
    if (!canTransitionReadinessBy('restore', g.status, 'active')) {
      return err(
        coreError('conflict', `the record is ${g.status}: only a suspended record is restored`),
      );
    }
    if (Date.parse(g.prr.fresh_until) <= Date.parse(at)) {
      return err(
        coreError(
          'refused',
          'the record has expired: it is re-signed as a new version, never restored',
        ),
      );
    }
    const findings = evaluateDrift(inputs);
    const left = blocksRestore(findings);
    if (left.length > 0) {
      return err(coreError('refused', restoreWhyNot(l) ?? 'the re-check did not pass'));
    }
    const started = await ledgerStart(tx, d.ledger);
    if (!started.ok) return started;
    const pending = started.value;
    const entryId = deterministicId<'LedgerEntry'>(
      `prr.restored:${g.prr.record_hash}:${g.version}:${l.drift.restores.length}`,
    );
    const s = await j.emit(
      prrStream(project, r.value.repo_id),
      PRR_EVENT.status_changed,
      PrrStatusChangedPayload.parse({
        version: g.version,
        record_hash: g.prr.record_hash,
        from: g.status,
        to: 'active',
        actor: 'restore',
        cause: DRIFT_CAUSE.restored,
      }),
      who,
    );
    if (!s.ok) return s;
    const body = DriftRestoredPayload.parse({
      repo: l.repo_ref,
      project_id: project,
      s0_id: g.s0_id,
      prr_version: g.version,
      record_hash: g.prr.record_hash,
      by: who,
      at,
      recheck: {
        findings_hash: driftFindingsHash(findings),
        head_sha: l.files?.value.sha ?? null,
        rules_hash: l.rules?.value_hash ?? null,
      },
      baseline: baselineOf(
        l.files?.value ?? null,
        l.rules?.value ?? null,
        baselineFor(l.drift, g.version),
      ),
      bypass: { logins: shown.logins, list_hash: shown.list_hash },
      attestation: req.attestation,
      ledger_entry_id: entryId,
    });
    const w = await j.emit(driftStream(l.repo_ref), DRIFT_EVENT.restored, body, who);
    if (!w.ok) return w;
    const { ledger_entry_id: _drop, ...rest } = body;
    void _drop;
    const draft: LedgerEntryDraft = {
      entry_id: entryId,
      entry_type: DRIFT_LEDGER_ENTRY.restored,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: 's0_record',
      subject_id: g.s0_id as never,
      subject_hash: hashCanonical(rest) as never,
      decision: null,
      actor: who,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: { kind: 'prr_restored', ...rest } as never,
      created_at: at as never,
    };
    const le = await appendLedgerEntryTx(tx, d.ledger, draft);
    if (!le.ok) return err(coreError('unavailable', le.error.message));
    pending.push(...le.value.pending);
    return ok({
      value: { prr_version: g.version, status: 'active', ledger_entry_id: entryId as never },
      pending,
    });
  });
}

// ---------------------------------------------------------------- re-affirm (OB §4.2)

/** The repo text at the recorded head for a drifted path, with what a re-affirmation would need to know about it. */
export async function readDriftedText(
  d: DriftDeps,
  l: LoadedDrift,
  path: string,
): Promise<
  Result<
    {
      head_sha: string;
      text: string | null;
      blob_sha: string | null;
      sha256: string | null;
      expected: string;
    },
    CoreError
  >
> {
  const g = l.governing;
  const inputs = inputsOf(l);
  if (!g || !inputs) return err(coreError('conflict', 'no readiness record governs this repo'));
  const finding = evaluateDrift(inputs).find((f) => f.effect === 'reaffirm' && f.subject === path);
  // OB §4.2: a KRL penalty is lifted only by re-affirming its path, so the card stays while one is open, even when
  // the file went back to the affirmed bytes (re-affirming the same text is then what lifts it)
  const penalty = openKrl(l.drift, g.version).find((p) => p.path === path);
  if (!finding && !penalty)
    return err(coreError('conflict', `${path} has not drifted: there is nothing to re-affirm`));
  const head = l.files?.value.sha;
  if (!head) return err(coreError('conflict', 'no files poll is recorded yet'));
  const obs = l.files?.value.files.find((f) => f.path === path) ?? null;
  const read = await d.source.read_at_sha({ repo: l.repo_ref as RepoFullName, sha: head, path });
  if (read.state !== 'ok') {
    return err(coreError('unavailable', `${path} could not be read at ${head}: ${read.message}`));
  }
  const text = read.value?.content ?? null;
  const sha = text === null ? null : sha256Hex(text);
  // the bytes must be the ones the recorded fact saw: the record decides, never a read of a moved head
  if (sha !== (obs?.sha256 ?? null)) {
    return err(
      coreError('conflict', `${path} at ${head} is not what the poll recorded: poll again`),
    );
  }
  return ok({
    head_sha: head,
    text,
    blob_sha: read.value?.blob_sha ?? null,
    sha256: sha,
    expected:
      finding?.expected ?? inputs.tracked.find((t) => t.path === path)?.expected_sha256 ?? '',
  });
}

export const lintOf = (text: string) =>
  [...lintText(text), ...lintAgentsFormat(text, false)]
    .map((f) => ({ rule: f.rule as string, severity: f.severity, line: f.line }))
    .sort((a, b) => a.line - b.line || (a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0));

export async function reaffirmInstruction(
  d: DriftActionDeps,
  project: ProjectId,
  req: ReaffirmRequest,
): Promise<Result<ReaffirmResult, CoreError>> {
  const r = await repoOf(d, project, req.repo);
  if (!r.ok) return r;
  const who = req.on_behalf_of;
  const notHolder = await holder(d, project, who);
  if (notHolder) return err(notHolder);
  if (!d.stepUp) return err(coreError('unavailable', 'no step-up is configured'));
  const before = await loadDrift(d.pool, r.value.repo_ref);
  if (!before) return err(coreError('not_found', 'no such repository'));
  const read = await readDriftedText(d, before, req.path);
  if (!read.ok) return read;
  const { text, sha256, head_sha, blob_sha } = read.value;
  if (text === null || sha256 === null || blob_sha === null) {
    return err(
      coreError('refused', `${req.path} is gone at the head: the affirmed text keeps being served`),
    );
  }
  if (sha256 !== req.text_sha256) {
    return err(coreError('conflict', 'the text changed since it was shown: read it again'));
  }
  if (text.length > REAFFIRM_TEXT_MAX) return err(coreError('refused', 'the text is too long'));
  // OB §4.1 item 4: secret-scanned before it enters the record; a hit blocks, with no override
  if (scanText(text).length > 0) {
    return err(
      coreError('refused', 'the shared secret ruleset hit the text: it cannot be affirmed'),
    );
  }
  const lint = lintOf(text);
  if (lint.some((f) => f.severity === 'blocking')) {
    return err(
      coreError(
        'refused',
        'a blocking content-lint finding is in the text: fix the file on GitHub first',
      ),
    );
  }
  const v = await d.stepUp.verify(req.step_up.proof, sha256 as never, who);
  if (!v.ok) return err(coreError('refused', 'the step-up does not verify for this text'));
  const at = clockOf(d).now().toISOString();
  return inCoreLedgerTx<ReaffirmResult>(d, async (j, tx) => {
    await lockRepo(tx, project, r.value.repo_ref);
    const l = await loadDrift(tx, r.value.repo_ref);
    const g = l?.governing;
    if (!l || !g) return err(coreError('conflict', 'no readiness record governs this repo'));
    if (l.files?.value.sha !== head_sha) {
      return err(coreError('conflict', 'a newer poll is recorded: read the text again'));
    }
    const started = await ledgerStart(tx, d.ledger);
    if (!started.ok) return started;
    const pending = started.value;
    const entryId = deterministicId<'LedgerEntry'>(
      `instructions.reaffirmed:${g.prr.record_hash}:${req.path}:${sha256}:${head_sha}`,
    );
    const body = DriftReaffirmedPayload.parse({
      repo: l.repo_ref,
      project_id: project,
      s0_id: g.s0_id,
      prr_version: g.version,
      record_hash: g.prr.record_hash,
      path: req.path,
      text,
      text_sha256: sha256,
      previous_sha256: read.value.expected || null,
      head_sha,
      blob_sha,
      lint_report_hash: hashCanonical(lint),
      step_up_ref: `stepup:${sha256Hex(req.step_up.proof).slice(0, 32)}`,
      by: who,
      at,
      ledger_entry_id: entryId,
    });
    const w = await j.emitAll(driftStream(l.repo_ref), [
      {
        type: DRIFT_EVENT.reaffirmed,
        body: body as unknown as Record<string, unknown>,
        actor: who,
        idempotency_key: `drift:reaffirmed:${entryId}`,
      },
    ]);
    if (!w.ok) return w;
    if (w.value.duplicate) {
      return ok({
        value: { path: req.path, text_sha256: sha256 as never, ledger_entry_id: entryId as never },
        pending,
      });
    }
    const { ledger_entry_id: _drop, text: _text, ...rest } = body;
    void _drop;
    void _text;
    const draft: LedgerEntryDraft = {
      entry_id: entryId,
      entry_type: DRIFT_LEDGER_ENTRY.reaffirmed,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: 's0_record',
      subject_id: g.s0_id as never,
      subject_hash: sha256 as never,
      decision: null,
      actor: who,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: { kind: 'instructions_reaffirmed', ...rest } as never,
      created_at: at as never,
    };
    const le = await appendLedgerEntryTx(tx, d.ledger, draft);
    if (!le.ok) return err(coreError('unavailable', le.error.message));
    pending.push(...le.value.pending);
    return ok({
      value: { path: req.path, text_sha256: sha256 as never, ledger_entry_id: entryId as never },
      pending,
    });
  }).then(async (out) => {
    // the new text is now the affirmed one: fold again so the finding clears
    if (out.ok) await checkDrift(d, r.value.repo_ref);
    return out;
  });
}

// ---------------------------------------------------------------- a new version: level-up, re-sign (OB §8)

const rank = (l: Level): number => LevelValues.indexOf(l);

/** The levels a level-up may ask for from `signed`. */
export const levelsAbove = (signed: Level): Level[] =>
  LevelValues.filter((l) => rank(l) > rank(signed));

export async function requestVersion(
  d: CoreDeps,
  project: ProjectId,
  req: OnboardingVersionRequest,
): Promise<Result<OnboardingVersionResult, CoreError>> {
  const r = await repoOf(d, project, req.repo);
  if (!r.ok) return r;
  const l = await loadDrift(d.pool, r.value.repo_ref);
  const g = l?.governing;
  if (!l || !g) {
    return err(
      coreError('refused', 'no readiness record governs this repository: onboard it first'),
    );
  }
  const now = clockOf(d).nowMs();
  const expired = g.status === 'expired' || now >= Date.parse(g.prr.fresh_until);
  const signed = g.prr.level.signed;
  if (req.reason === 'level_up') {
    if (expired) return err(coreError('refused', 'the record has expired: re-sign it first'));
    if (rank(req.level) <= rank(signed)) {
      return err(coreError('invalid_input', `a level-up asks for a level above ${signed}`));
    }
    // user decision 2026-11-12: Full only as a level-up of a repo signed at LIGHT (card 3 needs the intent slot that
    // card 4's role map publishes); a Census repo is onboarded at Light first
    if (req.level === 'full' && signed !== 'light') {
      return err(
        coreError('refused', 'Full is a level-up of a Light repo: raise it to Light first'),
      );
    }
  } else {
    if (!expired)
      return err(coreError('refused', 'the record has not expired: nothing to re-sign'));
    if (rank(req.level) > rank(signed)) {
      return err(
        coreError(
          'invalid_input',
          'a re-sign is at the signed level or lower: a raise is a level-up',
        ),
      );
    }
  }
  // one request per version, reason and level: the same ask twice is the same S0 record
  const requestId = deterministicId<'Request'>(
    `drift.version:${repoKeyOf(r.value.repo_ref)}:${g.version}:${req.reason}:${req.level}`,
  );
  const toFull = req.reason === 'level_up' && req.level === 'full';
  const made = await requestOnboarding(
    d,
    {
      project_id: project,
      repo: r.value.repo_ref as RepoFullName,
      level: req.level,
      request_id: requestId,
      on_behalf_of: req.on_behalf_of,
    },
    // THE path to Full: the S0 driver raises 0.3 and card 3 for this record. SEAM (M17.1): the Full baseline's content
    // and card 3's view are built there; this request, its decision and its recording are complete here.
    toFull
      ? { levelUp: { from_version: g.version, from_level: 'light' } }
      : req.level === 'full'
        ? { levelUp: { from_version: g.version, from_level: 'full' } } // the re-sign of a Full record
        : {},
  );
  if (!made.ok) return made;
  const w = await inCoreTx(d, async (j, tx) => {
    await lockRepo(tx, project, r.value.repo_ref);
    return j.emitAll(driftStream(r.value.repo_ref), [
      {
        type: DRIFT_EVENT.version_requested,
        body: DriftVersionRequestedPayload.parse({
          repo: r.value.repo_ref,
          project_id: project,
          s0_id: g.s0_id,
          prr_version: g.version,
          record_hash: g.prr.record_hash,
          reason: req.reason,
          from_level: signed,
          level: req.level,
          new_s0_id: made.value.s0_id,
          opens: toFull ? ['0.3', 'C3'] : [],
          by: req.on_behalf_of,
        }) as unknown as Record<string, unknown>,
        actor: req.on_behalf_of,
        idempotency_key: `drift:version:${requestId}`,
      },
    ]);
  });
  if (!w.ok) return w;
  return ok({
    s0_id: made.value.s0_id as never,
    level: req.level,
    reason: req.reason,
    duplicate: made.value.duplicate,
  });
}
