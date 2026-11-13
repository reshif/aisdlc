import {
  BudgetExhaustedPayload,
  GATEWAY_EVENT,
  ITEM_EVENT,
  PrincipalId,
  pdpResource,
  type BudgetGroupView,
  type BudgetRow,
  type BudgetsView,
  type CoreGithubAppsView,
  type CostView,
  type GithubAppReport,
  type OnboardReposView,
  type ProjectSummary,
  type RepoOnboardingState,
} from '@aisdlc/contracts';
import type { Result } from '@aisdlc/kernel';
import type { Pdp } from '@aisdlc/pdp';
import type { CodeHostPort } from '@aisdlc/ports';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { readGoverning } from './prr-store.js';
import { listProjects, registeredRepos } from './queries.js';
import { catchUpWork } from './work-projection.js';

// The portal's operate and govern reads of the P2 gap list (docs/design/portal-review.md §12, contracts
// `portal-ops.ts`). Reads only, from the record: nothing here writes it. Each names the human in `on_behalf_of` and
// asks the PDP about them (a logged decision, like the other fleet reads).
//
//   GET /v1/budgets?on_behalf_of=             portal  ops.read on the fleet      P2-8: budget groups
//   GET /v1/cost?on_behalf_of=[&days=]        portal  quality.read on the fleet  P2-8: spend per day, project, merged item
//   GET /v1/onboarding/repos?on_behalf_of=    onboard project.onboard on the fleet  P2-21: the installation's repos
//                                                                                 (and where each stands, P2-4)
//   GET /v1/integrations/github-apps?on_behalf_of=  portal quality.read or ops.read  P2-4: the App reports, the rules
//
// Budgets: what settled calls spent is summed from `gateway.model_call` (refusals spend nothing), ET1 from
// `gateway.budget_exhausted`; the limits and the reservations of calls in flight live in the gateway alone and are
// asked of it (`budget.view`) when core has the gateway's admin API. Unanswered, they are `live: null`: unknown.

/** The gateway's view of one group (`GatewayAdminHttp.view`); `null`: the gateway does not know it. */
export interface BudgetViewPort {
  view(group_id: string): Promise<Result<BudgetGroupView | null, { readonly code: string }>>;
}

export interface PortalOpsDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly pdp: Pdp | undefined;
  readonly now: () => Date;
  readonly allowed: (req: FastifyRequest, scope: 'portal' | 'onboard') => boolean;
  readonly budget?: BudgetViewPort;
  readonly repos?: Pick<CodeHostPort, 'list_repos'>;
  /**
   * The GitHub Apps panel: the App reports of the services that hold the keys (the codehost, the Push Broker; `null`
   * when that one is not configured here) and the codehost's branch rules (`posture`).
   */
  readonly githubApps?: {
    readonly codehost: (() => Promise<GithubAppReport | null>) | null;
    readonly pushBroker: (() => Promise<GithubAppReport | null>) | null;
    readonly rules: Pick<CodeHostPort, 'rules_for_branch'> | null;
  };
}

type PortalOpsAction = 'ops.read' | 'quality.read' | 'project.onboard';

/** At most this many groups are listed (newest activity first), and asked of the gateway. */
const MAX_GROUPS = 100;

const DaysQuery = z.coerce.number().int().min(1).max(366);

