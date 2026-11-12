import { AGENT_DEFINITIONS, PROMPTS_LOCK } from '@aisdlc/agents';
import { CATALOGUE_VERSION, catalogueFor, releasedCatalogues } from '@aisdlc/catalogue';
import {
  AuditDecisionRow,
  CODING_SESSION_CAP,
  ITEM_EVENT,
  KILL_OBSERVED_EVENT,
  KillObservedPayload,
  KILL_SIGNATURE_PENDING,
  PDP_EVENT,
  PdpDecisionRecord,
  PrincipalId,
  ProjectId,
  pdpResource,
  type ActionId,
  type AdmissionView,
  type AgentRegistryView,
  type CatalogueView,
  type HeldItemRow,
  type ItemListRow,
  type KillsView,
  type PdpResource,
  type WorkItemPhase,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { activeGrantCount, grantsWithStatus } from './admission/read.js';
import { activeBanners, activeControls } from './controls.js';
import { readItem } from './work-items.js';
import { catchUpWork } from './work-projection.js';

// The portal's list reads (2026-11-12): the thinnest read over what core already holds, for the screens
// whose backends were on main (contracts `portal-lists.ts`). Each names the human in `on_behalf_of`
// and asks the PDP about them; a row the person may not see is left out (a listing probe, not logged,
// like the bff's `/api/me/decisions`). Reads only: nothing here writes the record.
//
//   GET /v1/items?on_behalf_of=[&project=]       work    item.view_floor per row
//   GET /v1/agents?on_behalf_of=                 work    audit.read on the fleet (the registry is code)
//   GET /v1/catalogue                            work    every released catalogue, with its pinned items
//   GET /v1/admission?on_behalf_of=              work    audit.read on the fleet
//   GET /v1/controls?on_behalf_of=               portal  audit.read on the fleet (every scope's controls)
//   GET /v1/kills?on_behalf_of=                  portal  audit.read on the fleet (the observed journal)
//   GET /v1/audit/decisions?on_behalf_of=[&limit=&action=]  portal  audit.read on the fleet

export interface PortalListDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly pdp: Pdp | undefined;
  readonly now: () => Date;
  readonly allowed: (req: FastifyRequest, scope: 'work' | 'portal') => boolean;
}

