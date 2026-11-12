import {
  CENSUS_AREA,
  DEFAULT_REONBOARD_TRIGGERS,
  MS_PER_DAY,
  KDEFECT_EVENT,
  KnowledgeDefectRecordedPayload,
  REONBOARD_EVENT,
  REONBOARD_TRIGGERS_KEY,
  ReonboardDecidedPayload,
  ReonboardProposalView,
  ReonboardProposedPayload,
  ReonboardTriggersConfig,
  kdefectStream,
  reonboardStream,
  type KnowledgeDefect,
  type KnowledgeDefectSource,
} from '@aisdlc/contracts';
import type { ConfigReader } from '@aisdlc/config';
import { areaOfPath } from '@aisdlc/onboarding';
import { hashCanonical, ok, type Result } from '@aisdlc/kernel';
import type { Executor, Tx } from '@aisdlc/record';
import type { CoreError } from './errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from './journal.js';
import { readGoverning } from './prr-store.js';

// Knowledge defects as a re-onboarding trigger (PLAN M17; OB §8: "≥3 knowledge defects in 30 d" -> "Re-onboarding
// proposal item"; R3: "≥3 knowledge-defect trips in an area become a re-onboarding trigger").
//
//   1. a context build logged defects: each that names a REPOSITORY path (not the request, not an earlier artefact)
//      is recorded once per source (`knowledge.defect_recorded` on `kdefect:<repo>`), in the area of the governing
//      readiness record that holds the path (the longest area prefix; `.` for a repo-wide record), folded into
//      `core.knowledge_defect`;
//   2. in the same transaction, an area with at least `count` defects detected within `window_days` (config
//      `onboarding.reonboard_triggers`, M1-gated; the spec's 3 in 30 days as defaults, also when the value does not
//      read) and no open proposal gets one: RECORDED first (`reonboard.proposed` on `reonboard:<repo>`), folded into
//      `core.reonboard_proposal`. Nothing else happens: accepting it is a new S0 from 0.1, a new version and an M4.
//      A proposal never changes a level, and the trigger never raises one.

export const KDEFECT_ACTOR = 'system.knowledge_defects';

/** `onboarding.reonboard_triggers` from a config reader; a value that does not read gives the spec's numbers. */
export function reonboardTriggersFrom(reader: ConfigReader): () => ReonboardTriggersConfig {
  return () => {
    const c = reader.current();
    if (c.rejected.includes(REONBOARD_TRIGGERS_KEY)) return DEFAULT_REONBOARD_TRIGGERS;
    const p = ReonboardTriggersConfig.safeParse(c.get(REONBOARD_TRIGGERS_KEY));
    return p.success ? p.data : DEFAULT_REONBOARD_TRIGGERS;
  };
}

export interface KnowledgeDefectDeps extends CoreDeps {
  /** The thresholds in force; absent: the spec's (3 in 30 days). */
  readonly reonboardTriggers?: () => ReonboardTriggersConfig;
}

/** A path the defect is about, when it is a repository path (context paths like `artefact:...` are not). */
const repoPathOf = (d: KnowledgeDefect): string | null =>
  d.path === null || d.path.length === 0 || /^[a-z_]+:/.test(d.path) || d.path.startsWith('/')
    ? null
    : d.path;

/** The area of `path` (the longest area that is a directory prefix of it, else `.`): `@aisdlc/onboarding`'s. */
export { areaOfPath };

// ---------------------------------------------------------------- read models

export async function applyKnowledgeDefectEvent(
  tx: Pick<Tx, 'query'>,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type === KDEFECT_EVENT.recorded) {
    const p = KnowledgeDefectRecordedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.knowledge_defect (defect_id, repo, project_id, area, kind, path, detected_at, event_gseq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (defect_id) DO NOTHING`,
      [
        p.defect_id,
        p.repo.toLowerCase(),
        p.project_id,
        p.area,
        p.kind,
        p.path,
        p.detected_at,
        e.global_seq,
      ],
    );
    return;
  }
  if (e.type === REONBOARD_EVENT.proposed) {
    const p = ReonboardProposedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.reonboard_proposal
         (proposal_id, repo, project_id, area, trigger, status, body, proposed_at, event_gseq)
       VALUES ($1,$2,$3,$4,$5,'proposed',$6,$7,$8) ON CONFLICT (proposal_id) DO NOTHING`,
      [
        p.proposal_id,
        p.repo.toLowerCase(),
        p.project_id,
        p.area,
        p.trigger,
        JSON.stringify(p),
        p.proposed_at,
        e.global_seq,
      ],
    );
    return;
  }
  if (e.type === REONBOARD_EVENT.decided) {
    const p = ReonboardDecidedPayload.parse(e.payload);
    await tx.query(
      `UPDATE core.reonboard_proposal SET status = $2, decision = $3 WHERE proposal_id = $1 AND status = 'proposed'`,
      [p.proposal_id, p.decision === 'accept' ? 'accepted' : 'declined', JSON.stringify(p)],
    );
  }
}

