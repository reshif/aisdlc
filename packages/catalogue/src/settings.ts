import { CatalogueReleasedPayload, CatalogueRef, type SettingsSnapshot } from '@aisdlc/contracts';
import { canonicalJson, err, hashCanonical, ok, taggedError, type Result } from '@aisdlc/kernel';
import type { z } from 'zod';
import {
  CATALOGUE_SNAPSHOTS,
  catalogueFor,
  registeredSettingsSnapshots as registered,
  snapshotHash,
  type CatalogueSnapshot,
} from './history.js';
import { CatalogueData } from './schema.js';

// The catalogue from the factory's settings (portal v2, screen map H1-H5, H18-H21). The factory owner changes a
// track, a retry limit, the rework budget, the extension rule, gating, eligibility or autonomy as CONFIG: one key per
// catalogue section (`catalogue.<section>`), M1-gated like every revision, whose default is the section of the newest
// code release. A released catalogue stays immutable: when a revision that changes a section is published, the
// catalogue it makes (the base release's data with those sections replaced) becomes a NEW version
// `<base>+settings.<n>`, hashed the way every release is and recorded once as a `catalogue.released` event with its
// full data. New items pin the new release; an item keeps the release it pinned (`catalogueFor` reads both kinds).
//
// The same sections on the same base are the same release (by `content_hash`, the hash of the data without its
// version), so publishing an unrelated key never makes a release, and going back to an earlier set of values pins
// the release that already has them. Settings equal to the base make no release at all: the base is pinned.
//
// What a process has read of the record is registered here (`registerSettingsRelease`), checked like a code
// snapshot: the hash recomputed from the data, the base a code release with the hash it names. A release this
// process has not registered is `CatalogueUnknown`: an item pinned to it fails closed until it is loaded.

/** The sections a setting may replace (every section of the data but its version). */
export const CATALOGUE_SECTIONS = [
  'lanes',
  'back_edge_limits',
  'rework_budget',
  'envelope_extension',
  'flow_limits',
  'triggers',
  'gating',
  'eligibility',
  'autonomy',
  'criteria',
] as const satisfies ReadonlyArray<Exclude<keyof CatalogueData, 'version'>>;
export type CatalogueSection = (typeof CATALOGUE_SECTIONS)[number];

/** The config key of a section. */
export const catalogueSettingKey = (s: CatalogueSection): string => `catalogue.${s}`;

/** The schema of a section, from the catalogue's own schema (never re-listed). */
export const catalogueSectionSchema = (s: CatalogueSection): z.ZodType =>
  CatalogueData.shape[s] as unknown as z.ZodType;

/** What the settings replace: a value per section they set. */
export type CatalogueOverlay = Partial<{ [K in CatalogueSection]: CatalogueData[K] }>;

const payloads = new Map<string, CatalogueReleasedPayload>();

export const SettingsReleaseInvalid = taggedError('SettingsReleaseInvalid');
export type SettingsReleaseError = ReturnType<typeof SettingsReleaseInvalid<{ reason: string }>>;

/** The newest code release: the base every settings release is made from now. */
export const baseCatalogueSnapshot = (): CatalogueSnapshot =>
  CATALOGUE_SNAPSHOTS[CATALOGUE_SNAPSHOTS.length - 1] as CatalogueSnapshot;

const refOf = (s: { version: string; hash: string }): CatalogueRef =>
  CatalogueRef.parse({ version: s.version, hash: s.hash });

/**
 * The overlay a config snapshot holds. A section key that was published and no longer fits its schema is an error:
 * the factory cannot tell which catalogue its settings mean, so nothing new is pinned (fail closed).
 */
export function overlayFrom(
  c: SettingsSnapshot | Readonly<Record<string, unknown>>,
): Result<CatalogueOverlay, SettingsReleaseError> {
  const get = (k: string): unknown =>
    'get' in c && typeof c.get === 'function'
      ? (c as SettingsSnapshot).get(k)
      : (c as Record<string, unknown>)[k];
  const rejected = 'rejected' in c && Array.isArray(c.rejected) ? c.rejected : [];
  const out: Record<string, unknown> = {};
  for (const s of CATALOGUE_SECTIONS) {
    const key = catalogueSettingKey(s);
    if (rejected.includes(key)) {
      return err(SettingsReleaseInvalid({ reason: `${key} no longer fits its schema` }));
    }
    const v = get(key);
    if (v === undefined) continue;
    const p = catalogueSectionSchema(s).safeParse(v);
    if (!p.success) return err(SettingsReleaseInvalid({ reason: `${key}: ${p.error.message}` }));
    out[s] = p.data;
  }
  return ok(out as CatalogueOverlay);
}

