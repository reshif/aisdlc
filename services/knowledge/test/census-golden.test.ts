import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { CATALOGUE } from '@aisdlc/catalogue';
import {
  CensusAssembledPayload,
  CensusLatest,
  CensusRecord,
  censusHash,
  censusStream,
  type IntakeResult,
} from '@aisdlc/contracts';
import { canonicalJson } from '@aisdlc/kernel';
import { makeCanary } from '@aisdlc/secrets-rules';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { assembleCensus, censusProjection } from '../src/census/index.js';
import { ATTESTED, cleanRepo as cleanRepoIn } from './census-helpers.js';
import type { FixtureRepo } from '../src/testing.js';
import {
  FileBundleSource,
  scratchDir,
  startKnowledgeStack,
  type KnowledgeStack,
  type StackOptions,
} from '../src/testing.js';

// M6.5: the census of fixture repos, end to end. Each scenario builds a real repository, runs the
// whole census-intake job (real git, real scan, real detectors, real Postgres), and compares the
// census the job assembled with a committed golden file. `UPDATE_GOLDEN=1` regenerates the files; a
// stale golden fails the test. Every scenario also asserts what must hold whatever the golden says:
// posture, blockers, the exact gap ids and severities, and no secret material anywhere.

const GOLDEN = join(import.meta.dirname, 'golden');
const UPDATE = process.env['UPDATE_GOLDEN'] === '1';
const scratch = scratchDir();
afterAll(() => scratch.dispose());

interface Scenario {
  readonly name: string;
  readonly build: (r: FixtureRepo) => void;
  readonly commits?: number;
  readonly opts?: Partial<StackOptions>;
  /** Asserts on the census (and the stack) beyond the golden. */
  readonly check: (c: CensusRecord, s: KnowledgeStack, job: IntakeResult) => Promise<void> | void;
}

const canary = makeCanary('census-golden');

/** A git wrapper that fails the all-objects pass of the scan, as git does on a damaged mirror. */
const failingGit = join(scratch.dir, 'failing-git.sh');
writeFileSync(
  failingGit,
  '#!/bin/sh\nfor a in "$@"; do\n  if [ "$a" = "--objects" ]; then echo "fatal: simulated" >&2; exit 128; fi\ndone\nexec git "$@"\n',
);
chmodSync(failingGit, 0o755);

/** Runs the whole job for `sc` and returns the census the job itself assembled and persisted. */
async function runScenario<T>(
  sc: Pick<Scenario, 'name' | 'build' | 'opts'>,
  fn: (s: KnowledgeStack, census: CensusRecord, result: IntakeResult) => Promise<T>,
): Promise<T> {
  const r = cleanRepoIn(scratch.dir, sc.name);
  sc.build(r);
  r.commit('final');
  const b = r.bundle(join(scratch.dir, `${sc.name}.bundle`));
  const s = await startKnowledgeStack({
    source: new FileBundleSource(b.file, b.manifest),
    attestations: async () => ATTESTED,
    ...sc.opts,
  });
  try {
    const job = await s.runJob();
    expect(job.state, job.error ?? '').toBe('done');
    const stored = await s.db.pool.query<{ census: unknown }>(
      'SELECT census FROM knowledge.census ORDER BY global_seq DESC LIMIT 1',
    );
    const census = CensusRecord.parse(stored.rows[0]?.census);
    return await fn(s, census, job.result as IntakeResult);
  } finally {
    await s.stop();
  }
}

function matchesGolden(name: string, census: CensusRecord): void {
  const file = join(GOLDEN, `census-${name}.json`);
  const text = `${JSON.stringify(census, null, 2)}\n`;
  if (UPDATE) {
    mkdirSync(GOLDEN, { recursive: true });
    writeFileSync(file, text);
  }
  expect(existsSync(file), `golden ${name} missing: run with UPDATE_GOLDEN=1`).toBe(true);
  expect(
    readFileSync(file, 'utf8') === text,
    `golden census-${name}.json is stale: review the diff and run UPDATE_GOLDEN=1`,
  ).toBe(true);
}

