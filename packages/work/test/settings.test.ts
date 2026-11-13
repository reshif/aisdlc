import { SETTINGS_KEYS, installSetting, type PrincipalId } from '@aisdlc/contracts';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_REQUEST_TEXT_CHARS, taintMark } from '../src/index.js';

// Portal v2 (`work.request`, H26): the request text limit is the factory's setting, today's 20,000 by default.

afterEach(() => installSetting(SETTINGS_KEYS.work_request, null));

const mark = (raw: string) =>
  taintMark({
    raw,
    channel: 'N1',
    submitted_by: 'alice' as PrincipalId,
    received_at: '2026-11-13T00:00:00.000Z',
  });

describe('work.request', () => {
  it('defaults to 20,000 characters', () => {
    expect(MAX_REQUEST_TEXT_CHARS).toBe(20_000);
    expect(mark('a'.repeat(20_000)).ok).toBe(true);
    expect(mark('a'.repeat(20_001)).ok).toBe(false);
  });

  it('a published limit is in force', () => {
    installSetting(SETTINGS_KEYS.work_request, { max_text_chars: 600 });
    const r = mark('a'.repeat(601));
    expect(!r.ok && r.error.code).toBe('too_long');
    expect(mark('a'.repeat(600)).ok).toBe(true);
  });
});
