import {
  patchHashOf,
  type PatchSet,
  type PushEvidence,
  type PushRefusalCode,
} from '@aisdlc/contracts';
import { err, ok, taggedError, type Result, type TaggedError } from '@aisdlc/kernel';

// 6.6 asks the Push Broker for ONE thing (PLAN M13.6): this Unit's patch, as a commit on its branch and a Draft PR. The
// coding port knows nothing of GitHub, a token or a lease table: it names the Unit and the patch and gets a verdict. The
// real adapter (core's `CorePush`) records the intent, asks the code host's broker (which checks the lease, the ruleset,
// the paths and X2 itself), records the receipt and moves the Unit to Pushed; the fake answers from a script.

export const PushPortError = taggedError('PushPortError');
export type PushPortError = TaggedError<'PushPortError', { message: string }>;

export interface PushRequest {
  readonly item_id: string;
  readonly repo: string;
  readonly lane: string;
  readonly unit_key: string;
  /** The epoch the writer held when it worked: a lease that moved since makes the push stale. */
  readonly lease_epoch: number;
  readonly base_sha: string;
  readonly patch: PatchSet;
  readonly message: string;
  readonly evidence: PushEvidence;
  /** The 6.6 command's key: one command, one push (a redelivery is answered with the receipt it already has). */
  readonly command_key: string;
}

export type PushResult =
  | {
      readonly kind: 'pushed';
      readonly head_sha: string;
      readonly branch: string;
      readonly pr_number: number;
      readonly patch_hash: string;
      readonly receipt_id: string;
    }
  | {
      /** The broker refused: a verdict, not a failure to ask. `code` is the broker's token. */
      readonly kind: 'refused';
      readonly code: PushRefusalCode;
      readonly message: string;
      readonly patch_hash: string;
    };

export interface PushPort {
  /** An error is "unknown whether it ran": the command is delivered again with the same key. */
  push(req: PushRequest): Promise<Result<PushResult, PushPortError>>;
}

/** Deterministic `PushPort`: scripted answers, every request kept. */
export class FakePush implements PushPort {
  readonly requests: PushRequest[] = [];
  private readonly scripts: Array<(r: PushRequest) => PushResult | undefined> = [];
  private down = false;
  private n = 0;

  script(fn: (r: PushRequest) => PushResult | undefined): this {
    this.scripts.unshift(fn);
    return this;
  }
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }

  async push(req: PushRequest): Promise<Result<PushResult, PushPortError>> {
    this.requests.push(req);
    if (this.down) return err(PushPortError({ message: 'the Push Broker did not answer' }));
    const scripted = this.scripts.map((s) => s(req)).find((r) => r !== undefined);
    if (scripted) return ok(scripted);
    this.n += 1;
    const patch_hash = patchHashOf(req.patch);
    return ok({
      kind: 'pushed',
      head_sha: this.n.toString(16).padStart(40, 'c'),
      branch: `agent/${req.item_id}/${req.unit_key}`,
      pr_number: 1,
      patch_hash,
      receipt_id: `receipt-${this.n}`,
    });
  }
}
