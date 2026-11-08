import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CATALOGUE, type CatalogueData } from '@aisdlc/catalogue';
import {
  CENSUS_NA_RULES,
  CensusRecord,
  IntakeResult,
  LevelValues,
  PrrPillar,
  READINESS_PILLAR_OF_FAMILY,
  gapId,
  parseGapId,
  type CensusAttestations,
  type CensusCriterionResult,
  type DetectorsResult,
  type Level,
} from '@aisdlc/contracts';
import { canonicalJson } from '@aisdlc/kernel';
import {
  EVALUATORS,
  UNOBSERVED,
  assembleCensus,
  repoIdOf,
  scorePillar,
  toPrrPillars,
  type Row,
} from '../src/census/index.js';
import { detect, FixtureRepo, scratchDir } from '../src/testing.js';
import { ATTESTED, cleanRepo } from './census-helpers.js';

// M6.5: the pure assembly, on results built from real detector runs over fixture repositories (no
// database; the golden tests run the whole job). Fail-closed rules, N/A rules, class and floor
// handling, scoring, determinism.

const scratch = scratchDir();
afterAll(() => scratch.dispose());

const SHA = 'a'.repeat(40);
const HEX = 'b'.repeat(64);

function intakeOf(
  detectors: DetectorsResult | null,
  over: Partial<IntakeResult> = {},
): IntakeResult {
  return IntakeResult.parse({
    repo: 'acme/app',
    base_sha: SHA,
    manifest: {
      repo: 'acme/app',
      head_sha: SHA,
      refs_covered: 'all',
      ref_count: 1,
      commit_count: 1,
      bytes: 1,
      duration_ms: 0,
    },
    bundle_sha256: HEX,
    bundle_bytes: 1,
    refs: [{ name: 'refs/heads/main', sha: SHA }],
    head_tree: { files: 1, bytes: 1 },
    coverage_items: [],
    coverage_counts: {},
    scan_status: 'ok',
    scan_error: null,
    scan_coverage: {
      refs_covered: 'all',
      ref_count: 1,
      commits_scanned: 1,
      blobs_scanned: 1,
      truncated: false,
      cap_reached: false,
      lfs_unscanned: 0,
      submodules_listed: 0,
      rules_version: 'secrets-rules/2:000000000000',
    },
    security_summary: {
      history_scan: {
        status: 'ok',
        refs_covered: 'all',
        commits_scanned: 1,
        truncated: false,
        open: 0,
        rotated: 0,
        false_positive: 0,
        accepted_test_fixture: 0,
        rules_version: 'secrets-rules/2:000000000000',
      },
    },
    finding_counts: { open: 0, rotated: 0, false_positive: 0, accepted_test_fixture: 0 },
    detectors,
    ...over,
  });
}

let clean: IntakeResult;
let cleanDetectors: DetectorsResult;
beforeAll(async () => {
  const repo = cleanRepo(scratch.dir, 'unit-clean');
  repo.commit('c');
  const run = await detect(repo);
  cleanDetectors = run.result;
  clean = intakeOf(cleanDetectors);
});

const gapKey = (c: CensusRecord): string[] => c.gaps.map((g) => g.criterion);
const crit = (c: CensusRecord, id: string): CensusCriterionResult => {
  const r = c.criteria.find((x) => x.id === id);
  if (!r) throw new Error(`no result for ${id}`);
  return r;
};

describe('determinism and shape', () => {
  it('the same inputs give byte-identical canonical JSON, one hash and the same gap ids', () => {
    const a = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    const b = assembleCensus(
      structuredClone(clean),
      CATALOGUE,
      'census',
      structuredClone(ATTESTED),
    );
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(a.census_hash).toBe(b.census_hash);
    expect(a.gaps.map((g) => g.gap_id)).toEqual(b.gaps.map((g) => g.gap_id));
    expect(CensusRecord.parse(a)).toEqual(a);
    // a different input is a different hash
    expect(assembleCensus(clean, CATALOGUE, 'light', ATTESTED).census_hash).not.toBe(a.census_hash);
  });

  it('gap ids are gap:<repo_id>:<criterion>:. through the contracts gapId, one repo-wide area', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    expect(repoIdOf('Acme/App')).toBe('acme.app');
    for (const g of c.gaps) {
      expect(g.gap_id).toBe(gapId('acme.app', g.criterion, '.'));
      expect(parseGapId(g.gap_id)).toEqual({
        repo_id: 'acme.app',
        criterion: g.criterion,
        area: '.',
      });
      expect(g.status).toBe('open');
    }
  });

  it('pins the catalogue, the criteria set, the detector set and the secret rules version', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    expect(c.pins.catalogue.version).toBe(CATALOGUE.version);
    expect(c.pins.criteria_set).toBe(`CRITERIA_V2@${CATALOGUE.version}`);
    expect(c.pins.detector_set_version).toBe(cleanDetectors.detector_set_version);
    expect(c.pins.rules_version).toBe('secrets-rules/2:000000000000');
    expect(c.baseline_sha).toBe(SHA);
    expect(c.refs_covered).toBe('all');
  });
});

