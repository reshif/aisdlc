import {
  ACCESS_GRANT_ORIGIN,
  ADMIN_OVERRIDE_ENTRY_TYPE,
  DELETION_ENTRY_TYPE,
  FleetLedgerFilter,
  FleetLedgerView,
  PeopleListView,
  PersonDetailView,
  PrincipalId,
  ROLE_MAP_ORIGIN,
  TeamDetailView,
  TeamId,
  TeamListView,
  pdpResource,
  type ActionId,
  type FleetLedgerEntry,
  type PersonRow,
  type TeamRow,
} from '@aisdlc/contracts';
import { freshReadModel } from '@aisdlc/identity/read';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';

// Portal v2's People, teams & roles reads and the fleet decision log (docs/design/screen-map.md §2.13, §2.16; N19,
// N25; shapes: contracts `people.ts`). Read from identity's read model and the ledger in this process (the bff reads
// the record database as the app role, as `/api/directory` does). Who may read: the people screens are for those who
// run access on the fleet (`audit.read`, `identity.admin` or `access.manage` there); the decision log is `audit.read`
// on the fleet. Fail closed: an evaluator error is a refusal.
//
//   GET /api/people            everyone the directory knows (not deleted), their teams and role count
//   GET /api/people/:id        one person: sign-in, groups, every role assignment that reaches them
//   GET /api/teams             the teams with their members
//   GET /api/teams/:id         one team: members and its role assignments
//   GET /api/audit/ledger?filter=&before=&limit=   the fleet's decision log, newest first

export interface PeopleRouteDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly pdp: Pdp;
  readonly now: () => Date;
  readonly principalOf: (req: FastifyRequest) => string;
}

/** Who may read the people screens: any of these on the fleet. */
export const PEOPLE_READ_ACTIONS: readonly ActionId[] = [
  'audit.read',
  'identity.admin',
  'access.manage',
];

const originOf = (c: Record<string, unknown>) =>
  c['origin'] === ROLE_MAP_ORIGIN
    ? ('role_map' as const)
    : c['origin'] === ACCESS_GRANT_ORIGIN
      ? ('access_grant' as const)
      : ('other' as const);

/** A membership in force at `$1`. */
const ACTIVE_M = `m.active_from <= $1 AND (m.active_until IS NULL OR m.active_until > $1)`;
const ACTIVE_B = `(b.expiry IS NULL OR b.expiry > $1)`;

