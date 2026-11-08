import {
  CardId,
  LedgerAuditView,
  PROJECT_CONFIG_KEYS,
  ProjectSettingsDoc,
  S0_EVENT,
  SettingsRevisionView,
  s0Stream,
  type CoreInboxItem,
  type PrincipalId,
  type ProjectPrrView,
  type ReadinessStatus,
  type RecordEvent,
  type S0Revision,
} from '@aisdlc/contracts';
import { configPublish, readLineage, type ConfigDeps } from '@aisdlc/config';
import {
  decide as decideGate,
  prepare as prepareGate,
  readGateState,
  recordEvidenceViewed,
} from '@aisdlc/decisions';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import type pg from 'pg';
import { decisionRefusal } from './cards/api.js';
import { isLive } from './cards/sync.js';
import { SLOT_OF_CARD, type CardDeps } from './cards/model.js';
import { loadS0, s0Cards } from './cards/read.js';
import { decidersFrom, decidersOf } from './cards/views.js';
import { coreError, type CoreError } from './errors.js';
import { activeS0Ids, catchUp } from './queries.js';
import { governingPrr } from '@aisdlc/onboarding/fold';
import { readPrrState } from './prr-store.js';

// What the portal reads beyond the card routes (PLAN M8.3, M8.4). Everything here reads the
// authoritative streams and the ledger, not a projection that may lag, except the list of live S0
// records, which is core's read model caught up first.

// ---------------------------------------------------------------- Settings revision (card 4's M1 gate)

const lineageOf = (project: string) =>
  ({ layer: 'project', scope: { kind: 'project', ref: project } }) as const;

async function s0Events(pool: pg.Pool, s0Id: string): Promise<RecordEvent[]> {
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [s0Stream(s0Id)],
  );
  return q.rows.map(toRecordEvent);
}

/** The M1 gate card 4's newest approval opened for the record, or `null`. */
export function revisionGateOf(events: readonly RecordEvent[]): string | null {
  for (const e of [...events].reverse()) {
    if (e.type !== S0_EVENT.card_applied) continue;
    const p = e.payload as { card?: string; decision?: string; refs?: Record<string, string> };
    if (p.card === 'C4' && p.decision === 'approve' && p.refs?.['m1_gate_instance_id']) {
      return p.refs['m1_gate_instance_id'];
    }
  }
  return null;
}

/** The s0 that proposed an M1 gate through card 4, if any. */
async function s0OfGate(pool: pg.Pool, gate: string): Promise<string | null> {
  const q = await pool.query<{ stream: string }>(
    `SELECT stream FROM record.record_event
      WHERE type = $1 AND body #>> '{refs,m1_gate_instance_id}' = $2 ORDER BY global_seq LIMIT 1`,
    [S0_EVENT.card_applied, gate],
  );
  const s = q.rows[0]?.stream;
  return s ? s.slice('s0:'.length) : null;
}

export async function settingsRevision(
  deps: { pool: pg.Pool; config: ConfigDeps },
  gate: string,
): Promise<Result<SettingsRevisionView, CoreError>> {
  const state = await readGateState(deps.pool, gate);
  const p = state?.open.payload;
  if (!state || !p || p.gate_id !== 'M1' || p.subject_kind !== 'config') {
    return err(coreError('not_found', `no settings revision gate ${gate}`));
  }
  const lineage = await readLineage(deps.pool, lineageOf(p.project_id));
  const rev = lineage.proposed.get(p.subject_hash);
  if (!rev) return err(coreError('not_found', 'the revision this gate decides is gone'));
  const doc = ProjectSettingsDoc.safeParse(rev.doc);
  if (!doc.success)
    return err(coreError('conflict', 'the proposed revision is not a settings document'));
  const d = doc.data;
  return ok(
    SettingsRevisionView.parse({
      gate_instance_id: gate,
      project_id: p.project_id,
      s0_id: await s0OfGate(deps.pool, gate),
      rev_hash: p.subject_hash,
      proposed_by: rev.proposed_by,
      status: state.status,
      outcome: state.outcome,
      published: lineage.published.some((x) => x.rev_hash === p.subject_hash),
      settings: {
        role_map: d[PROJECT_CONFIG_KEYS.role_map],
        two_person: d[PROJECT_CONFIG_KEYS.two_person],
        gating_profile: d[PROJECT_CONFIG_KEYS.gating_profile],
        kill_delegations: d[PROJECT_CONFIG_KEYS.kill_delegations],
      },
      evidence_hash: p.evidence_pack_hash ?? p.subject_hash,
      deciders: await decidersFrom(deps.config.eligibility, p.project_id, 'admin'),
    }),
  );
}

