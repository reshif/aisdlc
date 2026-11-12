import type { ThreadSubject } from '@aisdlc/contracts';
import type pg from 'pg';
import { loadS0, s0Cards } from '../cards/read.js';
import type { KnowledgePort } from '../clients.js';
import { getProjectDetail } from '../queries.js';

// What the assistant may know about a thread's subject (PLAN M18; portal-config §4 "answers only from what the
// person can see"). Core builds it from the record and knowledge's census, and the route has already asked the PDP
// for `project.view` on the subject's project. Each fact carries the ref a citation names it by; the set of refs and
// of targets (cards, records, items, projects) is what an answer's citations and proposals are checked against.
//
// THE HEAD. A thread answers about ONE commit: the census head. For an S0 record that is the census the record was
// raised on; when knowledge holds a newer census of the repo, or the code host says the default branch moved past
// it, the thread is `stale`: it still answers from the record and the old census, and answers nothing about the
// new head (the search is asked at the census commit only, and a citation at any other commit is refused).

export interface Fact {
  readonly ref: string;
  readonly text: string;
}

export interface Ground {
  readonly subject: ThreadSubject;
  readonly repo: string | null;
  /** The census head the thread answers about; `null`: no census, so no repository text at all. */
  readonly census_sha: string | null;
  readonly stale: boolean;
  readonly facts: readonly Fact[];
  /** What a proposal may target, by kind. */
  readonly cards: ReadonlyMap<string, { kind: string; project_id: string }>;
  readonly s0s: ReadonlySet<string>;
  readonly items: ReadonlyMap<string, { project_id: string; lane: string | null }>;
  readonly projects: ReadonlySet<string>;
}

export interface GroundDeps {
  readonly pool: pg.Pool;
  readonly knowledge: Pick<KnowledgePort, 'census'>;
  /** The default branch's head on the code host now; `null` when it cannot be read (then only knowledge decides). */
  readonly head?: (repo: string) => Promise<string | null>;
}

const SHA_IN_ID = /([0-9a-f]{40})$/;

async function headMoved(d: GroundDeps, repo: string, sha: string): Promise<boolean> {
  if (!d.head) return false;
  try {
    const h = await d.head(repo);
    return h !== null && h !== sha;
  } catch {
    return false;
  }
}

/** The census of a repo as the assistant may quote it: counts, statuses and the tier floor, never a finding. */
function censusFact(
  repo: string,
  c: NonNullable<Awaited<ReturnType<KnowledgePort['census']>>>,
): Fact | null {
  if (!c.ok || c.value === null) return null;
  const census = c.value.census;
  const bySeverity = new Map<string, number>();
  for (const g of census.gaps) bySeverity.set(g.severity, (bySeverity.get(g.severity) ?? 0) + 1);
  return {
    ref: `project:census/${repo}`,
    text: [
      `census of ${repo} at ${census.baseline_sha}`,
      `gaps: ${[...bySeverity].map(([k, n]) => `${n} ${k}`).join(', ') || 'none'}`,
      `tier floor: ${census.risk_category.tier_floor}`,
      `blockers: ${census.blockers.map((b) => `${b.id} ${b.status}`).join(', ') || 'none'}`,
      'secret findings are on the security card only (rule ids and counts); their values are never quoted',
    ].join('\n'),
  };
}