const gapsOf = (c: CensusRecord): Array<[string, string]> =>
  c.gaps.map((g) => [g.gap_id.replace(/^gap:[^:]+:/, '').replace(/:\.$/, ''), g.severity]);
const blockerStatus = (c: CensusRecord): Record<string, string> =>
  Object.fromEntries(c.blockers.map((b) => [b.id, b.status]));

/** No secret value, no finding fingerprint, no path of a finding anywhere in the census or its gaps. */
async function noSecretMaterial(
  s: KnowledgeStack,
  c: CensusRecord,
  extra: string[] = [],
): Promise<void> {
  const text = JSON.stringify(c);
  expect(text).not.toContain(canary);
  expect(text).not.toContain(canary.slice(0, 16));
  const fp = await s.db.pool.query<{ fingerprint: string }>(
    'SELECT fingerprint FROM security_findings.finding',
  );
  for (const row of fp.rows) expect(text).not.toContain(row.fingerprint);
  for (const x of extra) expect(text).not.toContain(x);
  const ev = await s.db.pool.query<{ body: unknown }>(
    `SELECT body FROM record.record_event WHERE stream LIKE 'census:%'`,
  );
  for (const row of ev.rows) expect(JSON.stringify(row.body)).not.toContain(canary);
}

const scenarios: Scenario[] = [
  {
    name: 'a-clean',
    build: () => undefined,
    check: (c) => {
      expect(c.posture.state).toBe('green');
      expect(c.posture.reasons).toEqual([]);
      expect(blockerStatus(c)).toEqual({
        B1: 'met',
        B2: 'met',
        B3: 'not_evaluated',
        B4: 'met',
        B5: 'met',
        B6: 'met',
      });
      expect(c.risk_category.tier_floor).toBe('T0');
      expect(c.risk_category.blocks_m4_until_attested).toBe(false);
      expect(c.floors.filter((f) => f.id.startsWith('CF')).map((f) => f.status)).toEqual([
        'met',
        'met',
        'met',
        'met',
      ]);
    },
  },
  {
    name: 'b-secret-in-history',
    build: (r) => {
      r.write('config.env', `API_TOKEN=${canary}\n`).commit('add config');
      r.remove('config.env');
    },
    check: async (c, s) => {
      expect(c.posture.state).toBe('red');
      expect(blockerStatus(c)['B1']).toBe('blocked');
      expect(c.security_summary.history_scan.open).toBeGreaterThanOrEqual(1);
      expect(c.security_summary.history_scan.accepted_test_fixture).toBe(0);
      const sec = c.gaps.find((g) => g.criterion === 'RS-SEC');
      expect(sec).toMatchObject({
        gap_id: `gap:${c.repo.repo_id}:RS-SEC:.`,
        severity: 'tracked',
        disposition: 'track_only',
        visibility_class: 'private_only',
        status: 'open',
        issue: null,
      });
      // The blocker's evidence is a count reference, never a location.
      expect(c.blockers.find((b) => b.id === 'B1')?.evidence).toEqual([
        { source: 'scan', ref: 'scan:finding_counts' },
      ]);
      await noSecretMaterial(s, c, ['config.env']);
    },
  },
  {
    name: 'c-dangerous-workflow',
    build: (r) => {
      r.write(
        '.github/workflows/pr.yml',
        [
          'on: pull_request_target',
          'permissions: {}',
          'jobs:',
          '  build:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '        with:',
          '          ref: ${{ github.event.pull_request.head.sha }}',
          '      - run: npm test',
          '',
        ].join('\n'),
      );
    },
    check: (c) => {
      expect(c.posture.state).toBe('red');
      expect(blockerStatus(c)['B5']).toBe('blocked');
      const b5 = c.blockers.find((b) => b.id === 'B5');
      expect(b5?.reasons).toEqual(['pr_target_head_checkout']);
      expect(b5?.evidence[0]).toMatchObject({
        source: 'detector',
        path: '.github/workflows/pr.yml',
        line: 9,
      });
      expect(c.posture.reasons).toMatchObject([
        { kind: 'blocker', blocker: 'B5', status: 'blocked' },
      ]);
      expect(c.gaps.find((g) => g.criterion === 'RS-SEC')).toMatchObject({
        severity: 'tracked',
        visibility_class: 'private_only',
        disposition: 'track_only',
      });
    },
  },
  {
    name: 'd-apply-on-merge',
    build: (r) => {
      r.write(
        '.github/workflows/deploy.yml',
        [
          'on:',
          '  push:',
          '    branches: [main]',
          'permissions: {}',
          'jobs:',
          '  d:',
          '    runs-on: ubuntu-latest',
          '    steps:',
          '      - run: terraform apply -auto-approve',
          '',
        ].join('\n'),
      );
    },
    check: (c) => {
      // B6 blocks L5 only: it is a blocker, not part of the posture.
      expect(blockerStatus(c)['B6']).toBe('blocked');
      expect(c.blockers.find((b) => b.id === 'B6')?.reasons).toEqual(['apply_on_merge_unattested']);
      expect(c.posture.state).toBe('green');
      expect(c.risk_category.tier_floor).toBe('T2');
      expect(c.risk_category.signals.map((x) => x.signal)).toEqual(['aom.terraform_apply']);
      expect(c.risk_category.raised_by).toEqual(['b6_apply_on_merge']);
      // The owner signed T0 over a T2 floor: raise-only is violated, so RS-ID-3 is unmet.
      expect(c.criteria.find((x) => x.id === 'RS-ID-3')).toMatchObject({
        status: 'unmet',
        reasons: ['signed_below_floor'],
      });
      expect(gapsOf(c).find(([id]) => id === 'RS-ID-3')).toEqual(['RS-ID-3', 'blocking']);
    },
  },
  {
    name: 'e-scan-error',
    build: () => undefined,
    opts: { gitBin: failingGit },
    check: (c) => {
      // No scan result is not "clean": B2 is blocked and B1 cannot be called met.
      expect(c.posture.state).toBe('red');
      expect(blockerStatus(c)).toMatchObject({ B1: 'unknown', B2: 'blocked' });
      expect(c.blockers.find((b) => b.id === 'B2')?.reasons).toEqual(
        expect.arrayContaining(['scan_error', 'truncated']),
      );
      expect(c.security_summary.history_scan).toMatchObject({ status: 'error', truncated: true });
      expect(c.criteria.find((x) => x.id === 'RS-SEC')).toMatchObject({ status: 'unmet' });
      expect(c.gaps.find((g) => g.criterion === 'RS-SEC')).toMatchObject({
        severity: 'tracked',
        visibility_class: 'private_only',
      });
    },
  },
  {
    name: 'f-scan-capped',
    build: (r) => {
      r.write('a.txt', 'a\n').commit('one');
      r.write('b.txt', 'b\n').commit('two');
    },
    opts: { commitCap: 1 },
    check: (c) => {
      expect(blockerStatus(c)).toMatchObject({ B1: 'unknown', B2: 'blocked' });
      expect(c.blockers.find((b) => b.id === 'B2')?.reasons).toEqual(['cap_reached', 'truncated']);
    },
  },
];