/** The revision card 4 proposed for an S0 record (any state), or `null`. */
export async function revisionOfS0(
  deps: { pool: pg.Pool; config: ConfigDeps },
  s0Id: string,
): Promise<Result<S0Revision, CoreError>> {
  if (!(await loadS0(deps.pool, s0Id))) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const gate = revisionGateOf(await s0Events(deps.pool, s0Id));
  if (!gate) return ok({ revision: null });
  const v = await settingsRevision(deps, gate);
  return v.ok ? ok({ revision: v.value }) : v;
}

export async function prepareRevision(
  deps: { config: ConfigDeps },
  input: { gate: string; principal: PrincipalId },
) {
  const p = await prepareGate(deps.config, {
    gate_instance_id: input.gate,
    principal: input.principal,
  });
  return p.ok
    ? ok({
        nonce: p.value.nonce,
        expires_at: p.value.expires_at,
        evidence_hash: p.value.evidence_hash,
      })
    : err(decisionRefusal(p.error));
}

export async function recordRevisionEvidence(
  deps: { config: ConfigDeps },
  input: { nonce: string; evidence_hash: string },
) {
  const r = await recordEvidenceViewed(deps.config, input);
  return r.ok ? ok({ evidence_viewed: true }) : err(decisionRefusal(r.error));
}

export interface RevisionDecision {
  readonly entry: { ledger_seq: number; entry_hash: string; decision: string | null };
  readonly outcome: string | null;
  /** The revision is in force now (approved and published in the same call). */
  readonly published: boolean;
  readonly publish_error: string | null;
}

/**
 * Decides the M1 gate over a settings revision with a prepared nonce. An approval that ends the gate
 * is published straight away (`configPublish` checks the ledger itself); a publish that fails is
 * reported and can be retried with `publishRevision`: the decision stays on the ledger either way.
 */
export async function decideRevision(
  deps: { pool: pg.Pool; config: ConfigDeps },
  input: { nonce: string; decision: string },
): Promise<Result<RevisionDecision, CoreError>> {
  const d = await decideGate(deps.config, { nonce: input.nonce, decision: input.decision });
  if (!d.ok) return err(decisionRefusal(d.error));
  const { entry, after } = d.value;
  let published = false;
  let publishError: string | null = null;
  if (after.status === 'decided' && after.outcome === 'approve') {
    const r = await publishRevision(deps, entry.gate_instance_id as string);
    published = r.ok;
    publishError = r.ok ? null : r.error.message;
  }
  return ok({
    entry: { ledger_seq: entry.ledger_seq, entry_hash: entry.entry_hash, decision: entry.decision },
    outcome: after.outcome,
    published,
    publish_error: publishError,
  });
}

