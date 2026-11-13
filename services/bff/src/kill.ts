import type { KillActPrepared } from '@aisdlc/contracts';
import {
  ActiveKillsView,
  KillRecord,
  PortalKillPrepareRequest,
  PortalKillReleaseRequest,
  PortalKillRequest,
  killActHash,
  killScopeResource,
  pdpResource,
  type ActionId,
  type KillAct,
  type PdpResource,
} from '@aisdlc/contracts';
import type { Pdp } from '@aisdlc/pdp';
import { decodeStepUpToken } from '@aisdlc/ports';
import { sendError, type CallResult } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { CoreClient } from './core-client.js';

// The kill switch in the portal (RC-UI-1; docs/specs/killswitch-api.md). The bff is a process that carries a person's
// act: it asks the PDP for the signed-in person (the same `kill.request` / `kill.release` on the scope's resource the
// kill switch asks), has the person step up for exactly the act's hash (`POST /api/step-up` with the hash
// `prepare` returned, a re-authentication at the identity provider), and forwards the act with that proof. The kill
// switch verifies the proof itself and takes the actor from it, never from this service's token; the bff also
// refuses a proof that is not the session's own or not bound to exactly this act, so it never carries someone else's.
//
//   GET  /api/kills/active                    the kills that still kill, and what this person may do  (ops.read)
//   POST /api/kills/prepare      {scope, reason}                   the hash to step up for       (kill.request)
//   POST /api/kills              {scope, reason, step_up: {proof}} request the kill              (kill.request)
//   POST /api/kills/:id/release/prepare                            the hash to step up for       (kill.release)
//   POST /api/kills/:id/release  {step_up: {proof}}                approve the release           (kill.release)
//
// A release needs the approvals of as many DISTINCT people as the kill says (two where two-person applies): each
// approves in their own session with their own step-up.

export interface KillRouteDeps {
  readonly app: FastifyInstance;
  readonly pdp: Pdp;
  readonly killswitch: CoreClient | undefined;
  readonly principalOf: (req: FastifyRequest) => string;
}

const KillId = z.uuid();

