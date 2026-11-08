import { describe, expect, it } from 'vitest';
import {
  ACCESS_ENTRY_TYPES,
  ACCESS_EVENT_TYPES,
  ACCESS_LEDGERED,
  AccessLedgerBody,
  GATE_POLICIES,
  IDENTITY_EVENT,
  IdentityLink,
  PrincipalUpdatedPayload,
  ProjectSettings,
  ROLE_CATALOGUE,
  RoleDef,
  RoleSlotValues,
  TWO_PERSON_SLOTS,
  bindingIdFor,
  identityLinkKey,
  impliedBindings,
  roleForSlot,
  roleMapGroupId,
  scopeCovers,
  slotOfRole,
  type ProjectSettings as Settings,
  type Scope,
} from '../../src/index.js';
import { T0, projectSettings } from './fixtures.js';

const settings = (over: Partial<Settings> = {}): Settings => ({ ...projectSettings(), ...over });
const must = <T, E>(r: { ok: true; value: T } | { ok: false; error: E }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

describe('role catalogue', () => {
  it('is valid, unique, and has exactly one role per slot', () => {
    for (const r of ROLE_CATALOGUE) expect(RoleDef.parse(r)).toEqual(r);
    expect(new Set(ROLE_CATALOGUE.map((r) => r.role_id)).size).toBe(ROLE_CATALOGUE.length);
    for (const slot of RoleSlotValues) {
      expect(ROLE_CATALOGUE.filter((r) => r.slot === slot)).toHaveLength(1);
      expect(slotOfRole(roleForSlot(slot))).toBe(slot);
    }
  });

  it('every gate policy slot has a role that can approve', () => {
    for (const p of Object.values(GATE_POLICIES)) {
      const role = ROLE_CATALOGUE.find((r) => r.role_id === roleForSlot(p.slot));
      // G6 is the requesters' own acceptance; every other slot's role is approval capable.
      if (p.slot !== 'requesters') expect(role?.approval_capable, p.slot).toBe(true);
    }
  });

  it('derives the two-person slots from the policies', () => {
    expect([...TWO_PERSON_SLOTS].sort()).toEqual(['kill', 'm4', 'x']);
  });

  it('fleet kill is a factory role, not a slot role', () => {
    expect(ROLE_CATALOGUE.find((r) => r.role_id === 'factory.admin')?.scope_kinds).toEqual([
      'fleet',
    ]);
    expect(slotOfRole('factory.admin')).toBeNull();
  });
});

describe('access events and ledger mapping', () => {
  it('maps exactly the access events, each to a distinct access.* entry type', () => {
    expect(ACCESS_EVENT_TYPES).toContain(IDENTITY_EVENT.member_added);
    expect(ACCESS_EVENT_TYPES).toContain(IDENTITY_EVENT.binding_revoked);
    expect(ACCESS_EVENT_TYPES).not.toContain(IDENTITY_EVENT.principal_updated);
    expect(new Set(ACCESS_ENTRY_TYPES).size).toBe(ACCESS_ENTRY_TYPES.length);
    for (const t of Object.values(ACCESS_LEDGERED)) expect(t).toMatch(/^access\.[a-z_]+$/);
  });

  it('validates the ledger body and an update payload', () => {
    const body = {
      access_event_id: '018f3c1e-7b2a-7c3d-8e4f-0123456789ab',
      stream: 'group:g',
      stream_seq: 1,
      global_seq: 1,
      event_type: IDENTITY_EVENT.member_added,
      occurred_at: T0,
      change: {},
    };
    expect(AccessLedgerBody.parse(body)).toEqual(body);
    expect(AccessLedgerBody.safeParse({ ...body, stream_seq: 0 }).success).toBe(false);
    expect(PrincipalUpdatedPayload.safeParse({}).success).toBe(false);
    expect(PrincipalUpdatedPayload.safeParse({ display_name: 'A' }).success).toBe(true);
  });
});

describe('IdentityLink', () => {
  it('needs an issuer exactly for an idp subject, and keys are case-insensitive for logins', () => {
    const l = { principal_id: 'alice', kind: 'idp_subject', issuer: 'idp', value: 'Sub-1' };
    expect(IdentityLink.parse(l)).toEqual(l);
    expect(IdentityLink.safeParse({ ...l, issuer: null }).success).toBe(false);
    expect(IdentityLink.safeParse({ ...l, kind: 'email' }).success).toBe(false);
    const gh = { kind: 'github_login', issuer: null } as const;
    expect(identityLinkKey({ ...gh, value: 'Alice' })).toBe(
      identityLinkKey({ ...gh, value: 'alice' }),
    );
    const sub = { kind: 'idp_subject', issuer: 'idp' } as const;
    expect(identityLinkKey({ ...sub, value: 'A' })).not.toBe(
      identityLinkKey({ ...sub, value: 'a' }),
    );
  });
});

describe('scopeCovers', () => {
  const p = (ref: string): Scope => ({ kind: 'project', ref });
  it('fleet covers all, equal covers itself, project covers what is under it', () => {
    expect(scopeCovers({ kind: 'fleet', ref: '*' }, p('a'))).toBe(true);
    expect(scopeCovers(p('a'), p('a'))).toBe(true);
    expect(scopeCovers(p('a'), p('b'))).toBe(false);
    expect(scopeCovers(p('a'), { kind: 'lane', ref: 'a/L4' })).toBe(true);
    expect(scopeCovers(p('a'), { kind: 'lane', ref: 'ab/L4' })).toBe(false);
    expect(scopeCovers({ kind: 'lane', ref: 'a/L4' }, p('a'))).toBe(false);
    expect(scopeCovers(p('a'), { kind: 'fleet', ref: '*' })).toBe(false);
    expect(scopeCovers({ kind: 'team', ref: 't' }, p('a'))).toBe(false);
  });
});

describe('impliedBindings', () => {
  it('gives one binding per slot, generated groups, deterministic ids and stable order', () => {
    const specs = must(impliedBindings(settings()));
    expect(specs.map((s) => s.slot)).toEqual([...RoleSlotValues]);
    for (const s of specs) {
      expect(s.group_id).toBe(roleMapGroupId('acme-web' as never, s.slot));
      expect(s.role_id).toBe(roleForSlot(s.slot));
      expect(s.scope).toEqual({ kind: 'project', ref: 'acme-web' });
      expect(s.binding_id).toBe(bindingIdFor(s.group_id, s.role_id, s.scope));
      expect(s.constraints['origin']).toBe('role_map');
    }
    expect(must(impliedBindings(settings()))).toEqual(specs);
  });

  it('g4 code owners generate a binding with unmanaged membership', () => {
    const g4 = must(impliedBindings(settings())).find((s) => s.slot === 'g4');
    expect(g4?.members).toBeNull();
  });

  it('stamps two_person only on slots a two-person rule covers, from the setting', () => {
    const on = must(impliedBindings(settings()));
    expect(
      on
        .filter((s) => 'two_person' in s.constraints)
        .map((s) => s.slot)
        .sort(),
    ).toEqual(['kill', 'm4', 'x']);
    expect(on.find((s) => s.slot === 'm4')?.constraints['two_person']).toBe(true);
    const off = must(
      impliedBindings(
        settings({ two_person: { enabled: false, default: 'on_if_2plus', locked_on: false } }),
      ),
    );
    expect(off.find((s) => s.slot === 'm4')?.constraints['two_person']).toBe(false);
  });

  it('adds active project delegates to the kill group and a binding per delegated lane', () => {
    const base = projectSettings();
    const d = (delegate: string, scope: Scope, revoked: string | null = null) => ({
      delegate: delegate as never,
      scope,
      granted_by: 'alice' as never,
      granted_at: T0,
      revoked_at: revoked,
    });
    const s = settings({
      kill_delegations: [
        d('bob', { kind: 'project', ref: 'acme-web' }),
        d('carol', { kind: 'lane', ref: 'acme-web/L4' }),
        d('dave', { kind: 'lane', ref: 'acme-web/L4' }),
        d('erin', { kind: 'project', ref: 'acme-web' }, '2026-11-09T10:00:00Z'),
      ],
    });
    ProjectSettings.parse(s);
    const specs = must(impliedBindings(s));
    expect(specs.find((x) => x.slot === 'kill' && x.scope.kind === 'project')?.members).toEqual([
      'alice',
      'bob',
    ]);
    const lane = specs.find((x) => x.scope.kind === 'lane');
    expect(lane?.members).toEqual(['carol', 'dave']);
    expect(lane?.constraints['delegated']).toBe(true);
    expect(specs).toHaveLength(11);
    expect(base.kill_delegations).toHaveLength(1);
  });

  it('refuses a delegation scoped to another project or lane', () => {
    const bad = (scope: Scope) =>
      impliedBindings(
        settings({
          kill_delegations: [
            {
              delegate: 'bob' as never,
              scope,
              granted_by: 'alice' as never,
              granted_at: T0,
              revoked_at: null,
            },
          ],
        }),
      );
    for (const scope of [
      { kind: 'project', ref: 'other' },
      { kind: 'lane', ref: 'other/L4' },
    ] as Scope[]) {
      const r = bad(scope);
      expect(r.ok).toBe(false);
    }
  });
});