export function registerPortalListRoutes(d: PortalListDeps): void {
  const { app } = d;

  const who = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const p = PrincipalId.safeParse((req.query as Record<string, string>)['on_behalf_of']);
    if (p.success) return p.data;
    sendError(reply, 400, 'invalid_input', 'on_behalf_of is needed');
    return null;
  };

  /** A probe: `allow` or nothing, never logged (a listing asks once per row). */
  const may = async (principal: string, action: ActionId, resource: PdpResource) => {
    if (!d.pdp) return false;
    try {
      return (
        (await d.pdp.decide({ principal, action, resource }, { log: false })).decision === 'allow'
      );
    } catch {
      return false;
    }
  };

  /** The scope, the principal, and the PDP's `audit.read` on the fleet (a logged decision, like the other audit reads). */
  async function auditReader(req: FastifyRequest, reply: FastifyReply, scope: 'work' | 'portal') {
    if (!d.allowed(req, scope)) {
      sendError(reply, 403, 'forbidden', `scope ${scope} is needed`);
      return null;
    }
    const p = who(req, reply);
    if (!p) return null;
    if (!d.pdp) {
      sendError(reply, 503, 'unavailable', 'no policy decision point is configured');
      return null;
    }
    const out = await d.pdp.decide({
      principal: p,
      action: 'audit.read',
      resource: pdpResource.fleet(),
    });
    if (out.decision !== 'allow') {
      reply.code(403).send({
        error: { code: 'forbidden', message: 'audit.read denied', reasons: out.reasons },
      });
      return null;
    }
    return p;
  }

  const unavailable = (reply: FastifyReply, what: string) =>
    sendError(reply, 503, 'unavailable', `${what} could not be read`);

  // ------------------------------------------------------------ items

  app.get('/v1/items', async (req, reply) => {
    if (!d.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const p = who(req, reply);
    if (!p) return;
    const raw = (req.query as Record<string, string>)['project'];
    const project = raw === undefined ? null : ProjectId.safeParse(raw);
    if (project !== null && !project.success) {
      return sendError(reply, 400, 'invalid_input', 'bad project id');
    }
    type Row = {
      item_id: string;
      project_id: string;
      repo_key: string;
      lane: string | null;
      proposed_lane: string;
      phase: string;
      underlying: string;
      terminal: string | null;
      holds: number;
      in_flight: boolean;
      catalogue_version: string;
      created_at: Date;
      updated_at: Date;
      mine: boolean;
    };
    let rows: Row[];
    try {
      await catchUpWork(d.pool);
      const q = await d.pool.query<Row>(
        `SELECT w.item_id, w.project_id, w.repo_key, w.lane, w.proposed_lane, w.phase, w.underlying,
                w.terminal, w.holds, w.in_flight, w.catalogue_version, w.created_at, w.updated_at,
                EXISTS (SELECT 1 FROM record.record_event e
                         WHERE e.stream = 'item:' || w.item_id::text AND e.type = $2
                           AND e.body ->> 'requester' = $1) AS mine
           FROM core.work_item w
          WHERE ($3::text IS NULL OR w.project_id = $3)
          ORDER BY w.updated_at DESC, w.item_id
          LIMIT 500`,
        [p, ITEM_EVENT.created, project === null ? null : project.data],
      );
      rows = q.rows;
    } catch {
      return unavailable(reply, 'the items');
    }
    const items: ItemListRow[] = [];
    for (const r of rows) {
      const lane = (r.lane ?? r.proposed_lane) as never;
      if (!(await may(p, 'item.view_floor', pdpResource.item(r.project_id, r.item_id, lane)))) {
        continue;
      }
      items.push({
        item_id: r.item_id as never,
        project_id: r.project_id as never,
        repo: r.repo_key,
        lane: r.lane as never,
        proposed_lane: r.proposed_lane as never,
        phase: r.phase as WorkItemPhase,
        underlying: r.underlying as WorkItemPhase,
        terminal: r.terminal,
        holds: r.holds,
        in_flight: r.in_flight,
        mine: r.mine,
        catalogue_version: r.catalogue_version,
        created_at: r.created_at.toISOString(),
        updated_at: r.updated_at.toISOString(),
      });
    }
    return { items };
  });

  // ------------------------------------------------------------ agents: the registry is code (packages/agents)

  app.get('/v1/agents', async (req, reply) => {
    if (!(await auditReader(req, reply, 'work'))) return;
    const view: AgentRegistryView = {
      lock_format: PROMPTS_LOCK.format,
      agents: AGENT_DEFINITIONS.map((a) => ({
        agent_id: a.agent_id,
        name: a.name,
        role: a.role,
        note: a.note,
        steps: [...a.steps],
        specialist_steps: [...a.specialist_steps],
        contract_version: a.contract.contract_version,
        output_schema_id: a.contract.output_schema_id,
        tools: [...a.contract.tools],
        data_class_max: a.contract.data_class_max,
        models: [...a.contract.models],
        prompt: a.prompt,
      })),
    };
    return view;
  });

  // ------------------------------------------------------------ catalogue: every release, immutable

  app.get('/v1/catalogue', async (req, reply) => {
    if (!d.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    let pinned: Map<string, number>;
    try {
      await catchUpWork(d.pool);
      const q = await d.pool.query<{ v: string; h: string; n: string }>(
        `SELECT catalogue_version AS v, catalogue_hash AS h, count(*)::text AS n
           FROM core.work_item GROUP BY 1, 2`,
      );
      pinned = new Map(q.rows.map((r) => [`${r.v}:${r.h}`, Number(r.n)]));
    } catch {
      return unavailable(reply, 'the catalogue pins');
    }
    const view: CatalogueView = {
      versions: releasedCatalogues().map((ref) => {
        const got = catalogueFor(ref);
        // a released snapshot that no longer hashes to its pin is shown with no lanes, never as current data
        const data = got.ok ? got.value : null;
        return {
          ref,
          current: ref.version === CATALOGUE_VERSION,
          pinned_items: pinned.get(`${ref.version}:${ref.hash}`) ?? 0,
          lanes: Object.values(data?.lanes ?? {}).map((l) => ({
            lane: l.id,
            label: l.label,
            enter_at: l.enter_at,
            stages: l.stages.map((st) => st.stage),
            gates: l.gates.map((g) => ({ gate: g.gate, step: g.step, presence: g.presence })),
          })),
        };
      }),
    };
    return view;
  });

  // ------------------------------------------------------------ admission: H1-H3, WIP, HUMAN-WAIT

  app.get('/v1/admission', async (req, reply) => {
    if (!(await auditReader(req, reply, 'work'))) return;
    try {
      await catchUpWork(d.pool);
      const [active, waiting, inSlot] = await Promise.all([
        grantsWithStatus(d.pool, 'active'),
        grantsWithStatus(d.pool, 'waiting'),
        activeGrantCount(d.pool),
      ]);
      const heldIds = await d.pool.query<{ item_id: string }>(
        `SELECT item_id FROM core.work_item WHERE holds > 0 AND terminal IS NULL
          ORDER BY updated_at LIMIT 200`,
      );
      const held: HeldItemRow[] = [];
      for (const { item_id } of heldIds.rows) {
        const it = await readItem(d.pool, item_id);
        if (!it) continue;
        const s = it.state;
        held.push({
          item_id: s.item_id as never,
          project_id: s.project_id as never,
          lane: s.lane,
          underlying: s.underlying,
          reasons: s.holds.map((h) => h.reason),
          since: s.holds.map((h) => h.placed_at).sort()[0] ?? null,
        });
      }
      const view: AdmissionView = {
        as_of: d.now().toISOString(),
        coding_session_cap: CODING_SESSION_CAP,
        sessions_in_slot: inSlot,
        active,
        waiting,
        held,
      };
      return view;
    } catch {
      return unavailable(reply, 'the admission state');
    }
  });

  // ------------------------------------------------------------ controls (every scope) and the kill journal

  app.get('/v1/controls', async (req, reply) => {
    if (!(await auditReader(req, reply, 'portal'))) return;
    try {
      const now = d.now();
      return {
        controls: await activeControls(d.pool, now),
        banners: await activeBanners(d.pool, now),
      };
    } catch {
      return unavailable(reply, 'the controls');
    }
  });

  app.get('/v1/kills', async (req, reply) => {
    if (!(await auditReader(req, reply, 'portal'))) return;
    try {
      const q = await d.pool.query<{ body: unknown }>(
        `SELECT body FROM record.record_event WHERE type = $1
          ORDER BY global_seq DESC LIMIT 200`,
        [KILL_OBSERVED_EVENT],
      );
      const journal = q.rows.map((r) => {
        const e = KillObservedPayload.parse(r.body);
        return {
          ks_seq: e.ks_seq,
          kind: e.kind,
          subject: e.subject,
          actor: e.actor,
          entry_hash: e.entry_hash,
          signed: e.signature !== KILL_SIGNATURE_PENDING,
          at: e.at,
        };
      });
      const view: KillsView = {
        observed_head: journal.reduce((m, e) => Math.max(m, e.ks_seq), 0),
        journal,
      };
      return view;
    } catch {
      return unavailable(reply, 'the kill journal');
    }
  });

  // ------------------------------------------------------------ audit: the PDP decision log

  app.get('/v1/audit/decisions', async (req, reply) => {
    if (!(await auditReader(req, reply, 'portal'))) return;
    const q = req.query as Record<string, string>;
    const limit = q['limit'] === undefined ? 100 : Number(q['limit']);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      return sendError(reply, 400, 'invalid_input', 'limit is 1 to 500');
    }
    const action = q['action'];
    if (action !== undefined && !/^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/.test(action)) {
      return sendError(reply, 400, 'invalid_input', 'bad action');
    }
    try {
      const rows = await d.pool.query<{ body: unknown }>(
        `SELECT body FROM record.record_event
          WHERE type = $1 AND ($2::text IS NULL OR body ->> 'action' = $2)
          ORDER BY global_seq DESC LIMIT $3`,
        [PDP_EVENT.decision, action ?? null, limit],
      );
      return {
        decisions: rows.rows.map((r) => {
          const e = PdpDecisionRecord.parse(r.body);
          return AuditDecisionRow.parse({
            decision_id: e.decision_id,
            principal: e.principal,
            action: e.action,
            resource: e.resource,
            decision: e.decision,
            reasons: e.reasons,
            bundle_version: e.bundle_version,
            at: e.at,
            logged_because: e.logged_because,
          });
        }),
      };
    } catch {
      return unavailable(reply, 'the decision log');
    }
  });
}
