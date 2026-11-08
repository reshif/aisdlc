import type { CodeHostRead, InstallationInfo, RequiredCheck } from '@aisdlc/contracts';
import { readUnknown, readUnreadable } from '@aisdlc/ports';
import { describe, expect, it } from 'vitest';
import { b4Checks } from '../src/b4.js';

const inst = (
  permissions: Record<string, 'read' | 'write' | 'admin'>,
): CodeHostRead<InstallationInfo> => ({
  state: 'ok',
  value: {
    installation_id: 1,
    account_login: 'acme',
    repository_selection: 'selected',
    permissions,
    suspended: false,
  },
});
const checks = (...c: RequiredCheck[]): CodeHostRead<RequiredCheck[]> => ({
  state: 'ok',
  value: c,
});
const pinned: RequiredCheck = { context: 'gate-check', integration_id: 99 };
const loose: RequiredCheck = { context: 'lint', integration_id: null };
const READ = { contents: 'read', metadata: 'read' } as const;

describe('B4a', () => {
  it('blocks when the installation holds administration or workflows (any level)', () => {
    for (const p of ['administration', 'workflows'] as const) {
      for (const level of ['read', 'write'] as const) {
        const r = b4Checks({
          installation: inst({ ...READ, [p]: level }),
          required_checks: checks(pinned),
        });
        expect(r.b4a.status, `${p}:${level}`).toBe('blocked');
        expect(r.b4a.blocks).toBe('m4');
        expect(r.b4a.reasons.join()).toContain(`the installation holds ${p}:${level}`);
        expect(r.blocks_m4).toBe(true);
      }
    }
  });

  it('the B4a fixture (the testbed App with administration) blocks M4', () => {
    const r = b4Checks({
      installation: inst({
        ...READ,
        administration: 'write',
        statuses: 'write',
        workflows: 'write',
      }),
      required_checks: checks(pinned),
    });
    expect(r.blocks_m4).toBe(true);
    expect(r.b4a).toMatchObject({ id: 'B4a', status: 'blocked', active: true });
  });

  it('blocks when any minted token would carry administration, workflows or statuses', () => {
    for (const p of ['administration', 'workflows', 'statuses']) {
      const r = b4Checks({
        installation: inst(READ),
        required_checks: checks(pinned),
        token_permissions: [{ role: 'docs', permissions: { ...READ, [p]: 'write' } }],
      });
      expect(r.b4a.status, p).toBe('blocked');
      expect(r.b4a.reasons.join()).toContain(`a docs token carries ${p}:write`);
      expect(r.blocks_m4).toBe(true);
    }
  });

  it('is clear for a read-only installation and the default role permissions', () => {
    const r = b4Checks({ installation: inst(READ), required_checks: checks(pinned) });
    expect(r.b4a).toMatchObject({ status: 'clear', active: false, reasons: [] });
    expect(r.blocks_m4).toBe(false);
    expect(r.amber).toBe(false);
  });

  it('an installation that cannot be read is unknown and blocks (never clear)', () => {
    for (const bad of [readUnknown('network', 'x'), readUnreadable('forbidden', 'x')]) {
      const r = b4Checks({ installation: bad, required_checks: checks(pinned) });
      expect(r.b4a).toMatchObject({ status: 'unknown', active: true });
      expect(r.b4b.status).toBe('unknown');
      expect(r.blocks_m4).toBe(true);
    }
  });
});

describe('B4b', () => {
  it('blocks when the installation holds statuses and a required check has no integration_id', () => {
    const r = b4Checks({
      installation: inst({ ...READ, statuses: 'write' }),
      required_checks: checks(pinned, loose),
    });
    expect(r.b4b).toMatchObject({ status: 'blocked', blocks: 'm4', active: true });
    expect(r.b4b.reasons.join()).toContain('lint');
    expect(r.b4c.status).toBe('clear');
    expect(r.blocks_m4).toBe(true);
    expect(r.b4a.status).toBe('clear');
  });

  it('is clear without statuses, even with an unpinned check', () => {
    const r = b4Checks({ installation: inst(READ), required_checks: checks(loose) });
    expect(r.b4b.status).toBe('clear');
    expect(r.b4c.status).toBe('clear');
    expect(r.blocks_m4).toBe(false);
  });

  it('is unknown and blocks when statuses is held and the required checks cannot be read', () => {
    for (const bad of [readUnknown('timeout', 'x'), readUnreadable('forbidden', 'x')]) {
      const r = b4Checks({
        installation: inst({ ...READ, statuses: 'write' }),
        required_checks: bad,
      });
      expect(r.b4b).toMatchObject({ status: 'unknown', active: true });
      expect(r.blocks_m4).toBe(true);
    }
    // Without statuses the checks do not matter.
    const r = b4Checks({ installation: inst(READ), required_checks: readUnknown('timeout', 'x') });
    expect(r.blocks_m4).toBe(false);
  });
});

describe('B4c', () => {
  it('is amber when the installation holds statuses and every required check is pinned', () => {
    const r = b4Checks({
      installation: inst({ ...READ, statuses: 'write' }),
      required_checks: checks(pinned, { context: 'build', integration_id: 7 }),
    });
    expect(r.b4c).toMatchObject({ status: 'amber', blocks: 'remediation', active: true });
    expect(r.b4c.reasons.join()).toContain('DEC-7');
    expect(r.amber).toBe(true);
    expect(r.blocks_m4).toBe(false);
    expect(r.b4b.status).toBe('clear');
  });

  it('with no required checks at all it is still amber (nothing is unpinned)', () => {
    const r = b4Checks({
      installation: inst({ ...READ, statuses: 'write' }),
      required_checks: checks(),
    });
    expect(r.b4c.status).toBe('amber');
    expect(r.blocks_m4).toBe(false);
  });

  it('statuses:read counts as holding statuses', () => {
    const r = b4Checks({
      installation: inst({ ...READ, statuses: 'read' }),
      required_checks: checks(loose),
    });
    expect(r.b4b.status).toBe('blocked');
  });
});
