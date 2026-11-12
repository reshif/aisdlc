import {
  ISSUE_TWIN_EVENT,
  ISSUE_TWIN_LEDGER_ENTRY_TYPE,
  IssueTwinBatchApproved,
  IssueTwinLinked,
  IssueTwinRequestMade,
  issueTwinStream,
  type Gap,
  type IssueTwinBatchRequest,
  type IssueTwinBatchResult,
  type IssueTwinBatchRow,
  type IssueTwinLinkRequest,
  IssueTwinRepoView,
  type IssueTwinRequestRequest,
  IssueTwinRequestResult,
  type IssueTwinView,
  type LedgerEntryDraft,
  type ProjectId,
  type RecordEvent,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION } from '@aisdlc/decisions';
import { deterministicId, err, hashCanonical, newId, ok, type Result } from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type LedgerClientDeps,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import { injectionReportOf, taintMark } from '@aisdlc/work';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreLedgerTx, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { readGoverning } from '../prr-store.js';
import { catchUp } from '../queries.js';
import { requestWork } from '../work.js';
import { foldIssueTwin, type TwinState } from './fold.js';
import {
  allowedTwinDispositions,
  defaultTwinDisposition,
  disclosureOf,
  renderTwin,
  twinTitle,
} from './render.js';

// The issue twin's writes and reads in core (PLAN M16; OB §7; DEC-20(a)). The record is the truth: every row the portal
// shows is a fold of the repo's `issue_twin:<repo>` stream and the governing readiness record's gap ledger.
//
//   approveBatch     a person disposes of gaps (file_issue | track_only). One transaction: the twin lock, then the
//                    ledger lock before the first record append, `issue_twin.batch_approved` with the exact rows and
//                    the hash of the rendered bodies, and the `issue_twin.batch` ledger entry last. Nothing is filed
//                    here: the sync loop files exactly the approved list.
//   linkDuplicate    dedupe step 3: a person links an issue already on GitHub as the twin of a gap not yet filed.
//   requestFromTwin  OB §7 "Remediation path": a gap becomes an N6 request, S1 as L2, then G0 like any request. The
//                    text is the factory's rendered twin (what the issue was filed with, never what it says on GitHub
//                    now), and it goes through the normal intake: normalise, taint-mark (origin `issue`), injection
//                    scan, de-dupe. The same gap asked twice is the same request.
//   issueTwinView    the portal's view: twins and their sync state, approved batches, candidates for the next batch.

export const ISSUE_TWIN_ACTOR = 'system.issue_twin';
export const twinLockKey = (repo: string): string => `issue_twin:${repo.toLowerCase()}`;

/** The lane a remediation request enters S1 as (OB §7, §8: "a gap becomes an N6 item, enters S1 as L2, then G0"). */
export const REMEDIATION_LANE = 'L2' as const;
/** The entry channel of a remediation request (contracts: N6 `factory_proposed`). */
export const REMEDIATION_CHANNEL = 'N6' as const;

export async function twinEvents(db: Executor, repo: string): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [issueTwinStream(repo)],
  );
  return q.rows.map(toRecordEvent);
}

export async function readTwin(db: Executor, repo: string): Promise<TwinState> {
  return foldIssueTwin(await twinEvents(db, repo));
}

interface Governed {
  readonly project_id: string;
  readonly repo_ref: string;
  readonly repo_id: string;
  readonly s0_id: string;
  readonly version: number;
  readonly record_hash: string;
  readonly visibility: 'public' | 'private' | 'internal';
  readonly gaps: readonly Gap[];
}

async function governed(
  db: Executor,
  project: string,
  repo: string,
): Promise<Result<Governed, CoreError>> {
  const g = await readGoverning(db, repo);
  if (!g || g.project_id !== project) {
    return err(coreError('not_found', `no repository ${repo} in project ${project}`));
  }
  if (!g.governing) {
    return err(coreError('refused', `no readiness record governs ${g.repo_ref}: nothing to file`));
  }
  const prr = g.governing.prr;
  return ok({
    project_id: g.project_id,
    repo_ref: g.repo_ref,
    repo_id: prr.repo.repo_id,
    s0_id: g.governing.s0_id,
    version: g.governing.version,
    record_hash: prr.record_hash,
    visibility: prr.repo.visibility,
    gaps: prr.gaps,
  });
}