export function registerPortalOpsRoutes(d: PortalOpsDeps): void {
  const { app } = d;

  async function reader(
    req: FastifyRequest,
    reply: FastifyReply,
    scope: 'portal' | 'onboard',
    action: PortalOpsAction | readonly PortalOpsAction[],
  ): Promise<string | null> {
    const actions: readonly PortalOpsAction[] = typeof action === 'string' ? [action] : action;
    if (!d.allowed(req, scope)) {
      sendError(reply, 403, 'forbidden', `scope ${scope} is needed`);
      return null;
    }
    const p = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (!p.success) {
      sendError(reply, 400, 'invalid_input', 'on_behalf_of is needed');
      return null;
    }
    if (!d.pdp) {
      sendError(reply, 503, 'unavailable', 'no policy decision point is configured');
      return null;
    }
    // any one of the actions allows (the Integrations page: quality.read or ops.read)
    const reasons: unknown[] = [];
    for (const a of actions) {
      let out;
      try {
        out = await d.pdp.decide({ principal: p.data, action: a, resource: pdpResource.fleet() });
      } catch {
        sendError(reply, 503, 'unavailable', 'the policy decision point could not answer');
        return null;
      }
      if (out.decision === 'allow') return p.data;
      reasons.push(...out.reasons);
    }
    reply.code(403).send({
      error: { code: 'forbidden', message: `${actions.join(' or ')} denied`, reasons },
    });
    return null;
  }

  // ------------------------------------------------------------ P2-8: budget groups

  app.get('/v1/budgets', async (req, reply) => {
    if (!(await reader(req, reply, 'portal', 'ops.read'))) return;
    let rows: BudgetRow[];
    try {
      rows = await budgetRows(d.pool);
    } catch {
      return sendError(reply, 503, 'unavailable', 'the budget groups could not be read');
    }
    const port = d.budget;
    const groups = port
      ? await Promise.all(
          rows.map(async (r) => {
            try {
              const v = await port.view(r.budget_group);
              return { ...r, live: v.ok ? v.value : null };
            } catch {
              return r;
            }
          }),
        )
      : rows;
    const view: BudgetsView = { as_of: d.now().toISOString(), gateway: port !== undefined, groups };
    return view;
  });

  // ------------------------------------------------------------ P2-8: cost over time and per merged item

  app.get('/v1/cost', async (req, reply) => {
    const raw = (req.query as Record<string, string>)['days'];
    const days =
      raw === undefined ? { success: true as const, data: 30 } : DaysQuery.safeParse(raw);
    if (!days.success) return sendError(reply, 400, 'invalid_input', 'days is 1 to 366');
    if (!(await reader(req, reply, 'portal', 'quality.read'))) return;
    const now = d.now();
    const since = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    since.setUTCDate(since.getUTCDate() - (days.data - 1));
    try {
      await catchUpWork(d.pool);
      const view: CostView = {
        as_of: now.toISOString(),
        since: since.toISOString(),
        days: days.data,
        ...(await costOf(d.pool, since)),
      };
      return view;
    } catch {
      return sendError(reply, 503, 'unavailable', 'the cost could not be read');
    }
  });

  // ------------------------------------------------------------ P2-21: the onboard form's repo picker

  app.get('/v1/onboarding/repos', async (req, reply) => {
    if (!(await reader(req, reply, 'onboard', 'project.onboard'))) return;
    if (!d.repos) {
      return sendError(reply, 503, 'unavailable', 'core has no code host to ask');
    }
    const got = await d.repos.list_repos().catch(() => null);
    if (!got || got.state !== 'ok') {
      return sendError(
        reply,
        502,
        'codehost_unavailable',
        'the code host could not list the repos',
      );
    }
    let known: Set<string>;
    try {
      // P-MUST-3's rule: a repo with a live or finished S0 record belongs to a project already
      known = new Set((await registeredRepos(d.pool)).map((r) => r.repo.toLowerCase()));
    } catch {
      return sendError(reply, 503, 'unavailable', 'the registered repos could not be read');
    }
    const states = await onboardingStates(d.pool).catch(() => null);
    const view: OnboardReposView = {
      repos: [...got.value]
        .sort((a, b) => a.full_name.localeCompare(b.full_name))
        .map((r) => ({
          ...r,
          registered: known.has(r.full_name.toLowerCase()),
          onboarding: r.archived
            ? { state: 'archived' }
            : states === null
              ? { state: 'unknown' }
              : (states.get(r.full_name.toLowerCase()) ?? { state: 'not_onboarded' }),
        })),
    };
    return view;
  });

  // ------------------------------------------------------------ P2-4: the GitHub Apps panel (read only)

  app.get('/v1/integrations/github-apps', async (req, reply) => {
    if (!(await reader(req, reply, 'portal', ['quality.read', 'ops.read']))) return;
    const g = d.githubApps;
    const ask = async (
      source: 'codehost' | 'push-broker',
      f: (() => Promise<GithubAppReport | null>) | null | undefined,
    ) => {
      if (!f) return { source, state: 'not_configured' as const, reports: [] };
      const r = await f().catch(() => null);
      return r === null
        ? { source, state: 'unreachable' as const, reports: [] }
        : { source, state: 'ok' as const, reports: r.reports };
    };
    const [ch, pb] = await Promise.all([
      ask('codehost', g?.codehost),
      ask('push-broker', g?.pushBroker),
    ]);
    // the registered repos' default branches: does each require aisdlc/gate (the bff pins it to gate-check's App)?
    const registered = await registeredRepos(d.pool)
      .then((rs) => [...new Set(rs.map((r) => r.repo))])
      .catch(() => [] as string[]);
    const listed = d.repos ? await d.repos.list_repos().catch(() => null) : null;
    const branches = await Promise.all(
      registered.map(async (repo) => {
        const info =
          listed?.state === 'ok'
            ? listed.value.find((r) => r.full_name.toLowerCase() === repo.toLowerCase())
            : undefined;
        const branch = info?.default_branch ?? null;
        if (branch === null || !g?.rules) return { repo, branch, required_checks: null };
        const rules = await g.rules
          .rules_for_branch({ repo: repo as never, branch })
          .catch(() => null);
        return {
          repo,
          branch,
          required_checks:
            rules?.state === 'ok'
              ? rules.value.required_checks.map((c) => ({
                  context: c.context,
                  integration_id: c.integration_id,
                }))
              : null,
        };
      }),
    );
    const view: CoreGithubAppsView = {
      sources: [
        { source: ch.source, state: ch.state },
        { source: pb.source, state: pb.state },
      ],
      reports: [...ch.reports, ...pb.reports],
      branches,
    };
    return view;
  });
}

