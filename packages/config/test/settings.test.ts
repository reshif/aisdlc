import {
  CATALOGUE,
  CATALOGUE_SECTIONS,
  catalogueFor,
  catalogueSettingKey,
  clearSettingsReleases,
  currentCatalogueRef,
} from '@aisdlc/catalogue';
import { agentSettingsDefaults } from '@aisdlc/agents';
import {
  CATALOGUE_RELEASE_STREAM,
  DEFAULT_GATES_POLICY,
  DEFAULT_SESSION_POLICY,
  SETTINGS_KEYS,
} from '@aisdlc/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  ConfigRegistry,
  configPublish,
  ensureSettingsRelease,
  loadSettingsReleases,
  pinCatalogue,
  proposeRevision,
  readSettingsReleases,
  registerSettingsConfig,
  SETTINGS_KEY_DEFAULTS,
} from '../src/index.js';
import { decideGate, pr, setupProject, startStack, type Stack } from './helpers.js';

// Portal v2 settings in the registry, and the catalogue from config end to end: propose, M1, publish records the
// release; a new item pins N+1 while an item that pinned N still reads N.

let s: Stack;
beforeAll(async () => {
  s = await startStack(registerSettingsConfig(new ConfigRegistry()));
  setupProject(s, 'factory', { admin: ['root', 'rita'] });
});
afterAll(async () => {
  clearSettingsReleases();
  await s.stop();
});

const factory = { layer: 'factory' as const };

async function publish(doc: Record<string, unknown>) {
  const p = await proposeRevision(s.deps, { ...factory, doc, proposed_by: pr('root') });
  if (!p.ok) throw new Error(p.error.message);
  const d = await decideGate(s, p.value.gate_instance_id, 'rita', 'approve');
  if (!d.ok) throw new Error(JSON.stringify(d.error));
  const r = await configPublish(s.deps, { rev_hash: p.value.rev_hash });
  if (!r.ok) throw new Error(r.error.message);
  return p.value.rev_hash;
}

const rework = (total: number) => ({
  ...CATALOGUE.rework_budget,
  total: { ...CATALOGUE.rework_budget.total, value: total },
});

describe('settings keys in the registry', () => {
  it('registers every key once with its default, factory only, each with a JSON Schema', () => {
    const r = registerSettingsConfig(registerSettingsConfig(new ConfigRegistry()));
    const keys = [
      ...CATALOGUE_SECTIONS.map(catalogueSettingKey),
      ...SETTINGS_KEY_DEFAULTS.map((d) => d.key),
    ];
    expect(keys.length).toBe(23);
    for (const k of keys) {
      const def = r.get(k);
      expect(def, k).toBeDefined();
      expect(def?.overridable).toBe(false);
      expect(() =>
        z.toJSONSchema(def!.schema, { target: 'draft-2020-12', io: 'input' }),
      ).not.toThrow();
      expect(r.validate('project', { [k]: def?.default }).ok).toBe(false);
    }
    expect(r.get(SETTINGS_KEYS.gates_policy)?.default).toEqual(DEFAULT_GATES_POLICY);
    expect(r.get(SETTINGS_KEYS.session_policy)?.default).toEqual(DEFAULT_SESSION_POLICY);
    expect(r.get(SETTINGS_KEYS.agents_settings)?.default).toEqual(agentSettingsDefaults());
    expect(r.get('catalogue.lanes')?.default).toEqual(CATALOGUE.lanes);
  });

  it('refuses invalid values, and models that are neither the contract’s nor routed', () => {
    const r = registerSettingsConfig(new ConfigRegistry());
    expect(r.validate('factory', { [SETTINGS_KEYS.session_policy]: { idle_s: 1 } }).ok).toBe(false);
    expect(r.validate('factory', { 'catalogue.rework_budget': { total: 5 } }).ok).toBe(false);
    expect(
      r.validate('factory', { [SETTINGS_KEYS.agents_settings]: { A1: { models: ['made-up'] } } })
        .ok,
    ).toBe(false);
    expect(
      r.validate('factory', { [SETTINGS_KEYS.agents_settings]: { A1: { enabled: false } } }).ok,
    ).toBe(true);
  });
});

