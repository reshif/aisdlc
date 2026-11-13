import {
  AuditResultRequest,
  EscapeReportRequest,
  FACTORY_PROJECT_ID,
  LearnRunRequest,
  ModeELiftRequest,
  PrincipalId,
  ProjectId,
  RevisionDecideRequest,
  RevisionEvidenceRequest,
  RevisionPrepareRequest,
  ReviewerUnsureRequest,
  pdpResource,
  type ActionId,
  type PdpResource,
} from '@aisdlc/contracts';
import type { ConfigDeps } from '@aisdlc/config';
import { readGateState } from '@aisdlc/decisions';
import type { Result } from '@aisdlc/kernel';
import { sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type pg from 'pg';
import { z } from 'zod';
import { listAuditSamples, recordAuditResult } from './closeout/audit.js';
import { projectLearnView, requestModeELift, runLearn } from './closeout/learn.js';
import { listEscapes, readCloseOut, reportEscape } from './closeout/record.js';
import { CORE_STATUS, coreError, type CoreError } from './errors.js';
import { factoryRevisionView } from './factory-m1.js';
import type { CoreDeps } from './journal.js';
import { decideRevision, prepareRevision, recordRevisionEvidence } from './portal-reads.js';
import { overrideOf } from './override.js';
import { reviewerUnsure } from './review/g4.js';
import { readItem } from './work-items.js';

// M15.5's routes, for the bff acting for a signed-in person (`on_behalf_of`). Each asks the PDP for its action first
// (fail closed: no PDP, an error or anything but `allow` is a refusal), then the function, which checks the rest
// (slots, the requester and approver bars, the state of the item).
//
//   POST /v1/items/:id/review/unsure       B14, the mode-E approver is unsure        (scope work, item.unsure)
//   POST /v1/items/:id/escape              B17, an escape after the merge             (scope work, item.escape)
//   GET  /v1/items/:id/closeout?on_behalf_of=  9.3 record, escapes, its audit         (scope work, closeout.read)
//   POST /v1/items/:id/audit               9.5 the audit of a drawn mode-E merge      (scope work, audit.record)
//   GET  /v1/projects/:id/learn?on_behalf_of=  9.4 proposals, earned autonomy, B19     (scope work, audit.read)
//   POST /v1/projects/:id/learn/run        9.4 now: settle from the ledger, propose  (scope work, learn.propose)
//   POST /v1/projects/:id/learn/mode-e-lift  ask for B19's lift: an M5                (scope work, learn.propose)
//   GET  /v1/config/revisions/:gate        a factory revision as something to decide (scope read)
//   POST /v1/config/revisions/:gate/prepare|evidence|decide                          (scope portal, config.decide)
//
// The RELHOLD re-request (G5 again) is `POST /v1/items/:id/release/re-request` (M15.3, `item.release`).

export interface GovernanceRouteDeps {
  readonly app: FastifyInstance;
  readonly pool: pg.Pool;
  readonly deps: CoreDeps;
  readonly config: ConfigDeps | undefined;
  readonly allowed: (req: FastifyRequest, scope: 'work' | 'read' | 'portal') => boolean;
  readonly guard: (
    reply: FastifyReply,
    principal: string,
    action: ActionId,
    resource: PdpResource,
  ) => Promise<boolean>;
}

const Who = z.strictObject({ on_behalf_of: PrincipalId });

export function registerGovernanceRoutes(r: GovernanceRouteDeps): void {
  const { app } = r;
  const fail = (reply: FastifyReply, e: CoreError) =>
    sendError(reply, CORE_STATUS[e.code], e.code, e.message);
  const send = (reply: FastifyReply, x: Result<unknown, CoreError>, code = 200) =>
    x.ok ? reply.code(code).send(x.value) : fail(reply, x.error);
  const kernel = (reply: FastifyReply): ConfigDeps | null => {
    if (r.config) return r.config;
    fail(reply, coreError('unavailable', 'no decision kernel is configured'));
    return null;
  };
  const body = <S extends z.ZodType>(reply: FastifyReply, s: S, v: unknown): z.infer<S> | null => {
    const p = s.safeParse(v ?? {});
    if (p.success) return p.data;
    fail(reply, coreError('invalid_input', p.error.message));
    return null;
  };

  /** The item of the route and the PDP's yes for the person on it, or the refusal sent. */
  async function itemGuard(
    req: FastifyRequest,
    reply: FastifyReply,
    who: string,
    action: ActionId,
  ) {
    const id = (req.params as { id?: string }).id;
    if (!z.uuid().safeParse(id).success) {
      fail(reply, coreError('invalid_input', 'bad id'));
      return null;
    }
    let item;
    try {
      item = await readItem(r.pool, id as string);
    } catch {
      fail(reply, coreError('unavailable', 'the item could not be read'));
      return null;
    }
    if (!item) {
      fail(reply, coreError('not_found', 'no such item'));
      return null;
    }
    const s = item.state;
    const res = pdpResource.item(s.project_id, s.item_id, s.lane ?? s.proposed_lane);
    if (!(await r.guard(reply, who, action, res))) return null;
    return { id: id as string, state: s };
  }
  const projectOf = (req: FastifyRequest, reply: FastifyReply): ProjectId | null => {
    const p = ProjectId.safeParse((req.params as { id?: string }).id);
    if (p.success) return p.data;
    fail(reply, coreError('invalid_input', 'bad project id'));
    return null;
  };

  // ------------------------------------------------------------ B14, B17, 9.3, 9.5

  app.post('/v1/items/:id/review/unsure', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = body(reply, ReviewerUnsureRequest, req.body);
    if (!b) return;
    const it = await itemGuard(req, reply, b.on_behalf_of, 'item.unsure');
    const k = it ? kernel(reply) : null;
    if (!it || !k) return;
    return send(
      reply,
      await reviewerUnsure({ ...r.deps, decisions: k }, it.id, b.on_behalf_of, b.key),
    );
  });

  app.post('/v1/items/:id/escape', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = body(reply, EscapeReportRequest, req.body);
    if (!b) return;
    const it = await itemGuard(req, reply, b.on_behalf_of, 'item.escape');
    if (!it) return;
    return send(
      reply,
      await reportEscape(r.deps, {
        item_id: it.id,
        by: b.on_behalf_of,
        lane: b.lane,
        reason_code: b.reason_code,
        key: b.key,
      }),
    );
  });

  app.get('/v1/items/:id/closeout', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const q = body(reply, Who, req.query);
    if (!q) return;
    const it = await itemGuard(req, reply, q.on_behalf_of, 'closeout.read');
    if (!it) return;
    const c = await readCloseOut(r.pool, it.id);
    if (!c) return fail(reply, coreError('not_found', 'the item has no close-out record'));
    const audit = (await listAuditSamples(r.pool, c.project_id)).find((x) => x.item_id === it.id);
    return {
      closeout_sha256: c.closeout_sha256,
      record: c.record,
      escapes: await listEscapes(r.pool, it.id),
      audit: audit
        ? { sampled: audit.sampled, outcome: audit.outcome, audited_by: audit.audited_by }
        : null,
    };
  });

  app.post('/v1/items/:id/audit', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = body(reply, AuditResultRequest, req.body);
    if (!b) return;
    const it = await itemGuard(req, reply, b.on_behalf_of, 'audit.record');
    const k = it ? kernel(reply) : null;
    if (!it || !k) return;
    return send(
      reply,
      await recordAuditResult(
        { ...r.deps, ledger: k.ledger, decisions: k },
        { item_id: it.id, by: b.on_behalf_of, outcome: b.outcome, reason_code: b.reason_code },
      ),
    );
  });

  // ------------------------------------------------------------ 9.4 Learn and the META gates

  app.get('/v1/projects/:id/learn', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const q = body(reply, Who, req.query);
    const p = q ? projectOf(req, reply) : null;
    if (!q || !p) return;
    if (!(await r.guard(reply, q.on_behalf_of, 'audit.read', pdpResource.project(p)))) return;
    return projectLearnView(r.pool, p);
  });

  app.post('/v1/projects/:id/learn/run', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = body(reply, LearnRunRequest, req.body);
    const p = b ? projectOf(req, reply) : null;
    if (!b || !p) return;
    if (!(await r.guard(reply, b.on_behalf_of, 'learn.propose', pdpResource.project(p)))) return;
    const k = kernel(reply);
    if (!k) return;
    return send(reply, await runLearn({ ...r.deps, decisions: k }, p));
  });

  app.post('/v1/projects/:id/learn/mode-e-lift', async (req, reply) => {
    if (!r.allowed(req, 'work')) return sendError(reply, 403, 'forbidden', 'scope work is needed');
    const b = body(reply, ModeELiftRequest, req.body);
    const p = b ? projectOf(req, reply) : null;
    if (!b || !p) return;
    if (!(await r.guard(reply, b.on_behalf_of, 'learn.propose', pdpResource.project(p)))) return;
    const k = kernel(reply);
    if (!k) return;
    const x = await requestModeELift({ ...r.deps, decisions: k }, p, b.on_behalf_of);
    return send(reply, x, x.ok && !x.value.duplicate ? 201 : 200);
  });

  // ------------------------------------------------------------ the factory M1 decide path (portal-config gap 2)

  const gateOf = (req: FastifyRequest, reply: FastifyReply): string | null => {
    const g = (req.params as { gate?: string }).gate;
    if (z.uuid().safeParse(g).success) return g as string;
    fail(reply, coreError('invalid_input', 'bad id'));
    return null;
  };

  app.get('/v1/config/revisions/:gate', async (req, reply) => {
    if (!r.allowed(req, 'read')) return sendError(reply, 403, 'forbidden', 'scope read is needed');
    const k = kernel(reply);
    const g = k ? gateOf(req, reply) : null;
    if (!k || !g) return;
    return send(reply, await factoryRevisionView({ pool: r.pool, config: k }, g));
  });

  async function factoryAction<S extends z.ZodType<{ on_behalf_of: string }>>(
    req: FastifyRequest,
    reply: FastifyReply,
    schema: S,
    run: (
      d: { pool: pg.Pool; config: ConfigDeps },
      gate: string,
      b: z.infer<S>,
    ) => Promise<Result<unknown, CoreError>>,
  ) {
    if (!r.allowed(req, 'portal'))
      return sendError(reply, 403, 'forbidden', 'scope portal is needed');
    const k = kernel(reply);
    const g = k ? gateOf(req, reply) : null;
    if (!k || !g) return;
    const b = body(reply, schema, req.body);
    if (!b) return;
    const st = await readGateState(r.pool, g);
    const p = st?.open.payload;
    if (
      !p ||
      p.gate_id !== 'M1' ||
      p.subject_kind !== 'config' ||
      p.project_id !== FACTORY_PROJECT_ID
    ) {
      return fail(reply, coreError('not_found', `no factory revision gate ${g}`));
    }
    if (!(await r.guard(reply, b.on_behalf_of, 'config.decide', pdpResource.fleet()))) return;
    return send(reply, await run({ pool: r.pool, config: k }, g, b));
  }

  app.post('/v1/config/revisions/:gate/prepare', (req, reply) =>
    factoryAction(req, reply, RevisionPrepareRequest, (d, gate, b) =>
      prepareRevision(d, { gate, principal: b.on_behalf_of, override: overrideOf(req) }),
    ),
  );
  app.post('/v1/config/revisions/:gate/evidence', (req, reply) =>
    factoryAction(req, reply, RevisionEvidenceRequest, (d, _g, b) =>
      recordRevisionEvidence(d, { nonce: b.nonce, evidence_hash: b.evidence_hash }),
    ),
  );
  app.post('/v1/config/revisions/:gate/decide', (req, reply) =>
    factoryAction(req, reply, RevisionDecideRequest, (d, _g, b) =>
      decideRevision(d, {
        nonce: b.nonce,
        decision: b.decision,
        step_up: b.step_up,
        override: overrideOf(req),
      }),
    ),
  );
}