describe('every catalogue criterion, at every level', () => {
  for (const level of LevelValues) {
    it(`${level}: one result per criterion in catalogue order, class from the catalogue`, () => {
      const c = assembleCensus(clean, CATALOGUE, level, ATTESTED);
      expect(c.criteria.map((r) => r.id)).toEqual(CATALOGUE.criteria.criteria.map((x) => x.id));
      for (const cr of CATALOGUE.criteria.criteria) {
        const r = crit(c, cr.id);
        expect(r.family).toBe(cr.pillar);
        expect(r.pillar).toBe(READINESS_PILLAR_OF_FAMILY[cr.pillar]);
        expect(r.class).toBe(cr.class_by_level[level]); // solo mode: no escalation
        if (r.class === null) {
          expect(r.status).toBe('na');
          expect(r.na_rule).toBe('NA-LEVEL');
        }
      }
    });
  }

  it('every criterion has an evaluator or a stated reason it cannot be observed, and no more', () => {
    const ids = new Set(CATALOGUE.criteria.criteria.map((x) => x.id));
    for (const id of [...Object.keys(EVALUATORS), ...Object.keys(UNOBSERVED)]) {
      expect(ids.has(id), `${id} is not in the catalogue`).toBe(true);
    }
    for (const id of ids) {
      expect(id in EVALUATORS || id in UNOBSERVED, `${id} has neither`).toBe(true);
      expect(id in EVALUATORS && id in UNOBSERVED, `${id} has both`).toBe(false);
    }
    const c = assembleCensus(clean, CATALOGUE, 'full', ATTESTED);
    expect(c.criteria.flatMap((r) => r.reasons)).not.toContain('no_evaluator');
  });

  it('a criterion with no evaluator is unknown (never met), and a gap', () => {
    const extra: CatalogueData['criteria']['criteria'][number] = {
      id: 'RS-ID-9',
      pillar: 'ID',
      title: 'invented',
      class_by_level: { census: 'SCORED', light: 'SCORED', full: 'SCORED' },
      floors: [],
      escalations: [],
      note: null,
    };
    const cat: CatalogueData = {
      ...CATALOGUE,
      criteria: { ...CATALOGUE.criteria, criteria: [...CATALOGUE.criteria.criteria, extra] },
    };
    const c = assembleCensus(clean, cat, 'census', ATTESTED);
    expect(crit(c, 'RS-ID-9')).toMatchObject({ status: 'unknown', reasons: ['no_evaluator'] });
    expect(gapKey(c)).toContain('RS-ID-9');
    expect(c.pins.catalogue.hash).not.toBe(
      assembleCensus(clean, CATALOGUE, 'census').pins.catalogue.hash,
    );
  });
});

