import type { Checkpoint } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import {
  ErrorEnvelope,
  WITNESS_STATUS,
  WitnessCosignResponse,
  WitnessLastResponse,
  witnessError,
  type CosignRequest,
  type WitnessError,
  type WitnessErrorCode,
  type WitnessPort,
} from '@aisdlc/ports';
import { callJson } from '@aisdlc/service-kit';
import type { z } from 'zod';

export interface HttpWitnessOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
}

const CODES = Object.keys(WITNESS_STATUS) as WitnessErrorCode[];

/** `WitnessPort` over HTTP. A network or protocol failure is `unavailable`, never a co-signature. */
export class HttpWitness implements WitnessPort {
  constructor(private readonly o: HttpWitnessOptions) {}

  private async call<S extends z.ZodType>(
    method: 'GET' | 'POST',
    path: string,
    body: unknown,
    schema: S,
  ): Promise<Result<z.infer<S>, WitnessError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method,
      path,
      ...(body === undefined ? {} : { body }),
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return err(witnessError('unavailable', r.message));
    if (r.status !== 200) {
      const e = ErrorEnvelope.safeParse(r.json);
      if (!e.success) return err(witnessError('unavailable', `HTTP ${r.status}`));
      const code = CODES.find((c) => c === e.data.error.code) ?? 'internal';
      return err(witnessError(code, e.data.error.message));
    }
    const p = schema.safeParse(r.json);
    return p.success ? ok(p.data) : err(witnessError('unavailable', 'malformed witness response'));
  }

  async cosign(req: CosignRequest): Promise<Result<Checkpoint, WitnessError>> {
    const r = await this.call('POST', '/v1/cosign', req, WitnessCosignResponse);
    return r.ok ? ok(r.value.checkpoint) : r;
  }

  async last(): Promise<Result<Checkpoint | null, WitnessError>> {
    const r = await this.call('GET', '/v1/last', undefined, WitnessLastResponse);
    return r.ok ? ok(r.value.checkpoint) : r;
  }
}
