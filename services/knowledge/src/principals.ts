import { PrincipalId, PrincipalKind, PrincipalStatus } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';
import { knowledgeError, type KnowledgeError } from './errors.js';

// Who is acting (OB §5.3 item 6: finding states are human-only). The caller of the state API is a
// service (the bff); the human it acts for is named in the request and checked here against the
// identity service. A principal that is unknown, not active, or a SERVICE principal is refused, and
// so is any answer this code cannot read: an error is a refusal, never an approval.

export interface PrincipalView {
  readonly principal_id: string;
  readonly kind: PrincipalKind;
  readonly status: PrincipalStatus;
}

export interface PrincipalDirectory {
  /** `null`: no such principal. An error: the directory could not say. */
  lookup(id: string): Promise<Result<PrincipalView | null, KnowledgeError>>;
}

const View = z.looseObject({
  principal_id: PrincipalId,
  kind: PrincipalKind,
  status: PrincipalStatus,
});

/** identity's `GET /v1/principals/:id` with knowledge's own service token (scope `read`). */
export class HttpPrincipalDirectory implements PrincipalDirectory {
  constructor(private readonly o: { baseUrl: string; token: string; fetchImpl?: typeof fetch }) {}

  async lookup(id: string): Promise<Result<PrincipalView | null, KnowledgeError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method: 'GET',
      path: `/v1/principals/${encodeURIComponent(id)}`,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return err(knowledgeError('unavailable', 'identity did not answer'));
    if (r.status === 404) return ok(null);
    if (r.status !== 200)
      return err(knowledgeError('unavailable', `identity answered ${r.status}`));
    const p = View.safeParse(r.json);
    return p.success
      ? ok({ principal_id: p.data.principal_id, kind: p.data.kind, status: p.data.status })
      : err(knowledgeError('unavailable', 'identity answered with an unexpected shape'));
  }
}

/** Deterministic fake for tests: a fixed set of principals; unlisted ones do not exist. */
export class FakePrincipalDirectory implements PrincipalDirectory {
  private down = false;
  constructor(private readonly principals: PrincipalView[] = []) {}
  add(p: PrincipalView): this {
    this.principals.push(p);
    return this;
  }
  /** Makes every lookup fail, as an unreachable identity service would. */
  breakIt(): this {
    this.down = true;
    return this;
  }
  async lookup(id: string): Promise<Result<PrincipalView | null, KnowledgeError>> {
    if (this.down) return err(knowledgeError('unavailable', 'identity did not answer'));
    return ok(this.principals.find((p) => p.principal_id === id) ?? null);
  }
}