describe('N/A: only by a written deterministic rule', () => {
  it('lists its rules, and uses nothing else', () => {
    expect(Object.keys(CENSUS_NA_RULES).sort()).toEqual([
      'NA-LEVEL',
      'NA-NO-MANIFEST',
      'NA-NO-NESTED-AGENTS',
      'NA-PUBLIC-OR-USER-REPO',
    ]);
    // the catalogue's own note for RS-CC-5 is the source of the public/user rule
    expect(CATALOGUE.criteria.criteria.find((x) => x.id === 'RS-CC-5')?.note).toMatch(
      /N\/A on public or user-owned/,
    );
    for (const level of LevelValues) {
      const c = assembleCensus(clean, CATALOGUE, level, ATTESTED);
      for (const r of c.criteria.filter((x) => x.status === 'na')) {
        expect(Object.keys(CENSUS_NA_RULES)).toContain(r.na_rule);
      }
      expect(c.criteria.filter((r) => r.status !== 'na').every((r) => r.na_rule === null)).toBe(
        true,
      );
    }
  });

  it('NA-LEVEL: a dash in the catalogue at the requested level (RS-AI-2 at Census, not at Light)', () => {
    expect(crit(assembleCensus(clean, CATALOGUE, 'census', ATTESTED), 'RS-AI-2')).toMatchObject({
      status: 'na',
      na_rule: 'NA-LEVEL',
      class: null,
    });
    expect(crit(assembleCensus(clean, CATALOGUE, 'light', ATTESTED), 'RS-AI-2').status).toBe(
      'unknown',
    );
  });

  it('NA-PUBLIC-OR-USER-REPO: RS-CC-5 is N/A on a public repo and on a user-owned one, unknown otherwise', () => {
    const at = (repo: NonNullable<CensusAttestations['repo']>) =>
      crit(assembleCensus(clean, CATALOGUE, 'light', { ...ATTESTED, repo }), 'RS-CC-5');
    expect(at({ visibility: 'public', owner_type: 'org', plan: 'free' }).na_rule).toBe(
      'NA-PUBLIC-OR-USER-REPO',
    );
    expect(at({ visibility: 'private', owner_type: 'user', plan: 'free' }).na_rule).toBe(
      'NA-PUBLIC-OR-USER-REPO',
    );
    expect(at({ visibility: 'private', owner_type: 'org', plan: 'team' })).toMatchObject({
      status: 'unknown',
    });
    // visibility unknown: not N/A
    expect(crit(assembleCensus(clean, CATALOGUE, 'light', {}), 'RS-CC-5').status).toBe('unknown');
  });

  it('NA-NO-NESTED-AGENTS and NA-NO-MANIFEST', async () => {
    expect(crit(assembleCensus(clean, CATALOGUE, 'light', ATTESTED), 'RS-AI-6').na_rule).toBe(
      'NA-NO-NESTED-AGENTS',
    );
    const nested = new FixtureRepo(scratch.dir, 'nested');
    nested.write('AGENTS.md', '# a\n').write('pkg/AGENTS.md', '# b\n').commit('x');
    const n = assembleCensus(intakeOf((await detect(nested)).result), CATALOGUE, 'light', ATTESTED);
    expect(crit(n, 'RS-AI-6')).toMatchObject({
      status: 'unknown',
      reasons: ['nested_location_unchecked'],
    });

    const bare = new FixtureRepo(scratch.dir, 'bare');
    bare.write('notes.txt', 'x\n').commit('x');
    const b = assembleCensus(intakeOf((await detect(bare)).result), CATALOGUE, 'light', ATTESTED);
    expect(crit(b, 'RS-BT-3').na_rule).toBe('NA-NO-MANIFEST');
    // a manifest with no lockfile is a failure, not N/A
    const nolock = new FixtureRepo(scratch.dir, 'nolock');
    nolock.write('package.json', '{"scripts":{}}').commit('x');
    const l = assembleCensus(intakeOf((await detect(nolock)).result), CATALOGUE, 'light', ATTESTED);
    expect(crit(l, 'RS-BT-3')).toMatchObject({ status: 'unmet', reasons: ['lockfile_absent'] });
    // at Light B3 (protect-main) is read and unknown, so the posture is red; at Census it is amber
    expect(l.posture.state).toBe('red');
    const lc = assembleCensus(
      intakeOf((await detect(nolock)).result),
      CATALOGUE,
      'census',
      ATTESTED,
    );
    expect(lc.posture.reasons).toMatchObject([{ kind: 'amber', code: 'no_lockfile' }]);
    expect(lc.posture.state).toBe('amber');
  });
});