/** Rebuilds a repo's two read models from its `kdefect:` and `reonboard:` streams alone. */
export async function rebuildKnowledgeDefects(d: CoreDeps, repo: string): Promise<number> {
  const streams = [kdefectStream(repo), reonboardStream(repo)];
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = ANY($1) ORDER BY global_seq`,
    [streams],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, streams);
    await tx.query('DELETE FROM core.knowledge_defect WHERE repo = $1', [repo.toLowerCase()]);
    await tx.query('DELETE FROM core.reonboard_proposal WHERE repo = $1', [repo.toLowerCase()]);
    for (const e of q.rows) {
      await applyKnowledgeDefectEvent(tx, {
        type: e.type,
        payload: e.body,
        global_seq: Number(e.global_seq),
      });
    }
    return ok(q.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

export async function listReonboardProposals(
  db: Executor,
  repo: string,
): Promise<ReonboardProposalView[]> {
  const q = await db.query<{ body: unknown; status: string; decision: unknown }>(
    'SELECT body, status, decision FROM core.reonboard_proposal WHERE repo = $1 ORDER BY event_gseq',
    [repo.toLowerCase()],
  );
  return q.rows.map((r) =>
    ReonboardProposalView.parse({
      ...(r.body as object),
      status: r.status,
      decision: r.decision ?? null,
    }),
  );
}

/** One proposal of a repo, or `null`. */
export async function reonboardProposal(
  db: Executor,
  repo: string,
  proposalId: string,
): Promise<ReonboardProposalView | null> {
  return (await listReonboardProposals(db, repo)).find((p) => p.proposal_id === proposalId) ?? null;
}

// ---------------------------------------------------------------- the step

export interface RecordDefectsInput {
  readonly repo: string;
  readonly defects: readonly KnowledgeDefect[];
  readonly source: KnowledgeDefectSource;
}

export interface RecordDefectsOutcome {
  /** Defects newly recorded (a repeat of the same defect from the same source is not). */
  readonly recorded: number;
  readonly proposals: ReonboardProposedPayload[];
}

/**
 * Records the repository defects of one context build and proposes re-onboarding where an area reached the
 * threshold. One transaction under the repo's keys; idempotent per defect and source. A repo the factory does
 * not know records nothing.
 */
export async function recordKnowledgeDefects(
  d: KnowledgeDefectDeps,
  i: RecordDefectsInput,
): Promise<Result<RecordDefectsOutcome, CoreError>> {
  const repoDefects = i.defects.flatMap((x) => {
    const path = repoPathOf(x);
    return path === null ? [] : [{ ...x, path }];
  });
  if (repoDefects.length === 0) return ok({ recorded: 0, proposals: [] });
  const g = await readGoverning(d.pool, i.repo);
  if (!g) return ok({ recorded: 0, proposals: [] });
  const repo = g.repo_ref;
  const areas =
    g.governing?.prr.level.areas?.map((a) => a.area) ??
    Object.keys(g.governing?.prr.level.by_area ?? { [CENSUS_AREA]: 'census' });
  const t = (d.reonboardTriggers ?? (() => DEFAULT_REONBOARD_TRIGGERS))().knowledge_defects;
  const now = clockOf(d).now();
  const streams = [kdefectStream(repo), reonboardStream(repo)];
  return inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, streams);
    let recorded = 0;
    const touched = new Set<string>();
    for (const x of repoDefects) {
      const defect_id = hashCanonical({
        repo: repo.toLowerCase(),
        source: i.source,
        kind: x.kind,
        path: x.path,
        rules: [...x.rules].sort(),
      });
      const seen = await tx.query('SELECT 1 FROM core.knowledge_defect WHERE defect_id = $1', [
        defect_id,
      ]);
      if ((seen.rowCount ?? 0) > 0) continue;
      const area = areaOfPath(x.path, areas);
      const payload = KnowledgeDefectRecordedPayload.parse({
        defect_id,
        repo,
        project_id: g.project_id,
        area,
        kind: x.kind,
        path: x.path,
        rules: x.rules,
        source: i.source,
        detected_at: now.toISOString(),
      });
      const e = await j.emit(kdefectStream(repo), KDEFECT_EVENT.recorded, payload, KDEFECT_ACTOR);
      if (!e.ok) return e;
      await applyKnowledgeDefectEvent(tx, {
        type: e.value.type,
        payload,
        global_seq: e.value.global_seq,
      });
      recorded += 1;
      touched.add(area);
    }
    const proposals: ReonboardProposedPayload[] = [];
    const since = new Date(now.getTime() - t.window_days * MS_PER_DAY);
    for (const area of [...touched].sort()) {
      const open = await tx.query(
        `SELECT 1 FROM core.reonboard_proposal
          WHERE repo = $1 AND area = $2 AND trigger = 'knowledge_defects' AND status = 'proposed'`,
        [repo.toLowerCase(), area],
      );
      if ((open.rowCount ?? 0) > 0) continue;
      const inWindow = await tx.query<{ defect_id: string }>(
        `SELECT defect_id FROM core.knowledge_defect
          WHERE repo = $1 AND area = $2 AND detected_at >= $3 AND detected_at <= $4
          ORDER BY detected_at, defect_id`,
        [repo.toLowerCase(), area, since.toISOString(), now.toISOString()],
      );
      if (inWindow.rows.length < t.count) continue;
      const defect_ids = inWindow.rows.map((r) => r.defect_id);
      const payload = ReonboardProposedPayload.parse({
        proposal_id: hashCanonical({ repo: repo.toLowerCase(), area, defect_ids }),
        repo,
        project_id: g.project_id,
        area,
        trigger: 'knowledge_defects',
        count: defect_ids.length,
        threshold: t.count,
        window_days: t.window_days,
        defect_ids,
        prr_version: g.governing?.version ?? null,
        proposed_at: now.toISOString(),
      });
      const e = await j.emit(
        reonboardStream(repo),
        REONBOARD_EVENT.proposed,
        payload,
        KDEFECT_ACTOR,
      );
      if (!e.ok) return e;
      await applyKnowledgeDefectEvent(tx, {
        type: e.value.type,
        payload,
        global_seq: e.value.global_seq,
      });
      proposals.push(payload);
    }
    return ok({ recorded, proposals });
  });
}
