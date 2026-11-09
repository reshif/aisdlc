import {
  CATALOGUE,
  catalogueFor,
  currentCatalogueRef,
  releasedCatalogues,
} from '@aisdlc/catalogue';
import { ITEM_EVENT, LaneValues, type RecordEvent } from '@aisdlc/contracts';
import { describe, expect, it } from 'vitest';
import {
  CataloguePinUnavailable,
  catalogueOfItem,
  foldItem,
  pinnedCatalogueResolver,
} from '../src/index.js';
import { PROFILE_ALL_ON, Sim, createdPayload, uuid } from './sim.js';

// An item pinned to a released catalogue keeps running on THAT catalogue after the current one has
// moved on (M9.2/M9.4 defect: only the current one shipped, so every bump stranded in-flight items).

const older = releasedCatalogues().filter((r) => r.version !== currentCatalogueRef().version);

function recordOf(sim: Sim, ref: (typeof older)[number]): RecordEvent[] {
  const all = [
    {
      type: ITEM_EVENT.created as string,
      payload: createdPayload(sim.name, { catalogue_ref: ref }) as unknown,
      seq: 1,
    },
    ...sim.steps.map((s) => ({
      type: s.event.type as string,
      payload: s.event.payload,
      seq: s.event.seq,
    })),
  ];
  return all.map(
    (e) =>
      ({
        event_id: uuid(`e:${sim.name}:${e.seq}`),
        stream_id: `item:${sim.state.item_id}`,
        stream_seq: e.seq,
        global_seq: e.seq,
        type: e.type,
        payload: e.payload,
        actor: 'test',
        idempotency_key: null,
        occurred_at: new Date(Date.UTC(2026, 10, 9, 8, 0, e.seq)).toISOString(),
        prev_hash: '0'.repeat(64),
        hash: '0'.repeat(64),
      }) as unknown as RecordEvent,
  );
}

describe('an item pinned to an older catalogue', () => {
  it('there are older releases to pin to', () => {
    expect(older.map((o) => o.version)).toContain('1.1.0');
  });

  for (const ref of older) {
    for (const lane of LaneValues) {
      it(`${ref.version}: ${lane} continues to a terminal state, and its stream refolds to the same state`, () => {
        const cat = catalogueFor(ref);
        expect(cat.ok).toBe(true);
        if (!cat.ok) return;
        expect(ref.hash).not.toBe(currentCatalogueRef().hash);
        const sim = new Sim(
          `pin-${ref.version}-${lane}`,
          { lane, profile: PROFILE_ALL_ON, catalogue_ref: ref },
          cat.value,
        );
        sim.submit();
        sim.run();
        expect(sim.state.terminal).not.toBeNull();
        expect(sim.state.catalogue_ref).toEqual(ref);
        const folded = foldItem(recordOf(sim, ref), pinnedCatalogueResolver);
        expect(folded?.state.terminal).toBe(sim.state.terminal);
        expect(folded?.state.phase).toBe(sim.state.phase);
        expect(folded?.state.catalogue_ref).toEqual(ref);
      });
    }
  }

  it('is read through its own catalogue, never the current one', () => {
    const ref = older[0]!;
    const cat = catalogueFor(ref);
    if (!cat.ok) throw new Error('released catalogue missing');
    const sim = new Sim('pin-own', { catalogue_ref: ref }, cat.value);
    expect(catalogueOfItem(sim.state).version).toBe(ref.version);
    expect(catalogueOfItem(sim.state)).not.toEqual(CATALOGUE);
  });

  it('a pin this build does not carry cannot be interpreted (fail closed)', () => {
    const state = { catalogue_ref: { version: '0.0.1', hash: 'a'.repeat(64) } };
    expect(() => catalogueOfItem(state)).toThrow(CataloguePinUnavailable);
    expect(pinnedCatalogueResolver(state.catalogue_ref)).toBeNull();
    // right version, wrong hash
    expect(pinnedCatalogueResolver({ version: '1.1.0', hash: 'b'.repeat(64) })).toBeNull();
  });

  it('new items pin the current catalogue', () => {
    expect(createdPayload('fresh').catalogue_ref).toEqual(currentCatalogueRef());
  });
});
