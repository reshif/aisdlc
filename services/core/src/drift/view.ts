import type { ProjectDriftView } from '@aisdlc/contracts';
import {
  DRIFT_EVENT,
  PRR_EVENT,
  PrrStatusChangedPayload,
  ReaffirmView,
  RepoDriftView,
  bypassListHash,
  prrStream,
  type CoreInboxItem,
  type DriftHistoryRow,
  type MergeBypassConfig,
  type ProjectId,
} from '@aisdlc/contracts';
import { systemClock, type Clock } from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import type pg from 'pg';
import { affirmedOf } from '../cards/pack.js';
import { loadS0, s0Cards } from '../cards/read.js';
import { coreError, type CoreError } from '../errors.js';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  AFTER_ONBOARDING_SLOT,
  bypassShown,
  levelsAbove,
  lintOf,
  readDriftedText,
  restoreWhyNot,
} from './actions.js';
import { listReonboardProposals } from '../knowledge-defects.js';
import { catchUp } from '../queries.js';
import { repoIdentity } from '../prr-store.js';
import type { DriftDeps } from './check.js';
import { evaluateDrift, servedFiles } from './evaluate.js';
import { inputsOf, loadDrift, reaffirmedOf, type LoadedDrift } from './state.js';

// What the portal shows after onboarding (PLAN M16; the design reference's project "Drift" tab): per repo, the
// readiness record's status, the newest polls, the findings and what each does, what the factory serves for every
// tracked file, the suspension and whether a restore can go ahead, the bypass list a restore re-attests, the levels a
// level-up may ask for, and the history (each row a record event, ledgered rows with their entry). Reads only.

async function prrHistory(
  db: Executor,
  project: string,
  repoId: string,
): Promise<DriftHistoryRow[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [prrStream(project, repoId)],
  );
  const out: DriftHistoryRow[] = [];
  for (const e of q.rows.map(toRecordEvent)) {
    if (e.type === PRR_EVENT.activated) {
      out.push({
        at: e.occurred_at,
        type: 'activated',
        summary: `version ${(e.payload as { version?: number }).version ?? '?'} active (M4)`,
        by: null,
        ledger_entry_id: null,
      });
    } else if (e.type === PRR_EVENT.status_changed) {
      const p = PrrStatusChangedPayload.parse(e.payload);
      if (p.to === 'expired') {
        out.push({
          at: e.occurred_at,
          type: 'expired',
          summary: `version ${p.version} expired: fresh_until passed (Census-only behaviour until re-signed)`,
          by: null,
          ledger_entry_id: null,
        });
      }
    }
  }
  return out;
}

const describe = (f: { kind: string; subject: string | null; reasons: readonly string[] }) =>
  `${f.kind.replace('_', ' ')}${f.subject ? ` ${f.subject}` : ''}: ${f.reasons.join(', ')}`;

function history(l: LoadedDrift): DriftHistoryRow[] {
  const out: DriftHistoryRow[] = [];
  for (const e of l.drift.events) {
    const p = e.payload as Record<string, unknown>;
    const ledger = (p['ledger_entry_id'] as string | undefined) ?? null;
    switch (e.type) {
      case DRIFT_EVENT.evaluated: {
        const f = (p['findings'] as Array<Parameters<typeof describe>[0]>) ?? [];
        out.push({
          at: e.occurred_at,
          type: 'evaluated',
          summary: (f.length === 0 ? 'clean' : f.map(describe).join('; ')).slice(0, 300),
          by: null,
          ledger_entry_id: null,
        });
        break;
      }
      case DRIFT_EVENT.suspended:
        out.push({
          at: e.occurred_at,
          type: 'suspended',
          summary:
            `record suspended: agent lanes closed, new items go L8 (${((p['findings'] as Array<Parameters<typeof describe>[0]>) ?? []).map(describe).join('; ')})`.slice(
              0,
              300,
            ),
          by: null,
          ledger_entry_id: ledger as never,
        });
        break;
      case DRIFT_EVENT.restored:
        out.push({
          at: e.occurred_at,
          type: 'restored',
          summary: 'restored after the re-check, with the bypass list re-attested',
          by: (p['by'] as string) ?? null,
          ledger_entry_id: ledger as never,
        });
        break;
      case DRIFT_EVENT.reaffirmed:
        out.push({
          at: e.occurred_at,
          type: 'reaffirmed',
          summary: `${String(p['path'])} re-affirmed with step-up (text ${String(p['text_sha256']).slice(0, 12)})`,
          by: (p['by'] as string) ?? null,
          ledger_entry_id: ledger as never,
        });
        break;
      case DRIFT_EVENT.version_requested:
        out.push({
          at: e.occurred_at,
          type: 'version_requested',
          summary: `${p['reason'] === 'level_up' ? 'level-up' : 're-sign'} requested: ${String(p['from_level'])} -> ${String(p['level'])}`,
          by: (p['by'] as string) ?? null,
          ledger_entry_id: null,
        });
        break;
    }
  }
  return out;
}

