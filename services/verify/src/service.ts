import { verifyResultHash, type VerifyRunRequest, type VerifyRunResponse } from '@aisdlc/contracts';
import { err, ok, systemClock, type Clock, type Result } from '@aisdlc/kernel';
import type { VerifyRunner } from '@aisdlc/verify';
import type pg from 'pg';
import { recordResult, resultByCommand } from './store.js';

// The verify service's one operation (PLAN M14.3): run a step's check over a Unit head, once per command key, and
// record the result before it is answered (record first: a result that is not in the record does not exist). A
// command key that has a result is answered from the record, and nothing runs again. The gateway key a reviewer
// call needs is in the request for the length of the call: it is never recorded, logged or answered.

export class VerifyService {
  constructor(
    private readonly d: {
      readonly pool: pg.Pool;
      readonly runner: VerifyRunner;
      readonly clock?: Clock;
    },
  ) {}

  async run(req: VerifyRunRequest): Promise<Result<VerifyRunResponse, { message: string }>> {
    const have = await resultByCommand(this.d.pool, req.command_key);
    if (have) {
      return ok({ result_sha256: have.result_sha256, result: have.result, duplicate: true });
    }
    const r = await this.d.runner.run(req);
    if (!r.ok) return err({ message: r.error.message });
    const { stored, duplicate } = await recordResult(
      this.d.pool,
      req.command_key,
      r.value,
      this.d.clock ?? systemClock,
    );
    if (stored.result_sha256 !== verifyResultHash(stored.result)) {
      throw new Error('the stored result does not hash to its address');
    }
    return ok({ result_sha256: stored.result_sha256, result: stored.result, duplicate });
  }
}