/** A gap a batch may still dispose of: open (not verified, not waived) and without a twin. */
const isCandidate = (g: Gap, twin: TwinState): boolean =>
  g.status === 'open' && !twin.twins.has(g.gap_id);

export const bodiesHash = (rows: readonly IssueTwinBatchRow[]): string =>
  hashCanonical(
    rows
      .filter((r) => r.disposition === 'file_issue')
      .map((r) => ({ gap_id: r.gap_id, body_sha256: r.body_sha256 })),
  );

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- approve a batch

export async function approveBatch(
  deps: CoreDeps & { readonly ledger: LedgerClientDeps },
  project: ProjectId,
  req: IssueTwinBatchRequest,
): Promise<Result<IssueTwinBatchResult, CoreError>> {
  const batchId = newId<'IssueTwinBatch'>();
  const entryId = deterministicId<'LedgerEntry'>(`issue_twin.batch:${batchId}`);
  return inCoreLedgerTx(deps, async (j, tx) => {
    await lockKeys(tx, [twinLockKey(req.repo)]);
    const gov = await governed(tx, project, req.repo);
    if (!gov.ok) return gov;
    const twin = foldIssueTwin(await j.events(issueTwinStream(gov.value.repo_ref)));
    const byId = new Map(gov.value.gaps.map((g) => [g.gap_id, g]));
    const seen = new Set<string>();
    const rows: IssueTwinBatchRow[] = [];
    for (const r of req.rows) {
      const g = byId.get(r.gap_id);
      if (!g)
        return err(coreError('invalid_input', `${r.gap_id} is not a gap of the readiness record`));
      if (seen.has(r.gap_id))
        return err(coreError('invalid_input', `${r.gap_id} is in the batch twice`));
      seen.add(r.gap_id);
      if (!isCandidate(g, twin)) {
        return err(
          coreError('refused', `${r.gap_id} already has a twin, or is no longer an open gap`),
        );
      }
      if (!allowedTwinDispositions(g).includes(r.disposition)) {
        const why = disclosureOf(g);
        return err(
          coreError(
            'refused',
            why === 'private_only'
              ? `${r.gap_id} is a security gap: it is tracked in the factory only, never filed as an issue`
              : `${r.gap_id}: its issue text does not pass the content lint, so it cannot be filed`,
          ),
        );
      }
      const rendered = r.disposition === 'file_issue' ? renderTwin(g) : null;
      rows.push({
        gap_id: g.gap_id,
        criterion: g.criterion,
        severity: g.severity,
        disposition: r.disposition,
        title: rendered?.title ?? twinTitle(g),
        body_sha256: rendered?.body_sha256 ?? null,
      });
    }
    rows.sort((a, b) => cmp(a.gap_id, b.gap_id));
    const at = clockOf(deps).now().toISOString();
    const batch = IssueTwinBatchApproved.parse({
      batch_id: batchId,
      project_id: gov.value.project_id,
      repo: gov.value.repo_ref,
      repo_id: gov.value.repo_id,
      s0_id: gov.value.s0_id,
      prr_version: gov.value.version,
      record_hash: gov.value.record_hash,
      visibility: gov.value.visibility,
      rows,
      bodies_hash: bodiesHash(rows),
      approved_by: req.on_behalf_of,
      approved_at: at,
      ledger_entry_id: entryId,
    });
    // the ledger lock before the first record append, the entry last (AGENTS.md lock order)
    await lockLedger(tx);
    const pending: PendingConfirm[] = [];
    const caught = await importUnconfirmed(tx, deps.ledger);
    if (!caught.ok) return err(coreError('unavailable', caught.error.message));
    pending.push(...caught.value.pending);
    const w = await j.emitAll(issueTwinStream(gov.value.repo_ref), [
      {
        type: ISSUE_TWIN_EVENT.batch_approved,
        body: batch as unknown as Record<string, unknown>,
        actor: req.on_behalf_of,
        idempotency_key: `issue_twin:batch:${batchId}`,
      },
    ]);
    if (!w.ok) return w;
    const { ledger_entry_id: _drop, ...body } = batch;
    void _drop;
    const draft: LedgerEntryDraft = {
      entry_id: entryId,
      entry_type: ISSUE_TWIN_LEDGER_ENTRY_TYPE,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: 's0_record',
      subject_id: gov.value.s0_id,
      subject_hash: batch.bodies_hash as never,
      decision: null,
      actor: req.on_behalf_of,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: { kind: 'issue_twin_batch', ...body } as never,
      created_at: at as never,
    };
    const l = await appendLedgerEntryTx(tx, deps.ledger, draft);
    if (!l.ok) return err(coreError('unavailable', l.error.message));
    pending.push(...l.value.pending);
    return ok({
      value: {
        batch_id: batchId,
        filed: rows.filter((r) => r.disposition === 'file_issue').length,
        tracked: rows.filter((r) => r.disposition === 'track_only').length,
        bodies_hash: batch.bodies_hash,
        ledger_entry_id: entryId,
      },
      pending,
    });
  });
}