describe('classes, floors and gaps', () => {
  it('Census: CF1-CF4 are decided, LF and FF are not_evaluated', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    const st = Object.fromEntries(c.floors.map((f) => [f.id, f.status]));
    expect(st).toMatchObject({ CF1: 'met', CF2: 'met', CF3: 'met', CF4: 'met' });
    for (const id of ['LF1', 'LF2', 'LF3', 'LF4', 'LF5', 'LF6', 'LF7', 'LF8', 'FF1', 'FF2']) {
      expect(st[id], id).toBe('not_evaluated');
    }
    expect(c.floors.map((f) => f.id)).toEqual(CATALOGUE.criteria.floors.map((f) => f.id));
    expect(c.floors.find((f) => f.id === 'LF3')?.criteria).toEqual(
      CATALOGUE.criteria.floors.find((f) => f.id === 'LF3')?.criteria,
    );
  });

  it('Light: LF is decided and unknown counts as unmet; FF stays not_evaluated', () => {
    const c = assembleCensus(clean, CATALOGUE, 'light', ATTESTED);
    const st = Object.fromEntries(c.floors.map((f) => [f.id, f.status]));
    expect(st['LF3']).toBe('unknown'); // the probe is pending
    expect(st['LF5']).toBe('unknown'); // nothing is affirmed yet
    expect(st['FF1']).toBe('not_evaluated');
    expect(st['LF4']).toBe('unknown'); // inventoried, but the isolation test has not run
    const full = assembleCensus(clean, CATALOGUE, 'full', ATTESTED);
    expect(full.floors.find((f) => f.id === 'FF1')?.status).toBe('unknown');
  });

  for (const level of LevelValues) {
    it(`${level}: severity is blocking iff the criterion is a FLOOR at that level; ADVISORY makes no gap`, () => {
      const c = assembleCensus(clean, CATALOGUE, level, ATTESTED);
      for (const g of c.gaps) {
        const r = crit(c, g.criterion);
        expect(['unmet', 'unknown']).toContain(r.status);
        expect(r.class).not.toBe('ADVISORY');
        expect(g.severity).toBe(r.class === 'FLOOR' ? 'blocking' : 'tracked');
        expect(g.blocks_level).toBe(r.class === 'FLOOR' ? level : null);
        expect(r.gap_id).toBe(g.gap_id);
      }
      const gapped = new Set(c.gaps.map((g) => g.criterion));
      for (const r of c.criteria) {
        if (r.status === 'unmet' || r.status === 'unknown') {
          expect(gapped.has(r.id), r.id).toBe(r.class !== 'ADVISORY');
        } else expect(gapped.has(r.id)).toBe(false);
      }
    });
  }

  it('Light: the unobserved floor criteria are blocking gaps that default to file_issue', () => {
    const c = assembleCensus(clean, CATALOGUE, 'light', ATTESTED);
    const g = c.gaps.find((x) => x.criterion === 'RS-BT-2');
    expect(g).toMatchObject({
      severity: 'blocking',
      blocks_level: 'light',
      disposition: 'file_issue',
      visibility_class: 'public_safe',
    });
    expect(c.gaps.find((x) => x.criterion === 'RS-BT-4')).toMatchObject({
      severity: 'tracked',
      disposition: 'track_only',
    });
  });

  it('RS-SEC and any security-derived gap are private_only and track_only, even when blocking', () => {
    const d: DetectorsResult = {
      ...cleanDetectors,
      lint: { ...cleanDetectors.lint, blocking: 1, by_rule: { 'L-SECRET': 1 } },
    };
    const c = assembleCensus(
      intakeOf(d, {
        finding_counts: { open: 1, rotated: 0, false_positive: 0, accepted_test_fixture: 0 },
      }),
      CATALOGUE,
      'light',
      ATTESTED,
    );
    for (const id of ['RS-SEC', 'RS-AI-3']) {
      expect(
        c.gaps.find((g) => g.criterion === id),
        id,
      ).toMatchObject({
        severity: 'blocking',
        disposition: 'track_only',
        visibility_class: 'private_only',
      });
    }
    // and their results carry no path
    expect(
      crit(c, 'RS-AI-3').evidence.every((e) => e.path === undefined && e.line === undefined),
    ).toBe(true);
    expect(
      c.gaps
        .filter((g) => g.visibility_class === 'private_only')
        .map((g) => g.criterion)
        .sort(),
    ).toEqual(['RS-AI-3', 'RS-SEC']);
  });

  it('team mode raises RS-CC-1/2 to FLOOR, and RS-PUB-1/2 only on a public (or unknown) repo', () => {
    const team = (repo?: CensusAttestations['repo']) =>
      assembleCensus(clean, CATALOGUE, 'light', {
        ...ATTESTED,
        mode: 'team',
        ...(repo ? { repo } : {}),
      });
    const priv = team({ visibility: 'private', owner_type: 'org', plan: 'team' });
    expect(crit(priv, 'RS-CC-1')).toMatchObject({ class: 'FLOOR', escalated: true });
    expect(crit(priv, 'RS-PUB-1')).toMatchObject({ class: 'SCORED', escalated: false });
    const pub = team({ visibility: 'public', owner_type: 'org', plan: 'team' });
    expect(crit(pub, 'RS-PUB-1')).toMatchObject({ class: 'FLOOR', escalated: true });
    expect(pub.gaps.find((g) => g.criterion === 'RS-PUB-1')?.severity).toBe('blocking');
    expect(crit(assembleCensus(clean, CATALOGUE, 'light', ATTESTED), 'RS-CC-1').class).toBe(
      'SCORED',
    );
  });
});

