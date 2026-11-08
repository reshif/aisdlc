import {
  PRR_FRESH_DAYS,
  ProjectReadinessRecord,
  prrRecordHash,
  toPrrPillars,
  type Gap,
  type PrincipalId,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import { beforeAll, describe, expect, it } from 'vitest';
import { computeAutonomy, expectedSigner, routeLane } from '../src/index.js';
import { censusFixture } from './cards-fixtures.js';
import {
  GATING_ON,
  NOW,
  REPO,
  alice,
  built,
  good,
  inputs,
  loadReports,
  refused,
  unprotected,
} from './prr-fixtures.js';

beforeAll(loadReports);

// The PRR builder (PLAN M7.4): pure, golden. Each cap of OB §2.3 is the binding minimum at least
// once, and the refinements of the contract (T2 gating floor, a blocking gap open at the signed
// level) refuse a record rather than produce one.

describe('computeAutonomy: every cap is the binding minimum at least once (OB §2.3)', () => {
  const at = new Date('2026-11-09T10:00:00.000Z');
  const base = {
    tier: 'T0',
    level: 'full',
    composite: 4,
    posture: 'green',
    issued_at: at,
  } as const;

  it('tier: T2 caps at A2 (shown once probation is behind it: no record can show it at issue)', () => {
    const a = computeAutonomy({ ...base, tier: 'T2', afterProbation: true });
    expect(a).toMatchObject({ tier_cap: 'A2', effective: 'A2', binding: ['tier'] });
    expect(computeAutonomy({ ...base, tier: 'T1', afterProbation: true })).toMatchObject({
      tier_cap: 'A3',
      effective: 'A3',
    });
  });

  it('level: Census caps at A0; Light and Full state no cap', () => {
    const a = computeAutonomy({ ...base, level: 'census', afterProbation: true });
    expect(a).toMatchObject({ effective: 'A0', binding: ['level'] });
    expect(computeAutonomy({ ...base, level: 'light', afterProbation: true }).effective).toBe('A3');
  });

  it('readiness: RL1 A0, RL2 A1, RL3 A2, RL4 A3; the composite is the min, RL0 fails closed to A0', () => {
    const e = (composite: number) =>
      computeAutonomy({ ...base, composite, afterProbation: true }).effective;
    expect([0, 1, 2, 3, 4].map(e)).toEqual(['A0', 'A0', 'A1', 'A2', 'A3']);
    expect(computeAutonomy({ ...base, composite: 2, afterProbation: true }).binding).toEqual([
      'readiness',
    ]);
  });

  it('posture: red A0, amber A1, green no constraint', () => {
    expect(computeAutonomy({ ...base, posture: 'red', afterProbation: true })).toMatchObject({
      posture_cap: 'A0',
      effective: 'A0',
      binding: ['posture'],
    });
    expect(computeAutonomy({ ...base, posture: 'amber', afterProbation: true })).toMatchObject({
      posture_cap: 'A1',
      effective: 'A1',
      binding: ['posture'],
    });
    expect(
      computeAutonomy({ ...base, posture: 'green', afterProbation: true }).posture_cap,
    ).toBeNull();
  });

  it('probation: A1 for four weeks from issue, whatever else allows; it ends by the earn rule, not the clock', () => {
    const a = computeAutonomy(base);
    expect(a).toMatchObject({ effective: 'A1', binding: ['probation'] });
    expect(a.probation_until).toBe('2026-12-07T10:00:00.000Z'); // issued_at + 28 days
    // Nothing earned: the same record a year later (clock past probation_until) is still capped, in
    // this model, until a human loosens it (the record is re-issued by an M4).
    expect(computeAutonomy({ ...base, tier: 'T2' }).effective).toBe('A1');
  });
});

describe('buildPrr: the record, golden', () => {
  it('a clean Census: one area, tier from card 1, pillars from the census, composite = min, caps, lanes, writes, +90 d', () => {
    const prr = built(inputs());
    const census = censusFixture(REPO).census;
    expect(ProjectReadinessRecord.safeParse(prr).success).toBe(true);
    expect(prr).toMatchObject({
      schema: 'prr/1',
      record_id: 'prr:prr-unit:acme.prr-unit',
      version: 1,
      supersedes: null,
      status: 'proposed',
      m4: null,
      baseline_sha: census.baseline_sha,
      level: {
        requested: 'census',
        signed: 'census',
        by_area: { '.': 'census' },
        steps: {
          '0.1': 'done',
          '0.2': 'not_requested',
          '0.3': 'not_requested',
          '0.4': 'done',
          '0.5': 'done',
        },
      },
      tier: { value: 'T0', floor: 'T0', raised_by: [], t0_attested: true },
      composite: 1,
      autonomy: {
        tier_cap: 'A3',
        level_cap: 'A0',
        readiness_cap: 'A0',
        posture_cap: null,
        effective: 'A0',
        lanes_eligible: ['L8'],
        r3_zones: [],
        probation_until: '2026-12-07T10:00:00.000Z',
      },
      writes: 'docs',
      issued_at: '2026-11-09T10:00:00.000Z',
      fresh_until: '2027-02-07T10:00:00.000Z',
      review_by: null,
      signer: { principal: 'alice', role: 'TL', mode: 'solo', sod_waiver: true },
    });
    expect(prr.pillars).toEqual(toPrrPillars(census));
    expect(prr.composite).toBe(Math.min(...prr.pillars.map((p) => p.level)));
    expect(prr.tier.risk_category_hash).toBe(hashCanonical(census.risk_category));
    expect(prr.gaps).toHaveLength(census.gaps.length);
    expect(prr.gaps.every((g) => g.disposition === 'track_only' && g.status === 'open')).toBe(true);
    expect(prr.pins.governance_cap_map).toBe('governance-caps/1');
    // controls are what 0.4 observed
    expect(prr.controls).toMatchObject({
      attested: { bypass_has_no_factory_app: true, by: 'alice' },
      app_installation: { installation_id: 4242, repository_selection: 'selected' },
      sensitive_paths_hash: good.sensitive_paths_hash,
    });
    expect(prr.controls.effective_rules?.required_checks).toEqual([
      { name: 'gate-check', integration_id: 99 },
    ]);
    // counts only: no finding, no fingerprint, no value
    expect(Object.keys(prr.security_summary.history_scan).sort()).toEqual(
      [
        'accepted_test_fixture',
        'commits_scanned',
        'false_positive',
        'open',
        'refs_covered',
        'rotated',
        'rules_version',
        'status',
        'truncated',
      ].sort(),
    );
    // sealed: the hash is the content's, and status, m4 and freshness are outside it
    expect(prr.record_hash).toBe(prrRecordHash(prr));
    expect(
      prrRecordHash({ ...prr, status: 'active', m4: null, freshness: { ...prr.freshness } }),
    ).toBe(prr.record_hash);
    expect(PRR_FRESH_DAYS).toBe(90);
  });

  it('is deterministic: the same inputs give the same bytes; another instant gives another record', () => {
    expect(JSON.stringify(built(inputs()))).toBe(JSON.stringify(built(inputs())));
    const later = built(inputs({ over: { now: new Date(NOW.getTime() + 1000) } }));
    expect(later.record_hash).not.toBe(built(inputs()).record_hash);
  });

  it('Light: review_by +3 months, agent lanes L1-L3 open, writes agent; Full: +12 months and L4-L6', () => {
    const light = built(inputs({ level: 'light' }));
    expect(light.review_by).toBe('2027-02-09T10:00:00.000Z');
    expect(light.autonomy.lanes_eligible).toEqual(['L1', 'L2', 'L3', 'L8']);
    expect(light.writes).toBe('agent');
    expect(light.autonomy.level_cap).toBe('A3'); // no level cap is stated above Census
    expect(light.autonomy.effective).toBe('A0'); // readiness RL1 binds
    const full = built(inputs({ level: 'full' }));
    expect(full.review_by).toBe('2027-11-09T10:00:00.000Z');
    expect(full.autonomy.lanes_eligible).toEqual(['L1', 'L2', 'L3', 'L4', 'L6', 'L8']); // L5 needs FF2
  });

  it('T2 needs Full for any agent-led lane, so a T2 Light record has docs writes and no agent lane', () => {
    const t2 = built(inputs({ tier: 'T2', level: 'light' }));
    expect(t2.autonomy).toMatchObject({ tier_cap: 'A2', lanes_eligible: ['L8'] });
    expect(t2.writes).toBe('docs');
    expect(t2.signer.sod_waiver).toBe(false);
  });

  it('a read-only Census signs without B3 (writes none); Light and Full cannot', () => {
    const none = built(inputs({ report: unprotected }));
    expect(none.writes).toBe('none');
    const e = refused(inputs({ level: 'light', report: unprotected }));
    expect(e.code).toBe('b3_not_met');
  });

  it('a red posture confines the lanes to Census lanes and caps at A0', () => {
    const red = built(inputs({ level: 'light', census: { golden: 'b' } }));
    expect(red.autonomy).toMatchObject({
      posture_cap: 'A0',
      lanes_eligible: ['L8'],
      effective: 'A0',
    });
    expect(red.writes).toBe('docs');
  });

  it('records who raised the tier: the detectors (a9), the owner at the request or on card 1', () => {
    const raised = built(
      inputs({ tier: 'T2', census: { tierFloor: 'T1' }, over: { attested_floor: null } }),
    );
    expect(raised.tier).toMatchObject({ value: 'T2', floor: 'T2' });
    const owner = built({
      ...inputs({ tier: 'T1' }),
      c1: { ...inputs({ tier: 'T1' }).c1, tier: 'T2', floor: 'T1' },
      c4: { ...inputs({ tier: 'T2' }).c4 },
      signer: { principal: alice, role: 'FGB', mode: 'team', sod_waiver: false },
    });
    expect(owner.tier.raised_by).toContain('owner');
  });

  it('applies card 1: a waived gap carries its waiver; a gap not disposed of refuses', () => {
    const i = inputs();
    const first = i.census.gaps[0]!;
    const waived = built({
      ...i,
      c1: {
        ...i.c1,
        gap_rows: i.c1.gap_rows.map((r) =>
          r.gap_id === first.gap_id
            ? {
                ...r,
                disposition: 'waive' as const,
                waiver: {
                  reason: 'accepted for now',
                  expires_at: '2027-01-01T00:00:00.000Z' as never,
                },
              }
            : r,
        ),
      },
    });
    const g = waived.gaps.find((x) => x.gap_id === first.gap_id)!;
    expect(g).toMatchObject({
      disposition: 'waive',
      status: 'waived',
      waiver: { granted_by: 'alice' },
    });
    expect(refused({ ...i, c1: { ...i.c1, gap_rows: i.c1.gap_rows.slice(1) } }).code).toBe(
      'gap_not_disposed',
    );
  });
});

describe('buildPrr: the refinements refuse a record', () => {
  it('a blocking gap open at the signed level is refused; signing the level below it is not', () => {
    const light = (g: Gap[]) =>
      g.map((x, i) =>
        i === 0 ? { ...x, severity: 'blocking' as const, blocks_level: 'light' as const } : x,
      );
    const e = refused(inputs({ level: 'light', requested: 'light', gaps: light }));
    expect(e).toMatchObject({ code: 'blocking_gap_open' });
    expect(e.issues).toHaveLength(1);
    // the human signs Census instead (requested stays Light, DEC-9)
    const lower = built(inputs({ level: 'census', requested: 'light', gaps: light }));
    expect(lower.level).toMatchObject({ requested: 'light', signed: 'census' });
    expect(lower.gaps.find((g) => g.severity === 'blocking')).toMatchObject({ status: 'open' });
  });

  it('T2 cannot turn off G2, G3d or G3 for L4-L6, or G5 where it deploys (the gating floor)', () => {
    const off = { ...GATING_ON, gates: { ...GATING_ON.gates, g2: 'off' as const } };
    expect(refused(inputs({ tier: 'T2', gating: off }))).toMatchObject({ code: 'gating_floor' });
    // T0 and T1 may
    expect(built(inputs({ tier: 'T1', gating: off })).gating_profile.gates.g2).toBe('off');
    // an unknown "deploys" counts as deploying (unknown is unmet)
    const g5off = { ...GATING_ON, gates: { ...GATING_ON.gates, g5: 'off' as const } };
    expect(refused(inputs({ tier: 'T2', gating: g5off, over: { deploys: null } })).code).toBe(
      'gating_floor',
    );
    expect(built(inputs({ tier: 'T2', gating: g5off, over: { deploys: false } })).tier.value).toBe(
      'T2',
    );
  });

  it('a T2 record locks two-person on and carries no sod_waiver', () => {
    const i = inputs({ tier: 'T2' });
    expect(built(i).role_map.two_person).toMatchObject({ locked_on: true, enabled: true });
    expect(refused({ ...i, signer: { ...i.signer, sod_waiver: true } }).issues.join(' ')).toMatch(
      /sod_waiver is never stamped for T2/,
    );
    expect(
      refused({
        ...i,
        c4: { ...i.c4, two_person: { enabled: true, default: 'on_if_2plus', locked_on: false } },
      }).issues.join(' '),
    ).toMatch(/T2 project has two-person locked on/);
  });

  it('M4 cannot sign while the census says the owner has not attested (T0, regulatory, criticality) or the detectors did not finish', () => {
    const census = { unattested: true };
    const i = inputs({ census });
    const none = {
      ...i,
      c1: { ...i.c1, t0_attested: false, regulatory_attested: false, criticality_attested: false },
    };
    const e = refused(none);
    expect(e).toMatchObject({ code: 'risk_unattested' });
    expect(e.issues).toEqual(['t0_unattested', 'regulatory_unattested', 'criticality_unattested']);
    // each attestation clears its own reason; raising the tier above T0 clears the T0 claim
    expect(
      refused({ ...none, c1: { ...none.c1, t0_attested: true, regulatory_attested: true } }).issues,
    ).toEqual(['criticality_unattested']);
    expect(
      built({
        ...i,
        c1: { ...i.c1, t0_attested: true, regulatory_attested: true, criticality_attested: true },
      }).tier.t0_attested,
    ).toBe(true);
    const t1 = inputs({ census, tier: 'T1' });
    expect(
      built({ ...t1, c1: { ...t1.c1, regulatory_attested: true, criticality_attested: true } })
        .tier,
    ).toMatchObject({ value: 'T1', t0_attested: false });
    // an incomplete detector run is not the owner's to attest
    const inc = inputs({ census: { detectorsIncomplete: true } });
    expect(refused(inc)).toMatchObject({
      code: 'risk_unattested',
      issues: ['detectors_incomplete'],
    });
  });

  it('unknown is unmet: unreadable repo facts, an unreadable installation, a step not done', () => {
    const i = inputs();
    expect(
      refused({ ...i, census: { ...i.census, repo: { ...i.census.repo, visibility: null } } }).code,
    ).toBe('repo_facts_unknown');
    expect(
      refused({
        ...i,
        c4: {
          ...i.c4,
          report: {
            ...i.c4.report,
            app_installation: { ...i.c4.report.app_installation, read: 'unknown' },
          },
        },
      }).code,
    ).toBe('installation_unknown');
    expect(refused({ ...i, s0: { ...i.s0, step_0_2: 'card' } }).code).toBe('step_not_done');
  });
});

describe('who signs (expectedSigner)', () => {
  const holders = ['bob', 'alice'] as PrincipalId[];
  const base = { two_person_enabled: true, team_mode: false, requester: alice } as const;
  it('the requester if they hold m4, else the first holder; the team-mode role of the tier', () => {
    const r = (o: Parameters<typeof expectedSigner>[0]) => {
      const x = expectedSigner(o);
      if (!x.ok) throw new Error(x.error.message);
      return x.value;
    };
    expect(r({ ...base, tier: 'T0', m4_holders: [alice] })).toEqual({
      principal: 'alice',
      role: 'TL',
      mode: 'solo',
      sod_waiver: true,
    });
    expect(r({ ...base, tier: 'T1', m4_holders: holders })).toMatchObject({
      principal: 'alice',
      role: 'EM',
      mode: 'team',
      sod_waiver: false,
    });
    expect(r({ ...base, tier: 'T1', m4_holders: ['carol', 'bob'] as PrincipalId[] })).toMatchObject(
      {
        principal: 'bob',
      },
    );
    // two-person off: a waiver, with two holders; never at T2
    expect(
      r({ ...base, two_person_enabled: false, tier: 'T1', m4_holders: holders }).sod_waiver,
    ).toBe(true);
    expect(
      r({ ...base, two_person_enabled: false, tier: 'T2', m4_holders: holders }),
    ).toMatchObject({
      role: 'FGB',
      sod_waiver: false,
    });
    expect(expectedSigner({ ...base, tier: 'T0', m4_holders: [] })).toMatchObject({ ok: false });
  });
});

describe('routeLane is a pure function of the record (see eligibility.test for the system)', () => {
  it('no governing record is N8', () => {
    expect(routeLane(REPO, 'L1', null, NOW)).toMatchObject({
      eligible: false,
      route: 'n8_hold',
      reason: 'no_active_prr',
      prr: null,
    });
  });
});
