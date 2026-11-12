import {
  KillDelegationGrant,
  KillEvent,
  KillRecord,
  KillStatus,
  type KillQuery,
} from '@aisdlc/contracts';
import { err, ok, type Jwk, type Result } from '@aisdlc/kernel';
import {
  ErrorEnvelope,
  killStateError,
  type KillStateError,
  type KillStatePort,
} from '@aisdlc/ports';
import { callJson } from '@aisdlc/service-kit';
import { z } from 'zod';
import { killswitchError, type KillswitchError, type KillswitchErrorCode } from './errors.js';

export interface KillswitchClientOptions {
  baseUrl: string;
  /** This caller's service token. */
  token: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const CODES: readonly KillswitchErrorCode[] = [
  'invalid_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'unavailable',
];

const KillswitchErrorEnvelope = z.strictObject({
  error: ErrorEnvelope.shape.error.extend({ reasons: z.array(z.string()).optional() }),
});

async function request<S extends z.ZodType>(
  o: KillswitchClientOptions,
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body: unknown,
  schema: S,
): Promise<Result<z.infer<S>, KillswitchError>> {
  const r = await callJson({
    baseUrl: o.baseUrl,
    token: o.token,
    method,
    path,
    ...(body === undefined ? {} : { body }),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
    timeoutMs: o.timeoutMs ?? 3_000,
  });
  if (!r.reached) return err(killswitchError('unavailable', r.message));
  if (r.status < 200 || r.status > 299) {
    // the kill switch adds `reasons` to a PDP refusal; the code and message are what a caller reads
    const e = KillswitchErrorEnvelope.safeParse(r.json);
    if (!e.success) return err(killswitchError('unavailable', `HTTP ${r.status}`));
    const code = CODES.find((c) => c === e.data.error.code) ?? 'unavailable';
    return err(killswitchError(code, e.data.error.message));
  }
  const p = schema.safeParse(r.json);
  return p.success
    ? ok(p.data)
    : err(killswitchError('unavailable', 'malformed kill switch response'));
}

/**
 * `KillStatePort` over HTTP. Read-only. A network or protocol failure is an error, and the enforcement
 * point turns an error into "killed" (`admitAgentWork`): unreachable means no new agent work.
 */
export class HttpKillState implements KillStatePort {
  constructor(private readonly o: KillswitchClientOptions) {}

  async status(q: KillQuery): Promise<Result<KillStatus, KillStateError>> {
    const qs = new URLSearchParams({ project_id: q.project_id });
    if (q.lane) qs.set('lane', q.lane);
    if (q.session_id) qs.set('session_id', q.session_id);
    const r = await request(this.o, 'GET', `/v1/status?${qs}`, undefined, KillStatus);
    return r.ok ? r : err(killStateError('unavailable', r.error.message));
  }
}

const Events = z.object({ events: z.array(KillEvent), key: z.unknown().optional() });

/** The rest of the kill switch's API, for core-worker (sync, observe) and the BFF (act). */
export class KillswitchClient {
  constructor(private readonly o: KillswitchClientOptions) {}

  // Every act carries the acting person's step-up proof for exactly that act (`killActHash`, RC-SEC-3):
  // the kill switch takes the actor from the proof. The caller cannot name anyone.
  kill(proof: string, scope: unknown, reason: string) {
    return request(this.o, 'POST', '/v1/kills', { step_up: { proof }, scope, reason }, KillRecord);
  }
  release(proof: string, kill_id: string) {
    return request(
      this.o,
      'POST',
      `/v1/kills/${kill_id}/release`,
      { step_up: { proof } },
      KillRecord,
    );
  }
  delegate(proof: string, delegate: string, scope: unknown) {
    return request(
      this.o,
      'POST',
      '/v1/delegations',
      { step_up: { proof }, delegate, scope },
      KillDelegationGrant,
    );
  }
  revoke(proof: string, delegation_id: string) {
    return request(
      this.o,
      'POST',
      `/v1/delegations/${delegation_id}/revoke`,
      { step_up: { proof } },
      KillDelegationGrant,
    );
  }
  async events(
    after: number,
    limit = 200,
  ): Promise<Result<{ events: KillEvent[]; key: Jwk | null }, KillswitchError>> {
    const r = await request(
      this.o,
      'GET',
      `/v1/events?after=${after}&limit=${limit}`,
      undefined,
      Events,
    );
    return r.ok ? ok({ events: r.value.events, key: (r.value.key as Jwk | undefined) ?? null }) : r;
  }
  syncHolders(
    project_id: string,
    body: {
      admins: string[];
      kill_holders: string[];
      tier: 'T0' | 'T1' | 'T2' | null;
      two_person: boolean;
    },
  ) {
    return request(
      this.o,
      'PUT',
      `/v1/holders/${encodeURIComponent(project_id)}`,
      body,
      z.object({ project_id: z.string() }).passthrough(),
    );
  }
  capabilities(on_behalf_of: string, project_id: string | null) {
    const qs = new URLSearchParams({ on_behalf_of, ...(project_id ? { project_id } : {}) });
    return request(
      this.o,
      'GET',
      `/v1/capabilities?${qs}`,
      undefined,
      z.object({
        kill: z.boolean(),
        release: z.boolean(),
        delegate: z.boolean(),
        fleet_kill: z.boolean(),
      }),
    );
  }
}

// The journal's verifier is pure and shared: core's observer checks what it reads against the kill
// switch's pinned public key before it records anything.
export {
  verifyKillJournal,
  verifyKillJournalReport,
  type JournalProblem,
  type JournalReport,
} from './journal.js';