describe('fail closed', () => {
  it('nothing attested: CF1-CF4 unknown (blocking gaps), B4 unknown, posture red', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census');
    expect(c.floors.filter((f) => f.id.startsWith('CF')).map((f) => f.status)).toEqual([
      'unknown',
      'unknown',
      'unknown',
      'unknown',
    ]);
    expect(c.gaps.filter((g) => g.severity === 'blocking').map((g) => g.criterion)).toEqual([
      'RS-ID-1',
      'RS-ID-2',
      'RS-ID-3',
      'RS-ID-4',
    ]);
    expect(c.blockers.find((b) => b.id === 'B4')).toMatchObject({
      status: 'unknown',
      reasons: ['installation_unknown'],
    });
    expect(c.posture.state).toBe('red');
    expect(c.posture.reasons).toMatchObject([
      { kind: 'blocker', blocker: 'B4', status: 'unknown' },
    ]);
    expect(c.risk_category.blocks_m4_reasons).toEqual(
      ['regulatory_unattested', 'criticality_unattested', 't0_unattested'].sort(
        (a, b) =>
          ['t0_unattested', 'regulatory_unattested', 'criticality_unattested'].indexOf(a) -
          ['t0_unattested', 'regulatory_unattested', 'criticality_unattested'].indexOf(b),
      ),
    );
    expect(c.risk_category).toMatchObject({
      regulatory: 'unattested',
      criticality: 'unattested',
      t0: 'unattested',
    });
  });

  it('B4: administration or workflows is B4a, statuses with an unpinned required check is B4b, pinned is amber', () => {
    const inst = (
      permissions: Record<string, 'read' | 'write' | 'admin'>,
      checks?: CensusAttestations['required_checks'],
    ) =>
      assembleCensus(clean, CATALOGUE, 'census', {
        ...ATTESTED,
        installation: { repository_selection: 'selected', permissions },
        ...(checks === undefined ? {} : { required_checks: checks }),
      });
    expect(inst({ administration: 'write' }).blockers.find((b) => b.id === 'B4')).toMatchObject({
      status: 'blocked',
      reasons: ['B4a'],
    });
    expect(inst({ workflows: 'write' }).posture.state).toBe('red');
    expect(inst({ statuses: 'write' }).blockers.find((b) => b.id === 'B4')).toMatchObject({
      status: 'unknown',
      reasons: ['B4b_required_checks_unknown'],
    });
    expect(inst({ statuses: 'write' }, null).posture.state).toBe('red');
    expect(
      inst({ statuses: 'write' }, [{ name: 'gate-check' }]).blockers.find((b) => b.id === 'B4'),
    ).toMatchObject({ status: 'blocked', reasons: ['B4b'] });
    const pinned = inst({ statuses: 'write' }, [{ name: 'gate-check', integration_id: 7 }]);
    expect(pinned.blockers.find((b) => b.id === 'B4')?.status).toBe('met');
    expect(pinned.posture).toMatchObject({
      state: 'amber',
      reasons: [{ kind: 'amber', code: 'b4c_statuses_pinned' }],
    });
  });

  it('no detectors result: every detector fact is unknown, B5 and B6 unknown, the tier floor is a lower bound', () => {
    const c = assembleCensus(intakeOf(null), CATALOGUE, 'census', ATTESTED);
    expect(c.detectors).toBeNull();
    expect(c.pins.detector_set_version).toBeNull();
    expect(blockerOf(c, 'B5')).toBe('unknown');
    expect(blockerOf(c, 'B6')).toBe('unknown');
    expect(c.posture.state).toBe('red');
    expect(c.risk_category).toMatchObject({ floor_basis: 'incomplete', tier_floor: 'T0' });
    expect(c.risk_category.blocks_m4_reasons).toContain('detectors_incomplete');
    expect(crit(c, 'RS-BT-1').status).toBe('unknown');
    expect(crit(c, 'RS-AI-1').status).toBe('unknown');
    expect(c.inventory.status).toBe('incomplete');
  });

  it('a failed detector makes its own facts unknown, not "none found"', () => {
    const d: DetectorsResult = {
      ...cleanDetectors,
      status: 'error',
      errors: [
        {
          detector: 'task_contract',
          code: 'detector_failed',
          message: 'the task_contract detector failed (detector_failed)',
        },
      ],
    };
    const c = assembleCensus(intakeOf(d), CATALOGUE, 'census', ATTESTED);
    expect(crit(c, 'RS-BT-1')).toMatchObject({
      status: 'unknown',
      reasons: ['detector_incomplete:task_contract'],
    });
    expect(crit(c, 'RS-AI-1').status).toBe('met'); // the inventory detector ran
    expect(c.detectors?.error_codes).toEqual(['task_contract:detector_failed']);
  });

  it('B5 unknown (a workflow could not be read) is open for the posture', () => {
    const d: DetectorsResult = {
      ...cleanDetectors,
      b5: { ...cleanDetectors.b5, status: 'unknown', workflows_unanalysed: 1 },
    };
    const c = assembleCensus(intakeOf(d), CATALOGUE, 'census', ATTESTED);
    expect(c.blockers.find((b) => b.id === 'B5')).toMatchObject({
      status: 'unknown',
      reasons: ['workflows_unanalysed'],
    });
    expect(c.posture.state).toBe('red');
  });

  it('B2: an error, a cap or a cut-short walk is blocked; default_only is a note at Census and a blocker at Light', () => {
    const cov = clean.scan_coverage;
    const dflt = intakeOf(cleanDetectors, {
      manifest: { ...clean.manifest, refs_covered: 'default_only' },
      scan_coverage: { ...cov, refs_covered: 'default_only' },
    });
    const census = assembleCensus(dflt, CATALOGUE, 'census', ATTESTED);
    expect(census.blockers.find((b) => b.id === 'B2')).toMatchObject({
      status: 'met',
      reasons: [],
      notes: ['refs_default_only'],
    });
    expect(census.posture.state).toBe('green');
    expect(census.refs_covered).toBe('default_only');
    const light = assembleCensus(dflt, CATALOGUE, 'light', ATTESTED);
    expect(light.blockers.find((b) => b.id === 'B2')).toMatchObject({
      status: 'blocked',
      reasons: ['refs_default_only'],
    });
    expect(light.posture.state).toBe('red');
    for (const over of [{ truncated: true }, { cap_reached: true }] as const) {
      const c = assembleCensus(
        intakeOf(cleanDetectors, { scan_coverage: { ...cov, ...over } }),
        CATALOGUE,
        'census',
        ATTESTED,
      );
      expect(c.blockers.find((b) => b.id === 'B2')?.status).toBe('blocked');
      expect(c.blockers.find((b) => b.id === 'B1')?.status).toBe('unknown');
    }
    const errored = assembleCensus(
      intakeOf(cleanDetectors, {
        scan_status: 'error',
        scan_error: { code: 'git_failed', message: 'x' },
      }),
      CATALOGUE,
      'census',
      ATTESTED,
    );
    expect(errored.blockers.find((b) => b.id === 'B2')?.reasons).toEqual(['scan_error']);
  });

  it('B1 reads the counts: open blocks; rotated, false_positive and accepted_test_fixture do not, and are all counted', () => {
    const counts = { open: 0, rotated: 1, false_positive: 2, accepted_test_fixture: 3 };
    const ok = assembleCensus(
      intakeOf(cleanDetectors, {
        finding_counts: counts,
        security_summary: { history_scan: { ...clean.security_summary.history_scan, ...counts } },
      }),
      CATALOGUE,
      'census',
      ATTESTED,
    );
    expect(blockerOf(ok, 'B1')).toBe('met');
    expect(ok.security_summary.history_scan).toMatchObject(counts);
    const open = assembleCensus(
      intakeOf(cleanDetectors, { finding_counts: { ...counts, open: 1 } }),
      CATALOGUE,
      'census',
      ATTESTED,
    );
    expect(blockerOf(open, 'B1')).toBe('blocked');
    expect(open.posture.state).toBe('red');
    expect(crit(open, 'RS-SEC')).toMatchObject({ status: 'unmet', reasons: ['B1'] });
  });
});

