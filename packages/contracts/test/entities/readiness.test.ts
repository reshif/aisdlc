import { describe, expect, it } from 'vitest';
import {
  Criterion,
  FloorDef,
  Gap,
  MAX_WAIVER_DAYS,
  PRR_HASH_EXCLUDED,
  ProjectReadinessRecord,
  gapId,
  parseGapId,
  prrRecordHash,
  sealPrr,
  type PrrBody,
} from '../../src/index.js';
import { H, SHA40, T0, U3, gap, prr, prrBody } from './fixtures.js';

describe('Gap', () => {
  it('round-trips and has the gap:<repo_id>:<criterion_id>[:<area>] id', () => {
    const g = gap();
    expect(Gap.parse(g)).toEqual(g);
    expect(g.gap_id).toBe('gap:r1:RS-BT-3');
    expect(gapId('r1', 'RS-BT-3', 'web')).toBe('gap:r1:RS-BT-3:web');
    expect(parseGapId('gap:r1:RS-BT-3:web')).toEqual({
      repo_id: 'r1',
      criterion: 'RS-BT-3',
      area: 'web',
    });
    expect(parseGapId('gap:r1:RS-SEC')).toEqual({ repo_id: 'r1', criterion: 'RS-SEC', area: null });
    expect(parseGapId('gap:r1')).toBeNull();
    const withArea = gap({ area: 'web', gap_id: gapId('r1', 'RS-BT-3', 'web') });
    expect(Gap.safeParse(withArea).success).toBe(true);
  });

  it('rejects an id that does not match its fields, and bad severity or disposition', () => {
    expect(Gap.safeParse(gap({ gap_id: 'gap:r1:RS-BT-4' })).success).toBe(false);
    expect(Gap.safeParse(gap({ gap_id: 'bt3' })).success).toBe(false);
    expect(Gap.safeParse({ ...gap(), severity: 'major' }).success).toBe(false);
    expect(Gap.safeParse({ ...gap(), disposition: 'ignore' }).success).toBe(false);
    expect(Gap.safeParse({ ...gap(), criterion: 'bt3' }).success).toBe(false);
  });

  const waiver = (days: number) => ({
    granted_by: 'alice',
    granted_at: T0,
    expires_at: new Date(Date.parse(T0) + days * 86_400_000).toISOString().replace('.000Z', 'Z'),
    reason: 'tracked in Q1',
  });

  it('waiver lasts at most 90 days', () => {
    const w = (d: number) =>
      Gap.safeParse({ ...gap(), disposition: 'waive', status: 'waived', waiver: waiver(d) })
        .success;
    expect(MAX_WAIVER_DAYS).toBe(90);
    expect(w(90)).toBe(true);
    expect(w(1)).toBe(true);
    expect(w(91)).toBe(false);
    expect(w(0)).toBe(false);
    expect(w(-3)).toBe(false);
  });

  it('a blocking gap is never waived at its own level', () => {
    const blocking = gap({
      severity: 'blocking',
      blocks_level: 'light',
      disposition: 'file_issue',
    });
    expect(Gap.safeParse(blocking).success).toBe(true);
    expect(Gap.safeParse({ ...blocking, blocks_level: null }).success).toBe(false);
    expect(
      Gap.safeParse({ ...blocking, disposition: 'waive', status: 'waived', waiver: waiver(30) })
        .success,
    ).toBe(false);
    expect(Gap.safeParse({ ...blocking, waiver: waiver(30) }).success).toBe(false);
  });

  it('disposition waive and a waiver go together', () => {
    expect(Gap.safeParse({ ...gap(), disposition: 'waive' }).success).toBe(false);
    expect(Gap.safeParse({ ...gap(), waiver: waiver(10) }).success).toBe(false);
    expect(Gap.safeParse({ ...gap(), status: 'waived' }).success).toBe(false);
  });

  it('security gaps are private_only and track_only, with no issue', () => {
    const sec = gap({
      gap_id: gapId('r1', 'RS-SEC'),
      criterion: 'RS-SEC',
      visibility_class: 'private_only',
    });
    expect(Gap.safeParse(sec).success).toBe(true);
    expect(Gap.safeParse({ ...sec, visibility_class: 'public_safe' }).success).toBe(false);
    expect(Gap.safeParse({ ...sec, disposition: 'file_issue' }).success).toBe(false);
    expect(Gap.safeParse({ ...sec, issue: { number: 1, state: 'open' } }).success).toBe(false);
  });
});

