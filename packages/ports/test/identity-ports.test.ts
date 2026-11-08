import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProjectSettings, type ProjectId } from '@aisdlc/contracts';
import { afterAll, describe, expect, it } from 'vitest';
import {
  FakeIdentityProvider,
  FakeProjectSettings,
  IdpSnapshot,
  SeedIdentityProvider,
} from '../src/index.js';

const subject = (n: string, groups: string[] = []) => ({
  issuer: 'idp',
  subject: `sub-${n}`,
  principal_id: n,
  kind: 'human',
  status: 'active',
  upn: `${n}@x.test`,
  display_handle: n,
  display_name: n,
  logins: [],
  groups,
});
const snapshot = (): IdpSnapshot =>
  IdpSnapshot.parse({
    issuer: 'idp',
    groups: [{ group_id: 'g', display: 'G', pim_managed: false, protected: false }],
    subjects: [subject('a', ['g']), subject('b')],
  });

describe('IdpSnapshot', () => {
  it('rejects an unknown group, a duplicate subject, and a foreign issuer', () => {
    const s = snapshot();
    expect(IdpSnapshot.safeParse({ ...s, subjects: [subject('a', ['nope'])] }).success).toBe(false);
    expect(IdpSnapshot.safeParse({ ...s, subjects: [subject('a'), subject('a')] }).success).toBe(
      false,
    );
    expect(
      IdpSnapshot.safeParse({ ...s, subjects: [{ ...subject('a'), issuer: 'other' }] }).success,
    ).toBe(false);
    expect(IdpSnapshot.safeParse({ ...s, extra: 1 }).success).toBe(false);
  });
});

describe('SeedIdentityProvider', () => {
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-idp-'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('reads the file on every call, so an edit shows at the next sync', async () => {
    const file = join(dir, 'seed.json');
    writeFileSync(file, JSON.stringify(snapshot()));
    const idp = SeedIdentityProvider.fromFile(file);
    const first = await idp.syncGroups();
    expect(first.ok && first.value.subjects).toHaveLength(2);
    writeFileSync(file, JSON.stringify({ ...snapshot(), subjects: [subject('a', ['g'])] }));
    const second = await idp.syncGroups();
    expect(second.ok && second.value.subjects).toHaveLength(1);
  });

  it('resolves a subject, null for unknown subject or issuer; errors are refusals', async () => {
    const idp = SeedIdentityProvider.fromText(JSON.stringify(snapshot()));
    const a = await idp.resolveSubject({ issuer: 'idp', subject: 'sub-a' });
    expect(a.ok && a.value?.groups).toEqual(['g']);
    const none = await idp.resolveSubject({ issuer: 'idp', subject: 'sub-zz' });
    expect(none.ok && none.value).toBeNull();
    const other = await idp.resolveSubject({ issuer: 'elsewhere', subject: 'sub-a' });
    expect(other.ok && other.value).toBeNull();

    const missing = await SeedIdentityProvider.fromFile(join(dir, 'absent.json')).syncGroups();
    expect(!missing.ok && missing.error.code).toBe('unavailable');
    const broken = await SeedIdentityProvider.fromText('{').syncGroups();
    expect(!broken.ok && broken.error.code).toBe('unavailable');
    const invalid = await SeedIdentityProvider.fromText('{"issuer":"idp"}').resolveSubject({
      issuer: 'idp',
      subject: 'x',
    });
    expect(!invalid.ok && invalid.error.code).toBe('invalid');
  });
});

describe('FakeIdentityProvider', () => {
  it('is deterministic, hands out copies, and fails closed until healed', async () => {
    const idp = new FakeIdentityProvider(snapshot());
    const a = await idp.syncGroups();
    const b = await idp.syncGroups();
    expect(a).toEqual(b);
    if (a.ok) a.value.subjects.length = 0;
    const c = await idp.syncGroups();
    expect(c.ok && c.value.subjects).toHaveLength(2);
    idp.fail('refused');
    const d = await idp.resolveSubject({ issuer: 'idp', subject: 'sub-a' });
    expect(!d.ok && d.error.code).toBe('refused');
    expect((await idp.syncGroups()).ok).toBe(false);
    idp.heal();
    expect((await idp.syncGroups()).ok).toBe(true);
    expect(() =>
      idp.set({ issuer: 'idp', groups: [], subjects: [subject('a', ['missing'])] } as never),
    ).toThrow();
  });
});

describe('FakeProjectSettings', () => {
  const settings = ProjectSettings.parse({
    project_id: 'acme',
    role_map: Object.fromEntries(
      ['admin', 'requesters', 'intent', 'design', 'g4', 'g5', 'x', 'sec', 'm4', 'kill'].map((s) => [
        s,
        { kind: 'principals', principals: ['alice'] },
      ]),
    ),
    two_person: { enabled: true, default: 'on_if_2plus', locked_on: false },
    gating_profile: {
      gates: { g0g1: 'on', g2: 'on', g3d: 'on', g3_g3s: 'on', g5: 'on', g6: 'on' },
      schedule: 'auto',
      tier_floor_applied: true,
    },
    kill_delegations: [],
    version: 1,
    updated_at: '2026-11-09T10:00:00Z',
  });

  it('serves what was set, refuses unknown or broken projects', async () => {
    const f = new FakeProjectSettings().set(settings, 'T1');
    const got = await f.get('acme' as ProjectId);
    expect(got.ok && got.value.tier).toBe('T1');
    expect(got.ok && got.value.settings.project_id).toBe('acme');
    const unknown = await f.get('beta' as ProjectId);
    expect(!unknown.ok && unknown.error.code).toBe('unknown_project');
    f.breakProject('acme' as ProjectId);
    const broken = await f.get('acme' as ProjectId);
    expect(!broken.ok && broken.error.code).toBe('unavailable');
    expect(() => new FakeProjectSettings().set({ ...settings, version: 0 })).toThrow();
  });
});