/** Publishes the revision a decided-approve M1 gate covers. Idempotent. */
export async function publishRevision(
  deps: { pool: pg.Pool; config: ConfigDeps },
  gate: string,
): Promise<Result<{ published: boolean }, CoreError>> {
  const state = await readGateState(deps.pool, gate);
  if (!state || state.open.payload.gate_id !== 'M1') {
    return err(coreError('not_found', `no settings revision gate ${gate}`));
  }
  if (!(state.status === 'decided' && state.outcome === 'approve')) {
    return err(coreError('conflict', 'the revision has not been approved'));
  }
  const r = await configPublish(deps.config, { rev_hash: state.open.payload.subject_hash });
  if (!r.ok) {
    return err(
      coreError(r.error.code === 'stale_parent' ? 'conflict' : 'refused', r.error.message),
    );
  }
  return ok({ published: true });
}

// ---------------------------------------------------------------- Inbox

/**
 * Every open thing waiting for a person: the cards of the live S0 records that a person can decide
 * now, and the settings revisions card 4 proposed that have not been decided. Who decides each is
 * the role map (or the bootstrap grantee) at this moment.
 */
export async function coreInbox(deps: {
  cards: CardDeps;
  config?: ConfigDeps | undefined;
  clock?: Clock | undefined;
}): Promise<CoreInboxItem[]> {
  const pool = deps.cards.pool;
  const now = (deps.clock ?? systemClock).now().getTime();
  await catchUp(pool);
  const out: CoreInboxItem[] = [];
  for (const s0Id of await activeS0Ids(pool)) {
    const loaded = await loadS0(pool, s0Id);
    if (!loaded) continue;
    const project = loaded.s0.record.project_id;
    for (const card of await s0Cards(pool, s0Id)) {
      if (card.state.status !== 'open' || !isLive(loaded, card)) continue;
      const slot = SLOT_OF_CARD[card.kind];
      const who = await decidersOf(deps.cards, project, slot, s0Id);
      const due = card.state.open.sla_due_at;
      out.push({
        kind: 'onboarding_card',
        id: CardId.parse(card.card_id),
        project_id: project,
        s0_id: s0Id as never,
        label: card.kind,
        slot,
        opened_at: card.state.opened_at,
        sla_due_at: due,
        overdue: now >= Date.parse(due),
        escalated: card.state.escalations.length > 0,
        holders: [...who.holders],
      });
    }
    const config = deps.config;
    const gate = config ? revisionGateOf(loaded.events) : null;
    if (config && gate) {
      const state = await readGateState(pool, gate);
      if (state?.status === 'pending') {
        const who = await decidersFrom(config.eligibility, project, 'admin');
        out.push({
          kind: 'settings_revision',
          id: gate,
          project_id: project,
          s0_id: s0Id as never,
          label: null,
          slot: 'admin',
          opened_at: state.open.opened_at,
          sla_due_at: null,
          overdue: false,
          escalated: false,
          holders: [...who.holders],
        });
      }
    }
  }
  return out.sort((a, b) =>
    a.overdue !== b.overdue
      ? a.overdue
        ? -1
        : 1
      : a.opened_at < b.opened_at
        ? -1
        : a.opened_at > b.opened_at
          ? 1
          : a.id < b.id
            ? -1
            : 1,
  );
}

// ---------------------------------------------------------------- Readiness record (M8.4)

export async function projectPrr(
  pool: pg.Pool,
  project: string,
  clock: Clock = systemClock,
): Promise<ProjectPrrView | null> {
  await catchUp(pool);
  const repos = await pool.query<{ repo_ref: string; repo_id: string }>(
    'SELECT repo_ref, repo_id FROM core.repo WHERE project_id = $1 ORDER BY repo_ref',
    [project],
  );
  if (repos.rows.length === 0) {
    const known = await pool.query('SELECT 1 FROM core.project WHERE project_id = $1', [project]);
    if (known.rowCount === 0) return null;
  }
  const now = clock.now().getTime();
  const out: ProjectPrrView['repos'] = [];
  for (const r of repos.rows) {
    const state = await readPrrState(pool, project, r.repo_id);
    const gov = governingPrr(state);
    const newest = state.versions.at(-1);
    const proposed =
      newest && newest.status === 'proposed' && (!gov || newest.version > gov.version)
        ? {
            version: newest.version,
            record_hash: newest.prr.record_hash,
            s0_id: newest.s0_id as never,
            proposed_at: newest.proposed_at,
          }
        : null;
    out.push({
      repo: r.repo_ref as never,
      governing: gov
        ? {
            version: gov.version,
            status: gov.status,
            effective_status: (gov.status === 'active' && now >= Date.parse(gov.prr.fresh_until)
              ? 'expired'
              : gov.status) as ReadinessStatus,
            s0_id: gov.s0_id as never,
            proposed_at: gov.proposed_at,
            activated_at: gov.activated_at,
            record: gov.prr,
          }
        : null,
      proposed,
    });
  }
  return { project_id: project, repos: out } as ProjectPrrView;
}