export async function groundS0(d: GroundDeps, s0Id: string): Promise<Ground | null> {
  const loaded = await loadS0(d.pool, s0Id);
  if (!loaded) return null;
  const { s0 } = loaded;
  const project = s0.record.project_id;
  const facts: Fact[] = [
    {
      ref: `s0:${s0Id}`,
      text: [
        `S0 record ${s0Id} of ${s0.repo} (project ${project})`,
        `status: ${s0.record.status}`,
        `requested level: ${s0.record.requested_level}; signable level: ${s0.record.signable_level}`,
        `waiting: ${s0.waiting ?? 'nothing'}`,
      ].join('\n'),
    },
  ];
  for (const [step, p] of [...s0.steps].sort(([a], [b]) => a.localeCompare(b))) {
    facts.push({
      ref: `step:${s0Id}/${step}`,
      text: `step ${step}: ${p.state}${p.blocked_cause ? ` (blocked: ${p.blocked_cause})` : ''}${
        p.send_backs > 0 ? `, ${p.send_backs} send-back(s)` : ''
      }`,
    });
  }
  const cards = new Map<string, { kind: string; project_id: string }>();
  for (const c of await s0Cards(d.pool, s0Id)) {
    cards.set(c.card_id, { kind: c.kind, project_id: project });
    facts.push({
      ref: `card:${c.card_id}`,
      text: `card ${c.kind} (${c.card_id}), occurrence ${c.occurrence}: ${c.state.status}`,
    });
  }

  let census_sha: string | null = null;
  let stale = false;
  if (s0.census) {
    const latest = await d.knowledge.census(s0.repo);
    if (latest.ok && latest.value !== null && latest.value.census_hash === s0.census.census_hash) {
      census_sha = latest.value.census.baseline_sha;
      const f = censusFact(s0.repo, latest);
      if (f) facts.push(f);
      stale = await headMoved(d, s0.repo, census_sha);
    } else {
      // knowledge moved on to a newer census (or cannot say): the record's census is all we answer about
      stale = true;
      census_sha = SHA_IN_ID.exec(s0.census.census_id)?.[1] ?? null;
    }
  }
  return {
    subject: { kind: 's0', s0_id: s0Id as never, project_id: project },
    repo: s0.repo,
    census_sha,
    stale,
    facts,
    cards,
    s0s: new Set([s0Id]),
    items: new Map(),
    projects: new Set([project]),
  };
}

export async function groundProject(d: GroundDeps, projectId: string): Promise<Ground | null> {
  const detail = await getProjectDetail(d.pool, projectId);
  if (!detail) return null;
  const facts: Fact[] = [
    {
      ref: `project:${projectId}`,
      text: [
        `project ${projectId} (${detail.project.name})`,
        `repos: ${detail.repos.map((r) => r.repo_ref).join(', ') || 'none'}`,
      ].join('\n'),
    },
  ];
  const s0s = new Set<string>();
  for (const o of detail.s0) {
    s0s.add(o.record.s0_id);
    facts.push({
      ref: `s0:${o.record.s0_id}`,
      text: `S0 record ${o.record.s0_id}: ${o.record.status}, signable level ${o.record.signable_level}, waiting: ${o.waiting ?? 'nothing'}`,
    });
  }
  const items = new Map<string, { project_id: string; lane: string | null }>();
  const q = await d.pool.query<{
    item_id: string;
    phase: string;
    lane: string | null;
    proposed_lane: string;
    repo_key: string;
  }>(
    `SELECT item_id, phase, lane, proposed_lane, repo_key FROM core.work_item
      WHERE project_id = $1 AND terminal IS NULL ORDER BY updated_at DESC LIMIT 30`,
    [projectId],
  );
  for (const r of q.rows) {
    items.set(r.item_id, { project_id: projectId, lane: r.lane ?? r.proposed_lane });
    facts.push({
      ref: `item:${r.item_id}`,
      text: `item ${r.item_id} on ${r.repo_key}: ${r.phase}, lane ${r.lane ?? `${r.proposed_lane} (proposed)`}`,
    });
  }

  const repo = detail.repos[0]?.repo_ref ?? null;
  let census_sha: string | null = null;
  let stale = false;
  if (repo !== null) {
    const latest = await d.knowledge.census(repo);
    if (latest.ok && latest.value !== null) {
      census_sha = latest.value.census.baseline_sha;
      const f = censusFact(repo, latest);
      if (f) facts.push(f);
      stale = await headMoved(d, repo, census_sha);
    }
  }
  return {
    subject: { kind: 'project', project_id: projectId as never },
    repo,
    census_sha,
    stale,
    facts,
    cards: new Map(),
    s0s,
    items,
    projects: new Set([projectId]),
  };
}

export async function groundOf(d: GroundDeps, subject: ThreadSubject): Promise<Ground | null> {
  return subject.kind === 's0' ? groundS0(d, subject.s0_id) : groundProject(d, subject.project_id);
}
