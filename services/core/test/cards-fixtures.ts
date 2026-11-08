import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CensusRecord,
  censusHash,
  gapId,
  type CensusLatest,
  type Gap,
  type Tier,
} from '@aisdlc/contracts';
import { FakeGitHub, emptySeed, type CodeHostSeed } from '@aisdlc/ports';
import { rawRules } from '@aisdlc/ports/testing';

// Fixtures of the card tests: a real census record (the knowledge service's golden files, retargeted
// at the repo under test and re-sealed) and a fake code host in a good or a broken state.

const GOLDEN = join(import.meta.dirname, '..', '..', 'knowledge', 'test', 'golden');
export const SHA = 'c'.repeat(40);

export interface CensusOptions {
  /** `a`: clean; `b`: a secret in history (B1 blocked). */
  readonly golden?: 'a' | 'b';
  readonly extraGaps?: number;
  /** Turns the gap of this criterion into a blocking one at the census level. */
  readonly blocking?: readonly string[];
  readonly tierFloor?: Tier;
  /** The scan did not complete: B2 is not met in this census. */
  readonly b2Unknown?: boolean;
}

export function censusFixture(repo: string, o: CensusOptions = {}): CensusLatest {
  const name = o.golden === 'b' ? 'census-b-secret-in-history' : 'census-a-clean';
  const text = readFileSync(join(GOLDEN, `${name}.json`), 'utf8')
    .replaceAll('acme.app', repo.toLowerCase().replace('/', '.'))
    .replaceAll('acme/app', repo);
  const raw = JSON.parse(text) as Record<string, unknown> & { gaps: Gap[] };
  const repoId = repo.toLowerCase().replace('/', '.');
  const gaps: Gap[] = raw.gaps.map((g) =>
    o.blocking?.includes(g.criterion)
      ? { ...g, severity: 'blocking' as const, blocks_level: 'census' as const, disposition: null }
      : g,
  );
  for (let i = 0; i < (o.extraGaps ?? 0); i++) {
    gaps.push({
      gap_id: gapId(repoId, `RS-GAP-${i}`, '.'),
      repo_id: repoId,
      criterion: `RS-GAP-${i}`,
      area: '.',
      severity: 'tracked',
      blocks_level: null,
      disposition: null,
      status: 'open',
      issue: null,
      remediation_item_ref: null,
      waiver: null,
      visibility_class: 'public_safe',
    } as Gap);
  }
  const body = { ...raw, gaps } as Record<string, unknown>;
  if (o.tierFloor) {
    body['risk_category'] = {
      ...(raw['risk_category'] as object),
      tier_floor: o.tierFloor,
    };
  }
  if (o.b2Unknown) {
    body['blockers'] = (raw['blockers'] as Array<{ id: string }>).map((b) =>
      b.id === 'B2' ? { ...b, status: 'unknown', reasons: ['scan_error'] } : b,
    );
  }
  const sealed = CensusRecord.parse({ ...body, census_hash: censusHash(body) });
  return {
    census_id: sealed.census_id,
    census_hash: sealed.census_hash,
    job_id: 'job-1',
    assembled_at: '2026-11-09T10:00:00.000Z',
    census: sealed,
    gaps: sealed.gaps,
  };
}

export interface HostOptions {
  readonly rules?: 'good' | 'none';
  /** The App holds `statuses` and a required check is not pinned: B4b is blocked. */
  readonly unpinnedStatuses?: boolean;
  readonly scope?: 'selected' | 'all';
  readonly codeowners?: string | null;
}

/** The seed of a repo with its rules, files and collaborators. */
export function hostSeed(repo: string, o: HostOptions = {}): CodeHostSeed {
  const good =
    o.rules !== 'none'
      ? [
          rawRules.pr({}),
          rawRules.checks(
            [
              o.unpinnedStatuses
                ? { context: 'ci' }
                : { context: 'gate-check', integration_id: 99 },
            ],
            false,
          ),
          rawRules.simple('non_fast_forward'),
          rawRules.simple('deletion'),
        ]
      : o.unpinnedStatuses
        ? [rawRules.checks([{ context: 'ci' }])]
        : [];
  return emptySeed({
    installation: {
      installation_id: 4242,
      account_login: 'acme',
      repository_selection: o.scope ?? 'selected',
      permissions: {
        contents: 'read',
        metadata: 'read',
        ...(o.unpinnedStatuses ? { statuses: 'write' as const } : {}),
      },
      suspended: false,
    },
    repos: [{ full_name: repo, default_branch: 'main', private: true, archived: false }],
    heads: [{ repo, branch: 'main', sha: SHA }],
    files: [
      ...(o.codeowners === null
        ? []
        : [
            {
              repo,
              sha: SHA,
              path: '.github/CODEOWNERS',
              content: o.codeowners ?? '* @alice-gh\n',
            },
          ]),
      { repo, sha: SHA, path: 'AGENTS.md', content: '# agents\n' },
    ],
    rules: [{ repo, branch: 'main', rules: good }],
    collaborators: [
      {
        repo,
        collaborators: [
          { login: 'alice-gh', permission: 'admin' },
          { login: 'bob-gh', permission: 'write' },
          { login: 'ghost-gh', permission: 'write' },
        ],
      },
    ],
  });
}

export const cardHost = (repo: string, o: HostOptions = {}): FakeGitHub =>
  new FakeGitHub(hostSeed(repo, o));