describe('Criterion and FloorDef', () => {
  const crit = {
    id: 'RS-BT-1',
    pillar: 'BT',
    title: 'Task-contract targets discoverable',
    class_by_level: { census: 'RECORDED', light: 'FLOOR', full: 'FLOOR' },
    floors: ['LF3'],
    escalations: [],
    note: null,
  };
  it('round-trips and rejects a wrong pillar, class or level key', () => {
    expect(Criterion.parse(crit)).toEqual(crit);
    expect(Criterion.safeParse({ ...crit, pillar: 'OP' }).success).toBe(false);
    expect(
      Criterion.safeParse({ ...crit, class_by_level: { ...crit.class_by_level, light: 'MUST' } })
        .success,
    ).toBe(false);
    expect(
      Criterion.safeParse({ ...crit, class_by_level: { census: null, light: null } }).success,
    ).toBe(false);
    expect(
      Criterion.safeParse({ ...crit, class_by_level: { census: null, light: null, full: null } })
        .success,
    ).toBe(true);
    expect(Criterion.safeParse({ ...crit, floors: ['LF9'] }).success).toBe(false);
    expect(
      Criterion.safeParse({ ...crit, escalations: [{ when: 'team', class: 'SCORED' }] }).success,
    ).toBe(false);
    expect(Criterion.safeParse({ ...crit, id: 'RS-SEC', pillar: 'SEC' }).success).toBe(true);
  });
  it('FloorDef: the id prefix fixes the level', () => {
    const f = {
      id: 'LF3',
      level: 'light',
      title: 'Probe',
      criteria: ['RS-BT-1'],
      method: 'D',
      why: null,
    };
    expect(FloorDef.parse(f)).toEqual(f);
    expect(FloorDef.safeParse({ ...f, level: 'full' }).success).toBe(false);
    expect(FloorDef.safeParse({ ...f, criteria: [] }).success).toBe(false);
  });
});