describe('the catalogue from config', () => {
  it('nothing changed: new items pin the code release', async () => {
    const pin = await pinCatalogue(s.record.pool);
    expect(pin.ok && pin.value.ref).toEqual(currentCatalogueRef());
  });

  it('changing a limit creates version N+1 at publish; an old item still reads N', async () => {
    const before = currentCatalogueRef();
    await publish({ 'catalogue.rework_budget': rework(7) });
    const releases = await readSettingsReleases(s.record.pool);
    expect(releases.map((r) => r.version)).toEqual([`${before.version}+settings.1`]);
    expect(releases[0]?.sections).toEqual(['rework_budget']);

    const pin1 = await pinCatalogue(s.record.pool);
    if (!pin1.ok) throw new Error(pin1.error.message);
    expect(pin1.value.ref.version).toBe(`${before.version}+settings.1`);
    expect(pin1.value.data.rework_budget.total.value).toBe(7);

    // an unrelated key changes nothing: same release
    await publish({
      'catalogue.rework_budget': rework(7),
      [SETTINGS_KEYS.work_request]: { max_text_chars: 999 },
    });
    expect((await readSettingsReleases(s.record.pool)).length).toBe(1);

    await publish({ 'catalogue.rework_budget': rework(9) });
    const pin2 = await pinCatalogue(s.record.pool);
    if (!pin2.ok) throw new Error(pin2.error.message);
    expect(pin2.value.ref.version).toBe(`${before.version}+settings.2`);

    // the items that pinned earlier read exactly what they pinned
    const old = catalogueFor(before);
    const one = catalogueFor(pin1.value.ref);
    expect(old.ok && old.value.rework_budget.total.value).toBe(5);
    expect(one.ok && one.value.rework_budget.total.value).toBe(7);

    // back to 7: the release that has it, not a third
    await publish({ 'catalogue.rework_budget': rework(7) });
    const pin3 = await pinCatalogue(s.record.pool);
    expect(pin3.ok && pin3.value.ref).toEqual(pin1.value.ref);
    expect((await readSettingsReleases(s.record.pool)).length).toBe(2);
  });

  it('a fresh process loads the releases from the record and checks them', async () => {
    clearSettingsReleases();
    const l = await loadSettingsReleases(s.record.pool);
    expect(l.refused).toEqual([]);
    expect(l.loaded.length).toBe(2);
    expect(catalogueFor(l.loaded[1]!).ok).toBe(true);
    // a tampered release is refused, never loaded
    const one = (await readSettingsReleases(s.record.pool))[0]!;
    clearSettingsReleases();
    await s.record.pool
      .query(
        `UPDATE record.record_event SET body = jsonb_set(body, '{catalogue,rework_budget,total,value}', '42')
        WHERE stream = $1 AND body ->> 'version' = $2`,
        [CATALOGUE_RELEASE_STREAM, one.version],
      )
      .catch(() => undefined); // the record may forbid UPDATE: then nothing to tamper with
    const again = await loadSettingsReleases(s.record.pool);
    const tampered = (await readSettingsReleases(s.record.pool))[0]!;
    if ((tampered.catalogue['rework_budget'] as { total: { value: number } }).total.value === 42) {
      expect(again.refused.length).toBe(1);
      expect(catalogueFor(one).ok).toBe(false);
    }
  });

  it('ensureSettingsRelease is idempotent', async () => {
    const a = await ensureSettingsRelease(s.record.pool);
    const b = await ensureSettingsRelease(s.record.pool);
    expect(a.ok && b.ok).toBe(true);
    expect(a.ok && a.value?.kind).not.toBe('new');
  });
});
