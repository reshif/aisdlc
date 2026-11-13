import { AdminOverrideReason, OVERRIDE_REASON_HEADER } from '@aisdlc/contracts';
import type { OverrideInput } from '@aisdlc/decisions';
import type { FastifyRequest } from 'fastify';

// The factory admin's override as it reaches core (docs/specs/deletion.md §8): its reason in the
// `x-aisdlc-override-reason` header (URI-encoded), forwarded by the bff from the portal. One way for every route: the
// guard needs it when the PDP's allow is the override, and a decide route hands it to the decision kernel.

/** The reason from the header; absent, blank or malformed: none. */
export function overrideOf(req: Pick<FastifyRequest, 'headers'>): OverrideInput | undefined {
  const h = req.headers[OVERRIDE_REASON_HEADER];
  if (typeof h !== 'string') return undefined;
  let text: string;
  try {
    text = decodeURIComponent(h);
  } catch {
    return undefined;
  }
  const r = AdminOverrideReason.safeParse(text);
  return r.success ? { reason: r.data } : undefined;
}