const blockerOf = (c: CensusRecord, id: string) => c.blockers.find((b) => b.id === id)?.status;

describe('RiskCategory', () => {
  it('reads signals with evidence and who raised them; T0 needs a positive attestation (DEC-4)', async () => {
    const r = new FixtureRepo(scratch.dir, 'risky');
    r.write('db/migrate/001.rb', 'x\n')
      .write('terraform/main.tf', 'resource "x" "y" {}\n')
      .commit('x');
    const c = assembleCensus(intakeOf((await detect(r)).result), CATALOGUE, 'census', ATTESTED);
    expect(c.risk_category.tier_floor).toBe('T1');
    expect(c.risk_category.signals.map((s) => s.signal)).toEqual(['br.iac', 'br.migration']);
    expect(c.risk_category.signals.every((s) => s.evidence.length > 0 && s.evidence[0]?.blob)).toBe(
      true,
    );
    expect(c.risk_category.raised_by).toEqual(['tier_blast_radius']);
    expect(c.risk_category.t0).toBe('not_applicable');
    expect(c.risk_category.blocks_m4_until_attested).toBe(false);
    // signed T0 under a T1 floor: raise-only is violated
    expect(crit(c, 'RS-ID-3')).toMatchObject({ status: 'unmet', reasons: ['signed_below_floor'] });

    const t0 = assembleCensus(clean, CATALOGUE, 'census', {
      ...ATTESTED,
      tier: {
        signed: 'T0',
        regulatory_attested: true,
        criticality_attested: true,
        t0_attested: false,
      },
    });
    expect(t0.risk_category).toMatchObject({
      t0: 'unattested',
      blocks_m4_until_attested: true,
      blocks_m4_reasons: ['t0_unattested'],
    });
    expect(crit(t0, 'RS-ID-3')).toMatchObject({ status: 'unmet', reasons: ['t0_unattested'] });
  });
});

