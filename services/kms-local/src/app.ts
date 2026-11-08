import { b64urlDecode, b64urlEncode } from '@aisdlc/kernel';
import {
  KMS_STATUS,
  KmsHmacRequest,
  KmsSignRequest,
  type KeyCustodyErrorKind,
} from '@aisdlc/ports';
import type { ServiceAuth } from '@aisdlc/service-kit';
import { ServiceConfigError, newApp, sendError } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { KEY_REGISTRY, loadOrCreateKeys, type HeldKey } from './keys.js';

export interface KmsAppOptions {
  /** The volume directory holding key material. */
  dir: string;
  /** `FACTORY_ENV`. `dev:` keys are served only when this is exactly `local`. */
  factoryEnv: string | undefined;
  auth: ServiceAuth;
  /** caller name -> key ids it may sign or MAC with. */
  allow: Record<string, readonly string[]>;
}

const isDev = (keyId: string): boolean => keyId.startsWith('dev:');

/**
 * kms-local: ES256 signing of 32-byte digests and HMAC-SHA-256 by key id, over HTTP. Private keys
 * and the HMAC key never leave the process. This is the stand-in for AWS KMS (PLAN M2.2).
 */
export function createKmsApp(opts: KmsAppOptions): FastifyInstance {
  for (const [caller, keys] of Object.entries(opts.allow)) {
    for (const k of keys) {
      if (!(k in KEY_REGISTRY))
        throw new ServiceConfigError(`caller ${caller} allows unknown key ${k}`);
    }
  }
  const local = opts.factoryEnv === 'local';
  // Outside local mode no key is read or created at all.
  const keys: Map<string, HeldKey> = local ? loadOrCreateKeys(opts.dir) : new Map();
  const app = newApp();

  app.get('/healthz', async () => ({ ok: true, env: local ? 'local' : 'refused' }));

  const fail = (reply: FastifyReply, kind: KeyCustodyErrorKind, message: string) =>
    sendError(reply, KMS_STATUS[kind], kind, message);

  // Authenticate before the body is read.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/v1/')) return;
    const caller = opts.auth.authenticate(req.headers.authorization);
    if (caller === null) return fail(reply, 'unauthenticated', 'missing or unknown service token');
    (req as unknown as { caller: string }).caller = caller;
  });

  app.addHook('preHandler', async (req, reply) => {
    const keyId = (req.params as { keyId?: string }).keyId;
    if (keyId !== undefined && isDev(keyId) && !local) {
      return fail(reply, 'dev_key_refused', 'dev: keys are served only when FACTORY_ENV=local');
    }
  });

  const authorise = (req: unknown, keyId: string): boolean =>
    (opts.allow[(req as { caller: string }).caller] ?? []).includes(keyId);

  app.get<{ Params: { keyId: string } }>('/v1/keys/:keyId/public', async (req, reply) => {
    // A public key is public: any authenticated caller may read any registered one.
    const k = keys.get(req.params.keyId);
    if (!k) return fail(reply, 'unknown_key', 'unknown key');
    if (k.kind !== 'es256' || !k.publicJwk)
      return fail(reply, 'wrong_key_type', 'not an ES256 key');
    return k.publicJwk;
  });

  app.post<{ Params: { keyId: string } }>('/v1/keys/:keyId/sign', async (req, reply) => {
    if (!authorise(req, req.params.keyId))
      return fail(reply, 'forbidden', 'caller may not use this key');
    const k = keys.get(req.params.keyId);
    if (!k) return fail(reply, 'unknown_key', 'unknown key');
    if (k.kind !== 'es256' || !k.sign) return fail(reply, 'wrong_key_type', 'not an ES256 key');
    const body = KmsSignRequest.safeParse(req.body);
    if (!body.success) return fail(reply, 'invalid_request', 'digest must be 32 bytes, base64url');
    const digest = b64urlDecode(body.data.digest);
    if (digest.length !== 32) return fail(reply, 'invalid_request', 'digest must be 32 bytes');
    return { signature: b64urlEncode(k.sign(digest)) };
  });

  app.post<{ Params: { keyId: string } }>('/v1/keys/:keyId/hmac', async (req, reply) => {
    if (!authorise(req, req.params.keyId))
      return fail(reply, 'forbidden', 'caller may not use this key');
    const k = keys.get(req.params.keyId);
    if (!k) return fail(reply, 'unknown_key', 'unknown key');
    if (k.kind !== 'hmac' || !k.hmac) return fail(reply, 'wrong_key_type', 'not an HMAC key');
    const body = KmsHmacRequest.safeParse(req.body);
    if (!body.success) return fail(reply, 'invalid_request', 'data must be base64url');
    return { mac: k.hmac(b64urlDecode(body.data.data)) };
  });

  return app;
}
