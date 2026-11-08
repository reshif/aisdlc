import type { LedgerEntry } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  ErrorEnvelope,
  NotaryCheckpointResponse,
  NotaryConfirmResponse,
  NotaryReserveResponse,
  NotarySignResponse,
  NotaryUnconfirmedResponse,
  NotaryVerifyResponse,
  NOTARY_STATUS,
  notaryError,
  type CheckpointSignRequest,
  type NotaryError,
  type NotaryErrorCode,
  type NotaryPort,
  type ReserveRequest,
  type SignRequest,
  type SignedCheckpoint,
  type SignedLedgerEntry,
} from '@aisdlc/ports';
import { callJson } from '@aisdlc/service-kit';
import type { z } from 'zod';

export interface HttpNotaryOptions {
  baseUrl: string;
  /** This caller's service token. */
  token: string;
  fetchImpl?: typeof fetch;
}

const CODES = Object.keys(NOTARY_STATUS) as NotaryErrorCode[];

/** `NotaryPort` over HTTP. A network or protocol failure is `unavailable`, never a success. */
export class HttpNotary implements NotaryPort {
  constructor(private readonly o: HttpNotaryOptions) {}

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: S,
  ): Promise<Result<z.infer<S>, NotaryError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return err(notaryError('unavailable', r.message));
    if (r.status !== 200) {
      const e = ErrorEnvelope.safeParse(r.json);
      if (!e.success) return err(notaryError('unavailable', `HTTP ${r.status}`));
      const code = CODES.find((c) => c === e.data.error.code) ?? 'internal';
      return err(notaryError(code, e.data.error.message));
    }
    const p = schema.safeParse(r.json);
    return p.success ? ok(p.data) : err(notaryError('unavailable', 'malformed notary response'));
  }

  reserve(req: ReserveRequest) {
    return this.call('POST', '/v1/reserve', req, NotaryReserveResponse);
  }

  sign(req: SignRequest): Promise<Result<SignedLedgerEntry, NotaryError>> {
    return this.call('POST', '/v1/sign', req, NotarySignResponse);
  }

  async confirm(req: { ledger_seq: number; entry_hash: string }) {
    const r = await this.call('POST', '/v1/confirm', req, NotaryConfirmResponse);
    return r.ok ? ok(true as const) : r;
  }

  async unconfirmed() {
    const r = await this.call('GET', '/v1/unconfirmed', undefined, NotaryUnconfirmedResponse);
    return r.ok ? ok(r.value.entries) : r;
  }

  signCheckpoint(req: CheckpointSignRequest): Promise<Result<SignedCheckpoint, NotaryError>> {
    return this.call('POST', '/v1/checkpoint', req, NotaryCheckpointResponse);
  }

  async verify(entry: LedgerEntry) {
    const r = await this.call('POST', '/v1/verify', { entry }, NotaryVerifyResponse);
    return r.ok ? ok(true as const) : r;
  }
}
