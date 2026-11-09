import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WORK_ITEM_TRANSITIONS } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CATALOGUE,
  CATALOGUE_SNAPSHOTS,
  CATALOGUE_VERSION,
  PINNED_FLOW_TABLES,
  catalogueFor,
  catalogueHash,
  currentCatalogueRef,
  releasedCatalogues,
  snapshotHash,
  type CatalogueSnapshot,
} from '../src/index.js';

// Catalogue history: every released catalogue is carried as immutable data, so a catalogue bump
// never strands an item that pinned an earlier one.

// The pins that items were given when these were released, reconstructed from git history (the
// commits that introduced each) and recomputed here. A change to one of these is a corrupted release.
const RELEASED: Record<string, string> = {
  '1.0.0': 'b1f87eab750e56c08d903705040f1a0252cb8a94d143f9563a4fa99769a76da3',
  '1.1.0': '2ac87af649a1a97b9ff84130896683d652f930e935a9cf70abfd8cbb62e5e93a',
  '1.2.0': '6ed4d1f2e037aaa092efd30dad245578d1bf01c381bbe35d927b4e55279210c6',
  '1.3.0': '601beaae85ea26e30b0f13349571b76d549871ea7020afbd2199fb313a86a123',
};

const newest = (): CatalogueSnapshot => CATALOGUE_SNAPSHOTS[CATALOGUE_SNAPSHOTS.length - 1]!;
const semver = (v: string): number[] => v.split('.').map(Number);

// Releasing a catalogue: bump CATALOGUE_VERSION, then `CATALOGUE_WRITE_SNAPSHOT=1 npx vitest run
// --project catalogue history` writes src/snapshots/<version>.json (never over an existing file), then
// add it to CATALOGUE_SNAPSHOTS in history.ts and run prettier on it.
it.skipIf(process.env['CATALOGUE_WRITE_SNAPSHOT'] === undefined)('writes the snapshot', () => {
  const file = new URL(`../src/snapshots/${CATALOGUE_VERSION}.json`, import.meta.url);
  expect(existsSync(file), 'a released snapshot is immutable').toBe(false);
  const snap = {
    version: CATALOGUE_VERSION,
    hash: catalogueHash(),
    catalogue: CATALOGUE,
    flow: PINNED_FLOW_TABLES,
  };
  writeFileSync(file, `${JSON.stringify(snap, null, 2)}\n`);
});

describe('catalogue history', () => {
  it('carries every release since 1.0.0 with the hash its items were pinned with', () => {
    for (const [version, hash] of Object.entries(RELEASED)) {
      const s = CATALOGUE_SNAPSHOTS.find((x) => x.version === version);
      expect(s, version).toBeDefined();
      expect(s?.hash).toBe(hash);
      // recomputed from the data, not read from the file
      expect(snapshotHash(s as CatalogueSnapshot)).toBe(hash);
    }
  });

  it('is ordered oldest first with unique versions, and every snapshot file is registered', () => {
    const versions = CATALOGUE_SNAPSHOTS.map((s) => s.version);
    expect(new Set(versions).size).toBe(versions.length);
    const sorted = [...versions].sort((a, b) => {
      const [x, y] = [semver(a), semver(b)];
      return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
    });
    expect(versions).toEqual(sorted);
    const dir = fileURLToPath(new URL('../src/snapshots/', import.meta.url));
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
    expect(files).toEqual([...versions].sort());
    for (const s of CATALOGUE_SNAPSHOTS) expect(s.catalogue['version']).toBe(s.version);
  });

  it('REGRESSION GUARD: the current catalogue is the newest snapshot, byte for byte', () => {
    // Fails when catalogue data (or a pinned contract flow table) changes without a new
    // CATALOGUE_VERSION and a new file in src/snapshots (see the header of history.ts).
    expect(newest().version, 'bump CATALOGUE_VERSION and add a snapshot').toBe(CATALOGUE_VERSION);
    expect(catalogueHash(), 'the data changed: new version and new snapshot, never an edit').toBe(
      newest().hash,
    );
    expect(JSON.parse(JSON.stringify(CATALOGUE))).toEqual(newest().catalogue);
    expect(JSON.parse(JSON.stringify(PINNED_FLOW_TABLES))).toEqual(newest().flow);
    expect(currentCatalogueRef()).toEqual({ version: newest().version, hash: newest().hash });
  });

  it('returns the pinned catalogue, hash checked, for every release', () => {
    for (const ref of releasedCatalogues()) {
      const r = catalogueFor(ref);
      expect(r.ok, ref.version).toBe(true);
      if (r.ok) expect(r.value.version).toBe(ref.version);
    }
    const cur = catalogueFor(currentCatalogueRef());
    expect(cur.ok && cur.value).toEqual(CATALOGUE);
  });

  it('an old catalogue is what was released (its numbers are not the current ones)', () => {
    const old = catalogueFor({ version: '1.0.0', hash: RELEASED['1.0.0']! });
    expect(old.ok).toBe(true);
    if (old.ok) {
      expect(old.value.version).toBe('1.0.0');
      // later fields take the value of the release that introduced them, so the engine can read them
      expect(old.value.flow_limits).toEqual(CATALOGUE.flow_limits);
    }
  });

  it('fails closed: unknown version, wrong hash, corrupted snapshot are tagged errors', () => {
    const unknown = catalogueFor({ version: '0.9.0', hash: 'a'.repeat(64) });
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error._tag).toBe('CatalogueUnknown');
    const future = catalogueFor({ version: '99.0.0', hash: newest().hash });
    expect(!future.ok && future.error._tag).toBe('CatalogueUnknown');
    const wrong = catalogueFor({ version: '1.1.0', hash: RELEASED['1.2.0']! });
    expect(!wrong.ok && wrong.error._tag).toBe('CatalogueHashMismatch');
    // same version, hash not the released one: the pin is not honoured
    const forged = catalogueFor({ version: '1.2.0', hash: 'f'.repeat(64) });
    expect(!forged.ok && forged.error._tag).toBe('CatalogueHashMismatch');
    // a snapshot whose data moved no longer hashes to its release
    const tampered = structuredClone(CATALOGUE_SNAPSHOTS[0]!) as CatalogueSnapshot;
    (tampered.catalogue['rework_budget'] as { total: { value: number } }).total.value = 99;
    expect(snapshotHash(tampered)).not.toBe(tampered.hash);
  });

  it("every release only ever added phase edges, so the engine may run old items on today's table", () => {
    for (const s of CATALOGUE_SNAPSHOTS) {
      const t = (s.flow as { work_item_transitions: Record<string, string[]> })
        .work_item_transitions;
      for (const [from, tos] of Object.entries(t)) {
        const cur = (WORK_ITEM_TRANSITIONS as Record<string, readonly string[]>)[from] ?? [];
        for (const to of tos) expect(cur, `${s.version} ${from}>${to}`).toContain(to);
      }
    }
  });
});
