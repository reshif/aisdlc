import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GATING_PROFILE,
  DEFAULT_TWO_PERSON,
  EMPTY_ROLE_MAP,
  OnboardRequest,
  PROJECT_CONFIG_KEYS,
  ProjectSettingsDoc,
  RoleMap,
  S0_DEFAULT_CALENDAR,
  S0_DEFAULT_FAILURE_MODEL,
  S0_DEFAULT_TIMEBOXES,
  S0Calendar,
  S0FailureModel,
  S0TimeBoxes,
  levelRank,
  minLevel,
  projectStream,
  repoStream,
  s0RefOf,
  s0Stream,
} from '../../src/index.js';

describe('core streams', () => {
  it('names the streams of the three aggregates; repo streams ignore case', () => {
    expect(projectStream('acme')).toBe('project:acme');
    expect(repoStream('Acme/App')).toBe('repo:acme/app');
    expect(s0Stream('0190c9a0-0000-7000-8000-000000000001')).toBe(
      's0:0190c9a0-0000-7000-8000-000000000001',
    );
    expect(s0RefOf('evt-1')).toBe('record:evt-1');
  });
});

describe('OnboardRequest', () => {
  const base = { project_id: 'acme', repo: 'acme/app', level: 'light', on_behalf_of: 'alice' };
  it('takes repo, level, slug and raise-only attestations', () => {
    expect(OnboardRequest.safeParse(base).success).toBe(true);
    expect(
      OnboardRequest.safeParse({
        ...base,
        attestations: {
          classification: 'confidential',
          tier_floor: 'T2',
          deploys: true,
          mode: 'team',
        },
      }).success,
    ).toBe(true);
  });
  it('cannot express an attestation that lowers risk', () => {
    for (const attestations of [
      { classification: 'internal' },
      { tier_floor: 'T0' },
      { deploys: false },
      { mode: 'solo' },
      { t0_attested: true },
    ]) {
      expect(
        OnboardRequest.safeParse({ ...base, attestations }).success,
        JSON.stringify(attestations),
      ).toBe(false);
    }
    expect(OnboardRequest.safeParse({ ...base, level: 'gold' }).success).toBe(false);
    expect(OnboardRequest.safeParse({ ...base, project_id: 'Has:Colon' }).success).toBe(false);
  });
});

describe('S0 driver configuration', () => {
  it('has a time box for every step and valid defaults (OB §6.2, DEC-9)', () => {
    expect(S0TimeBoxes.parse(S0_DEFAULT_TIMEBOXES)).toEqual(S0_DEFAULT_TIMEBOXES);
    expect(S0_DEFAULT_TIMEBOXES['0.1']).toMatchObject({
      machine_minutes: 30,
      reminder_business_days: 2,
    });
    expect(S0TimeBoxes.safeParse({ '0.1': S0_DEFAULT_TIMEBOXES['0.1'] }).success).toBe(false);
    expect(S0FailureModel.parse(S0_DEFAULT_FAILURE_MODEL)).toEqual({
      send_backs_per_step: 1,
      park_business_days: 5,
      machine_retries: 3,
      machine_retry_delay_seconds: 60,
    });
    expect(S0Calendar.parse(S0_DEFAULT_CALENDAR)).toEqual(S0_DEFAULT_CALENDAR);
    expect(
      S0FailureModel.safeParse({ ...S0_DEFAULT_FAILURE_MODEL, send_backs_per_step: 0 }).success,
    ).toBe(false);
  });
});

describe('project settings as config', () => {
  it('the defaults make a valid settings document', () => {
    expect(RoleMap.safeParse(EMPTY_ROLE_MAP).success).toBe(true);
    const doc = {
      [PROJECT_CONFIG_KEYS.role_map]: EMPTY_ROLE_MAP,
      [PROJECT_CONFIG_KEYS.two_person]: DEFAULT_TWO_PERSON,
      [PROJECT_CONFIG_KEYS.gating_profile]: DEFAULT_GATING_PROFILE,
      [PROJECT_CONFIG_KEYS.kill_delegations]: [],
    };
    expect(ProjectSettingsDoc.safeParse(doc).success).toBe(true);
    expect(ProjectSettingsDoc.safeParse({ ...doc, extra: 1 }).success).toBe(false);
  });
});

describe('levels', () => {
  it('orders census < light < full', () => {
    expect(levelRank('census')).toBeLessThan(levelRank('light'));
    expect(minLevel('full', 'light')).toBe('light');
    expect(minLevel('census', 'full')).toBe('census');
  });
});
