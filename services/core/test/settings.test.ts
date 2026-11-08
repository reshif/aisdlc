import {
  DEFAULT_GATING_PROFILE,
  DEFAULT_TWO_PERSON,
  EMPTY_ROLE_MAP,
  PROJECT_CONFIG_KEYS,
  type RoleMap,
} from '@aisdlc/contracts';
import { loadEffective } from '@aisdlc/config';
import { identityProjection } from '@aisdlc/identity/read';
import { seedPrincipals, settingsOf, startTestIdentityApi } from '@aisdlc/identity/testing';
import { HttpProjectSettings, HttpRegisteredRepos } from '@aisdlc/ports';
import { err } from '@aisdlc/kernel';
import { runProjection } from '@aisdlc/record';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbProjectSettings,
  FakeRoleMapReconciler,
  remoteError,
  HttpRoleMapReconciler,
  createCoreApp,
  pendingRoleMaps,
  proposeProjectSettings,
  recordSigned,
  requestOnboarding,
  roleMapSyncLoop,
  syncRoleMaps,
} from '../src/index.js';
import {
  decideGate,
  pid,
  pr,
  publishSettings,
  request,
  setAdmins,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';

let s: CoreStack;
let app: FastifyInstance;
let coreUrl: string;
const TOKEN = {
  identity: 'identity-at-core-'.padEnd(32, 'x'),
  codehost: 'codehost-at-core-'.padEnd(32, 'x'),
};

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob', 'carol', 'dave']);
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKEN),
    callers: { identity: ['read'], codehost: ['registry'] },
    registry: s.registry,
    config: s.config,
    clock: s.clock,
  });
  coreUrl = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

const roleMap = (slots: Parameters<typeof settingsOf>[1]): RoleMap =>
  settingsOf('x', slots).role_map;

async function onboard(project: string, repo = `acme/${project}`, attestations = {}) {
  const r = await requestOnboarding(
    s.deps,
    request({ project_id: pid(project), repo, attestations }),
  );
  if (!r.ok) throw new Error(r.error.message);
  setAdmins(s, project, ['alice']);
  return r.value;
}