describe('ProjectReadinessRecord prr/1', () => {
  const parses = (r: unknown): boolean => ProjectReadinessRecord.safeParse(r).success;
  const messages = (r: unknown): string => {
    const p = ProjectReadinessRecord.safeParse(r);
    return p.success ? '' : p.error.issues.map((i) => i.message).join(' | ');
  };
  /** A sealed variant: hash recomputed so only the rule under test can fail. */
  const sealed = (over: Partial<PrrBody>) => prr(over);

  it('round-trips a valid record', () => {
    const r = prr();
    expect(ProjectReadinessRecord.parse(r)).toEqual(r);
    expect(r.schema).toBe('prr/1');
  });

  it('has every field of OB 2.4', () => {
    const keys = Object.keys(prr()).sort();
    expect(keys).toEqual(
      [
        'schema',
        'record_id',
        'version',
        'supersedes',
        'status',
        'repo',
        'baseline_sha',
        'pins',
        'level',
        'tier',
        'pillars',
        'gating_profile',
        'role_map',
        'composite',
        'autonomy',
        'writes',
        'affirmed',
        'controls',
        'security_summary',
        'gaps',
        'signer',
        'm4',
        'issued_at',
        'fresh_until',
        'review_by',
        'freshness',
        'record_hash',
      ].sort(),
    );
  });

  it('rejects missing fields, unknown fields and a wrong schema id', () => {
    const r = prr();
    for (const k of Object.keys(r)) {
      const rest = Object.fromEntries(Object.entries(r).filter(([key]) => key !== k));
      expect(parses(rest), `without ${k}`).toBe(false);
    }
    expect(parses({ ...r, extra: 1 })).toBe(false);
    expect(parses({ ...r, schema: 'prr/2' })).toBe(false);
    expect(parses({ ...r, writes: 'root' })).toBe(false);
    expect(parses({ ...r, baseline_sha: 'abc' })).toBe(false);
  });

  describe('record_hash', () => {
    it('is the hash of the record minus m4, status, freshness', () => {
      expect([...PRR_HASH_EXCLUDED].sort()).toEqual(['freshness', 'm4', 'record_hash', 'status']);
      const r = prr();
      expect(r.record_hash).toBe(prrRecordHash(r));
      expect(r.record_hash).toMatch(/^[0-9a-f]{64}$/);
    });

    it('does not change when m4, status or freshness change', () => {
      const r = prr();
      const h = prrRecordHash(r);
      expect(prrRecordHash({ ...r, m4: null })).toBe(h);
      expect(prrRecordHash({ ...r, m4: { ledger_entry_id: U3, decision_hash: H('other') } })).toBe(
        h,
      );
      for (const status of ['proposed', 'stale', 'suspended', 'expired', 'superseded'] as const) {
        expect(prrRecordHash({ ...r, status })).toBe(h);
      }
      expect(
        prrRecordHash({
          ...r,
          freshness: { last_mechanical_check_at: null, last_check_sha: null, stale_areas: ['web'] },
        }),
      ).toBe(h);
      // ...and the changed record still parses: those fields are outside the hash.
      expect(parses({ ...r, status: 'stale' })).toBe(true);
      expect(parses({ ...r, freshness: { ...r.freshness, stale_areas: ['web'] } })).toBe(true);
      expect(parses({ ...r, m4: { ledger_entry_id: U3, decision_hash: H('other') } })).toBe(true);
    });

    it('changes when any other field changes', () => {
      const r = prr();
      const h = prrRecordHash(r);
      const changes: Record<string, unknown> = {
        schema: 'prr/2',
        record_id: 'prr:acme-web:r2',
        version: 2,
        supersedes: H('prev'),
        repo: { ...r.repo, name: 'other' },
        baseline_sha: 'b'.repeat(40),
        pins: { ...r.pins, detector_set: 'detectors@9' },
        level: { ...r.level, signed: 'census' },
        tier: { ...r.tier, value: 'T2' },
        pillars: r.pillars.slice(1),
        gating_profile: { ...r.gating_profile, schedule: 'human' },
        role_map: {
          ...r.role_map,
          kill_delegations: [],
          source: { codeowners_sha: null, collaborators_read_at: null },
        },
        composite: 1,
        autonomy: { ...r.autonomy, effective: 'A0' },
        writes: 'none',
        affirmed: { ...r.affirmed, operations: { text_sha256: H('ops'), attested_by: 'alice' } },
        controls: { ...r.controls, egress_request_ref: null },
        security_summary: { history_scan: { ...r.security_summary.history_scan, open: 3 } },
        gaps: [],
        signer: { ...r.signer, role: 'TL' },
        issued_at: '2026-11-09T10:00:00Z',
        fresh_until: '2027-01-01T00:00:00Z',
        review_by: null,
      };
      expect(Object.keys(changes).sort()).toEqual(
        Object.keys(r)
          .filter((k) => !PRR_HASH_EXCLUDED.includes(k as never))
          .sort(),
      );
      for (const [k, v] of Object.entries(changes)) {
        expect(prrRecordHash({ ...r, [k]: v }), k).not.toBe(h);
      }
    });

    it('a tampered record (hash left as it was) is rejected', () => {
      const r = prr();
      expect(parses({ ...r, writes: 'agent' })).toBe(false);
      expect(messages({ ...r, writes: 'agent' })).toContain('record_hash');
      expect(parses({ ...r, record_hash: H('forged') })).toBe(false);
    });
  });

  describe('refinements', () => {
    it('signed level ≤ requested level', () => {
      expect(
        parses(sealed({ level: { ...prrBody().level, requested: 'light', signed: 'census' } })),
      ).toBe(true);
      expect(
        parses(sealed({ level: { ...prrBody().level, requested: 'light', signed: 'full' } })),
      ).toBe(false);
      expect(
        parses(sealed({ level: { ...prrBody().level, requested: 'census', signed: 'light' } })),
      ).toBe(false);
    });

    it('an open blocking gap blocks the level it names', () => {
      const blocking = gap({
        gap_id: gapId('r1', 'RS-BT-2'),
        criterion: 'RS-BT-2',
        severity: 'blocking',
        blocks_level: 'light',
        disposition: 'file_issue',
      });
      expect(parses(sealed({ gaps: [blocking] }))).toBe(false);
      const lower = { ...prrBody().level, requested: 'light', signed: 'census' } as const;
      expect(parses(sealed({ gaps: [blocking], level: lower }))).toBe(true);
      expect(parses(sealed({ gaps: [{ ...blocking, status: 'closed_verified' }] }))).toBe(true);
    });

    it('T2 locks two-person on', () => {
      const t2 = { ...prrBody().tier, value: 'T2', floor: 'T2' } as const;
      const base = prrBody();
      expect(parses(sealed({ tier: t2, signer: { ...base.signer, sod_waiver: false } }))).toBe(
        false,
      );
      const locked = {
        ...base.role_map,
        two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
      } as const;
      expect(
        parses(
          sealed({ tier: t2, role_map: locked, signer: { ...base.signer, sod_waiver: false } }),
        ),
      ).toBe(true);
      expect(
        parses(
          sealed({
            tier: t2,
            role_map: { ...locked, two_person: { ...locked.two_person, enabled: false } },
            signer: { ...base.signer, sod_waiver: false },
          }),
        ),
      ).toBe(false);
    });

    it('T2 never carries a sod_waiver', () => {
      const base = prrBody();
      const t2 = { ...base.tier, value: 'T2', floor: 'T2' } as const;
      const locked = {
        ...base.role_map,
        two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
      } as const;
      expect(
        messages(
          sealed({ tier: t2, role_map: locked, signer: { ...base.signer, sod_waiver: true } }),
        ),
      ).toContain('sod_waiver');
    });

    it('the tier is raise-only above its floor', () => {
      const base = prrBody();
      expect(parses(sealed({ tier: { ...base.tier, value: 'T0', floor: 'T1' } }))).toBe(false);
      expect(
        parses(
          sealed({
            tier: { ...base.tier, value: 'T2', floor: 'T1', raised_by: ['owner'] },
            role_map: {
              ...base.role_map,
              two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
            },
            signer: { ...base.signer, sod_waiver: false },
          }),
        ),
      ).toBe(true);
    });

    describe('gating profile T2 floor', () => {
      const base = prrBody();
      const t2 = (gp: PrrBody['gating_profile']): ProjectReadinessRecord =>
        sealed({
          tier: { ...base.tier, value: 'T2', floor: 'T2' },
          role_map: {
            ...base.role_map,
            two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
          },
          signer: { ...base.signer, sod_waiver: false },
          gating_profile: gp,
        });
      const gp = (
        over: Partial<PrrBody['gating_profile']['gates']>,
        deploys: boolean | null = true,
      ) => ({
        ...base.gating_profile,
        gates: { ...base.gating_profile.gates, ...over },
        project_deploys: deploys,
      });

      it('accepts the defaults', () => expect(parses(t2(gp({})))).toBe(true));
      it('refuses G2, G3d, G3_G3s off', () => {
        for (const g of ['g2', 'g3d', 'g3_g3s'] as const)
          expect(parses(t2(gp({ [g]: 'off' }))), g).toBe(false);
      });
      it('refuses G5 off if the project deploys or it is unknown, allows it if not', () => {
        expect(parses(t2(gp({ g5: 'off' }, true)))).toBe(false);
        expect(parses(t2(gp({ g5: 'off' }, null)))).toBe(false);
        expect(parses(t2(gp({ g5: 'off' }, false)))).toBe(true);
      });
      it('allows G0+G1 and G6 off', () => {
        expect(parses(t2(gp({ g6: 'off' })))).toBe(true);
        expect(parses(t2(gp({ g0g1: 'off' })))).toBe(true);
      });
      it('does not apply to T1', () => {
        expect(
          parses(
            sealed({ gating_profile: gp({ g2: 'off', g3d: 'off', g3_g3s: 'off', g5: 'off' }) }),
          ),
        ).toBe(true);
      });
      it('a per-lane override cannot get around the floor', () => {
        const lane = { ...gp({}), by_lane: { L5: { g3d: 'off' } } } as PrrBody['gating_profile'];
        expect(parses(t2(lane))).toBe(false);
      });
    });

    it('never holds a secret value or fingerprint', () => {
      const r = prrBody();
      const withKey = (path: 'security_summary' | 'controls', key: string, value: unknown) =>
        sealPrr({ ...r, [path]: { ...r[path], [key]: value } } as PrrBody);
      // The strict schema already refuses unknown members; the key check is the second line.
      expect(parses(withKey('security_summary', 'secret_value', 'ghp_x'))).toBe(false);
      expect(parses(withKey('security_summary', 'fingerprints', ['ab']))).toBe(false);
      expect(parses(withKey('controls', 'hmac', 'ab'))).toBe(false);
      const scan = (over: object) =>
        sealed({
          security_summary: { history_scan: { ...r.security_summary.history_scan, ...over } },
        });
      expect(parses(scan({ fingerprint: 'abc' }))).toBe(false);
      expect(parses(scan({ open: 'AKIAxxxx' }))).toBe(false);
      expect(parses(scan({ open: 2, rotated: 0 }))).toBe(true);
    });

    it('only an M4 decision makes a version active', () => {
      expect(parses(sealed({ status: 'active', m4: null }))).toBe(false);
      expect(parses(sealed({ status: 'proposed', m4: null }))).toBe(true);
      expect(parses(sealed({ status: 'stale', m4: null }))).toBe(false);
    });

    it('composite is the min of the pillars', () => {
      expect(parses(sealed({ composite: 3 }))).toBe(false);
      expect(parses(sealed({ composite: 2 }))).toBe(true);
    });

    it('effective autonomy never exceeds a cap, and probation caps it at A1', () => {
      const base = prrBody();
      expect(parses(sealed({ autonomy: { ...base.autonomy, effective: 'A3' } }))).toBe(false);
      expect(
        parses(sealed({ autonomy: { ...base.autonomy, probation_until: null, effective: 'A2' } })),
      ).toBe(true);
      expect(
        parses(sealed({ autonomy: { ...base.autonomy, probation_until: null, effective: 'A3' } })),
      ).toBe(false);
      expect(
        parses(
          sealed({
            autonomy: {
              ...base.autonomy,
              probation_until: null,
              posture_cap: 'A1',
              effective: 'A2',
            },
          }),
        ),
      ).toBe(false);
    });

    it('fresh_until is within 90 days, review_by within 3 (Light) or 12 (Full) months', () => {
      const base = prrBody();
      expect(parses(sealed({ fresh_until: '2027-02-07T10:00:00Z' }))).toBe(false);
      expect(parses(sealed({ fresh_until: T0 }))).toBe(false);
      expect(parses(sealed({ review_by: '2027-02-09T10:00:00Z' }))).toBe(false);
      expect(parses(sealed({ review_by: null }))).toBe(false);
      const full = { ...base.level, requested: 'full', signed: 'full' } as const;
      expect(parses(sealed({ level: full, review_by: '2027-11-08T10:00:00Z' }))).toBe(true);
      expect(parses(sealed({ level: full, review_by: '2027-11-09T10:00:00Z' }))).toBe(false);
      const census = { ...base.level, requested: 'census', signed: 'census' } as const;
      expect(parses(sealed({ level: census, review_by: null }))).toBe(true);
    });

    it('record_id names the repo; gaps and criteria stay consistent', () => {
      expect(parses(sealed({ record_id: 'prr:acme-web:other' }))).toBe(false);
      expect(
        parses(
          sealed({ gaps: [gap({ repo_id: 'other' as never, gap_id: gapId('other', 'RS-BT-3') })] }),
        ),
      ).toBe(false);
      expect(parses(sealed({ gaps: [gap(), gap()] }))).toBe(false);
      const base = prrBody();
      const p0 = base.pillars[0]!;
      const dangling = [
        { ...p0, criteria: [{ ...p0.criteria[0]!, gap_id: gapId('r1', 'RS-BT-9') }] },
        ...base.pillars.slice(1),
      ];
      expect(parses(sealed({ pillars: dangling }))).toBe(false);
      const ok = [
        { ...p0, criteria: [{ ...p0.criteria[0]!, gap_id: gapId('r1', 'RS-BT-3') }] },
        ...base.pillars.slice(1),
      ];
      expect(parses(sealed({ pillars: ok }))).toBe(true);
      expect(parses(sealed({ pillars: [p0, p0, ...base.pillars.slice(2)] }))).toBe(false);
    });

    it('claims counts cannot exceed the total; steps 0.1, 0.4, 0.5 always run', () => {
      const base = prrBody();
      expect(
        parses(
          sealed({
            affirmed: { ...base.affirmed, claims: { ...base.affirmed.claims, affirmed: 50 } },
          }),
        ),
      ).toBe(false);
      expect(
        parses(
          sealed({
            level: {
              ...base.level,
              steps: { ...base.level.steps, '0.4': 'not_requested' as never },
            },
          }),
        ),
      ).toBe(false);
    });
  });

  it('sealPrr adds the hash of the body', () => {
    const body = prrBody();
    expect(sealPrr(body).record_hash).toBe(prrRecordHash(body));
    expect(SHA40).toHaveLength(40);
  });
});
