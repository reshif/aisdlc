import {
  PRR_EVENT,
  PrrActivatedPayload,
  PrrProposedPayload,
  TRACKER_APP_PERMISSIONS,
  prrStream,
  repoIdOf,
  type Gap,
  type RepoVisibility,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { FakeGapRecheck, FakeGitHub, emptySeed, type IssueTrackerPort } from '@aisdlc/ports';
import { inCoreTx, lockKeys, requestOnboarding, type IssueTwinSyncDeps } from '../src/index.js';
import { pid, pr, request, type CoreStack } from '../src/testing.js';
import { built, inputs } from './prr-fixtures.js';

// Fixtures for the issue twin's tests (PLAN M16): a repo with an ACTIVE readiness record whose gap ledger card 1
// disposed as the test asks (written straight into the PRR stream, as the work fixtures do), and a FakeGitHub that
// knows the repo, seen through the tracker's own credential.

export const TRACKER_LOGIN = 'aisdlc-tracker[bot]';
export const HEAD = 'e'.repeat(40);

let n = 0;
export interface Seeded {
  readonly project: string;
  readonly repo: string;
  readonly gaps: readonly Gap[];
  readonly host: FakeGitHub;
  readonly tracker: IssueTrackerPort;
  readonly recheck: FakeGapRecheck;
  readonly sync: IssueTwinSyncDeps;
}

/** A repo with an ACTIVE readiness record whose gap ledger card 1 disposed as asked, and a fake host with the repo. */
export async function seedTwinRepo(
  s: CoreStack,
  o: {
    golden?: 'a' | 'b';
    visibility?: RepoVisibility;
    /** Criteria card 1 chose to file as issues. */
    fileIssue?: readonly string[];
  } = {},
): Promise<Seeded> {
  n += 1;
  const project = `tw-${n}`;
  const repo = `acme/tw-${n}`;
  const deps = { pool: s.record.pool, clock: s.clock };
  const r = await requestOnboarding(
    deps,
    request({ project_id: pid(project), repo, level: 'census', on_behalf_of: pr('alice') }),
  );
  if (!r.ok) throw new Error(r.error.message);
  const s0 = r.value.s0_id;
  const i0 = inputs({
    tier: 'T1',
    level: 'census',
    census: { golden: o.golden ?? 'a' },
    over: { project_id: project },
  });
  if (o.visibility) {
    (i0.census as { repo: { visibility: RepoVisibility } }).repo.visibility = o.visibility;
  }
  const i = {
    ...i0,
    c1: {
      ...i0.c1,
      gap_rows: i0.c1.gap_rows.map((g) =>
        o.fileIssue?.includes(g.criterion) ? { ...g, disposition: 'file_issue' as const } : g,
      ),
    },
  };
  const prr = built(i);
  const w = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [`project:${project}`, `repo:${repo.toLowerCase()}`]);
    const stream = prrStream(project, repoIdOf(repo));
    const p = await j.emit(
      stream,
      PRR_EVENT.proposed,
      PrrProposedPayload.parse({ s0_id: s0, prr }),
      'test',
    );
    if (!p.ok) return p;
    return j.emit(
      stream,
      PRR_EVENT.activated,
      PrrActivatedPayload.parse({
        s0_id: s0,
        version: 1,
        record_hash: prr.record_hash,
        m4: {
          ledger_entry_id: '00000000-0000-4000-8000-000000000001',
          decision_hash: sha256Hex('m4'),
        },
      }),
      'test',
    );
  });
  if (!w.ok) throw new Error(w.error.message);
  const host = new FakeGitHub(
    emptySeed({
      repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
      heads: [{ repo, branch: 'main', sha: HEAD }],
    }),
  );
  const tracker = host.asTracker({
    app_id: 3003,
    permissions: TRACKER_APP_PERMISSIONS,
    login: TRACKER_LOGIN,
  });
  const recheck = new FakeGapRecheck();
  return {
    project,
    repo,
    gaps: prr.gaps,
    host,
    tracker,
    recheck,
    sync: { ...s.deps, tracker, recheck },
  };
}
