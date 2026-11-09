import { PushLeaseFacts } from '@aisdlc/contracts';
import type { CodeHostRead } from '@aisdlc/contracts';
import { readOk, readUnknown, readUnreadable, type PushGuardsPort } from '@aisdlc/ports';
import { z } from 'zod';

// The Push Broker's questions to the Unit's owner (PLAN M13.6): core owns the lease epoch (DM gap 14) and the ledger, so it
// answers whether the Unit's lease is held at which epoch (and the item's lane), and whether an approved X2 decision is
// bound to a patch hash. Over HTTP with the codehost's own service token (scope `push_guard`). A garbled or missing answer is
// `unknown`, which refuses: the broker never guesses a lease or an approval.

export interface HttpPushGuardsOptions {
  readonly baseUrl: string;
  readonly token: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

export class HttpPushGuards implements PushGuardsPort {
  constructor(private readonly o: HttpPushGuardsOptions) {}

  private async get<S extends z.ZodType>(
    path: string,
    value: S,
  ): Promise<CodeHostRead<z.infer<S>>> {
    let res: Response;
    try {
      res = await (this.o.fetchImpl ?? fetch)(new URL(path, this.o.baseUrl), {
        headers: { authorization: `Bearer ${this.o.token}` },
        signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000),
      });
    } catch {
      return readUnknown('network', 'the Unit owner did not answer');
    }
    if (res.status === 401 || res.status === 403) {
      return readUnreadable('forbidden', `the Unit owner refused the question with ${res.status}`);
    }
    if (res.status === 404)
      return readUnreadable('not_found', 'the Unit owner does not know this Unit');
    if (res.status < 200 || res.status >= 300) {
      return readUnknown('server_error', `the Unit owner answered ${res.status}`);
    }
    let json: unknown;
    try {
      json = await res.json();
    } catch {
      return readUnknown('malformed', 'the Unit owner answered without JSON');
    }
    const p = value.safeParse(json);
    return p.success
      ? readOk(p.data as z.infer<S>)
      : readUnknown('malformed', 'the Unit owner answered with an unexpected shape');
  }

  lease(item_id: string, unit_key: string): Promise<CodeHostRead<PushLeaseFacts>> {
    return this.get(
      `/v1/push-guards/${encodeURIComponent(item_id)}/units/${encodeURIComponent(unit_key)}/lease`,
      PushLeaseFacts,
    );
  }

  async x2Bound(item_id: string, patch_hash: string): Promise<CodeHostRead<boolean>> {
    const r = await this.get(
      `/v1/push-guards/${encodeURIComponent(item_id)}/x2?patch_hash=${encodeURIComponent(patch_hash)}`,
      z.strictObject({ bound: z.boolean() }),
    );
    return r.state === 'ok' ? readOk(r.value.bound) : r;
  }
}
