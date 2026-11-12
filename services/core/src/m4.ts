import {
  ControlsAttestation,
  PRR_EVENT,
  PROJECT_EVENT,
  PrrActivatedPayload,
  PrrProposedPayload,
  PrrStatusChangedPayload,
  ProjectReadyPayload,
  S0ControlsRecordedPayload,
  S0PrrProposedPayload,
  S0_EVENT,
  prrStream,
  projectStream,
  s0Stream,
  type ControlsReport,
  type PrincipalId,
  type ProjectReadinessRecord,
  type Tier,
} from '@aisdlc/contracts';
import { governingPrr, type PrrVersion, type S0State } from './fold.js';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { PoolClient } from 'pg';
import type { KnowledgePort } from './clients.js';
import { coreError, type CoreError } from './errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps, type Journal } from './journal.js';
import { buildPrr, closeOwnerCardGaps, expectedSigner } from './prr.js';
import { getProjectState, getRepo } from './queries.js';
import { readPrrState } from './prr-store.js';
import { recordSignedIn } from './s0.js';
import { fanOutHeld, type FanOutReport } from './work.js';
import { c5Base } from './cards/views.js';
import { approvedPayload, loadS0, s0Cards, type LoadedS0 } from './cards/read.js';
import { affirmedFromC2, affirmedFullFrom, type AreaLevelInput } from '@aisdlc/onboarding';
import { fullBaselineOf } from './cards/full.js';
import type { Clock } from '@aisdlc/kernel';
import type pg from 'pg';

// The M4 side of onboarding (PLAN M7.4 PRR assembly, M7.5 sign-off). Card 5 reaches its person with
// a Project Readiness Record already built, proposed and hashed; the M4 gate on that card binds to
// the record's `record_hash`; only the approved M4 decision makes the record active. Reject leaves
// it `proposed` and the held work held.

/** What the PRR builder needs of the world besides the cards: the record and a clock, and knowledge. */
export interface PrrDeps {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  readonly knowledge: Pick<KnowledgePort, 'census' | 'securitySummary'>;
}

// ---------------------------------------------------------------- what card 4 was decided on

/**
 * Records the controls report in full, as the person saw it when they decided card 4. The card's
 * payload holds only the report's hash (the ledger binds to it); the PRR's `controls` are read from
 * the report this event holds, whose hash must equal the decided one.
 */
export async function recordControlsSeen(
  deps: CoreDeps,
  s0Id: string,
  o: {
    report: ControlsReport;
    collaborators_read: 'ok' | 'unknown' | 'unreadable';
    by: PrincipalId;
  },
): Promise<Result<true, CoreError>> {
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`s0:${s0Id}`]);
    const events = await j.events(s0Stream(s0Id));
    if (
      events.some(
        (e) =>
          e.type === S0_EVENT.controls_recorded &&
          (e.payload as { report?: { report_hash?: string } }).report?.report_hash ===
            o.report.report_hash,
      )
    ) {
      return ok(true as const);
    }
    const w = await j.emit(
      s0Stream(s0Id),
      S0_EVENT.controls_recorded,
      S0ControlsRecordedPayload.parse({
        report: o.report,
        read_at: clockOf(deps).now().toISOString(),
        collaborators_read: o.collaborators_read,
      }),
      o.by,
    );
    return w.ok ? ok(true as const) : w;
  });
}

// ---------------------------------------------------------------- the ledger entry behind a card

async function entryMeta(
  pool: pg.Pool,
  entryId: string | null,
): Promise<{ actor: PrincipalId; at: Date; sod_waiver: boolean } | null> {
  if (entryId === null) return null;
  const q = await pool.query<{ actor: string | null; created_at: Date; sod_waiver: boolean }>(
    'SELECT actor, created_at, sod_waiver FROM ledger.ledger_entry WHERE entry_id = $1',
    [entryId],
  );
  const r = q.rows[0];
  return r?.actor
    ? { actor: r.actor as PrincipalId, at: r.created_at, sod_waiver: r.sod_waiver }
    : null;
}

