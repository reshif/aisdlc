import {
  SecretList,
  SecretName,
  SecretPutRequest,
  SecretWriteResult,
  pdpResource,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { CoreClient } from './core-client.js';

// The portal's write-only secret fields (portal v2 N15, gap G1):
//
//   GET    /api/secrets         every secret name with its metadata (set, version, when, by whom); never a value
//   PUT    /api/secrets/:name   {value}: stored in the secret store (Vault) through core, answered with metadata only
//   DELETE /api/secrets/:name   every version destroyed
//
// All three are `config.propose` on the fleet (a factory admin always has it); core asks the PDP again. The value
// travels browser -> bff -> core once, inside the session's TLS in production, and is held here only for the length
// of the call: it is never logged (the bff's fastify has no logger), never put in an error, never echoed, and the
// browser gets back {name, version, updated_at}. A refusal names the field, not what it held.

export interface SecretRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly core: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

export function registerSecretRoutes(d: SecretRouteDeps): void {
  const { app } = d;

  async function mayWrite(principal: string): Promise<boolean> {
    try {
      const out = await d.pdp.decide({
        principal,
        action: 'config.propose',
        resource: pdpResource.fleet(),
      });
      return out.decision === 'allow';
    } catch {
      return false;
    }
  }

  function core(reply: FastifyReply): CoreClient | null {
    if (!d.core) {
      sendError(reply, 503, 'unavailable', 'the factory core is not configured');
      return null;
    }
    return d.core;
  }

  /** Core's answer, or the error the browser gets; core's own message never holds a value (core's rule). */
  function upstream<T>(reply: FastifyReply, r: CallResult, parse: (v: unknown) => T): T | null {
    if (!r.reached) {
      sendError(reply, 502, 'core_unavailable', 'the factory core could not be reached');
      return null;
    }
    if (r.status >= 200 && r.status < 300) {
      try {
        return parse(r.json);
      } catch {
        sendError(reply, 502, 'core_error', 'the factory core sent something unexpected');
        return null;
      }
    }
    const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    sendError(
      reply,
      r.status >= 500 && r.status !== 503 ? 502 : r.status,
      typeof e?.code === 'string' ? e.code : 'refused',
      typeof e?.message === 'string' ? e.message : 'the request was refused',
    );
    return null;
  }

  const nameOf = (req: FastifyRequest, reply: FastifyReply): SecretName | null => {
    const n = SecretName.safeParse((req.params as { name?: string }).name);
    if (!n.success) {
      sendError(reply, 404, 'not_found', 'no such secret');
      return null;
    }
    return n.data;
  };

  app.get('/api/secrets', async (req, reply) => {
    const c = core(reply);
    if (!c) return;
    const who = d.principalOf(req);
    if (!(await mayWrite(who))) return sendError(reply, 403, 'forbidden', 'config.propose denied');
    const r = await c.call('GET', `/v1/secrets?on_behalf_of=${encodeURIComponent(who)}`);
    const got = upstream(reply, r, (v) => SecretList.parse(v));
    if (got) return got;
  });

  app.put('/api/secrets/:name', async (req, reply) => {
    const c = core(reply);
    const name = c ? nameOf(req, reply) : null;
    if (!c || !name) return;
    const body = SecretPutRequest.safeParse(req.body ?? {});
    if (!body.success) {
      return sendError(reply, 400, 'invalid_input', 'the body is {value}: a non-empty string');
    }
    const who = d.principalOf(req);
    if (!(await mayWrite(who))) return sendError(reply, 403, 'forbidden', 'config.propose denied');
    const r = await c.call('PUT', `/v1/secrets/${name}`, {
      value: body.data.value,
      on_behalf_of: who,
    });
    const got = upstream(reply, r, (v) => SecretWriteResult.parse(v));
    if (got) return got;
  });

  app.delete('/api/secrets/:name', async (req, reply) => {
    const c = core(reply);
    const name = c ? nameOf(req, reply) : null;
    if (!c || !name) return;
    const who = d.principalOf(req);
    if (!(await mayWrite(who))) return sendError(reply, 403, 'forbidden', 'config.propose denied');
    const r = await c.call('DELETE', `/v1/secrets/${name}`, { on_behalf_of: who });
    const got = upstream(reply, r, (v) => SecretWriteResult.parse(v));
    if (got) return got;
  });
}
