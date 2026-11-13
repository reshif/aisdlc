import {
  DELETION_ACTIONS,
  DELETION_ROUTES,
  DeletionKindValues,
  DeletionPreviewRequest,
  DeletionRequest,
  DeletionResult,
  isAdminOverride,
  type DeletionKind,
  type PdpResource,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { CORE_STATUS, coreError, type CoreError } from '../errors.js';
import { performDeletion, previewDeletion, type DeletionDeps } from './engine.js';
import { resolveTarget } from './targets.js';

// Delete means delete (docs/specs/deletion.md §5). For the bff acting for a signed-in person (`on_behalf_of`), scope
// `delete`:
//
//   POST   /v1/deletions/preview  {on_behalf_of, kind, id}       what would go, what blocks it; writes nothing
//   DELETE /v1/projects/:id        {on_behalf_of, reason, confirm} project.delete on the project
//   DELETE /v1/repos/:id           (owner/name, URL-encoded)       repo.delete on the repo
//   DELETE /v1/items/:id                                           item.delete on the item
//   DELETE /v1/people/:id                                          person.delete on the fleet
//   DELETE /v1/teams/:id                                           team.delete on the fleet
//   DELETE /v1/bindings/:id                                        binding.delete on its project (or the fleet)
//
// The PDP decides first (the factory admin always; a project admin for the project's own). `confirm` is the id typed
// again; the reason may not name what is deleted (it is kept on the deletion's record event). Without the purge login
// every route answers `503 deletion_unavailable`.

export interface DeletionRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp | undefined;
  /** The normal pool, for finding the object. */
  readonly pool: pg.Pool;
  readonly deletion: DeletionDeps | undefined;
  readonly allowed: (req: FastifyRequest) => boolean;
}

export function registerDeletionRoutes(r: DeletionRouteDeps): void {
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);

  const ready = (req: FastifyRequest, reply: FastifyReply): DeletionDeps | null => {
    if (!r.allowed(req)) {
      sendError(reply, 403, 'forbidden', 'scope delete is needed');
      return null;
    }
    if (!r.deletion) {
      fail(
        reply,
        coreError('unavailable', 'deletion_unavailable: no deletion login is configured'),
      );
      return null;
    }
    return r.deletion;
  };

  /** The PDP decides about the person; `null` when refused (and answered). */
  const decide = async (
    reply: FastifyReply,
    principal: string,
    kind: DeletionKind,
    resource: PdpResource,
    reason: string | null,
  ): Promise<{ override: boolean } | null> => {
    if (!r.pdp) {
      fail(reply, coreError('unavailable', 'no policy decision point is configured'));
      return null;
    }
    const d = await r.pdp.decide({
      principal,
      action: DELETION_ACTIONS[kind],
      resource,
      ...(reason ? { justification: reason } : {}),
    });
    if (d.decision !== 'allow') {
      reply.code(403).send({
        error: {
          code: 'forbidden',
          message: `${DELETION_ACTIONS[kind]} denied`,
          reasons: d.reasons,
        },
      });
      return null;
    }
    return { override: isAdminOverride(d) };
  };

  r.app.post('/v1/deletions/preview', async (req, reply) => {
    const deps = ready(req, reply);
    if (!deps) return;
    const body = DeletionPreviewRequest.safeParse(req.body ?? {});
    if (!body.success) return fail(reply, coreError('invalid_input', body.error.message));
    const target = await resolveTarget(r.pool, body.data.kind, body.data.id);
    if (!target.ok) return fail(reply, target.error);
    // A preview is asked like the delete itself, without a reason; not logged (a probe, not an act).
    if (!r.pdp)
      return fail(reply, coreError('unavailable', 'no policy decision point is configured'));
    const d = await r.pdp.decide(
      {
        principal: body.data.on_behalf_of,
        action: DELETION_ACTIONS[body.data.kind],
        resource: target.value.resource,
      },
      { log: false },
    );
    if (d.decision !== 'allow') {
      return reply.code(403).send({
        error: {
          code: 'forbidden',
          message: `${DELETION_ACTIONS[body.data.kind]} denied`,
          reasons: d.reasons,
        },
      });
    }
    try {
      return await inPurgeSnapshot(deps.purgePool, (c) =>
        previewDeletion(c, target.value, body.data.id),
      );
    } catch (e) {
      return fail(
        reply,
        coreError(
          'unavailable',
          `deletion_unavailable: ${e instanceof Error ? e.message : String(e)}`,
        ),
      );
    }
  });

  for (const kind of DeletionKindValues) {
    r.app.delete(`/v1/${DELETION_ROUTES[kind]}/:id`, async (req, reply) => {
      const deps = ready(req, reply);
      if (!deps) return;
      const id = decodeURIComponent((req.params as { id: string }).id);
      const body = DeletionRequest.safeParse(req.body ?? {});
      if (!body.success) return fail(reply, coreError('invalid_input', body.error.message));
      if (body.data.confirm !== id) {
        return fail(reply, coreError('invalid_input', 'confirm must be the id of what is deleted'));
      }
      const target = await resolveTarget(r.pool, kind, id);
      if (!target.ok) return fail(reply, target.error);
      const lower = body.data.reason.toLowerCase();
      if (target.value.spec.roots.some((x) => lower.includes(x.toLowerCase()))) {
        return fail(
          reply,
          coreError(
            'invalid_input',
            'the reason may not name what is deleted (it is kept on the record)',
          ),
        );
      }
      const allowed = await decide(
        reply,
        body.data.on_behalf_of,
        kind,
        target.value.resource,
        body.data.reason,
      );
      if (!allowed) return;
      const done = await performDeletion(deps, {
        target: target.value,
        actor: body.data.on_behalf_of,
        reason: body.data.reason,
        override: allowed.override,
      });
      if (!done.ok) return fail(reply, done.error);
      return reply.code(200).send(
        DeletionResult.parse({
          deletion_id: done.value.deletion_id,
          kind,
          counts: done.value.counts,
          objects_purged: done.value.objects_purged,
          ledger_entry_id: done.value.ledger_entry_id,
        }),
      );
    });
  }
}

/** A read-only snapshot as the purge role (it alone can read every schema the deletion sweeps). */
async function inPurgeSnapshot<T>(pool: pg.Pool, fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    await c.query('SET LOCAL ROLE aisdlc_purge');
    return await fn(c);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}