export async function repoDriftView(
  db: Executor,
  repo: string,
  o: { clock?: Clock; bypass: () => MergeBypassConfig | null },
): Promise<RepoDriftView | null> {
  const l = await loadDrift(db, repo);
  if (!l) return null;
  const g = l.governing;
  const now = (o.clock ?? systemClock).nowMs();
  const inputs = inputsOf(l);
  const findings = inputs ? evaluateDrift(inputs) : [];
  const shown = bypassShown(o.bypass(), l.repo_ref);
  const lastSusp = g
    ? [...l.drift.suspensions].reverse().find((s) => s.prr_version === g.version)
    : undefined;
  const restoredAfter =
    lastSusp && g
      ? l.drift.restores.some((r) => r.prr_version === g.version && r.at >= lastSusp.at)
      : false;
  const why = restoreWhyNot(l);
  const repoId = (await repoIdentity(db, l.repo_ref))?.repo_id;
  const hist = [
    ...history(l),
    ...(g && repoId ? await prrHistory(db, l.project_id, repoId) : []),
  ].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  return RepoDriftView.parse({
    repo: l.repo_ref,
    prr: g
      ? {
          version: g.version,
          status: g.status,
          level: g.prr.level.signed,
          fresh_until: g.prr.fresh_until,
          expired: g.status === 'expired' || now >= Date.parse(g.prr.fresh_until),
        }
      : null,
    head_sha: l.files?.value.sha ?? null,
    files_polled_at: l.files?.at ?? null,
    rules_polled_at: l.rules?.at ?? null,
    findings,
    files: inputs ? servedFiles(inputs) : [],
    suspension:
      g?.status === 'suspended' && lastSusp && !restoredAfter
        ? { at: lastSusp.at, findings: lastSusp.findings }
        : null,
    restore: {
      ready: g?.status === 'suspended' && why === null && shown !== null,
      why_not: shown === null ? 'the bypass list cannot be read' : why,
      bypass: shown ?? { logins: [], list_hash: bypassListHash([]) },
    },
    level_up: g && g.status !== 'expired' ? levelsAbove(g.prr.level.signed) : [],
    // open proposals first (each is a card for the admin slot), then the decided ones, newest first
    reonboarding: (await listReonboardProposals(db, l.repo_ref)).sort(
      (a, b) =>
        Number(a.status !== 'proposed') - Number(b.status !== 'proposed') ||
        (a.proposed_at < b.proposed_at ? 1 : a.proposed_at > b.proposed_at ? -1 : 0),
    ),
    history: hist.slice(0, 50),
  });
}

export async function projectDriftView(
  pool: pg.Pool,
  project: ProjectId,
  o: { clock?: Clock; bypass: () => MergeBypassConfig | null },
): Promise<ProjectDriftView> {
  await catchUp(pool);
  const repos = await pool.query<{ repo_ref: string }>(
    'SELECT repo_ref FROM core.repo WHERE project_id = $1 ORDER BY repo_ref',
    [project],
  );
  const out: RepoDriftView[] = [];
  for (const r of repos.rows) {
    const v = await repoDriftView(pool, r.repo_ref, o);
    if (v) out.push(v);
  }
  return { project_id: project, repos: out };
}

