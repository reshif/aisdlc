import { describe, expect, it } from 'vitest';
import { CatalogueRef, S0Record, WorkItem, WorkRequest } from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import {
  CATALOGUE,
  CATALOGUE_VERSION,
  CatalogueData,
  PINNED_FLOW_TABLES,
  catalogueHash,
  currentCatalogueRef,
  isCurrentCatalogue,
} from '../src/index.js';

const U1 = '018f3c1e-7b2a-7c3d-8e4f-0123456789ab';
const U2 = '018f3c1e-7b2a-7c3d-8e4f-0123456789ac';
const clone = (): CatalogueData => structuredClone(CATALOGUE);

describe('catalogue pinning (M1.6)', () => {
  it('changes when a pinned contract flow table changes', () => {
    const flow = structuredClone(PINNED_FLOW_TABLES) as unknown as {
      work_item_transitions: Record<string, string[]>;
    };
    flow.work_item_transitions['S5'] = ['Scheduling'];
    expect(catalogueHash(CATALOGUE, flow)).not.toBe(catalogueHash());
  });

  it('is version 1.2.0 and validates against its schema', () => {
    expect(CATALOGUE_VERSION).toBe('1.2.0');
    expect(CATALOGUE.version).toBe('1.2.0');
    expect(CatalogueData.safeParse(CATALOGUE).success).toBe(true);
  });

  it('currentCatalogueRef is a valid {version, hash} of the canonical data', () => {
    const ref = currentCatalogueRef();
    expect(CatalogueRef.safeParse(ref).success).toBe(true);
    expect(ref).toEqual({
      version: '1.2.0',
      hash: hashCanonical({ catalogue: CATALOGUE, flow: PINNED_FLOW_TABLES }),
    });
    expect(isCurrentCatalogue(ref)).toBe(true);
  });

  it('the hash is stable: same value on every call and for a deep copy', () => {
    const h = catalogueHash();
    expect(catalogueHash()).toBe(h);
    expect(currentCatalogueRef().hash).toBe(h);
    expect(catalogueHash(clone())).toBe(h);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  it('the returned ref is a copy: mutating it does not move the pin', () => {
    const a = currentCatalogueRef() as { version: string; hash: string };
    a.hash = '0'.repeat(64);
    expect(currentCatalogueRef().hash).toBe(catalogueHash());
  });

  it('the hash changes when any catalogue value changes', () => {
    const h = catalogueHash();
    const edits: [string, (c: CatalogueData) => void][] = [
      ['version', (c) => void (c.version = '1.0.1')],
      ['lane stage mode', (c) => void (c.lanes.L4.stages[1]!.mode = 'skipped')],
      ['lane gate position', (c) => void (c.lanes.L6.gates[0]!.step = '1.5')],
      ['lane envelope', (c) => void (c.lanes.L0.profile.default_envelope.budget_cents = 100)],
      ['oracle source', (c) => void (c.lanes.L1.profile.oracle_source = 'repro_test')],
      [
        'back-edge limit',
        (c) => {
          const e = c.back_edge_limits.B1;
          if (e.kind === 'limited') e.limits[0]!.value = 3;
        },
      ],
      [
        'back-edge reason',
        (c) => {
          const e = c.back_edge_limits.B16;
          if (e.kind === 'not_applicable') e.reason = `${e.reason}.`;
        },
      ],
      ['rework total', (c) => void (c.rework_budget.total.value = 6)],
      ['rework tune flag', (c) => void (c.rework_budget.total.tune = false)],
      ['envelope extension', (c) => void (c.envelope_extension.max_percent.value = 60)],
      [
        'trigger effect',
        (c) => void (c.triggers.ET7.effects[0] = { kind: 'handoff', handoff: 'D1' }),
      ],
      ['trigger threshold', (c) => void (c.triggers.ET1.thresholds[0]!.value = 90)],
      [
        'gating default',
        (c) => void (c.gating.defaults.g6 = { kind: 'fixed', value: 'off', exceptions: [] }),
      ],
      ['schedule default', (c) => void (c.gating.schedule_default = 'human')],
      ['t2 floor', (c) => void c.gating.t2_floor.groups.pop()],
      ['always required', (c) => void c.gating.always_required.pop()],
      ['eligibility', (c) => void (c.eligibility.by_level.light.L0 = 'eligible')],
      ['tier min level', (c) => void delete c.eligibility.tier_min_level.T2],
      ['autonomy tier cap', (c) => void (c.autonomy.tier.T2 = 'A3')],
      ['autonomy readiness', (c) => void (c.autonomy.readiness.RL0 = 'A0')],
      ['probation weeks', (c) => void (c.autonomy.probation.min_weeks.value = 3)],
      ['criterion class', (c) => void (c.criteria.criteria[5]!.class_by_level.light = 'FLOOR')],
      ['criterion title', (c) => void (c.criteria.criteria[0]!.title += ' ')],
      ['floor', (c) => void (c.criteria.floors[0]!.criteria = ['RS-ID-2'])],
    ];
    const seen = new Set<string>([h]);
    for (const [name, edit] of edits) {
      const c = clone();
      edit(c);
      const changed = catalogueHash(c);
      expect(changed, name).not.toBe(h);
      seen.add(changed);
    }
    expect(seen.size).toBe(edits.length + 1);
  });

  it('every leaf of the catalogue is covered by the hash (spot-check by perturbing each top-level key)', () => {
    const h = catalogueHash();
    for (const key of Object.keys(CATALOGUE) as (keyof CatalogueData)[]) {
      const c = {
        ...clone(),
        [key]: key === 'version' ? '9.9.9' : { extra: 1 },
      } as unknown as CatalogueData;
      expect(catalogueHash(c), key).not.toBe(h);
    }
  });

  it('a pin made now still validates on requests, items and S0 records, and a new catalogue does not move it', () => {
    const pin = currentCatalogueRef();
    const request = {
      request_id: U1,
      project_id: 'acme-web',
      channel: 'N1',
      requester: 'alice',
      received_at: '2026-11-08T10:00:00Z',
      catalogue_ref: pin,
    };
    const item = {
      item_id: U2,
      project_id: 'acme-web',
      request_id: U1,
      phase: 'S1',
      lane: null,
      stage: 'S1',
      owner_of_record: null,
      tier: null,
      catalogue_ref: pin,
    };
    const s0 = {
      s0_id: U2,
      project_id: 'acme-web',
      repo_id: 'r1',
      status: 'app',
      requested_level: 'census',
      signable_level: 'census',
      intake_ref: 'record:e1',
      rejected_at: null,
      readiness_version: null,
      catalogue_ref: pin,
      version: 1,
      created_at: '2026-11-08T10:00:00Z',
      updated_at: '2026-11-08T10:00:00Z',
    };
    expect(WorkRequest.parse(request).catalogue_ref).toEqual(pin);
    expect(WorkItem.parse(item).catalogue_ref).toEqual(pin);
    expect(S0Record.parse(s0).catalogue_ref).toEqual(pin);

    // A later catalogue has another hash; the stored pin is not "current" any more but stays valid.
    const changed = clone();
    changed.rework_budget.total.value = 7;
    const later = { version: '1.2.0', hash: catalogueHash(changed) };
    expect(later.hash).not.toBe(pin.hash);
    expect(isCurrentCatalogue(later)).toBe(false);
    expect(isCurrentCatalogue(pin)).toBe(true);
    expect(WorkItem.parse(item).catalogue_ref).toEqual(pin);
  });
});