export function registerPeopleRoutes(d: PeopleRouteDeps): void {
  const { app } = d;

  async function allowedAny(who: string, actions: readonly ActionId[]): Promise<boolean> {
    for (const action of actions) {
      try {
        const r = await d.pdp.decide({ principal: who, action, resource: pdpResource.fleet() });
        if (r.decision === 'allow') return true;
      } catch {
        // an evaluator error is not an allow; the next action may still be
      }
    }
    return false;
  }

  /** The guard and the read model's freshness; `false` when the reply is sent. */
  async function ready(
    req: FastifyRequest,
    reply: FastifyReply,
    actions: readonly ActionId[],
  ): Promise<boolean> {
    if (!(await allowedAny(d.principalOf(req), actions))) {
      sendError(reply, 403, 'forbidden', `${actions[0]} denied`);
      return false;
    }
    const fresh = await freshReadModel(d.pool);
    if (!fresh.ok) {
      sendError(reply, 503, 'directory_unavailable', 'the identity read model needs a rebuild');
      return false;
    }
    return true;
  }

  async function people(ids: readonly string[] | null): Promise<PersonRow[]> {
    const at = d.now();
    const q = await d.pool.query<{
      principal_id: string;
      display_name: string;
      display_handle: string;
      kind: 'human' | 'service';
      status: 'active' | 'disabled' | 'deleted';
      upn: string | null;
      breakglass: boolean;
      teams: string[] | null;
      roles: string;
    }>(
      `SELECT p.principal_id, p.display_name, p.display_handle, p.kind, p.status, p.upn, p.breakglass,
              (SELECT array_agg(DISTINCT t.team_id ORDER BY t.team_id)
                 FROM identity.membership m JOIN identity.team t ON t.idp_group = m.group_id
                WHERE m.principal_id = p.principal_id AND ${ACTIVE_M}) AS teams,
              (SELECT count(DISTINCT b.binding_id)
                 FROM identity.membership m JOIN identity.binding b ON b.group_id = m.group_id
                WHERE m.principal_id = p.principal_id AND ${ACTIVE_M} AND ${ACTIVE_B}) AS roles
         FROM identity.principal p
        WHERE p.status <> 'deleted' AND ($2::text[] IS NULL OR p.principal_id = ANY($2::text[]))
        ORDER BY lower(p.display_name), p.principal_id
        LIMIT 1000`,
      [at, ids],
    );
    return q.rows.map((r) => ({
      principal_id: r.principal_id as never,
      display_name: r.display_name,
      display_handle: r.display_handle,
      kind: r.kind,
      status: r.status,
      upn: r.upn,
      sign_in: r.breakglass ? 'local' : 'sso',
      teams: (r.teams ?? []) as never[],
      roles: Number(r.roles),
    }));
  }

  async function teams(id: string | null): Promise<TeamRow[]> {
    const at = d.now();
    const q = await d.pool.query<{
      team_id: string;
      name: string;
      classification: 'internal' | 'confidential';
      idp_group: string | null;
      members: string[] | null;
      roles: string;
    }>(
      `SELECT t.team_id, t.name, t.classification, t.idp_group,
              (SELECT array_agg(m.principal_id ORDER BY m.principal_id)
                 FROM identity.membership m JOIN identity.principal p ON p.principal_id = m.principal_id
                WHERE m.group_id = t.idp_group AND p.status <> 'deleted' AND ${ACTIVE_M}) AS members,
              (SELECT count(*) FROM identity.binding b WHERE b.group_id = t.idp_group AND ${ACTIVE_B}) AS roles
         FROM identity.team t
        WHERE $2::text IS NULL OR t.team_id = $2
        ORDER BY lower(t.name), t.team_id`,
      [at, id],
    );
    return q.rows.map((r) => ({
      team_id: r.team_id as never,
      name: r.name,
      classification: r.classification,
      group_id: r.idp_group as never,
      members: (r.members ?? []) as never[],
      roles: Number(r.roles),
    }));
  }

  async function names(ids: readonly string[]): Promise<Record<string, string>> {
    if (ids.length === 0) return {};
    const q = await d.pool.query<{ principal_id: string; display_name: string }>(
      'SELECT principal_id, display_name FROM identity.principal WHERE principal_id = ANY($1::text[])',
      [[...new Set(ids)]],
    );
    return Object.fromEntries(q.rows.map((r) => [r.principal_id, r.display_name]));
  }

  app.get('/api/people', async (req, reply) => {
    if (!(await ready(req, reply, PEOPLE_READ_ACTIONS))) return;
    return PeopleListView.parse({ people: await people(null) });
  });

  app.get('/api/people/:id', async (req, reply) => {
    const id = PrincipalId.safeParse((req.params as { id: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad person id');
    if (!(await ready(req, reply, PEOPLE_READ_ACTIONS))) return;
    const [row] = await people([id.data]);
    if (!row) return sendError(reply, 404, 'not_found', 'no such person');
    const at = d.now();
    const p = await d.pool.query<{ logins: string[]; role_label: string | null; at: Date }>(
      'SELECT logins, role_label, status_changed_at AS at FROM identity.principal WHERE principal_id = $1',
      [id.data],
    );
    const extra = p.rows[0];
    const groups = await d.pool.query<{
      group_id: string;
      display: string;
      team_id: string | null;
    }>(
      `SELECT g.group_id, g.display, t.team_id
         FROM identity.membership m JOIN identity.grp g ON g.group_id = m.group_id
         LEFT JOIN identity.team t ON t.idp_group = g.group_id
        WHERE m.principal_id = $2 AND ${ACTIVE_M}
        ORDER BY g.display, g.group_id`,
      [at, id.data],
    );
    const bindings = await d.pool.query<{
      binding_id: string;
      role_id: string;
      scope_kind: string;
      scope_ref: string;
      expiry: Date | null;
      constraints: Record<string, unknown>;
      group_id: string;
      team_id: string | null;
    }>(
      `SELECT DISTINCT ON (b.binding_id) b.binding_id, b.role_id, b.scope_kind, b.scope_ref, b.expiry,
              b.constraints, b.group_id, t.team_id
         FROM identity.membership m JOIN identity.binding b ON b.group_id = m.group_id
         LEFT JOIN identity.team t ON t.idp_group = b.group_id
        WHERE m.principal_id = $2 AND ${ACTIVE_M} AND ${ACTIVE_B}
        ORDER BY b.binding_id`,
      [at, id.data],
    );
    return PersonDetailView.parse({
      person: {
        ...row,
        logins: extra?.logins ?? [],
        role_label: extra?.role_label ?? null,
        status_changed_at: (extra?.at ?? at).toISOString(),
      },
      groups: groups.rows,
      bindings: bindings.rows
        .map((b) => ({
          binding_id: b.binding_id,
          role_id: b.role_id,
          scope: { kind: b.scope_kind, ref: b.scope_ref },
          expiry: b.expiry?.toISOString() ?? null,
          origin: originOf(b.constraints),
          group_id: b.group_id,
          team_id: b.team_id,
        }))
        .sort((a, b) => a.role_id.localeCompare(b.role_id)),
    });
  });

  app.get('/api/teams', async (req, reply) => {
    if (!(await ready(req, reply, PEOPLE_READ_ACTIONS))) return;
    const list = await teams(null);
    return TeamListView.parse({ teams: list, names: await names(list.flatMap((t) => t.members)) });
  });

  app.get('/api/teams/:id', async (req, reply) => {
    const id = TeamId.safeParse((req.params as { id: string }).id);
    if (!id.success) return sendError(reply, 400, 'invalid_input', 'bad team id');
    if (!(await ready(req, reply, PEOPLE_READ_ACTIONS))) return;
    const [team] = await teams(id.data);
    if (!team) return sendError(reply, 404, 'not_found', 'no such team');
    const members = await people(team.members);
    const b = team.group_id
      ? await d.pool.query<{
          binding_id: string;
          group_id: string;
          role_id: string;
          scope_kind: string;
          scope_ref: string;
          expiry: Date | null;
          constraints: Record<string, unknown>;
        }>(
          `SELECT b.binding_id, b.group_id, b.role_id, b.scope_kind, b.scope_ref, b.expiry, b.constraints
             FROM identity.binding b WHERE b.group_id = $2 AND ${ACTIVE_B}
            ORDER BY b.role_id, b.scope_kind, b.scope_ref`,
          [d.now(), team.group_id],
        )
      : { rows: [] };
    return TeamDetailView.parse({
      team,
      members: members.map((m) => ({
        principal_id: m.principal_id,
        display_name: m.display_name,
        status: m.status,
      })),
      bindings: b.rows.map((r) => ({
        binding_id: r.binding_id,
        group_id: r.group_id,
        role_id: r.role_id,
        scope: { kind: r.scope_kind, ref: r.scope_ref },
        expiry: r.expiry?.toISOString() ?? null,
        origin: originOf(r.constraints),
        members: team.members,
      })),
    });
  });

  const LedgerQuery = z.strictObject({
    filter: FleetLedgerFilter.default('all'),
    before: z.coerce.number().int().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  });
  const FILTERS: Record<FleetLedgerFilter, string> = {
    all: 'TRUE',
    decisions: 'decision IS NOT NULL',
    overrides: `(entry_type = '${ADMIN_OVERRIDE_ENTRY_TYPE}' OR jsonb_typeof(body -> 'override') = 'object')`,
    deletions: `entry_type IN ('${DELETION_ENTRY_TYPE}', 'redacted')`,
    access: `entry_type LIKE 'access.%'`,
  };

  app.get('/api/audit/ledger', async (req, reply) => {
    const q = LedgerQuery.safeParse(req.query ?? {});
    if (!q.success) return sendError(reply, 400, 'invalid_input', 'bad query');
    if (!(await allowedAny(d.principalOf(req), ['audit.read']))) {
      return sendError(reply, 403, 'forbidden', 'audit.read denied');
    }
    const rows = await d.pool.query<Record<string, unknown>>(
      `SELECT ledger_seq, entry_id, entry_type, gate_id, gate_instance_id::text AS gate_instance_id,
              body ->> 'step' AS step, body ->> 'card_id' AS card_id, subject_kind, subject_id,
              decision, actor, sod_waiver, created_at, entry_hash, prev_hash,
              CASE WHEN entry_type = '${ADMIN_OVERRIDE_ENTRY_TYPE}' THEN body ->> 'reason'
                   ELSE body -> 'override' ->> 'reason' END AS override_reason,
              CASE WHEN entry_type = '${DELETION_ENTRY_TYPE}' THEN body END AS deletion
         FROM ledger.ledger_entry
        WHERE (${FILTERS[q.data.filter]}) AND ($1::bigint IS NULL OR ledger_seq < $1)
        ORDER BY ledger_seq DESC LIMIT ${q.data.limit + 1}`,
      [q.data.before ?? null],
    );
    const head = await d.pool.query<{ ledger_seq: string; entry_hash: string }>(
      'SELECT ledger_seq, entry_hash FROM ledger.ledger_entry ORDER BY ledger_seq DESC LIMIT 1',
    );
    const page = rows.rows.slice(0, q.data.limit);
    const entries: FleetLedgerEntry[] = page.map((r) => {
      const del = r['deletion'] as {
        kind?: string;
        redacted_ledger_seqs?: unknown[];
        override?: boolean;
      } | null;
      return {
        ledger_seq: Number(r['ledger_seq']),
        entry_id: String(r['entry_id']),
        entry_type: String(r['entry_type']),
        gate_id: (r['gate_id'] as string | null) ?? null,
        gate_instance_id: (r['gate_instance_id'] as string | null) ?? null,
        step: (r['step'] as string | null) ?? null,
        card_id: (r['card_id'] as string | null) ?? null,
        subject_kind: (r['subject_kind'] as string | null) ?? null,
        subject_id: (r['subject_id'] as string | null) ?? null,
        decision: (r['decision'] as string | null) ?? null,
        actor: (r['actor'] as string | null) ?? null,
        sod_waiver: Boolean(r['sod_waiver']),
        created_at: (r['created_at'] as Date).toISOString(),
        entry_hash: String(r['entry_hash']),
        prev_hash: (r['prev_hash'] as string | null) ?? null,
        override_reason: (r['override_reason'] as string | null) ?? null,
        deletion: del
          ? {
              kind: String(del.kind ?? 'unknown'),
              redacted: Array.isArray(del.redacted_ledger_seqs)
                ? del.redacted_ledger_seqs.length
                : 0,
              override: del.override === true,
            }
          : null,
      };
    });
    const last = page.at(-1);
    return FleetLedgerView.parse({
      entries,
      head: head.rows[0]
        ? { ledger_seq: Number(head.rows[0].ledger_seq), entry_hash: head.rows[0].entry_hash }
        : null,
      next_before: rows.rows.length > q.data.limit && last ? Number(last['ledger_seq']) : null,
    });
  });
}