// ---------------------------------------------------------------- link a duplicate (dedupe step 3)

export async function linkDuplicate(
  deps: CoreDeps,
  project: ProjectId,
  req: IssueTwinLinkRequest,
): Promise<Result<{ duplicate: boolean }, CoreError>> {
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [twinLockKey(req.repo)]);
    const g = await readGoverning(tx, req.repo);
    if (!g || g.project_id !== project) {
      return err(coreError('not_found', `no repository ${req.repo} in project ${project}`));
    }
    const stream = issueTwinStream(g.repo_ref);
    const twin = foldIssueTwin(await j.events(stream));
    const t = twin.twins.get(req.gap_id);
    if (!t) return err(coreError('not_found', `${req.gap_id} has no approved twin`));
    if (t.number === req.number) return ok({ duplicate: true });
    if (t.number !== null) {
      return err(coreError('conflict', `${req.gap_id} is already linked to #${t.number}`));
    }
    for (const other of twin.twins.values()) {
      if (other.number === req.number) {
        return err(coreError('conflict', `#${req.number} is the twin of ${other.gap_id}`));
      }
    }
    const w = await j.emitAll(stream, [
      {
        type: ISSUE_TWIN_EVENT.linked,
        body: IssueTwinLinked.parse({
          gap_id: req.gap_id,
          number: req.number,
          via: 'linked',
          batch_id: t.batch_id,
          by: req.on_behalf_of,
        }),
        actor: req.on_behalf_of,
        idempotency_key: `issue_twin:linked:${req.gap_id}:${req.number}`,
      },
    ]);
    return w.ok ? ok({ duplicate: w.value.duplicate }) : w;
  });
}

// ---------------------------------------------------------------- a remediation request from a twin