/** The data of a base release with the overlay's sections in place, and the sections that differ from the base. */
export function applyOverlay(
  base: CatalogueSnapshot,
  overlay: CatalogueOverlay,
): Result<
  { data: Omit<CatalogueData, 'version'>; changed: CatalogueSection[] },
  SettingsReleaseError
> {
  const b = catalogueFor(refOf(base));
  if (!b.ok)
    return err(SettingsReleaseInvalid({ reason: `base ${base.version}: ${b.error._tag}` }));
  const { version: _v, ...data } = structuredClone(b.value) as CatalogueData;
  void _v;
  const changed: CatalogueSection[] = [];
  for (const s of CATALOGUE_SECTIONS) {
    const v = overlay[s];
    if (v === undefined || canonicalJson(v) === canonicalJson(data[s])) continue;
    (data as Record<string, unknown>)[s] = structuredClone(v);
    changed.push(s);
  }
  // the whole must still be a catalogue (cross-section shape)
  const whole = CatalogueData.safeParse({ ...data, version: base.version });
  if (!whole.success) {
    return err(SettingsReleaseInvalid({ reason: whole.error.message }));
  }
  return ok({ data, changed });
}

/** The hash of a catalogue's content without its version: what makes two releases the same. */
export const contentHashOf = (data: Omit<CatalogueData, 'version'>, flow: unknown): string =>
  hashCanonical({ catalogue: data, flow });

const SETTINGS_VERSION = /^(\d+\.\d+\.\d+)\+settings\.([1-9]\d*)$/;

/** `n` of `<base>+settings.<n>`, or `null`. */
export const settingsReleaseNumber = (version: string): { base: string; n: number } | null => {
  const m = SETTINGS_VERSION.exec(version);
  return m ? { base: m[1] as string, n: Number(m[2]) } : null;
};

export type SettingsReleasePlan =
  | { readonly kind: 'base'; readonly ref: CatalogueRef }
  | { readonly kind: 'existing'; readonly ref: CatalogueRef }
  | {
      readonly kind: 'new';
      readonly ref: CatalogueRef;
      readonly release: CatalogueReleasedPayload;
    };

/**
 * What a set of settings pins, given the releases already recorded: the base (settings equal to it), a release that
 * already has exactly this content, or a new release `<base>+settings.<n+1>` to record. Pure and deterministic.
 */
export function planSettingsRelease(i: {
  readonly overlay: CatalogueOverlay;
  readonly existing: readonly CatalogueReleasedPayload[];
  /** The config revision whose publish makes the release. */
  readonly rev_hash: string;
  readonly base?: CatalogueSnapshot;
}): Result<SettingsReleasePlan, SettingsReleaseError> {
  const base = i.base ?? baseCatalogueSnapshot();
  const applied = applyOverlay(base, i.overlay);
  if (!applied.ok) return applied;
  const { data, changed } = applied.value;
  if (changed.length === 0) return ok({ kind: 'base', ref: refOf(base) });
  const content_hash = contentHashOf(data, base.flow);
  const same = i.existing.find(
    (r) =>
      r.base.version === base.version &&
      r.base.hash === base.hash &&
      r.content_hash === content_hash,
  );
  if (same) return ok({ kind: 'existing', ref: refOf(same) });
  const n =
    1 +
    Math.max(
      0,
      ...i.existing
        .filter((r) => r.base.version === base.version)
        .map((r) => settingsReleaseNumber(r.version)?.n ?? 0),
    );
  const version = `${base.version}+settings.${n}`;
  const catalogue = CatalogueData.parse({ ...data, version });
  const hash = hashCanonical({ catalogue, flow: base.flow });
  const release = CatalogueReleasedPayload.parse({
    version,
    hash,
    base: refOf(base),
    content_hash,
    sections: changed,
    rev_hash: i.rev_hash,
    catalogue,
    flow: base.flow,
  });
  return ok({ kind: 'new', ref: refOf(release), release });
}

// ---------------------------------------------------------------- the releases this process knows

