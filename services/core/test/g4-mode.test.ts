import { AUTONOMY } from '@aisdlc/catalogue';
import { parseCodeowners } from '@aisdlc/codeowners';
import type { Autonomy } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REVIEW_SENSITIVE_GLOBS,
  decideReviewMode,
  type ReviewModeInput,
} from '../src/index.js';

// M15.1: G4's review mode as a pure function of the item. One test per rule: mode E only when every input is known
// and none asks for C; every "unsure" is mode C (B14's rule up front); a sensitive path is C plus the D37 step-up.

const CODEOWNERS = parseCodeowners(
  '* @evan\nsrc/billing/ @Olga @acme/payments\ndocs/ ops@example.com\n',
);
const caps = Object.values(AUTONOMY.posture)
  .filter((p) => p.g4_mode_c && p.cap !== null)
  .map((p) => p.cap as Autonomy);
const base: ReviewModeInput = {
  b14: false,
  human_authored: false,
  changed_paths: ['src/app.js', 'test/app.test.js'],
  sensitive_globs: DEFAULT_REVIEW_SENSITIVE_GLOBS,
  codeowners: { read: 'ok', parsed: CODEOWNERS },
  prr: { effective: 'A2', posture_cap: null, r3_zones: [] },
  mode_c_posture_caps: caps,
};

describe('G4 review mode (FL 8.1)', () => {
  it('mode E: every input known, nothing asks for a codeowner; the owners of the changed paths are still listed', () => {
    expect(decideReviewMode(base)).toEqual({
      mode: 'E',
      reasons: ['evidence_sufficient'],
      step_up: false,
      sensitive_paths: [],
      owner_logins: ['evan'],
      other_owners: [],
    });
  });

  it('a sensitive path (sensitive or protected globs) is mode C and the D37 step-up', () => {
    for (const p of [
      'db/migrations/0002_add.sql',
      'src/auth/login.ts',
      'AGENTS.md',
      '.github/x.yml',
    ]) {
      const r = decideReviewMode({ ...base, changed_paths: ['src/app.js', p] });
      expect([r.mode, r.reasons, r.step_up, r.sensitive_paths], p).toEqual([
        'C',
        ['sensitive_path'],
        true,
        [p],
      ]);
    }
  });

  it('B14: the unsure mode-E approver sends the same review to a codeowner', () => {
    expect(decideReviewMode({ ...base, b14: true })).toMatchObject({
      mode: 'C',
      reasons: ['b14_unsure'],
      step_up: false,
    });
  });

  it('unsure is mode C: paths unknown (also the step-up), CODEOWNERS unreadable, no governing PRR, an R3 zone', () => {
    expect(decideReviewMode({ ...base, changed_paths: null })).toMatchObject({
      mode: 'C',
      reasons: ['paths_unknown'],
      step_up: true,
      owner_logins: [],
    });
    expect(decideReviewMode({ ...base, codeowners: { read: 'unreadable' } })).toMatchObject({
      mode: 'C',
      reasons: ['codeowners_unreadable'],
      step_up: false,
    });
    expect(decideReviewMode({ ...base, prr: null }).reasons).toEqual(['no_governing_prr']);
    expect(
      decideReviewMode({
        ...base,
        prr: { effective: 'A2', posture_cap: null, r3_zones: ['src/**'] },
      }).reasons,
    ).toEqual(['r3_zone']);
  });

  it('the posture the catalogue marks (amber: G4 mode C on every PR) and autonomy A0 are mode C; green is not', () => {
    const amber = AUTONOMY.posture.amber.cap as Autonomy;
    expect(
      decideReviewMode({ ...base, prr: { effective: 'A1', posture_cap: amber, r3_zones: [] } })
        .reasons,
    ).toEqual(['posture']);
    expect(
      decideReviewMode({ ...base, prr: { effective: 'A0', posture_cap: null, r3_zones: [] } })
        .reasons,
    ).toEqual(['autonomy_a0']);
    expect(
      decideReviewMode({ ...base, prr: { effective: 'A3', posture_cap: null, r3_zones: [] } }).mode,
    ).toBe('E');
  });

  it('a change a human wrote (L8, a takeover) goes to a codeowner', () => {
    expect(decideReviewMode({ ...base, human_authored: true }).reasons).toEqual(['human_led']);
  });

  it('several reasons are all reported, in a fixed order; owners are the CODEOWNERS rule of each changed path', () => {
    const r = decideReviewMode({
      ...base,
      b14: true,
      human_authored: true,
      changed_paths: [
        'src/billing/charge.ts',
        'db/migrations/1.sql',
        'docs/a.md',
        'src/billing/charge.ts',
      ],
    });
    expect(r.reasons).toEqual(['b14_unsure', 'sensitive_path', 'human_led']);
    expect(r.owner_logins).toEqual(['evan', 'olga']);
    expect(r.other_owners).toEqual(['@acme/payments', 'ops@example.com']);
    expect(r.sensitive_paths).toEqual(['db/migrations/1.sql']);
  });

  it('no CODEOWNERS file: no path owners, the mode follows the other inputs', () => {
    expect(decideReviewMode({ ...base, codeowners: { read: 'none' } })).toMatchObject({
      mode: 'E',
      owner_logins: [],
    });
  });
});