export async function requestFromTwin(
  deps: CoreDeps,
  project: ProjectId,
  req: IssueTwinRequestRequest,
): Promise<Result<IssueTwinRequestResult, CoreError>> {
  const gov = await governed(deps.pool, project, req.repo);
  if (!gov.ok) return gov;
  const gap = gov.value.gaps.find((g) => g.gap_id === req.gap_id);
  if (!gap)
    return err(coreError('not_found', `${req.gap_id} is not a gap of the readiness record`));
  if (gap.status !== 'open') return err(coreError('refused', `${req.gap_id} is not an open gap`));
  if (disclosureOf(gap) === 'private_only') {
    // a security gap is remediated from the security card, never from an issue (OB §5.3)
    return err(
      coreError('refused', `${req.gap_id} is a security gap: it has no twin to request from`),
    );
  }
  const twin = await readTwin(deps.pool, gov.value.repo_ref);
  const row = twin.twins.get(req.gap_id);
  if (!row && !twin.tracked.has(req.gap_id)) {
    return err(coreError('refused', `${req.gap_id} is in no approved batch yet`));
  }
  const rendered = renderTwin(gap);
  // the text as the twin was filed (or would be), from the record: what GitHub says now is ignored as data
  const marked = taintMark({
    raw: `${rendered.title}\n\n${rendered.body}`,
    channel: REMEDIATION_CHANNEL,
    submitted_by: req.on_behalf_of,
    received_at: new Date(Math.floor(clockOf(deps).nowMs())).toISOString(),
    origin: 'issue',
  });
  if (!marked.ok) return err(coreError('invalid_input', marked.error.message, marked.error));
  const r = await requestWork(deps, {
    project_id: project,
    repo: gov.value.repo_ref,
    lane: REMEDIATION_LANE,
    requester: req.on_behalf_of,
    channel: REMEDIATION_CHANNEL,
    request_id: `issue-twin:${req.gap_id}`,
    request_text: marked.value,
    create_item: true,
  });
  if (!r.ok) return r;
  const made = IssueTwinRequestMade.parse({
    gap_id: req.gap_id,
    number: row?.number ?? null,
    request_id: r.value.request_id,
    item_id: r.value.item_id ?? null,
    by: req.on_behalf_of,
  });
  const w = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [twinLockKey(gov.value.repo_ref)]);
    return j.emitAll(issueTwinStream(gov.value.repo_ref), [
      {
        type: ISSUE_TWIN_EVENT.request_made,
        body: made,
        actor: req.on_behalf_of,
        idempotency_key: `issue_twin:request:${req.gap_id}:${made.request_id}`,
      },
    ]);
  });
  if (!w.ok) return w;
  return ok(
    IssueTwinRequestResult.parse({
      request_id: r.value.request_id,
      item_id: r.value.item_id ?? null,
      duplicate: r.value.duplicate,
      injection_suspected: injectionReportOf(marked.value).suspected,
    }),
  );
}

// ---------------------------------------------------------------- the portal's view

async function repoView(
  pool: pg.Pool,
  project: string,
  repo: { repo_ref: string },
): Promise<IssueTwinRepoView> {
  const twin = await readTwin(pool, repo.repo_ref);
  const g = await governed(pool, project, repo.repo_ref);
  const gaps = g.ok ? g.value.gaps : [];
  const twins = [...twin.twins.values()]
    .sort((a, b) => cmp(a.gap_id, b.gap_id))
    .map((t) => ({
      gap_id: t.gap_id,
      criterion: t.criterion,
      severity: t.severity,
      title: t.title,
      number: t.number,
      state: t.state,
      via: t.via,
      recheck: t.recheck,
      batch_id: t.batch_id,
      request: t.request,
    }));
  const candidates = gaps
    .filter((x) => isCandidate(x, twin) && disclosureOf(x) !== 'private_only')
    .sort((a, b) => cmp(a.gap_id, b.gap_id))
    .map((x) => ({
      gap_id: x.gap_id,
      criterion: x.criterion,
      severity: x.severity,
      visibility_class: x.visibility_class,
      title: twinTitle(x),
      disclosure: disclosureOf(x),
      default: defaultTwinDisposition(x),
      allowed: allowedTwinDispositions(x),
    }));
  return IssueTwinRepoView.parse({
    repo: repo.repo_ref,
    visibility: g.ok ? g.value.visibility : null,
    prr_version: g.ok ? g.value.version : null,
    twins,
    private_only: gaps
      .filter((x) => x.status === 'open' && disclosureOf(x) === 'private_only')
      .map((x) => ({ gap_id: x.gap_id, criterion: x.criterion })),
    batches: twin.batches.map((b) => ({
      batch_id: b.batch_id,
      approved_by: b.approved_by,
      approved_at: b.approved_at,
      filed: b.rows.filter((r) => r.disposition === 'file_issue').length,
      tracked: b.rows.filter((r) => r.disposition === 'track_only').length,
      bodies_hash: b.bodies_hash,
      ledger_entry_id: b.ledger_entry_id,
    })),
    candidates,
    polled_at: twin.polled_at,
  });
}

export async function issueTwinView(pool: pg.Pool, project: string): Promise<IssueTwinView> {
  await catchUp(pool);
  const repos = await pool.query<{ repo_ref: string }>(
    'SELECT repo_ref FROM core.repo WHERE project_id = $1 ORDER BY repo_ref',
    [project],
  );
  const out: IssueTwinRepoView[] = [];
  for (const r of repos.rows) out.push(await repoView(pool, project, r));
  return { project_id: project as never, repos: out };
}