/**
 * Where each repo a project holds stands, by lower-cased name: onboarded when a PRR governs it (its signed level and
 * lanes), else from the newest S0 record over every project naming it (a finished one with no PRR yet: level unknown).
 */
async function onboardingStates(pool: pg.Pool): Promise<Map<string, RepoOnboardingState>> {
  const newest = new Map<
    string,
    { project_id: string; s0: NonNullable<ProjectSummary['latest_s0']> }
  >();
  for (const p of await listProjects(pool)) {
    const s0 = p.latest_s0;
    if (!s0) continue;
    const key = s0.repo.toLowerCase();
    const have = newest.get(key);
    if (!have || have.s0.updated_at < s0.updated_at) {
      newest.set(key, { project_id: p.project.project_id, s0 });
    }
  }
  const out = new Map<string, RepoOnboardingState>();
  for (const [key, { project_id, s0 }] of newest) {
    // a PRR that governs the repo makes it onboarded (a level-up S0 may be running beside it)
    const g = await readGoverning(pool, s0.repo);
    if (g?.governing) {
      out.set(key, {
        state: 'onboarded',
        project_id: g.project_id as never,
        s0_id: g.governing.s0_id,
        level: g.governing.prr.level.signed,
        lanes: [...g.governing.prr.autonomy.lanes_eligible],
      });
    } else if (s0.status === 'superseded' || s0.status === 'withdrawn') {
      out.set(key, { state: 'not_onboarded' });
    } else if (s0.status === 'done') {
      // finished, but no PRR governs (yet): onboarded, level and lanes unknown
      out.set(key, {
        state: 'onboarded',
        project_id: project_id as never,
        s0_id: s0.s0_id,
        level: null,
        lanes: null,
      });
    } else {
      out.set(key, {
        state: 'onboarding',
        project_id: project_id as never,
        s0_id: s0.s0_id,
        status: s0.status,
        waiting: s0.waiting,
      });
    }
  }
  return out;
}

type Num = string | number | null;
const n = (v: Num): number => (v === null ? 0 : Number(v));

/** Every budget group the record knows (a key was minted on it, or a call was metered), newest activity first. */
export async function budgetRows(pool: pg.Pool): Promise<BudgetRow[]> {
  const q = await pool.query<{
    g: string;
    projects: string[] | null;
    items: string[] | null;
    calls: Num;
    refused: Num;
    tokens: Num;
    cost: Num;
    last_call: Date | null;
    last_seen: Date;
  }>(
    `WITH ev AS (
       SELECT type, body, occurred_at FROM record.record_event
        WHERE type IN ($1, $2) AND stream LIKE 'gateway:%'
     )
     SELECT body ->> 'budget_group' AS g,
            array_agg(DISTINCT body ->> 'project_id') AS projects,
            array_remove(array_agg(DISTINCT body ->> 'item_id'), NULL) AS items,
            count(*) FILTER (WHERE type = $1 AND body ->> 'outcome' <> 'refused') AS calls,
            count(*) FILTER (WHERE type = $1 AND body ->> 'outcome' = 'refused') AS refused,
            coalesce(sum((body ->> 'tokens_in')::bigint + (body ->> 'tokens_out')::bigint)
              FILTER (WHERE type = $1), 0) AS tokens,
            coalesce(sum((body ->> 'cost_micro_usd')::bigint) FILTER (WHERE type = $1), 0) AS cost,
            max(occurred_at) FILTER (WHERE type = $1) AS last_call,
            max(occurred_at) AS last_seen
       FROM ev
      GROUP BY 1
      ORDER BY last_seen DESC, 1
      LIMIT ${MAX_GROUPS}`,
    [GATEWAY_EVENT.model_call, GATEWAY_EVENT.vkey_minted],
  );
  const groups = q.rows.map((r) => r.g);
  const ex = await pool.query<{ g: string; body: unknown; occurred_at: Date }>(
    `SELECT DISTINCT ON (body ->> 'budget_group') body ->> 'budget_group' AS g, body, occurred_at
       FROM record.record_event
      WHERE type = $1 AND stream LIKE 'gateway:%' AND body ->> 'budget_group' = ANY($2::text[])
      ORDER BY body ->> 'budget_group', global_seq`,
    [GATEWAY_EVENT.budget_exhausted, groups],
  );
  const exhausted = new Map(
    ex.rows.map((r) => [r.g, { at: r.occurred_at, p: BudgetExhaustedPayload.parse(r.body) }]),
  );
  return q.rows.map((r) => {
    const e = exhausted.get(r.g);
    return {
      budget_group: r.g,
      project_ids: (r.projects ?? []).filter((x): x is string => typeof x === 'string').sort(),
      item_ids: (r.items ?? []).sort(),
      calls: n(r.calls),
      refused: n(r.refused),
      used_tokens: n(r.tokens),
      used_cost_micro_usd: n(r.cost),
      last_call_at: r.last_call ? r.last_call.toISOString() : null,
      exhausted_at: e ? e.at.toISOString() : null,
      exhausted_limit: e ? e.p.limit : null,
      live: null,
    };
  });
}