/** The re-affirm card's content for one drifted path: both texts for the diff, the lint and the secret check. */
export async function reaffirmView(
  d: DriftDeps,
  project: ProjectId,
  repo: string,
  path: string,
): Promise<Result<ReaffirmView, CoreError>> {
  const l = await loadDrift(d.pool, repo);
  if (!l || l.project_id !== project) {
    return err(coreError('not_found', `no repository ${repo} in project ${project}`));
  }
  const g = l.governing;
  if (!g) return err(coreError('conflict', 'no readiness record governs this repo'));
  const read = await readDriftedText(d, l, path);
  if (!read.ok) return read;
  // the affirmed text: a later re-affirmation's (in the record), else card 2's (the proposal or an edit)
  let affirmed: string | null = reaffirmedOf(l.drift, g.version).get(path)?.text ?? null;
  if (affirmed === null) {
    const s0 = await loadS0(d.pool, g.s0_id);
    if (s0) {
      const a = affirmedOf(s0, await s0Cards(d.pool, g.s0_id));
      if (a.ok) affirmed = a.value?.instructions.find((i) => i.path === path)?.text ?? null;
    }
  }
  const { text, sha256, head_sha } = read.value;
  const secret = text !== null && scanText(text).length > 0;
  const lint = text === null ? [] : lintOf(text);
  const blocking = lint.some((f) => f.severity === 'blocking');
  const whyNot =
    text === null
      ? 'the file is gone at the head: the affirmed text keeps being served'
      : secret
        ? 'the shared secret ruleset hit the text: it cannot be affirmed'
        : blocking
          ? 'a blocking content-lint finding is in the text: fix the file on GitHub first'
          : null;
  return ok(
    ReaffirmView.parse({
      repo: l.repo_ref,
      path,
      head_sha,
      affirmed_sha256: read.value.expected,
      affirmed_text: affirmed,
      repo_sha256: sha256,
      // never shown with a secret in it
      repo_text: secret ? null : text,
      lint,
      secret_hit: secret,
      bound_hash: whyNot === null ? sha256 : null,
      why_not: whyNot,
    }),
  );
}

/** The after-onboarding items of the inbox (OB §8): one per repo that waits for a person. */
export async function driftInboxItems(
  pool: pg.Pool,
  o: {
    clock?: Clock;
    deciders: (project: string) => Promise<{
      readonly holders: readonly string[];
      readonly error: string | null;
      readonly can_decide: boolean;
    }>;
  },
): Promise<CoreInboxItem[]> {
  const now = (o.clock ?? systemClock).nowMs();
  const repos = await pool.query<{ repo_ref: string }>(
    'SELECT repo_ref FROM core.repo ORDER BY repo_ref',
  );
  const out: CoreInboxItem[] = [];
  for (const r of repos.rows) {
    const l = await loadDrift(pool, r.repo_ref);
    const g = l?.governing;
    const inputs = l ? inputsOf(l) : null;
    if (!l || !g || !inputs) continue;
    const who = await o.deciders(l.project_id);
    const slot = AFTER_ONBOARDING_SLOT;
    const item = async (kind: CoreInboxItem['kind'], at: string): Promise<CoreInboxItem> => ({
      kind,
      id: l.repo_ref,
      project_id: l.project_id as never,
      s0_id: g.s0_id as never,
      label: null,
      slot: AFTER_ONBOARDING_SLOT,
      opened_at: at,
      sla_due_at: null,
      overdue: false,
      escalated: false,
      holders: [...who.holders] as never,
      item_id: null,
      gate: null,
      feasibility: who.error !== null ? 'unknown' : who.can_decide ? 'feasible' : 'infeasible',
      feasibility_reason:
        who.error !== null
          ? `who holds ${slot} is unknown: ${who.error}`
          : who.can_decide
            ? null
            : who.holders.length === 0
              ? `nobody holds the ${slot} role`
              : `T2 allows no waiver and ${slot} has one holder`,
    });
    const expired = g.status === 'expired' || now >= Date.parse(g.prr.fresh_until);
    if (expired) {
      out.push(await item('prr_resign', g.prr.fresh_until));
      continue;
    }
    if (g.status === 'suspended') {
      const s = [...l.drift.suspensions].reverse().find((x) => x.prr_version === g.version);
      out.push(await item('prr_restore', s?.at ?? l.files?.at ?? g.prr.issued_at));
    }
    // M17: an open re-onboarding proposal (knowledge defects in an area) is a card for the admin slot
    const open = (await listReonboardProposals(pool, l.repo_ref)).filter(
      (p) => p.status === 'proposed',
    );
    if (open.length > 0) out.push(await item('reonboard', open[0]?.proposed_at ?? g.prr.issued_at));
    if (evaluateDrift(inputs).some((f) => f.effect === 'reaffirm')) {
      out.push(
        await item(
          'drift_reaffirm',
          l.drift.evaluated.get(g.version)?.at ?? l.files?.at ?? g.prr.issued_at,
        ),
      );
    }
  }
  return out;
}
