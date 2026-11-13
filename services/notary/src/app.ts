import {
  NOTARY_STATUS,
  NotaryAuditExportSignRequest,
  NotaryCheckpointRequest,
  NotaryConfirmRequest,
  NotaryEvidenceSignRequest,
  NotaryReserveRequest,
  NotarySignRequest,
  NotaryVerifyRequest,
  NotaryRedactRequest,
  type JournalRedactorPort,
  type NotaryError,
  type AuditExportSignerPort,
  type EvidenceSignerPort,
  type NotaryErrorCode,
  type NotaryPort,
} from '@aisdlc/ports';
import type { LedgerEntry, LedgerEntryDraft } from '@aisdlc/contracts';
import type { ServiceAuth } from '@aisdlc/service-kit';
import { newApp, sendError } from '@aisdlc/service-kit';
import type { Result } from '@aisdlc/kernel';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

/**
 * What a caller may do: `ledger` (reserve, sign, confirm, unconfirmed), `checkpoint`, `read` (verify), `evidence`
 * (sign an Evidence Pack id, PLAN M14.4), `audit_export` (sign an audit export id, PLAN M19).
 */
export type NotaryScope = 'ledger' | 'checkpoint' | 'read' | 'evidence' | 'audit_export';

export interface NotaryAppOptions {
  service: NotaryPort & EvidenceSignerPort & AuditExportSignerPort & JournalRedactorPort;
  auth: ServiceAuth;
  /** caller name -> scopes. A caller with no entry may do nothing. */
  callers: Record<string, readonly NotaryScope[]>;
}

/** HTTP in front of a `NotaryPort` (the `NotaryService`). Every route needs a service token. */
export function createNotaryApp(opts: NotaryAppOptions): FastifyInstance {
  const app = newApp();
  app.get('/healthz', async () => ({ ok: true }));

  const fail = (reply: FastifyReply, code: NotaryErrorCode, message: string) =>
    sendError(reply, NOTARY_STATUS[code], code, message);

  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = opts.auth.authenticate(req.headers.authorization);
    if (caller === null) return fail(reply, 'unauthenticated', 'missing or unknown service token');
    (req as unknown as { caller: string }).caller = caller;
  });

  /** A route that needs `scope`, validates its body with `schema`, and calls the port. */
  function route<S extends z.ZodType, T>(
    method: 'get' | 'post',
    path: string,
    scope: NotaryScope,
    schema: S | null,
    run: (body: z.infer<S>) => Promise<Result<T, NotaryError>>,
    render: (value: T) => unknown,
  ): void {
    app[method](path, async (req: FastifyRequest, reply: FastifyReply) => {
      const caller = (req as unknown as { caller: string }).caller;
      if (!(opts.callers[caller] ?? []).includes(scope)) {
        return fail(reply, 'forbidden', `caller may not use scope ${scope}`);
      }
      let body = undefined as z.infer<S>;
      if (schema) {
        const p = schema.safeParse(req.body);
        if (!p.success) return fail(reply, 'invalid_request', p.error.message);
        body = p.data;
      }
      const r = await run(body);
      if (!r.ok) return fail(reply, r.error.code, r.error.message);
      return render(r.value);
    });
  }

  route(
    'post',
    '/v1/reserve',
    'ledger',
    NotaryReserveRequest,
    (b) => opts.service.reserve(b),
    (v) => v,
  );
  route(
    'post',
    '/v1/sign',
    'ledger',
    NotarySignRequest,
    // `draft` is validated by the service itself (`invalid_entry`).
    (b) => opts.service.sign({ ledger_seq: b.ledger_seq, draft: b.draft as LedgerEntryDraft }),
    (v) => v,
  );
  route(
    'post',
    '/v1/confirm',
    'ledger',
    NotaryConfirmRequest,
    (b) => opts.service.confirm(b),
    () => ({ ok: true }),
  );
  route(
    'get',
    '/v1/unconfirmed',
    'ledger',
    null,
    () => opts.service.unconfirmed(),
    (entries) => ({
      entries,
    }),
  );
  route(
    'post',
    '/v1/checkpoint',
    'checkpoint',
    NotaryCheckpointRequest,
    (b) => opts.service.signCheckpoint(b),
    (v) => v,
  );
  route(
    'post',
    '/v1/verify',
    'read',
    NotaryVerifyRequest,
    // An entry that is not even shaped like one is refused by the service as `invalid_entry`.
    (b) => opts.service.verify(b.entry as LedgerEntry),
    () => ({ valid: true }),
  );
  route(
    'post',
    '/v1/journal/redact',
    'ledger',
    NotaryRedactRequest,
    (b) => opts.service.redactJournal(b.entry as LedgerEntry),
    (v) => v,
  );
  route(
    'post',
    '/v1/evidence/sign',
    'evidence',
    NotaryEvidenceSignRequest,
    (b) => opts.service.signEvidencePack(b),
    (signature) => ({ signature }),
  );
  route(
    'post',
    '/v1/audit-export/sign',
    'audit_export',
    NotaryAuditExportSignRequest,
    (b) => opts.service.signAuditExport(b),
    (signature) => ({ signature }),
  );
  return app;
}
