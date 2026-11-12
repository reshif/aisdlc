import type { GapRecheckResult, GitSha, RepoFullName } from '@aisdlc/contracts';

// GapRecheckPort (PLAN M16; OB §7 "Sync": "the factory re-checks that criterion at the default-branch head"). What
// the issue twin asks before it calls a gap's twin verified: does the repo meet this criterion at the head of its
// default branch NOW. `unknown` is unmet (fail closed): a twin is `closed_verified` only on `pass`.

export interface GapRecheck {
  readonly result: GapRecheckResult;
  /** The head the criterion was checked at; `null` when it is not known. */
  readonly sha: GitSha | null;
  /** Why, in the factory's words (never repo text). */
  readonly reason: string;
}

export interface GapRecheckPort {
  recheck(req: {
    readonly repo: RepoFullName;
    readonly criterion: string;
    readonly area: string | null;
  }): Promise<GapRecheck>;
}

/** A deterministic re-check: what a test sets per repo and criterion; anything not set is `unknown`. */
export class FakeGapRecheck implements GapRecheckPort {
  private readonly answers = new Map<string, GapRecheck>();
  readonly asked: Array<{ repo: string; criterion: string }> = [];
  down = false;

  set(repo: string, criterion: string, result: GapRecheckResult, sha: GitSha | null = null): this {
    this.answers.set(`${repo.toLowerCase()}|${criterion}`, {
      result,
      sha,
      reason: `set by the test: ${result}`,
    });
    return this;
  }

  async recheck(req: Parameters<GapRecheckPort['recheck']>[0]): Promise<GapRecheck> {
    this.asked.push({ repo: req.repo, criterion: req.criterion });
    if (this.down) return { result: 'unknown', sha: null, reason: 'the re-check did not answer' };
    return (
      this.answers.get(`${req.repo.toLowerCase()}|${req.criterion}`) ?? {
        result: 'unknown',
        sha: null,
        reason: 'no answer for this criterion',
      }
    );
  }
}