describe('census golden files (M6.5)', () => {
  for (const sc of scenarios) {
    it(`${sc.name}: the job assembles, persists and matches its golden census`, async () => {
      await runScenario(sc, async (s, census, result) => {
        // The census the job stored is the one the pure function gives for the stored result.
        const again = assembleCensus(result, CATALOGUE, 'census', ATTESTED);
        expect(canonicalJson(again)).toBe(canonicalJson(census));
        expect(census.census_hash).toBe(censusHash(census));
        matchesGolden(sc.name, census);
        await sc.check(census, s, result);
        await noSecretMaterial(s, census);
      });
    }, 120_000);
  }

  it('the golden gap lists, exactly', async () => {
    const out: Record<string, Array<[string, string]>> = {};
    for (const sc of scenarios) {
      const f = join(GOLDEN, `census-${sc.name}.json`);
      if (existsSync(f))
        out[sc.name] = gapsOf(CensusRecord.parse(JSON.parse(readFileSync(f, 'utf8'))));
    }
    expect(out).toEqual(EXPECTED_GAPS);
  });

  it('there is no golden file without a scenario', () => {
    const names = new Set(scenarios.map((s) => `census-${s.name}.json`));
    expect(readdirSync(GOLDEN).filter((f) => !names.has(f))).toEqual([]);
  });
});