/**
 * Makes a recorded settings release readable by `catalogueFor`. Checked first: the version is a settings release of
 * a code release with the hash it names, and the data hashes to the release's hash. Registering the same release
 * twice is fine; another hash under a known version is refused (a release is immutable).
 */
export function registerSettingsRelease(
  input: unknown,
): Result<CatalogueRef, SettingsReleaseError> {
  const p = CatalogueReleasedPayload.safeParse(input);
  if (!p.success) return err(SettingsReleaseInvalid({ reason: p.error.message }));
  const r = p.data;
  const num = settingsReleaseNumber(r.version);
  if (!num || num.base !== r.base.version) {
    return err(
      SettingsReleaseInvalid({
        reason: `${r.version} is not a settings release of ${r.base.version}`,
      }),
    );
  }
  const base = CATALOGUE_SNAPSHOTS.find((s) => s.version === r.base.version);
  if (!base || base.hash !== r.base.hash) {
    return err(
      SettingsReleaseInvalid({
        reason: `base ${r.base.version} is not a release this build carries`,
      }),
    );
  }
  const snap: CatalogueSnapshot & { base: CatalogueRef } = {
    version: r.version,
    hash: r.hash,
    catalogue: r.catalogue,
    flow: r.flow,
    base: r.base,
  };
  if (snapshotHash(snap) !== r.hash) {
    return err(
      SettingsReleaseInvalid({ reason: `${r.version}: the data does not hash to ${r.hash}` }),
    );
  }
  if (r.catalogue['version'] !== r.version || !CatalogueData.safeParse(r.catalogue).success) {
    return err(SettingsReleaseInvalid({ reason: `${r.version}: not a catalogue of that version` }));
  }
  const had = registered.get(r.version);
  if (had && had.hash !== r.hash) {
    return err(
      SettingsReleaseInvalid({ reason: `${r.version} is already released with another hash` }),
    );
  }
  registered.set(r.version, snap);
  payloads.set(r.version, r);
  return ok(refOf(r));
}

/** The settings release of a version this process registered, if any (`catalogueFor` reads it). */
export const settingsSnapshotOf = (version: string): CatalogueSnapshot | undefined =>
  registered.get(version);

/** Every settings release this process registered, by base then number. */
export const settingsReleases = (): CatalogueRef[] =>
  [...registered.values()]
    .sort((a, b) => {
      const x = settingsReleaseNumber(a.version);
      const y = settingsReleaseNumber(b.version);
      return a.base.version.localeCompare(b.base.version) || (x?.n ?? 0) - (y?.n ?? 0);
    })
    .map(refOf);

/** The recorded payloads of the registered releases (what `planSettingsRelease` compares against). */
export const registeredSettingsReleases = (): CatalogueReleasedPayload[] => [...payloads.values()];

/** Forgets the registered releases (tests). */
export function clearSettingsReleases(): void {
  registered.clear();
  payloads.clear();
}

export const SettingsReleaseMissing = taggedError('SettingsReleaseMissing');

/**
 * The catalogue the factory's settings say NOW, from a config snapshot: its pin and data, for a new item to pin and
 * for the screens that show the current catalogue. `SettingsReleaseMissing`: the settings make a catalogue no
 * release recorded yet (this process has not loaded it, or it was never released): nothing may pin it, so the
 * caller refuses (fail closed); `data` of the error is what it would be, for a preview.
 */
export function currentCatalogue(
  c: SettingsSnapshot | Readonly<Record<string, unknown>>,
): Result<
  { ref: CatalogueRef; data: CatalogueData },
  | SettingsReleaseError
  | ReturnType<typeof SettingsReleaseMissing<{ version: string; data: CatalogueData }>>
> {
  const o = overlayFrom(c);
  if (!o.ok) return o;
  const plan = planSettingsRelease({
    overlay: o.value,
    existing: registeredSettingsReleases(),
    rev_hash: '0'.repeat(64),
  });
  if (!plan.ok) return plan;
  if (plan.value.kind === 'new') {
    const data = CatalogueData.parse(plan.value.release.catalogue);
    return err(SettingsReleaseMissing({ version: plan.value.ref.version, data }));
  }
  const data = catalogueFor(plan.value.ref);
  if (!data.ok) return err(SettingsReleaseInvalid({ reason: data.error._tag }));
  return ok({ ref: plan.value.ref, data: data.value });
}
