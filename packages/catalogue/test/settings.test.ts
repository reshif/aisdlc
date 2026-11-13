import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  CATALOGUE,
  CATALOGUE_SECTIONS,
  baseCatalogueSnapshot,
  catalogueFor,
  catalogueSectionSchema,
  catalogueSettingKey,
  clearSettingsReleases,
  currentCatalogue,
  currentCatalogueRef,
  overlayFrom,
  planSettingsRelease,
  registerSettingsRelease,
  settingsReleases,
  type CatalogueData,
} from '../src/index.js';

// The catalogue from the factory's settings: a changed section makes version N+1 of the base; an item pinned to an
// earlier release (code or settings) still reads exactly that one.

afterEach(() => clearSettingsReleases());

const REV = 'a'.repeat(64);

const withRework = (total: number): CatalogueData['rework_budget'] => ({
  ...CATALOGUE.rework_budget,
  total: { ...CATALOGUE.rework_budget.total, value: total },
});

describe('catalogue settings keys', () => {
  it.each(CATALOGUE_SECTIONS)('%s: default is the base section, with a JSON Schema', (s) => {
    expect(catalogueSettingKey(s)).toBe(`catalogue.${s}`);
    expect(catalogueSectionSchema(s).safeParse(CATALOGUE[s]).success).toBe(true);
    expect(() =>
      z.toJSONSchema(catalogueSectionSchema(s), { target: 'draft-2020-12', io: 'input' }),
    ).not.toThrow();
  });

  it('refuses a section that does not fit, and an unreadable published key', () => {
    expect(overlayFrom({ 'catalogue.rework_budget': { total: 'five' } }).ok).toBe(false);
    expect(overlayFrom({ rejected: ['catalogue.lanes'], get: () => undefined }).ok).toBe(false);
  });
});

describe('settings releases', () => {
  it('settings equal to the base pin the base', () => {
    const p = planSettingsRelease({
      overlay: { rework_budget: CATALOGUE.rework_budget, lanes: CATALOGUE.lanes },
      existing: [],
      rev_hash: REV,
    });
    expect(p.ok && p.value).toEqual({ kind: 'base', ref: currentCatalogueRef() });
  });

  it('changing a limit creates version N+1; an old item still reads N', () => {
    const base = baseCatalogueSnapshot();
    const first = planSettingsRelease({
      overlay: { rework_budget: withRework(7) },
      existing: [],
      rev_hash: REV,
    });
    if (!first.ok || first.value.kind !== 'new') throw new Error('expected a new release');
    expect(first.value.ref.version).toBe(`${base.version}+settings.1`);
    expect(first.value.release.sections).toEqual(['rework_budget']);
    expect(registerSettingsRelease(first.value.release).ok).toBe(true);

    const second = planSettingsRelease({
      overlay: { rework_budget: withRework(9) },
      existing: [first.value.release],
      rev_hash: REV,
    });
    if (!second.ok || second.value.kind !== 'new') throw new Error('expected a new release');
    expect(second.value.ref.version).toBe(`${base.version}+settings.2`);
    expect(registerSettingsRelease(second.value.release).ok).toBe(true);

    // each pin reads exactly its own data
    const one = catalogueFor(first.value.ref);
    const two = catalogueFor(second.value.ref);
    const code = catalogueFor(currentCatalogueRef());
    expect(one.ok && one.value.rework_budget.total.value).toBe(7);
    expect(two.ok && two.value.rework_budget.total.value).toBe(9);
    expect(code.ok && code.value.rework_budget.total.value).toBe(5);
    expect(one.ok && one.value.version).toBe(`${base.version}+settings.1`);
    expect(settingsReleases().map((r) => r.version)).toEqual([
      `${base.version}+settings.1`,
      `${base.version}+settings.2`,
    ]);

    // the same content again is the release that has it, not a third
    const again = planSettingsRelease({
      overlay: { rework_budget: withRework(7) },
      existing: [first.value.release, second.value.release],
      rev_hash: REV,
    });
    expect(again.ok && again.value).toEqual({ kind: 'existing', ref: first.value.ref });
  });

  it('currentCatalogue: pins a recorded release, refuses one not recorded yet', () => {
    const doc = { 'catalogue.rework_budget': withRework(6) };
    const missing = currentCatalogue(doc);
    expect(!missing.ok && missing.error._tag).toBe('SettingsReleaseMissing');
    const p = planSettingsRelease({
      overlay: { rework_budget: withRework(6) },
      existing: [],
      rev_hash: REV,
    });
    if (!p.ok || p.value.kind !== 'new') throw new Error('expected a new release');
    registerSettingsRelease(p.value.release);
    const now = currentCatalogue(doc);
    expect(now.ok && now.value.ref).toEqual(p.value.ref);
    expect(now.ok && now.value.data.rework_budget.total.value).toBe(6);
    // nothing set: the code release
    const none = currentCatalogue({});
    expect(none.ok && none.value.ref).toEqual(currentCatalogueRef());
  });

  it('refuses a release whose data does not hash to its hash, or another hash under a known version', () => {
    const p = planSettingsRelease({
      overlay: { rework_budget: withRework(8) },
      existing: [],
      rev_hash: REV,
    });
    if (!p.ok || p.value.kind !== 'new') throw new Error('expected a new release');
    const tampered = structuredClone(p.value.release);
    (tampered.catalogue['rework_budget'] as { total: { value: number } }).total.value = 99;
    expect(registerSettingsRelease(tampered).ok).toBe(false);
    expect(registerSettingsRelease(p.value.release).ok).toBe(true);
    const other = planSettingsRelease({
      overlay: { rework_budget: withRework(3) },
      existing: [],
      rev_hash: REV,
    });
    if (!other.ok || other.value.kind !== 'new') throw new Error('expected a new release');
    // same version number (both planned against no history), different content
    expect(other.value.ref.version).toBe(p.value.ref.version);
    expect(registerSettingsRelease(other.value.release).ok).toBe(false);
    // an unregistered settings release is unknown: fails closed
    clearSettingsReleases();
    expect(catalogueFor(p.value.ref).ok).toBe(false);
  });

  it('refuses settings that break the catalogue as a whole', () => {
    const bad = planSettingsRelease({
      overlay: {
        lanes: { ...CATALOGUE.lanes, L4: { ...CATALOGUE.lanes.L4, id: 'nope' } } as never,
      },
      existing: [],
      rev_hash: REV,
    });
    expect(bad.ok).toBe(false);
  });
});
