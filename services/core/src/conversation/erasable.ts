import { ErasablePayload, PrincipalId, ProjectId, Sha256Hex } from '@aisdlc/contracts';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { CORE_STATUS } from '../errors.js';
import { catchUpConversations, erasePayload } from './store.js';
import type { CoreDeps } from '../journal.js';

// The erasable payloads core owns (PLAN M19; docs/specs/audit-api.md), for the audit service ONLY (scope `erasure`):
// the payloads kept off the hash chain (`core.conversation_payload`: the title and the turns of a thread), listed by
// id, hash, owner, thread and project, never their text; and the erasure of one, by `erasePayload` (its text goes, its
// hash stays, `conversation.payload_erased` on the thread). The audit service decides WHETHER (two factory admins, the
// `erasure.execute` ledger entry, no legal hold); core only does it, and only for the payload whose hash was named.
//
//   GET  /v1/erasable-payloads?owner=&project=&created_before=&live_only=&limit=   ErasablePayloadList
//   POST /v1/erasable-payloads/:id/erase  {thread_id, owner, sha256}               {already}

const Query = z.strictObject({
  owner: PrincipalId.optional(),
  project: ProjectId.optional(),
  created_before: z.iso.datetime().optional(),
  live_only: z.enum(['true', 'false']).optional(),
  limit: z.coerce.number().int().min(1).max(1000),
});

const EraseBody = z.strictObject({ thread_id: z.uuid(), owner: PrincipalId, sha256: Sha256Hex });

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** The payloads a query names, oldest first: each with the thread that names it and that thread's project. */
export async function listErasablePayloads(
  pool: pg.Pool,
  q: {
    owner?: string;
    project_id?: string;
    created_before?: string;
    live_only?: boolean;
    limit: number;
  },
): Promise<ErasablePayload[]> {
  await catchUpConversations(pool);
  const rows = await pool.query<Record<string, unknown>>(
    `WITH refs AS (
       SELECT t.title_payload AS payload_id, t.thread_id, t.project_id FROM core.conversation_thread t
       UNION
       SELECT u.payload_id, u.thread_id, t.project_id
         FROM core.conversation_turn u JOIN core.conversation_thread t USING (thread_id)
     )
     SELECT p.payload_id::text AS payload_id, r.thread_id::text AS thread_id, p.owner, r.project_id, p.sha256,
            p.created_at, p.erased_at
       FROM core.conversation_payload p JOIN refs r USING (payload_id)
      WHERE ($1::text IS NULL OR p.owner = $1)
        AND ($2::text IS NULL OR r.project_id = $2)
        AND ($3::timestamptz IS NULL OR p.created_at < $3)
        AND (NOT $4 OR p.erased_at IS NULL)
      ORDER BY p.created_at, p.payload_id
      LIMIT $5`,
    [
      q.owner ?? null,
      q.project_id ?? null,
      q.created_before ?? null,
      q.live_only === true,
      q.limit,
    ],
  );
  return rows.rows.map((r) =>
    ErasablePayload.parse({
      kind: 'conversation_payload',
      payload_id: r['payload_id'],
      thread_id: r['thread_id'],
      owner: r['owner'],
      project_id: r['project_id'] ?? null,
      sha256: r['sha256'],
      created_at: iso(r['created_at']),
      erased_at: r['erased_at'] == null ? null : iso(r['erased_at']),
    }),
  );
}

export function registerErasableRoutes(r: {
  readonly app: FastifyInstance;
  readonly deps: CoreDeps;
  readonly allowed: (req: FastifyRequest) => boolean;
}): void {
  const { app } = r;
  const refuse = (reply: Parameters<typeof sendError>[0]) =>
    sendError(reply, 403, 'forbidden', 'scope erasure is needed');

  app.get('/v1/erasable-payloads', async (req, reply) => {
    if (!r.allowed(req)) return refuse(reply);
    const q = Query.safeParse(req.query);
    if (!q.success) return sendError(reply, 400, 'invalid_input', q.error.message.slice(0, 300));
    try {
      const payloads = await listErasablePayloads(r.deps.pool, {
        ...(q.data.owner ? { owner: q.data.owner } : {}),
        ...(q.data.project ? { project_id: q.data.project } : {}),
        ...(q.data.created_before ? { created_before: q.data.created_before } : {}),
        live_only: q.data.live_only === 'true',
        limit: q.data.limit,
      });
      return { payloads };
    } catch {
      return sendError(reply, 503, 'unavailable', 'the payloads could not be read');
    }
  });

  app.post('/v1/erasable-payloads/:id/erase', async (req, reply) => {
    if (!r.allowed(req)) return refuse(reply);
    const id = z.uuid().safeParse((req.params as { id?: string }).id);
    const b = EraseBody.safeParse(req.body ?? {});
    if (!id.success || !b.success) return sendError(reply, 400, 'invalid_input', 'bad request');
    const have = await r.deps.pool.query<{
      owner: string;
      sha256: string;
      erased_at: Date | null;
    }>('SELECT owner, sha256, erased_at FROM core.conversation_payload WHERE payload_id = $1', [
      id.data,
    ]);
    const row = have.rows[0];
    if (!row || row.owner !== b.data.owner) {
      return sendError(reply, 404, 'not_found', 'no such payload');
    }
    if (row.sha256 !== b.data.sha256) {
      return sendError(reply, 409, 'mismatch', 'the payload does not have that hash');
    }
    if (row.erased_at !== null) return { already: true };
    // the erasure is recorded on the thread that names the payload, and only there
    await catchUpConversations(r.deps.pool);
    const named = await r.deps.pool.query(
      `SELECT 1 FROM core.conversation_thread WHERE thread_id = $1 AND title_payload = $2
        UNION ALL SELECT 1 FROM core.conversation_turn WHERE thread_id = $1 AND payload_id = $2 LIMIT 1`,
      [b.data.thread_id, id.data],
    );
    if (named.rows.length === 0) return sendError(reply, 404, 'not_found', 'no such payload');
    const e = await erasePayload(r.deps, {
      owner: b.data.owner,
      thread_id: b.data.thread_id,
      payload_id: id.data,
    });
    if (!e.ok) {
      // a concurrent erase got there first: the payload is erased either way
      if (e.error.code === 'not_found') return { already: true };
      return sendError(reply, CORE_STATUS[e.error.code], e.error.code, e.error.message);
    }
    return { already: false };
  });
}