export function registerKillRoutes(d: KillRouteDeps): void {
  const { app } = d;

  async function allowed(principal: string, action: ActionId, resource: PdpResource) {
    try {
      return (await d.pdp.decide({ principal, action, resource })).decision === 'allow';
    } catch {
      return false;
    }
  }

  const ks = (reply: FastifyReply): CoreClient | null => {
    if (d.killswitch) return d.killswitch;
    sendError(reply, 503, 'killswitch_not_configured', 'the bff has no route to the kill switch');
    return null;
  };

  /** `proofSent`: the call carried the person's proof, so a 401 is the proof's (else the service token's). */
  function upstream<T>(
    reply: FastifyReply,
    r: CallResult,
    parse: (v: unknown) => T,
    proofSent = false,
  ): T | null {
    if (!r.reached || r.status >= 500) {
      sendError(reply, 502, 'killswitch_unavailable', 'the kill switch could not answer');
      return null;
    }
    if (r.status < 200 || r.status >= 300) {
      const e = (r.json as { error?: { code?: unknown; message?: unknown } } | null)?.error;
      // the kill switch's refusal is said as it is (a forbidden act, a used proof, a second approval by the same
      // person), except that a refused service token is the deployment's fault, not the person's
      const tokenRefused = r.status === 401 && e?.code === 'unauthenticated' && !proofSent;
      sendError(
        reply,
        tokenRefused ? 502 : r.status,
        typeof e?.code === 'string' ? e.code : 'refused',
        typeof e?.message === 'string' ? e.message : 'the kill switch refused',
      );
      return null;
    }
    try {
      return parse(r.json);
    } catch {
      sendError(reply, 502, 'killswitch_error', 'the kill switch sent something unexpected');
      return null;
    }
  }

  /** The proof is the session's own and bound to exactly `act`; else the reply is sent and `false`. */
  function ownProof(reply: FastifyReply, who: string, proof: string, act: KillAct): boolean {
    const t = decodeStepUpToken(proof);
    if (t === null || t.claims.principal !== who || t.claims.bound_hash !== killActHash(act)) {
      sendError(
        reply,
        401,
        'step_up_mismatch',
        'the step-up is not yours or not for this act: confirm your identity for it again',
      );
      return false;
    }
    return true;
  }

  const deny = (reply: FastifyReply, action: string) =>
    sendError(reply, 403, 'forbidden', `${action} denied`);

  async function killOf(c: CoreClient, id: string): Promise<KillRecord | null> {
    const r = await c.call('GET', '/v1/kills');
    if (!r.reached || r.status !== 200) return null;
    const list = z.array(KillRecord).safeParse(r.json);
    return list.success ? (list.data.find((k) => k.kill_id === id) ?? null) : null;
  }

  app.get('/api/kills/active', async (req, reply) => {
    const c = ks(reply);
    if (!c) return;
    const who = d.principalOf(req);
    if (!(await allowed(who, 'ops.read', pdpResource.fleet()))) return deny(reply, 'ops.read');
    const list = upstream(reply, await c.call('GET', '/v1/kills?active=1'), (v) =>
      z.array(KillRecord).parse(v),
    );
    if (!list) return;
    const out: ActiveKillsView = { kills: [] };
    for (const k of list) {
      out.kills.push({
        ...k,
        may_release: await allowed(who, 'kill.release', killScopeResource(k.scope)),
        approved_by_me: k.release_approvals.includes(who as never),
      });
    }
    return ActiveKillsView.parse(out);
  });

  app.post('/api/kills/prepare', async (req, reply) => {
    const b = PortalKillPrepareRequest.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    if (!(await allowed(d.principalOf(req), 'kill.request', killScopeResource(b.data.scope))))
      return deny(reply, 'kill.request');
    const prepared: KillActPrepared = {
      bound_hash: killActHash({
        action: 'kill.request',
        scope: b.data.scope,
        reason: b.data.reason,
      }) as never,
    };
    return prepared;
  });

  app.post('/api/kills', async (req, reply) => {
    const c = ks(reply);
    if (!c) return;
    const b = PortalKillRequest.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    const who = d.principalOf(req);
    if (!(await allowed(who, 'kill.request', killScopeResource(b.data.scope))))
      return deny(reply, 'kill.request');
    const act: KillAct = { action: 'kill.request', scope: b.data.scope, reason: b.data.reason };
    if (!ownProof(reply, who, b.data.step_up.proof, act)) return;
    const k = upstream(
      reply,
      await c.call('POST', '/v1/kills', {
        step_up: b.data.step_up,
        scope: b.data.scope,
        reason: b.data.reason,
      }),
      (v) => KillRecord.parse(v),
      true,
    );
    if (!k) return;
    return reply.code(201).send(k);
  });

  async function releasable(
    req: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ c: CoreClient; id: string; who: string } | null> {
    const c = ks(reply);
    if (!c) return null;
    const id = KillId.safeParse((req.params as { id?: string }).id);
    if (!id.success) {
      sendError(reply, 404, 'not_found', 'no such kill');
      return null;
    }
    const k = await killOf(c, id.data);
    if (!k) {
      sendError(reply, 404, 'not_found', 'no such kill');
      return null;
    }
    const who = d.principalOf(req);
    if (!(await allowed(who, 'kill.release', killScopeResource(k.scope)))) {
      deny(reply, 'kill.release');
      return null;
    }
    return { c, id: id.data, who };
  }

  app.post('/api/kills/:id/release/prepare', async (req, reply) => {
    const r = await releasable(req, reply);
    if (!r) return;
    const prepared: KillActPrepared = {
      bound_hash: killActHash({ action: 'kill.release', kill_id: r.id }) as never,
    };
    return prepared;
  });

  app.post('/api/kills/:id/release', async (req, reply) => {
    const b = PortalKillReleaseRequest.safeParse(req.body ?? {});
    if (!b.success) return sendError(reply, 400, 'invalid_input', b.error.message);
    const r = await releasable(req, reply);
    if (!r) return;
    if (!ownProof(reply, r.who, b.data.step_up.proof, { action: 'kill.release', kill_id: r.id }))
      return;
    return upstream(
      reply,
      await r.c.call('POST', `/v1/kills/${r.id}/release`, { step_up: b.data.step_up }),
      (v) => KillRecord.parse(v),
      true,
    );
  });
}