describe('pre-score', () => {
  const row = (
    pillar: Row['result']['pillar'],
    scoring: Row['result']['scoring_class'],
    observed: Row['result']['observed'],
    cls: Row['result']['class'] = scoring,
    specialNa = false,
  ): Row => ({
    specialNa,
    result: {
      id: 'RS-BT-1',
      family: 'BT',
      pillar,
      class: cls,
      escalated: false,
      scoring_class: scoring,
      status: observed === 'pass' ? 'met' : observed === 'fail' ? 'unmet' : 'unknown',
      observed,
      na_rule: null,
      reasons: [],
      evidence: [],
    },
  });
  const level = (rows: Row[]): number => scorePillar('VRL', rows).level;

  it('RL0: a FLOOR at the requested level is unmet or unknown; RL1 otherwise', () => {
    expect(level([row('VRL', 'FLOOR', 'unknown')])).toBe(0);
    expect(level([row('VRL', 'FLOOR', 'fail'), row('VRL', 'SCORED', 'pass')])).toBe(0);
    expect(level([row('VRL', 'FLOOR', 'pass'), row('VRL', 'SCORED', 'unknown')])).toBe(1);
    // a floor at the scoring level only (not the requested one) does not zero the pillar
    expect(level([row('VRL', 'FLOOR', 'unknown', 'RECORDED')])).toBe(1);
  });

  it('RL2 needs every scored criterion measured; RL3 the 80% rule on SCORED; RL4 everything passing', () => {
    expect(level([row('VRL', 'RECORDED', 'fail'), row('VRL', 'SCORED', 'fail')])).toBe(2);
    const four = [1, 2, 3, 4].map(() => row('VRL', 'SCORED', 'pass'));
    expect(level([...four, row('VRL', 'SCORED', 'fail')])).toBe(3); // 4 of 5 = 80%
    expect(
      level([...four.slice(0, 3), row('VRL', 'SCORED', 'fail'), row('VRL', 'SCORED', 'fail')]),
    ).toBe(2); // 3 of 5
    expect(level([...four, row('VRL', 'SCORED', 'pass')])).toBe(4);
    expect(level([...four, row('VRL', 'RECORDED', 'fail'), row('VRL', 'SCORED', 'pass')])).toBe(3);
  });

  it('ADVISORY and written N/A criteria are not scored; none scored is 100%', () => {
    expect(
      level([
        row('VRL', 'SCORED', 'pass'),
        row('VRL', 'ADVISORY', 'unknown'),
        row('VRL', 'SCORED', 'unknown', 'SCORED', true),
      ]),
    ).toBe(4);
    expect(level([row('VRL', 'RECORDED', 'pass')])).toBe(4);
    expect(level([row('VRL', null, 'unknown')])).toBe(4);
  });

  it('the composite is the min of VRL, ERL, ORL and KRL; Census scores against the Light classes', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    expect(c.pre_score.basis_level).toBe('light');
    expect(c.pre_score.pillars.map((p) => p.pillar)).toEqual(['VRL', 'ERL', 'ORL', 'KRL']);
    expect(c.pre_score.composite).toBe(Math.min(...c.pre_score.pillars.map((p) => p.level)));
    // the probe is pending, so the VRL family is unmeasured and VRL stays under RL2
    expect(c.pre_score.pillars.find((p) => p.pillar === 'VRL')?.level).toBeLessThan(2);
    expect(c.probe).toEqual({ state: 'pending', blocker: 'B7', counts_only_in: 'K-exec' });
    // unattested owner: ORL is 0 (CF2 open) and so is the composite
    const bare = assembleCensus(clean, CATALOGUE, 'census');
    expect(bare.pre_score.pillars.find((p) => p.pillar === 'ORL')?.level).toBe(0);
    expect(bare.pre_score.composite).toBe(0);
    expect(assembleCensus(clean, CATALOGUE, 'light', ATTESTED).pre_score.basis_level).toBe('light');
    expect(assembleCensus(clean, CATALOGUE, 'full', ATTESTED).pre_score.basis_level).toBe('full');
  });

  it('hands the PRR builder its pillars in the PRR shape, N/A left out', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    const pillars = toPrrPillars(c);
    for (const p of pillars) expect(PrrPillar.parse(p)).toEqual(p);
    expect(pillars.map((p) => p.pillar)).toEqual(['VRL', 'ERL', 'ORL', 'KRL']);
    const all = pillars.flatMap((p) => p.criteria);
    expect(all.length).toBe(c.criteria.filter((r) => r.status !== 'na').length);
    expect(all.find((x) => x.id === 'RS-BT-2')).toMatchObject({
      met: 'unknown',
      class: 'RECORDED',
      gap_id: 'gap:acme.app:RS-BT-2:.',
    });
    expect(all.find((x) => x.id === 'RS-ID-2')).toMatchObject({ met: true, class: 'FLOOR' });
  });
});