// ---------------------------------------------------------------- proposing the PRR

/**
 * Builds and proposes the PRR for the n-th raising of card 5, once (a repeat of the same call
 * returns the record it proposed). Everything the card layer decided goes in; the code host is not
 * read again, knowledge is asked for the census it already gave and the current finding counts.
 * Writes `prr.proposed` (the whole record, status `proposed`) and `s0.prr_proposed` in one
 * transaction. A refusal says what to do (lower the signable level, re-run 0.4...).
 */
export async function ensurePrrProposed(
  deps: PrrDeps,
  s0Id: string,
  occurrence: number,
): Promise<Result<ProjectReadinessRecord, CoreError>> {
  const loaded = await loadS0(deps.pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const { s0 } = loaded;
  const project = s0.record.project_id;
  const repoId = s0.record.repo_id;

  const prior = proposedFor(loaded, occurrence);
  if (prior) {
    const found = await findVersion(deps.pool, project, repoId, prior.version);
    if (found) return ok(found.prr);
  }
  if (s0.record.status !== 'card' || s0.steps.get('0.5')?.state !== 'card') {
    return err(coreError('conflict', 'the record is not waiting at the sign-off'));
  }

  const cards = await s0Cards(deps.pool, s0Id);
  const base = c5Base(loaded, cards);
  if (!base.ok) return base;
  const { c1, c4 } = base.value;

  // ---- the census card 1 decided on, and the current finding counts
  const latest = await deps.knowledge.census(s0.repo);
  if (!latest.ok) return err(coreError('unavailable', `knowledge: ${latest.error.message}`));
  if (latest.value === null || latest.value.census_hash !== base.value.package.census_hash) {
    return err(coreError('conflict', 'the census moved on since card 1 was decided'));
  }
  const fromKnowledge = latest.value.census;
  // What the code host said of the repo (core records it on the Repo: visibility, who owns it, the
  // default branch) fills in what the census was not given. Knowledge is not told these by anyone in
  // the deployed wiring, so its census leaves them null; they are not part of the census hash.
  const coreRepo = await getRepo(deps.pool, s0.repo);
  const attRow = c4.payload.find((p) => p.kind === 'controls_attestation');
  const parsedAtt =
    attRow?.kind === 'controls_attestation'
      ? ControlsAttestation.safeParse(attRow.attestation)
      : null;
  const attestedPlan = parsedAtt?.success ? parsedAtt.data.plan : 'unknown';
  const census: typeof fromKnowledge = coreRepo
    ? {
        ...fromKnowledge,
        repo: {
          ...fromKnowledge.repo,
          visibility: fromKnowledge.repo.visibility ?? coreRepo.visibility,
          owner_type: fromKnowledge.repo.owner_type ?? coreRepo.owner_type,
          default_branch: fromKnowledge.repo.default_branch ?? coreRepo.default_branch,
          // The code host cannot read the plan: what the PRR records is what card 4 attested.
          plan: attestedPlan,
        },
      }
    : fromKnowledge;
  const sec = await deps.knowledge.securitySummary(s0.repo);
  if (!sec.ok) return err(coreError('unavailable', `knowledge: ${sec.error.message}`));
  const security = {
    history_scan: {
      ...census.security_summary.history_scan,
      ...(sec.value.finding_counts ?? {}),
    },
  };

  // ---- card 1
  const tierRow = c1.payload.find((p) => p.kind === 'tier_decision');
  const gapRows = c1.payload.flatMap((p) => (p.kind === 'gap_disposition' ? [p] : []));
  const c1Entry = await entryMeta(deps.pool, c1.card.state.steps[0]?.ledger_entry_id ?? null);
  if (tierRow?.kind !== 'tier_decision' || !c1Entry) {
    return err(coreError('conflict', 'card 1 carries no tier decision or no ledger entry'));
  }

  // ---- card 4
  const setRow = c4.payload.find((p) => p.kind === 'settings_decision');
  const c4Entry = await entryMeta(deps.pool, c4.card.state.steps[0]?.ledger_entry_id ?? null);
  if (attRow?.kind !== 'controls_attestation' || setRow?.kind !== 'settings_decision' || !c4Entry) {
    return err(coreError('conflict', 'card 4 carries no attestation, settings or ledger entry'));
  }
  const seen = [...loaded.events]
    .reverse()
    .map((e) =>
      e.type === S0_EVENT.controls_recorded ? S0ControlsRecordedPayload.safeParse(e.payload) : null,
    )
    .find(
      (p) => p?.success && p.data.report.report_hash === base.value.package.controls_report_hash,
    );
  if (!seen?.success) {
    return err(coreError('conflict', 'the controls report card 4 was decided on is not recorded'));
  }

  const m4 = setRow.role_map.m4;
  const m4Holders = m4.kind === 'principals' ? m4.principals : [];
  const intake = loaded.events.find((e) => e.type === S0_EVENT.requested);
  const requester = (intake?.payload as { requested_by: PrincipalId }).requested_by;
  const projectState = await getProjectState(deps.pool, project);
  const signer = expectedSigner({
    tier: tierRow.tier,
    m4_holders: m4Holders,
    requester,
    two_person_enabled: setRow.two_person.enabled,
    team_mode: projectState?.attestations.mode === 'team',
  });
  if (!signer.ok) return err(coreError('refused', signer.error.message));

  // ---- card 2 (Light): what was affirmed goes into the record (OB §3.2 `affirmed`)
  let affirmed: ProjectReadinessRecord['affirmed'] | undefined;
  if (s0.steps.get('0.2')?.state === 'done') {
    const c2 = approvedPayload(cards, 'C2');
    const c2Entry = await entryMeta(deps.pool, c2?.card.state.steps[0]?.ledger_entry_id ?? null);
    if (!c2 || !c2Entry) {
      return err(coreError('conflict', 'step 0.2 is done but card 2 carries no ledgered decision'));
    }
    const a = affirmedFromC2(c2.payload, {
      decided_by: c2Entry.actor,
      sod_waiver: c2Entry.sod_waiver,
    });
    if (!a.ok) return err(coreError('conflict', a.error.message));
    affirmed = a.value;
  }

  // ---- card 3 (Full, M17): the baseline, interview, exam, seeds and golden tasks, by hash and count; and the
  // areas of its system map, over which the levels are judged (DEC-25(a))
  let areas: AreaLevelInput | null = null;
  if (s0.steps.get('0.3')?.state === 'done') {
    const c3 = approvedPayload(cards, 'C3');
    const c3Entry = await entryMeta(deps.pool, c3?.card.state.steps[0]?.ledger_entry_id ?? null);
    if (!c3 || !c3Entry || !affirmed) {
      return err(
        coreError(
          'conflict',
          'step 0.3 is done but card 3 (or card 2) carries no ledgered decision',
        ),
      );
    }
    const f = affirmedFullFrom(c3.payload, { decided_by: c3Entry.actor });
    if (!f.ok) return err(coreError('conflict', f.error.message));
    affirmed = { ...affirmed, full: f.value };
    const baseline = fullBaselineOf(loaded, c3.card.occurrence);
    if (!baseline || baseline.baseline_hash !== f.value.baseline_hash) {
      return err(
        coreError('conflict', 'card 3 was decided on a baseline the record does not hold'),
      );
    }
    areas = {
      system_map: baseline.system_map,
      seeded_areas: baseline.seeds.map((x) => x.area),
      graph_truncated: baseline.graph.truncated,
    };
  }

  return inCoreTx<ProjectReadinessRecord>(deps, async (j, tx) => {
    await lockKeys(tx, [`project:${project}`, `repo:${s0.repo.toLowerCase()}`, `s0:${s0Id}`]);
    const cur = await j.s0(s0Id);
    if (!cur || cur.head_seq !== s0.head_seq) {
      // The record moved while the inputs were read; the next sync looks again.
      const again = proposedForState(await j.events(s0Stream(s0Id)), occurrence);
      if (again) {
        const v = (await j.prr(project, repoId)).versions.find((x) => x.version === again.version);
        if (v) return ok(v.prr);
      }
      return err(coreError('conflict', 'the record moved on while the record was being built'));
    }
    const state = await j.prr(project, repoId);
    const version = Math.max(0, ...state.versions.map((v) => v.version)) + 1;
    const built = buildPrr({
      project_id: project,
      now: clockOf(deps).now(),
      version,
      supersedes: governingPrr(state)?.prr.record_hash ?? null,
      census: closeOwnerCardGaps(census, {
        light_affirmed: affirmed !== undefined,
        full_baseline: affirmed?.full !== undefined,
        owner_confirmed: c1.payload.some((p) => p.kind === 'owner_confirmation'),
        tier_signed: tierRow.kind === 'tier_decision',
        plan_attested: attestedPlan,
        app_scoped:
          seen.data.report.app_installation.read === 'ok' &&
          seen.data.report.app_installation.repository_selection === 'selected',
      }),
      s0: {
        requested_level: s0.record.requested_level,
        signable_level: s0.record.signable_level,
        step_0_2: s0.steps.get('0.2')?.state ?? 'todo',
        step_0_3: s0.steps.get('0.3')?.state ?? 'todo',
        catalogue_ref: s0.record.catalogue_ref,
      },
      attested_floor: projectState?.attestations.tier_floor ?? null,
      deploys: projectState?.project.deploys ?? null,
      c1: {
        owners: base.value.owners as PrincipalId[],
        tier: tierRow.tier,
        floor: tierRow.floor,
        t0_attested: tierRow.t0_attested,
        regulatory_attested: tierRow.regulatory_attested,
        criticality_attested: tierRow.criticality_attested,
        gap_rows: gapRows,
        decided_by: c1Entry.actor,
        decided_at: c1Entry.at,
      },
      c4: {
        report: seen.data.report,
        attestation: ControlsAttestation.parse(attRow.attestation),
        role_map: setRow.role_map,
        two_person: setRow.two_person,
        gating_profile: setRow.gating_profile,
        kill_delegations: setRow.kill_delegations,
        read_at: seen.data.read_at,
        collaborators_read: seen.data.collaborators_read,
        decided_by: c4Entry.actor,
        decided_at: c4Entry.at,
      },
      security,
      signer: signer.value,
      ...(affirmed ? { affirmed } : {}),
      areas,
    });
    if (!built.ok) {
      return err(coreError('refused', `${built.error.code}: ${built.error.message}`, built.error));
    }
    const prr = built.value;
    const w = await j.emit(
      prrStream(project, repoId),
      PRR_EVENT.proposed,
      PrrProposedPayload.parse({ s0_id: s0Id, prr }),
      'system.prr',
    );
    if (!w.ok) return w;
    const p = await j.emit(
      s0Stream(s0Id),
      S0_EVENT.prr_proposed,
      S0PrrProposedPayload.parse({
        occurrence,
        record_id: prr.record_id,
        version: prr.version,
        record_hash: prr.record_hash,
        level_signed: prr.level.signed,
        tier: prr.tier.value,
      }),
      'system.prr',
    );
    return p.ok ? ok(prr) : p;
  });
}

const proposedForState = (
  events: readonly { type: string; payload: unknown }[],
  occurrence: number,
) =>
  events
    .filter((e) => e.type === S0_EVENT.prr_proposed)
    .map((e) => S0PrrProposedPayload.parse(e.payload))
    .find((p) => p.occurrence === occurrence);

function proposedFor(loaded: LoadedS0, occurrence: number) {
  return proposedForState(loaded.events, occurrence);
}

async function findVersion(
  pool: pg.Pool,
  project: string,
  repoId: string,
  version: number,
): Promise<PrrVersion | null> {
  return (
    (await readPrrState(pool, project, repoId)).versions.find((v) => v.version === version) ?? null
  );
}

/** The PRR a card-5 gate binds to, by its `record_hash`. */
export async function prrByHash(
  pool: pg.Pool,
  project: string,
  repoId: string,
  hash: string,
): Promise<PrrVersion | null> {
  return (
    (await readPrrState(pool, project, repoId)).versions.find((v) => v.prr.record_hash === hash) ??
    null
  );
}

// ---------------------------------------------------------------- the M4 approval

export interface M4Approval {
  /** The `record_hash` the M4 gate bound to. */
  readonly prr_hash: string;
  readonly m4: { ledger_entry_id: string; decision_hash: string };
  readonly by: PrincipalId;
}

export interface M4Result {
  readonly version: number;
  readonly tier: Tier;
  readonly fan_out: FanOutReport;
}

const SUPERSEDABLE = ['active', 'stale', 'suspended'] as const;

/**
 * An approved M4 in the record (PLAN M7.5), inside the transaction that holds the project, repo
 * and S0 locks: the proposed version becomes `active` (only this does it), the version it replaced
 * becomes `superseded`, `recordSigned` sets the project's tier and level and the repo's level,
 * `project.ready` is recorded, and the project-level fan-out releases the held requests whose lane
 * the record opens and offers L8 for the rest. The caller moves the S0 record to `done`.
 */
export async function approveM4In(
  deps: CoreDeps,
  j: Journal,
  tx: PoolClient,
  s0: S0State,
  o: M4Approval,
): Promise<Result<M4Result, CoreError>> {
  const project = s0.record.project_id;
  const repoId = s0.record.repo_id;
  const state = await j.prr(project, repoId);
  const v = state.versions.find((x) => x.prr.record_hash === o.prr_hash);
  if (!v || v.status !== 'proposed') {
    return err(coreError('conflict', 'the record M4 bound to is not a proposed version'));
  }
  if (v.s0_id !== s0.record.s0_id) {
    return err(coreError('conflict', 'the record M4 bound to was proposed by another S0 record'));
  }
  const signed = await recordSignedIn(j, tx, s0, {
    s0_id: s0.record.s0_id,
    tier: v.prr.tier.value,
    level: v.prr.level.signed,
    actor: o.by,
  });
  if (!signed.ok) return signed;

  const stream = prrStream(project, repoId);
  for (const old of state.versions) {
    if (old.version === v.version || !SUPERSEDABLE.includes(old.status as never)) continue;
    const w = await j.emit(
      stream,
      PRR_EVENT.status_changed,
      PrrStatusChangedPayload.parse({
        version: old.version,
        record_hash: old.prr.record_hash,
        from: old.status,
        to: 'superseded',
        actor: 'm4_decision',
        cause: 'superseded',
      }),
      o.by,
    );
    if (!w.ok) return w;
  }
  const a = await j.emit(
    stream,
    PRR_EVENT.activated,
    PrrActivatedPayload.parse({
      s0_id: s0.record.s0_id,
      version: v.version,
      record_hash: v.prr.record_hash,
      m4: o.m4,
    }),
    o.by,
  );
  if (!a.ok) return a;
  const active = (await j.prr(project, repoId)).versions.find(
    (x) => x.version === v.version,
  ) as PrrVersion;
  const ready = await j.emit(
    projectStream(project),
    PROJECT_EVENT.ready,
    ProjectReadyPayload.parse({
      project_id: project,
      repo: s0.repo,
      s0_id: s0.record.s0_id,
      prr_version: v.version,
      record_hash: v.prr.record_hash,
      level: v.prr.level.signed,
      lanes_eligible: v.prr.autonomy.lanes_eligible,
    }),
    o.by,
  );
  if (!ready.ok) return ready;
  const fan = await fanOutHeld(j, tx, {
    repo: s0.repo,
    prr: active.prr,
    version: active,
    s0_id: s0.record.s0_id,
    now: clockOf(deps).now(),
    actor: o.by,
  });
  if (!fan.ok) return fan;
  return ok({ version: v.version, tier: v.prr.tier.value, fan_out: fan.value });
}