describe('persistence and the HTTP read', () => {
  it('writes census.assembled on census:<repo_id>:<sha>, folds the read model, serves it', async () => {
    await runScenario({ name: 'p-persist', build: () => undefined }, async (s, census, result) => {
      const stream = censusStream(census.repo.repo_id, census.baseline_sha);
      expect(stream).toBe(`census:acme.app:${result.manifest.head_sha}`);
      const ev = await s.db.pool.query<{
        type: string;
        seq: string;
        body: unknown;
        idempotency_key: string;
      }>('SELECT type, seq, body, idempotency_key FROM record.record_event WHERE stream = $1', [
        stream,
      ]);
      expect(ev.rows).toHaveLength(1);
      expect(ev.rows[0]?.type).toBe('census.assembled');
      const payload = CensusAssembledPayload.parse(ev.rows[0]?.body);
      expect(payload.census_hash).toBe(census.census_hash);
      expect(payload.repo).toBe('acme/app');

      // a second job at the same head appends to the same stream; the latest is the newer one
      const again = await s.runJob();
      expect(again.state).toBe('done');
      const ev2 = await s.db.pool.query<{ seq: string }>(
        'SELECT seq FROM record.record_event WHERE stream = $1 ORDER BY seq',
        [stream],
      );
      expect(ev2.rows.map((r) => Number(r.seq))).toEqual([1, 2]);
      await expectRebuildEqualsLive(s.db.pool, censusProjection);

      // HTTP
      const url = '/v1/repos/acme/app/census/latest';
      expect((await s.call(null, 'GET', url)).status).toBe(401);
      expect((await s.call(s.tokens.none, 'GET', url)).status).toBe(403);
      expect((await s.call(s.tokens.security, 'GET', url)).status).toBe(403);
      expect(
        (await s.call(s.tokens.census, 'GET', '/v1/repos/acme/other/census/latest')).status,
      ).toBe(404);
      const res = await s.call(s.tokens.census, 'GET', url);
      expect(res.status).toBe(200);
      const latest = CensusLatest.parse(res.json);
      expect(latest.job_id).toBe(again.job_id);
      expect(latest.census).toEqual(census);
      expect(latest.gaps).toEqual(census.gaps);
      expect(latest.census_hash).toBe(census.census_hash);
      expect(res.text).not.toContain('fingerprint');
    });
  }, 120_000);
});

/**
 * The exact gaps per scenario at the Census level: gap ids are `gap:<repo_id>:<criterion>:.`, shown as
 * the criterion. Criteria the Census cannot observe (the probe, and what no detector reads yet) are
 * tracked gaps in every scenario; the rest is what the scenario changes.
 */
const COMMON: Array<[string, string]> = [
  'RS-BT-2',
  'RS-BT-4',
  'RS-BT-5',
  'RS-BT-6',
  'RS-BT-7',
  'RS-BT-8',
  'RS-ST-5',
  'RS-TH-1',
  'RS-TH-2',
  'RS-TH-4',
  'RS-CC-3',
  'RS-CC-4',
  'RS-CC-5',
  'RS-CC-6',
  'RS-KN-1',
  'RS-EN-2',
  'RS-PUB-1',
  'RS-PUB-2',
  'RS-PUB-5',
].map((id) => [id, 'tracked']);
const WITH_SEC: Array<[string, string]> = [...COMMON, ['RS-SEC', 'tracked']];
const EXPECTED_GAPS: Record<string, Array<[string, string]>> = {
  'a-clean': COMMON,
  'b-secret-in-history': WITH_SEC,
  'c-dangerous-workflow': WITH_SEC,
  'd-apply-on-merge': [['RS-ID-3', 'blocking'], ...COMMON],
  'e-scan-error': WITH_SEC,
  'f-scan-capped': WITH_SEC,
};
