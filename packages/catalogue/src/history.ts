import { CatalogueRef } from '@aisdlc/contracts';
import { err, hashCanonical, ok, taggedError, type Result } from '@aisdlc/kernel';
import s100 from './snapshots/1.0.0.json' with { type: 'json' };
import s110 from './snapshots/1.1.0.json' with { type: 'json' };
import s120 from './snapshots/1.2.0.json' with { type: 'json' };
import s130 from './snapshots/1.3.0.json' with { type: 'json' };
import s140 from './snapshots/1.4.0.json' with { type: 'json' };
import { CatalogueData } from './schema.js';

// Catalogue history. An item pins {version, hash} when it is created (M1.6) and keeps that pin for
// its whole life, so every RELEASED catalogue stays available here, as data, exactly as it was
// released. A snapshot is immutable: its hash is the one items were given, and `catalogueFor` checks
// it twice (the pin against the snapshot, the snapshot's data against its own hash) before it returns
// anything. A catalogue that is not here is a tagged error: an item pinned to it cannot be
// interpreted, and fails closed. The current catalogue is the newest snapshot (a test fails when the
// code's catalogue data moves without a new version and a new snapshot file).

/** One released catalogue: the data and the contract flow tables the hash covers. */
export interface CatalogueSnapshot {
  readonly version: string;
  readonly hash: string;
  readonly catalogue: Record<string, unknown>;
  readonly flow: unknown;
}

/** Oldest first. Add the next release here, never edit an entry. */
export const CATALOGUE_SNAPSHOTS: readonly CatalogueSnapshot[] = [
  s100 as unknown as CatalogueSnapshot,
  s110 as unknown as CatalogueSnapshot,
  s120 as unknown as CatalogueSnapshot,
  s130 as unknown as CatalogueSnapshot,
  s140 as unknown as CatalogueSnapshot,
];

/**
 * The settings releases (`<base>+settings.<n>`, `settings.ts`) this process has read from the record and checked
 * (`registerSettingsRelease`). Not a code release: each came from a published settings revision.
 */
export const registeredSettingsSnapshots = new Map<
  string,
  CatalogueSnapshot & { base: CatalogueRef }
>();

export const CatalogueUnknown = taggedError('CatalogueUnknown');
export const CatalogueHashMismatch = taggedError('CatalogueHashMismatch');
export const CatalogueSnapshotCorrupt = taggedError('CatalogueSnapshotCorrupt');
export type CatalogueError =
  | ReturnType<typeof CatalogueUnknown<{ version: string; known: string[] }>>
  | ReturnType<typeof CatalogueHashMismatch<{ version: string; pinned: string; released: string }>>
  | ReturnType<typeof CatalogueSnapshotCorrupt<{ version: string; recomputed: string }>>;

/** Hash of a snapshot's own data, the way `catalogueHash` makes it. */
export const snapshotHash = (s: CatalogueSnapshot): string =>
  hashCanonical({ catalogue: s.catalogue, flow: s.flow });

/**
 * A snapshot lacks the fields later releases added. They take the value of the EARLIEST release
 * that has them, which is what the engine's later behaviour was introduced with (flow limits,
 * re-laning limits): an item pinned before them gets the numbers the field was born with, not a
 * silent absence. The pin and the hash are unaffected: they cover the snapshot as released.
 */
function withLaterFields(s: CatalogueSnapshot): Record<string, unknown> {
  const data: Record<string, unknown> = structuredClone(s.catalogue);
  for (const later of CATALOGUE_SNAPSHOTS) {
    for (const [k, v] of Object.entries(later.catalogue)) {
      if (!(k in data)) data[k] = structuredClone(v);
    }
  }
  return data;
}

const parsed = new Map<string, CatalogueData>(); // by version and hash

/**
 * The catalogue an item is pinned to. The version must be a released one, the pin's hash must be the
 * released hash, and the snapshot must still hash to it. Cached per version: the result is read-only.
 */
export function catalogueFor(ref: CatalogueRef): Result<CatalogueData, CatalogueError> {
  const s =
    CATALOGUE_SNAPSHOTS.find((x) => x.version === ref.version) ??
    registeredSettingsSnapshots.get(ref.version);
  if (s === undefined) {
    return err(
      CatalogueUnknown({
        version: ref.version,
        known: [
          ...CATALOGUE_SNAPSHOTS.map((x) => x.version),
          ...registeredSettingsSnapshots.keys(),
        ],
      }),
    );
  }
  if (s.hash !== ref.hash) {
    return err(CatalogueHashMismatch({ version: ref.version, pinned: ref.hash, released: s.hash }));
  }
  const hit = parsed.get(`${s.version}/${s.hash}`);
  if (hit) return ok(hit);
  const recomputed = snapshotHash(s);
  if (recomputed !== s.hash) {
    return err(CatalogueSnapshotCorrupt({ version: s.version, recomputed }));
  }
  const data = CatalogueData.parse(withLaterFields(s));
  parsed.set(`${s.version}/${s.hash}`, data);
  return ok(data);
}

/** Every released version, oldest first, with its pin. */
export const releasedCatalogues = (): CatalogueRef[] =>
  CATALOGUE_SNAPSHOTS.map((s) => CatalogueRef.parse({ version: s.version, hash: s.hash }));