describe('inventory and the rest of the record', () => {
  it('summarises the instruction and harness inventory (kinds, counts, auto-run) without paths', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    expect(c.inventory.status).toBe('complete');
    expect(c.inventory.kinds.find((k) => k.inventory === 'agents_md')).toMatchObject({
      state: 'data',
      file_count: 1,
    });
    expect(c.inventory.kinds.find((k) => k.inventory === 'mcp_json')).toMatchObject({
      state: 'absent',
      file_count: 0,
    });
    expect(c.inventory.agents).toMatchObject({ root_present: true, nested: 0 });
    expect(c.inventory.files_total).toBeGreaterThanOrEqual(2);
    expect(JSON.stringify(c.inventory)).not.toContain('AGENTS.md');
  });

  it('carries the repo identity and the coverage counts', () => {
    const c = assembleCensus(
      intakeOf(cleanDetectors, { coverage_counts: { unparseable_file: 2, lfs_pointer: 1 } }),
      CATALOGUE,
      'census',
      ATTESTED,
    );
    expect(c.repo).toMatchObject({
      full_name: 'acme/app',
      owner: 'acme',
      name: 'app',
      repo_id: 'acme.app',
      visibility: 'private',
      owner_type: 'org',
      plan: 'team',
      default_branch: 'main',
      archetype: null,
    });
    expect(c.coverage_counts).toEqual({ lfs_pointer: 1, unparseable_file: 2 });
    expect(c.census_id).toBe(`census:acme.app:${SHA}`);
    const custom = assembleCensus(clean, CATALOGUE, 'census', { ...ATTESTED, repo_id: 'proj-1' });
    expect(custom.repo.repo_id).toBe('proj-1');
    expect(custom.gaps.every((g) => g.repo_id === 'proj-1')).toBe(true);
  });

  it('the contract refuses a record whose hash, posture or composite is off', () => {
    const c = assembleCensus(clean, CATALOGUE, 'census', ATTESTED);
    expect(CensusRecord.safeParse({ ...c, requested_level: 'light' as Level }).success).toBe(false);
    expect(CensusRecord.safeParse({ ...c, posture: { ...c.posture, state: 'red' } }).success).toBe(
      false,
    );
    expect(
      CensusRecord.safeParse({ ...c, pre_score: { ...c.pre_score, composite: 4 } }).success,
    ).toBe(false);
    expect(CensusRecord.safeParse({ ...c, secret_fingerprint: 'x' }).success).toBe(false);
  });
});
