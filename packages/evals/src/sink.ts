import { EvalRunRecord } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { callJson } from '@aisdlc/service-kit';

// Where a finished run goes so that it is HISTORY (PLAN M11.3): core's record (`POST /v1/evals/runs`
// appends `eval.run_recorded`; `core.eval_run` is the read model, so trends, scores and the summary
// exist). The sink is a port: the fake keeps runs in memory.

export interface EvalSinkError {
  readonly code: string;
  readonly message: string;
}

export interface EvalRunSink {
  record(run: EvalRunRecord): Promise<Result<void, EvalSinkError>>;
}

export class MemoryEvalSink implements EvalRunSink {
  readonly runs: EvalRunRecord[] = [];
  async record(run: EvalRunRecord): Promise<Result<void, EvalSinkError>> {
    this.runs.push(EvalRunRecord.parse(run));
    return ok(undefined);
  }
}

export class CoreEvalSink implements EvalRunSink {
  constructor(private readonly o: { baseUrl: string; token: string; fetchImpl?: typeof fetch }) {}

  async record(run: EvalRunRecord): Promise<Result<void, EvalSinkError>> {
    const r = await callJson({
      baseUrl: this.o.baseUrl,
      token: this.o.token,
      method: 'POST',
      path: '/v1/evals/runs',
      body: run,
      ...(this.o.fetchImpl ? { fetchImpl: this.o.fetchImpl } : {}),
    });
    if (!r.reached) return err({ code: 'unavailable', message: r.message });
    if (r.status < 200 || r.status > 299) {
      return err({ code: 'refused', message: `core answered ${r.status}` });
    }
    return ok(undefined);
  }
}
