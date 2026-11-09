import {
  KillScope,
  scopeCoversQuery,
  type KillQuery,
  type KillRecord,
  type KillStatus,
} from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// KillStatePort (PLAN M9.6, AR9): what an enforcement point asks the kill switch before it lets agent
// work go on. The work driver reads it before it dispatches a stage command; the push broker (M13.6)
// and the gateway (M10) will read the same port. The kill switch is its own service with its own
// state; the port is read-only (a kill is requested through the kill switch's own API, never through
// this port).
//
// FAIL CLOSED: an enforcement point that cannot reach the kill switch treats the scope as KILLED for
// agent work. It says so in `admitAgentWork`, which is the only way the answer is turned into a
// decision, so no caller writes "unreachable means go on". Humans can still decide gates: nothing
// here is consulted by a decision.

export type KillStateErrorCode = 'unavailable' | 'invalid';
export const KillStateError = taggedError('KillStateError');
export type KillStateError = TaggedError<
  'KillStateError',
  { code: KillStateErrorCode; message: string }
>;
export const killStateError = (code: KillStateErrorCode, message: string): KillStateError =>
  KillStateError({ code, message });

export interface KillStatePort {
  status(q: KillQuery): Promise<Result<KillStatus, KillStateError>>;
}

/** The verdict of an enforcement point on agent work for a scope. */
export type AgentAdmission =
  | { readonly admitted: true }
  | {
      readonly admitted: false;
      /** `killed`: a kill covers it. `unreachable`: the kill switch could not be asked (fail closed). */
      readonly why: 'killed' | 'unreachable';
      readonly kill_ids: readonly string[];
      readonly message: string;
    };

/** Agent work may go on only when the kill switch answered and no covering kill is in force. */
export async function admitAgentWork(port: KillStatePort, q: KillQuery): Promise<AgentAdmission> {
  let r: Result<KillStatus, KillStateError>;
  try {
    r = await port.status(q);
  } catch (e) {
    return {
      admitted: false,
      why: 'unreachable',
      kill_ids: [],
      message: `kill switch unreachable: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  if (!r.ok) {
    return { admitted: false, why: 'unreachable', kill_ids: [], message: r.error.message };
  }
  if (r.value.killed) {
    return {
      admitted: false,
      why: 'killed',
      kill_ids: r.value.kills.map((k) => k.kill_id),
      message: `killed: ${r.value.kills.map((k) => `${k.scope.kind}:${k.scope.ref}`).join(', ')}`,
    };
  }
  return { admitted: true };
}

/** Deterministic `KillStatePort`: kills are what a test says; `breakIt` makes every read an error. */
export class FakeKillState implements KillStatePort {
  private readonly kills = new Map<string, KillRecord>();
  private down = false;
  private n = 0;
  readonly queries: KillQuery[] = [];

  constructor(private readonly now: () => Date = () => new Date(0)) {}

  /** A kill in force. Returns its id. */
  kill(scope: KillScope, by = 'tester', reason = 'test'): string {
    this.n += 1;
    const kill_id = `00000000-0000-4000-8000-${String(this.n).padStart(12, '0')}`;
    this.kills.set(kill_id, {
      kill_id,
      scope: KillScope.parse(scope),
      state: 'active',
      requested_by: by as never,
      reason,
      requested_at: this.now().toISOString(),
      release_required: 1,
      release_approvals: [],
      released_at: null,
    });
    return kill_id;
  }

  release(kill_id: string): void {
    const k = this.kills.get(kill_id);
    if (k)
      this.kills.set(kill_id, { ...k, state: 'released', released_at: this.now().toISOString() });
  }

  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async status(q: KillQuery): Promise<Result<KillStatus, KillStateError>> {
    this.queries.push(q);
    if (this.down) return err(killStateError('unavailable', 'kill switch unavailable'));
    const kills = [...this.kills.values()].filter(
      (k) => k.state !== 'released' && scopeCoversQuery(k.scope, q),
    );
    return ok({ killed: kills.length > 0, kills, as_of: this.now().toISOString() });
  }
}