// ---------------------------------------------------------------- Ledger audit (M8.4)

/** The ledger entries that concern a project (or one of its S0 records), oldest first. */
export async function ledgerAudit(
  pool: pg.Pool,
  project: string,
  o: { s0_id?: string; limit?: number } = {},
): Promise<LedgerAuditView> {
  await catchUp(pool);
  const limit = Math.min(Math.max(o.limit ?? 500, 1), 2000);
  // The gates opened for the project: the M1 over card 4's settings, the M4 over the readiness record.
  const opened = await pool.query<{ gate: string; subject_hash: string }>(
    `SELECT body ->> 'gate_instance_id' AS gate, body ->> 'subject_hash' AS subject_hash
       FROM record.record_event WHERE type = 'gate.opened' AND seq = 1 AND body ->> 'project_id' = $1`,
    [project],
  );
  let s0s: string[];
  let gates: string[];
  if (o.s0_id) {
    s0s = [o.s0_id];
    const events = await s0Events(pool, o.s0_id);
    const hashes = new Set(
      events
        .filter((e) => e.type === S0_EVENT.prr_proposed)
        .map((e) => (e.payload as { record_hash?: string }).record_hash),
    );
    const m1 = revisionGateOf(events);
    gates = opened.rows
      .filter((g) => g.gate === m1 || hashes.has(g.subject_hash))
      .map((g) => g.gate);
  } else {
    s0s = (
      await pool.query<{ s0_id: string }>(
        'SELECT s0_id FROM core.s0_record WHERE project_id = $1 ORDER BY created_at, s0_id',
        [project],
      )
    ).rows.map((r) => r.s0_id);
    gates = opened.rows.map((g) => g.gate);
  }
  const q = await pool.query<Record<string, unknown>>(
    `SELECT ledger_seq, entry_id, entry_type, gate_id, gate_instance_id::text AS gate_instance_id,
            body ->> 'step' AS step, body ->> 'card_id' AS card_id, subject_kind, subject_id,
            decision, actor, sod_waiver, created_at, entry_hash, prev_hash
       FROM ledger.ledger_entry
      WHERE subject_id = ANY($1::text[]) OR gate_instance_id::text = ANY($2::text[])
         OR ($3::text IS NULL AND body ->> 'project_id' = $4)
      ORDER BY ledger_seq LIMIT ${limit}`,
    [s0s, gates, o.s0_id ?? null, project],
  );
  const head = await pool.query<{ ledger_seq: string; entry_hash: string }>(
    'SELECT ledger_seq, entry_hash FROM ledger.ledger_entry ORDER BY ledger_seq DESC LIMIT 1',
  );
  return LedgerAuditView.parse({
    project_id: project,
    s0_id: o.s0_id ?? null,
    entries: q.rows.map((r) => ({
      ...r,
      ledger_seq: Number(r['ledger_seq']),
      created_at: (r['created_at'] as Date).toISOString(),
    })),
    head: head.rows[0]
      ? { ledger_seq: Number(head.rows[0].ledger_seq), entry_hash: head.rows[0].entry_hash }
      : null,
  });
}