/** Spend per UTC day and project, per outcome, and per item merged since `since` (every call made for it). */
export async function costOf(
  pool: pg.Pool,
  since: Date,
): Promise<Pick<CostView, 'by_day' | 'by_outcome' | 'merged_items'>> {
  const days = await pool.query<{
    day: string;
    p: string;
    calls: Num;
    ti: Num;
    to: Num;
    cost: Num;
  }>(
    `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, body ->> 'project_id' AS p,
            count(*) AS calls, sum((body ->> 'tokens_in')::bigint) AS ti,
            sum((body ->> 'tokens_out')::bigint) AS "to", sum((body ->> 'cost_micro_usd')::bigint) AS cost
       FROM record.record_event
      WHERE type = $1 AND stream LIKE 'gateway:%' AND occurred_at >= $2
      GROUP BY 1, 2 ORDER BY 1, 2`,
    [GATEWAY_EVENT.model_call, since],
  );
  const outcomes = await pool.query<{ o: string; calls: Num; cost: Num }>(
    `SELECT body ->> 'outcome' AS o, count(*) AS calls, sum((body ->> 'cost_micro_usd')::bigint) AS cost
       FROM record.record_event
      WHERE type = $1 AND stream LIKE 'gateway:%' AND occurred_at >= $2
      GROUP BY 1 ORDER BY 1`,
    [GATEWAY_EVENT.model_call, since],
  );
  const merged = await pool.query<{
    item_id: string;
    project_id: string;
    lane: string | null;
    merged_at: Date;
    calls: Num;
    tokens: Num;
    cost: Num;
  }>(
    `WITH merged AS (
       SELECT substring(stream FROM 6) AS item_id, min(occurred_at) AS merged_at
         FROM record.record_event
        WHERE type = $2 AND stream LIKE 'item:%' AND occurred_at >= $3
        GROUP BY 1
     ), spent AS (
       SELECT body ->> 'item_id' AS item_id, count(*) AS calls,
              sum((body ->> 'tokens_in')::bigint + (body ->> 'tokens_out')::bigint) AS tokens,
              sum((body ->> 'cost_micro_usd')::bigint) AS cost
         FROM record.record_event
        WHERE type = $1 AND stream LIKE 'gateway:%' AND body ->> 'item_id' IN (SELECT item_id FROM merged)
        GROUP BY 1
     )
     SELECT m.item_id, c.body ->> 'project_id' AS project_id,
            coalesce(w.lane, c.body ->> 'proposed_lane') AS lane, m.merged_at, s.calls, s.tokens, s.cost
       FROM merged m
       JOIN record.record_event c ON c.stream = 'item:' || m.item_id AND c.type = $4
       LEFT JOIN core.work_item w ON w.item_id::text = m.item_id
       LEFT JOIN spent s ON s.item_id = m.item_id
      ORDER BY m.merged_at DESC, m.item_id
      LIMIT 500`,
    [GATEWAY_EVENT.model_call, ITEM_EVENT.merge_observed, since, ITEM_EVENT.created],
  );
  return {
    by_day: days.rows.map((r) => ({
      day: r.day,
      project_id: r.p,
      calls: n(r.calls),
      tokens_in: n(r.ti),
      tokens_out: n(r.to),
      cost_micro_usd: n(r.cost),
    })),
    by_outcome: outcomes.rows.map((r) => ({
      outcome: r.o as never,
      calls: n(r.calls),
      cost_micro_usd: n(r.cost),
    })),
    merged_items: merged.rows.map((r) => ({
      item_id: r.item_id as never,
      project_id: r.project_id as never,
      lane: r.lane as never,
      merged_at: r.merged_at.toISOString(),
      calls: n(r.calls),
      tokens: n(r.tokens),
      cost_micro_usd: n(r.cost),
    })),
  };
}
