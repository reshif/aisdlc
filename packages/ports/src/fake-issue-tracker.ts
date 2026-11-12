import type { CodeHostNotOk, CodeHostRead, GateCheckAuthor } from '@aisdlc/contracts';
import { readOk, readUnreadable, repoKey } from './codehost.js';
import {
  badIssueComment,
  badIssueFile,
  isOwnIssue,
  type IssueFile,
  type IssueTrackerPort,
  type TrackedIssue,
} from './issue-tracker.js';

// The issues of the in-memory fake GitHub (PLAN M16), and the tracker's view of them. A person files, closes, deletes
// or transfers an issue with the board's own methods (the test's hand); the tracker reaches the board only through
// `FakeTrackerView`, which checks what GitHub checks (the token's `issues` permission, the repo is installed) and what
// the factory promises (`badIssueFile`, only its own issues are written to).

export interface FakeIssue {
  readonly number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: string[];
  readonly author: GateCheckAuthor;
  closed_by: string | null;
  /** Deleted or transferred away: it reads as not found. */
  gone: boolean;
  readonly comments: Array<{ id: number; by: string; body: string }>;
}

/** An issue tracker credential on the fake host: its App id, what its token carries, the login it writes as. */
export interface FakeTrackerIdentity {
  readonly app_id: number;
  readonly permissions: Readonly<Record<string, string>>;
  readonly login: string;
}

/** The fake host's side the tracker view needs (`FakeGitHub._issues()`). */
export interface FakeIssueHost {
  readonly issues: Map<string, FakeIssue[]>;
  readonly repoKnown: (repo: string) => boolean;
  readonly log: (method: 'GET' | 'POST' | 'PATCH', path: string) => void;
  readonly broken: () => CodeHostNotOk | null;
  /** The next issue or pull request number of a repo (they share one sequence on GitHub). */
  readonly nextNumber: (repo: string) => number;
  readonly nextCommentId: () => number;
}

const LEVEL: Record<string, number> = { read: 1, write: 2, admin: 3 };

export const trackedOf = (i: FakeIssue): TrackedIssue => ({
  number: i.number,
  state: i.state,
  title: i.title,
  body: i.body,
  labels: [...i.labels],
  author: { ...i.author },
  closed_by: i.state === 'closed' ? i.closed_by : null,
});

export class FakeTrackerView implements IssueTrackerPort {
  readonly login: string;

  constructor(
    private readonly host: () => FakeIssueHost,
    private readonly id: FakeTrackerIdentity,
  ) {
    this.login = id.login;
  }

  private start(
    method: 'GET' | 'POST' | 'PATCH',
    path: string,
    repo: string,
    level: 'read' | 'write',
  ): CodeHostNotOk | null {
    const h = this.host();
    h.log(method, path);
    const b = h.broken();
    if (b) return b;
    if (!h.repoKnown(repo))
      return readUnreadable(
        'not_found',
        `repository ${repo} is not reachable by this installation`,
      );
    if ((LEVEL[this.id.permissions['issues'] ?? ''] ?? 0) < (LEVEL[level] ?? 99)) {
      return readUnreadable(
        'forbidden',
        `${method} ${path}: 403 (the token has no issues:${level})`,
      );
    }
    return null;
  }

  private find(repo: string, number: number): FakeIssue | undefined {
    return this.host()
      .issues.get(repoKey(repo))
      ?.find((i) => i.number === number && !i.gone);
  }

  async list_labelled(req: { repo: string; label: string }): Promise<CodeHostRead<TrackedIssue[]>> {
    const no = this.start('GET', `/repos/${req.repo}/issues`, req.repo, 'read');
    if (no) return no;
    const list = this.host().issues.get(repoKey(req.repo)) ?? [];
    return readOk(
      list.filter((i) => !i.gone && i.labels.includes(req.label)).map((i) => trackedOf(i)),
    );
  }

  async read_issue(req: { repo: string; number: number }): Promise<CodeHostRead<TrackedIssue>> {
    const no = this.start('GET', `/repos/${req.repo}/issues/${req.number}`, req.repo, 'read');
    if (no) return no;
    const i = this.find(req.repo, req.number);
    return i ? readOk(trackedOf(i)) : readUnreadable('not_found', `no issue ${req.number}`);
  }

  async file_issue(req: IssueFile): Promise<CodeHostRead<{ number: number }>> {
    const bad = badIssueFile(req);
    if (bad) return readUnreadable('refused', bad);
    const no = this.start('POST', `/repos/${req.repo}/issues`, req.repo, 'write');
    if (no) return no;
    const h = this.host();
    const list = h.issues.get(repoKey(req.repo)) ?? [];
    h.issues.set(repoKey(req.repo), list);
    const number = h.nextNumber(req.repo);
    list.push({
      number,
      state: 'open',
      title: req.title,
      body: req.body,
      labels: [...req.labels],
      author: { login: this.login, type: 'Bot' },
      closed_by: null,
      gone: false,
      comments: [],
    });
    return readOk({ number });
  }

  /** The tracker's own issue, read before a write (the adapter does the same GET). */
  private async own(repo: string, number: number): Promise<CodeHostRead<FakeIssue>> {
    const r = await this.read_issue({ repo, number });
    if (r.state !== 'ok') return r;
    const i = this.find(repo, number) as FakeIssue;
    if (!isOwnIssue(r.value, this.login)) {
      return readUnreadable(
        'refused',
        `issue ${number} is not the tracker's own: never written to`,
      );
    }
    return readOk(i);
  }

  async comment_issue(req: {
    repo: string;
    number: number;
    body: string;
  }): Promise<CodeHostRead<{ id: number }>> {
    const bad = badIssueComment(req.body);
    if (bad) return readUnreadable('refused', bad);
    const i = await this.own(req.repo, req.number);
    if (i.state !== 'ok') return i;
    const no = this.start(
      'POST',
      `/repos/${req.repo}/issues/${req.number}/comments`,
      req.repo,
      'write',
    );
    if (no) return no;
    const id = this.host().nextCommentId();
    i.value.comments.push({ id, by: this.login, body: req.body });
    return readOk({ id });
  }

  async close_issue(req: {
    repo: string;
    number: number;
  }): Promise<CodeHostRead<{ number: number }>> {
    const i = await this.own(req.repo, req.number);
    if (i.state !== 'ok') return i;
    if (i.value.state === 'closed') return readOk({ number: req.number });
    const no = this.start('PATCH', `/repos/${req.repo}/issues/${req.number}`, req.repo, 'write');
    if (no) return no;
    i.value.state = 'closed';
    i.value.closed_by = this.login;
    return readOk({ number: req.number });
  }
}
