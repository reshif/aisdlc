import { validateOutput } from '@aisdlc/agents';
import type { AgentBinding } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { callMessages, type ModelCallOptions, type RepoFile } from '@aisdlc/ports';

// The ports of the verify service (PLAN M14.3), each with a deterministic fake:
//
//   RepoFilesPort   the repo at a commit (the code host's bundle route: `GitBundleFiles` over `HttpBundleSource`)
//   HoldoutPort     the Unit's hidden tests. NARROW on purpose: the eval store's holdouts are read by `holdout.ts` of
//                   the eval package only, and nothing here imports it; a deployment that keeps repo holdouts plugs an
//                   adapter in here. `NoHoldouts` (none bound) is what runs until one exists
//   ReviewerPort    the A half of 7.3 and 7.5: A5 (review.v1) through the gateway, under the run's own key

// ---------------------------------------------------------------- the repo

export interface RepoFilesError {
  readonly code: 'unavailable' | 'not_found';
  readonly message: string;
}

export interface RepoFilesPort {
  files(repo: string, sha: string): Promise<Result<RepoFile[], RepoFilesError>>;
}

export class FakeRepoFiles implements RepoFilesPort {
  private readonly trees = new Map<string, RepoFile[]>();
  private down = false;
  readonly asked: string[] = [];

  set(repo: string, sha: string, files: readonly RepoFile[]): this {
    this.trees.set(`${repo}@${sha}`, [...files]);
    return this;
  }
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }
  async files(repo: string, sha: string): Promise<Result<RepoFile[], RepoFilesError>> {
    this.asked.push(`${repo}@${sha}`);
    if (this.down) return err({ code: 'unavailable', message: 'the code host is unreachable' });
    const t = this.trees.get(`${repo}@${sha}`);
    return t ? ok(t) : err({ code: 'not_found', message: `no commit ${sha} in ${repo}` });
  }
}

// ---------------------------------------------------------------- holdouts

export interface HoldoutSet {
  readonly set_id: string;
  readonly files: readonly RepoFile[];
}

export interface HoldoutPort {
  holdouts(req: {
    item_id: string;
    repo: string;
    unit_key: string;
    base_sha: string;
  }): Promise<Result<HoldoutSet | null, { message: string }>>;
}

/** No holdout set is bound to any Unit (the default until a holdout store exists): 7.2 records `holdout_none`. */
export class NoHoldouts implements HoldoutPort {
  async holdouts(): Promise<Result<HoldoutSet | null, { message: string }>> {
    return ok(null);
  }
}

export class FakeHoldouts implements HoldoutPort {
  private readonly sets = new Map<string, HoldoutSet>();
  private down = false;
  set(item_id: string, s: HoldoutSet): this {
    this.sets.set(item_id, s);
    return this;
  }
  breakIt(broken = true): this {
    this.down = broken;
    return this;
  }
  async holdouts(req: {
    item_id: string;
  }): Promise<Result<HoldoutSet | null, { message: string }>> {
    if (this.down) return err({ message: 'the holdout store is unreachable' });
    return ok(this.sets.get(req.item_id) ?? null);
  }
}

// ---------------------------------------------------------------- the reviewer (A5)

export type ReviewCheck = 'spec_conformance' | 'constitution';

/** A5's answer, validated against review.v1. */
export interface ReviewAnswer {
  readonly verdict: 'pass' | 'findings';
  readonly findings: ReadonlyArray<{
    readonly severity: 'low' | 'medium' | 'high';
    readonly rule_id?: string | undefined;
    readonly location: { readonly path: string; readonly line?: number | undefined };
    readonly message: string;
  }>;
}

export interface ReviewRequest {
  readonly agent: AgentBinding;
  /** The run's virtual key, for the length of this call. */
  readonly key: string;
  readonly check: ReviewCheck;
  readonly system: string;
  readonly user: string;
  readonly model: string;
  readonly max_tokens: number;
}

/**
 * `unreachable`: no answer (the step is asked again: "gateway down: agent steps wait"). `refused`: the gateway said no
 * (kill, budget, route). `invalid`: an answer that is not one review.v1 object for this check. The last two are an
 * answer with no verdict: `unknown`.
 */
export interface ReviewFailure {
  readonly kind: 'unreachable' | 'refused' | 'invalid';
  readonly code: string;
}

export interface ReviewerPort {
  review(req: ReviewRequest): Promise<Result<ReviewAnswer, ReviewFailure>>;
}

/** The answer text as one review.v1 object for `check`, or why not (field paths only, never the text). */
export function parseReview(text: string, check: ReviewCheck): Result<ReviewAnswer, ReviewFailure> {
  const t = text.trim();
  const body = t.startsWith('{') ? t : (/```(?:json)?\s*([\s\S]*?)```/.exec(t)?.[1] ?? '').trim();
  let j: unknown;
  try {
    j = JSON.parse(body);
  } catch {
    return err({ kind: 'invalid', code: 'not_json' });
  }
  const v = validateOutput('A5', j);
  if (!v.ok) return err({ kind: 'invalid', code: 'schema' });
  const o = v.value as unknown as ReviewAnswer & { check: string };
  if (o.check !== check) return err({ kind: 'invalid', code: 'wrong_check' });
  return ok({ verdict: o.verdict, findings: o.findings });
}

/** A5 through the gateway's `/v1/messages`, one call, no tools (the review reads only what it is given). */
export class GatewayReviewer implements ReviewerPort {
  constructor(private readonly gateway: ModelCallOptions) {}

  async review(req: ReviewRequest): Promise<Result<ReviewAnswer, ReviewFailure>> {
    const r = await callMessages(this.gateway, req.key, req.agent.data_class_max, {
      model: req.model,
      max_tokens: req.max_tokens,
      system: req.system,
      messages: [{ role: 'user', content: req.user }],
    });
    if (!r.ok) {
      return err({
        kind: r.error.kind === 'refused' ? 'refused' : 'unreachable',
        code: r.error.code,
      });
    }
    return parseReview(r.value.text, req.check);
  }
}

/** Deterministic reviewer: a pass unless scripted. `calls` keeps every request (never the key: tests check). */
export class FakeReviewer implements ReviewerPort {
  readonly calls: Array<Omit<ReviewRequest, 'key'> & { key_seen: boolean }> = [];
  private script: (req: ReviewRequest) => ReviewAnswer | ReviewFailure | string | undefined = () =>
    undefined;

  scripted(fn: (req: ReviewRequest) => ReviewAnswer | ReviewFailure | string | undefined): this {
    this.script = fn;
    return this;
  }

  async review(req: ReviewRequest): Promise<Result<ReviewAnswer, ReviewFailure>> {
    const { key, ...rest } = req;
    this.calls.push({ ...rest, key_seen: key.length > 0 });
    const s = this.script(req);
    if (s === undefined) return ok({ verdict: 'pass', findings: [] });
    if (typeof s === 'string') return parseReview(s, req.check);
    if ('kind' in s) return err(s);
    return ok(s);
  }
}