describe('ProjectSettings as config revisions (PLAN M7.1)', () => {
  it('a proposal opens an M1 gate and is not in force until it is published', async () => {
    await onboard('set-a');
    const port = new DbProjectSettings({ pool: s.record.pool, registry: s.registry });
    expect(await port.get(pid('set-a'))).toMatchObject({
      ok: false,
      error: { code: 'unknown_project' },
    });
    const p = await proposeProjectSettings(s.config, {
      project: pid('set-a'),
      change: { role_map: roleMap({ admin: ['alice'], requesters: ['bob'] }) },
      proposed_by: pr('alice'),
    });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    const gate = await s.record.pool.query(
      `SELECT body FROM record.record_event WHERE stream = $1 AND seq = 1`,
      [`gate:${p.value.gate_instance_id}`],
    );
    expect(gate.rows[0].body).toMatchObject({ gate_id: 'M1', subject_kind: 'config' });
    // Proposed, gate pending: still no settings.
    expect(await port.get(pid('set-a'))).toMatchObject({ ok: false });
    // Decided but not published: still no settings (the M1 decision alone changes nothing).
    expect((await decideGate(s, p.value.gate_instance_id, 'alice', 'approve')).ok).toBe(true);
    expect(await port.get(pid('set-a'))).toMatchObject({ ok: false });
  });

  it('a published revision is the settings in force, with its version and the project tier', async () => {
    await onboard('set-b');
    const port = new DbProjectSettings({ pool: s.record.pool, registry: s.registry });
    const first = await publishSettings(
      s,
      'set-b',
      { role_map: roleMap({ admin: ['alice'], requesters: ['bob'], g4: 'codeowners' }) },
      'alice',
    );
    expect(first.published).toBe(true);
    const v1 = await port.get(pid('set-b'));
    expect(v1.ok).toBe(true);
    if (!v1.ok) return;
    expect(v1.value.tier).toBeNull();
    expect(v1.value.settings).toMatchObject({
      project_id: 'set-b',
      version: 1,
      two_person: DEFAULT_TWO_PERSON,
      gating_profile: DEFAULT_GATING_PROFILE,
      kill_delegations: [],
    });
    expect(v1.value.settings.role_map.requesters).toEqual({
      kind: 'principals',
      principals: ['bob'],
    });

    // A second revision: only what changed is given, the rest keeps its value.
    await publishSettings(
      s,
      'set-b',
      { gating_profile: { ...DEFAULT_GATING_PROFILE, schedule: 'human' } },
      'alice',
    );
    const v2 = await port.get(pid('set-b'));
    expect(v2.ok && v2.value.settings).toMatchObject({
      version: 2,
      gating_profile: { schedule: 'human' },
    });
    expect(v2.ok && v2.value.settings.role_map.requesters).toEqual({
      kind: 'principals',
      principals: ['bob'],
    });
    // Nothing else wrote it: the lineage's effective document is the published one.
    const eff = await loadEffective(s.record.pool, {
      layer: 'project',
      scope: { kind: 'project', ref: 'set-b' },
    });
    expect(Object.keys(eff?.doc ?? {}).sort()).toEqual(Object.values(PROJECT_CONFIG_KEYS).sort());
  });

  it('refuses an unknown project, a document that does not fit, and nothing changed', async () => {
    const unknown = await proposeProjectSettings(s.config, {
      project: pid('nobody'),
      change: {},
      proposed_by: pr('alice'),
    });
    expect(unknown).toMatchObject({ ok: false, error: { code: 'not_found' } });
    await onboard('set-c');
    const bad = await proposeProjectSettings(s.config, {
      project: pid('set-c'),
      change: { role_map: { ...EMPTY_ROLE_MAP, admin: { kind: 'codeowners' } } as never },
      proposed_by: pr('alice'),
    });
    expect(bad).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
    // The same document twice is "unchanged", not a second gate.
    await publishSettings(s, 'set-c', { role_map: roleMap({ admin: ['alice'] }) }, 'alice');
    expect(
      await proposeProjectSettings(s.config, {
        project: pid('set-c'),
        change: { role_map: roleMap({ admin: ['alice'] }) },
        proposed_by: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });

  it('a T2 project (here a raise-only T2 floor) locks two-person on and keeps the gating floor', async () => {
    await onboard('set-t2', 'acme/set-t2', { tier_floor: 'T2', deploys: true });
    const noTwoPerson = await proposeProjectSettings(s.config, {
      project: pid('set-t2'),
      change: { two_person: { enabled: false, default: 'on_if_2plus', locked_on: false } },
      proposed_by: pr('alice'),
    });
    expect(noTwoPerson).toMatchObject({ ok: false, error: { code: 'refused' } });
    const noG5 = await proposeProjectSettings(s.config, {
      project: pid('set-t2'),
      change: {
        two_person: { enabled: true, default: 'on_if_2plus', locked_on: true },
        gating_profile: {
          ...DEFAULT_GATING_PROFILE,
          gates: { ...DEFAULT_GATING_PROFILE.gates, g5: 'off' },
        },
      },
      proposed_by: pr('alice'),
    });
    expect(noG5).toMatchObject({ ok: false, error: { code: 'refused' } });
    const ok = await proposeProjectSettings(s.config, {
      project: pid('set-t2'),
      change: { two_person: { enabled: true, default: 'on_if_2plus', locked_on: true } },
      proposed_by: pr('alice'),
    });
    expect(ok.ok).toBe(true);
  });
});

describe('the signed tier reaches the settings port', () => {
  it('a project signed T2 has locked two-person: the port reports the tier and a loosening is refused', async () => {
    const o = await onboard('set-signed');
    await publishSettings(s, 'set-signed', { role_map: roleMap({ admin: ['alice'] }) }, 'alice');
    const port = new DbProjectSettings({ pool: s.record.pool, registry: s.registry });
    expect(await port.get(pid('set-signed'))).toMatchObject({ ok: true, value: { tier: null } });
    const signed = await recordSigned(s.deps, {
      s0_id: o.s0_id,
      tier: 'T2',
      level: 'census',
      actor: 'alice',
    });
    expect(signed.ok).toBe(true);
    expect(await port.get(pid('set-signed'))).toMatchObject({ ok: true, value: { tier: 'T2' } });
    expect(
      await proposeProjectSettings(s.config, {
        project: pid('set-signed'),
        change: { two_person: { enabled: false, default: 'on_if_2plus', locked_on: false } },
        proposed_by: pr('alice'),
      }),
    ).toMatchObject({ ok: false, error: { code: 'refused' } });
  });
});

describe('publishing a role map reconciles identity (role-map sync loop)', () => {
  it('reconciles each published revision once; a repeat pass writes nothing', async () => {
    await onboard('rm-a');
    const fake = new FakeRoleMapReconciler();
    const d = { pool: s.record.pool, reconciler: fake, clock: s.clock };
    expect((await pendingRoleMaps(d)).map((p) => p.project)).not.toContain('rm-a');
    const pub = await publishSettings(
      s,
      'rm-a',
      { role_map: roleMap({ admin: ['alice'] }) },
      'alice',
    );
    expect((await pendingRoleMaps(d)).map((p) => p.project)).toContain('rm-a');
    const r1 = await syncRoleMaps(d);
    expect(r1.synced).toContain('rm-a');
    const call = fake.calls.find((c) => c.project === 'rm-a');
    expect(call).toEqual({
      project: 'rm-a',
      config_rev: pub.rev_hash,
      m_gate_ref: pub.ledger_entry_id,
    });
    const before = fake.calls.length;
    expect((await syncRoleMaps(d)).synced).toEqual([]);
    expect(fake.calls.length).toBe(before);
    const row = await s.record.pool.query(
      'SELECT rev_hash, ledger_entry_id FROM core.role_map_sync WHERE project_id = $1',
      ['rm-a'],
    );
    expect(row.rows[0]).toEqual({ rev_hash: pub.rev_hash, ledger_entry_id: pub.ledger_entry_id });
  });

  it('is retry-safe: a failed call leaves the revision pending and the next pass tries again; one project does not stop another', async () => {
    await onboard('rm-b');
    await onboard('rm-c');
    const fake = new FakeRoleMapReconciler();
    const d = { pool: s.record.pool, reconciler: fake, clock: s.clock };
    await syncRoleMaps(d);
    await publishSettings(s, 'rm-b', { role_map: roleMap({ admin: ['alice'] }) }, 'alice');
    await publishSettings(s, 'rm-c', { role_map: roleMap({ admin: ['alice'] }) }, 'alice');
    fake.down = true;
    const failing = await syncRoleMaps(d);
    expect(failing.synced).toEqual([]);
    expect(failing.failed.map((f) => f.project).sort()).toEqual(['rm-b', 'rm-c']);
    expect((await pendingRoleMaps(d)).map((p) => p.project)).toEqual(
      expect.arrayContaining(['rm-b', 'rm-c']),
    );
    fake.down = false;
    // Identity refuses one project only: the other is reconciled, the refused one stays pending.
    const picky = new FakeRoleMapReconciler();
    const accept = picky.reconcile.bind(picky);
    picky.reconcile = (project, o) =>
      project === 'rm-b'
        ? Promise.resolve(err(remoteError('refused', 'identity refused')))
        : accept(project, o);
    const partial = await syncRoleMaps({ ...d, reconciler: picky });
    expect(partial.synced).toEqual(['rm-c']);
    expect(partial.failed.map((f) => f.project)).toEqual(['rm-b']);
    expect((await pendingRoleMaps(d)).map((p) => p.project)).toEqual(['rm-b']);
    const ok = await syncRoleMaps({ ...d, reconciler: fake });
    expect(ok.synced).toEqual(['rm-b']);
    // Then a new revision of rm-b is a new pending item (and rm-c is not).
    await publishSettings(s, 'rm-b', { role_map: roleMap({ admin: ['alice', 'bob'] }) }, 'alice');
    expect((await pendingRoleMaps(d)).map((p) => p.project)).toEqual(['rm-b']);
  });

  it('the loop spec does the same, item by item, and counts a failing project as failed', async () => {
    await onboard('rm-d');
    await publishSettings(s, 'rm-d', { role_map: roleMap({ admin: ['alice'] }) }, 'alice');
    const fake = new FakeRoleMapReconciler();
    fake.refuse = true;
    const spec = roleMapSyncLoop({ pool: s.record.pool, reconciler: fake, clock: s.clock });
    expect(spec.name).toBe('role_map_sync');
    let failed = 0;
    let ok = 0;
    const run = () =>
      spec.tick({
        name: 'role_map_sync',
        log: { info() {}, warn() {}, error() {} },
        signal: new AbortController().signal,
        async eachItem(items, _l, fn) {
          for (const it of items) {
            try {
              await fn(it);
              ok += 1;
            } catch {
              failed += 1;
            }
          }
        },
      });
    await run();
    expect(failed).toBeGreaterThanOrEqual(1);
    fake.refuse = false;
    const okBefore = ok;
    await run();
    expect(ok).toBeGreaterThan(okBefore);
  });

  it('end to end over HTTP: identity reads the settings from core and binds the published role map', async () => {
    await onboard('rm-e');
    // Identity's settings come from core over HTTP, not from a fixture.
    const identity = await startIdentityWithCoreSettings();
    try {
      await publishSettings(
        s,
        'rm-e',
        { role_map: roleMap({ admin: ['alice'], requesters: ['bob', 'carol'], g5: ['dave'] }) },
        'alice',
      );
      const reconciler = new HttpRoleMapReconciler({
        baseUrl: identity.url,
        token: identity.token,
      });
      const r = await syncRoleMaps({ pool: s.record.pool, reconciler, clock: s.clock });
      expect(r.failed).toEqual([]);
      expect(r.synced).toContain('rm-e');
      await runProjection(s.record.pool, identityProjection);
      const b = await s.record.pool.query<{ role_id: string; n: string }>(
        `SELECT role_id, count(*)::text AS n FROM identity.binding
          WHERE scope_kind = 'project' AND scope_ref = 'rm-e' AND constraints ->> 'origin' = 'role_map'
          GROUP BY role_id ORDER BY role_id`,
      );
      expect(b.rows.length).toBeGreaterThanOrEqual(3);
      // Identity's reconcile is idempotent: a second pass does not even call it.
      expect(
        (await syncRoleMaps({ pool: s.record.pool, reconciler, clock: s.clock })).synced,
      ).toEqual([]);
      // The reconcile was stamped with the published revision.
      const rev = await s.record.pool.query<{ config_rev: string | null }>(
        `SELECT DISTINCT config_rev FROM identity.binding WHERE scope_ref = 'rm-e' AND constraints ->> 'origin' = 'role_map'`,
      );
      expect(rev.rows.map((x) => x.config_rev)).toContain(
        (
          await s.record.pool.query(
            'SELECT rev_hash FROM core.role_map_sync WHERE project_id = $1',
            ['rm-e'],
          )
        ).rows[0].rev_hash,
      );
    } finally {
      await identity.stop();
    }
  });
});

/** An identity API whose ProjectSettingsPort is `HttpProjectSettings` over core's app. */
async function startIdentityWithCoreSettings() {
  const token = 'core-reconciles-'.padEnd(32, 'x');
  const api = await startTestIdentityApi(
    s.id,
    { core: { token, scopes: ['reconcile'] } },
    { settings: new HttpProjectSettings({ baseUrl: coreUrl, token: TOKEN.identity }) },
  );
  return { url: api.url, token, stop: () => api.stop() };
}

describe('core HTTP adapters for the ports', () => {
  it('HttpProjectSettings answers what the database port answers, and fails closed', async () => {
    await onboard('http-a');
    await publishSettings(s, 'http-a', { role_map: roleMap({ admin: ['alice'] }) }, 'alice');
    const db = await new DbProjectSettings({ pool: s.record.pool, registry: s.registry }).get(
      pid('http-a'),
    );
    const http = new HttpProjectSettings({ baseUrl: coreUrl, token: TOKEN.identity });
    expect(await http.get(pid('http-a'))).toEqual(db);
    expect(await http.get(pid('http-nope'))).toMatchObject({
      ok: false,
      error: { code: 'unknown_project' },
    });
    // Registered, nothing published: not "no restrictions".
    await onboard('http-b');
    expect(await http.get(pid('http-b'))).toMatchObject({
      ok: false,
      error: { code: 'unknown_project' },
    });
    // A wrong token, a missing scope, a dead core: refusals.
    expect(
      await new HttpProjectSettings({
        baseUrl: coreUrl,
        token: 'wrong-token-'.padEnd(32, 'x'),
      }).get(pid('http-a')),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(
      await new HttpProjectSettings({ baseUrl: coreUrl, token: TOKEN.codehost }).get(pid('http-a')),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(
      await new HttpProjectSettings({
        baseUrl: 'http://127.0.0.1:1',
        token: TOKEN.identity,
        timeoutMs: 500,
      }).get(pid('http-a')),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });

  it('HttpRegisteredRepos lists the repos with an S0 record, and fails closed', async () => {
    await onboard('http-c', 'acme/http-c');
    const http = new HttpRegisteredRepos({ baseUrl: coreUrl, token: TOKEN.codehost });
    const r = await http.list();
    expect(r.ok && r.value).toContainEqual({ project_id: 'http-c', repo: 'acme/http-c' });
    expect(
      await new HttpRegisteredRepos({ baseUrl: coreUrl, token: TOKEN.identity }).list(),
    ).toMatchObject({ ok: false, error: { code: 'unavailable' } });
    expect(
      await new HttpRegisteredRepos({
        baseUrl: 'http://127.0.0.1:1',
        token: TOKEN.codehost,
        timeoutMs: 500,
      }).list(),
    ).toMatchObject({ ok: false });
  });
});
