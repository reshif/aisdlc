import { AsyncLocalStorage } from 'node:async_hooks';
import { AdminOverrideReason, OVERRIDE_REASON_HEADER } from '@aisdlc/contracts';
import type { FastifyInstance } from 'fastify';

// The factory admin's override reason through the bff (docs/specs/deletion.md §8). The portal sends it with the act
// in `x-aisdlc-override-reason` (URI-encoded); the bff carries it, unchanged, on every call it makes to core while it
// serves that request, the way it carries the trace context. The bff decides nothing with it: core's guard asks for
// it when the PDP's allow is the override, and the decision kernel checks that the person is a factory admin.

const current = new AsyncLocalStorage<string>();

/** The headers to add to an upstream call: the reason of the request being served, if it gave one. */
export function overrideHeaders(): Record<string, string> {
  const r = current.getStore();
  return r === undefined ? {} : { [OVERRIDE_REASON_HEADER]: encodeURIComponent(r) };
}

/** Each `/api/` request runs with the reason it carries (a blank or malformed one is dropped, never guessed). */
export function carryOverride(app: FastifyInstance): void {
  app.addHook('onRequest', (req, _reply, done) => {
    const h = req.headers[OVERRIDE_REASON_HEADER];
    if (!req.url.startsWith('/api/') || typeof h !== 'string') return done();
    let text: string;
    try {
      text = decodeURIComponent(h);
    } catch {
      return done();
    }
    const r = AdminOverrideReason.safeParse(text);
    if (!r.success) return done();
    current.run(r.data, done);
  });
}
