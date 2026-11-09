import {
  ACTION_IDS,
  ROLE_CATALOGUE,
  actionDef,
  pdpResource,
  type ActionId,
  type PdpResource,
  type Scope,
} from '@aisdlc/contracts';
import { FakePdpEntities } from '@aisdlc/ports';
import { Pdp, StaticBundleSource, buildBundle, MemoryDecisionLog } from '../src/index.js';

export const FLEET: Scope = { kind: 'fleet', ref: '*' };
export const team = (t: string): Scope => ({ kind: 'team', ref: t });
export const proj = (p: string): Scope => ({ kind: 'project', ref: p });
export const lane = (p: string, l: string): Scope => ({ kind: 'lane', ref: `${p}/${l}` });

export interface Rig {
  readonly entities: FakePdpEntities;
  readonly source: StaticBundleSource;
  readonly log: MemoryDecisionLog;
  readonly pdp: Pdp;
}

export function rig(o: { sampleRate?: number } = {}): Rig {
  const entities = new FakePdpEntities();
  const source = new StaticBundleSource(buildBundle());
  const log = new MemoryDecisionLog();
  const pdp = new Pdp({
    source,
    entities,
    log,
    ...(o.sampleRate ? { sampleRate: o.sampleRate } : {}),
  });
  return { entities, source, log, pdp };
}

/** Every resource the matrix asks about: two projects, a lane, items, and a gate of each slot. */
export const RESOURCES: ReadonlyArray<{ name: string; res: PdpResource; project: string | null }> =
  [
    { name: 'fleet', res: pdpResource.fleet(), project: null },
    { name: 'team t1', res: pdpResource.team('t1'), project: null },
    { name: 'team t2', res: pdpResource.team('t2'), project: null },
    { name: 'project p1', res: pdpResource.project('p1'), project: 'p1' },
    { name: 'project p2', res: pdpResource.project('p2'), project: 'p2' },
    { name: 'lane p1/L3', res: pdpResource.lane('p1', 'L3'), project: 'p1' },
    { name: 'lane p1/L4', res: pdpResource.lane('p1', 'L4'), project: 'p1' },
    { name: 'repo p1/r', res: pdpResource.repo('p1', 'r'), project: 'p1' },
    { name: 'item in L3', res: pdpResource.item('p1', 'i1', 'L3'), project: 'p1' },
    { name: 'item no lane', res: pdpResource.item('p1', 'i2'), project: 'p1' },
    ...(['G0', 'G2', 'G3', 'G4', 'G5', 'G6', 'X1', 'M1', 'M4', 'Q1'] as const).flatMap((g) => [
      {
        name: `gate ${g} p1`,
        res: pdpResource.gate('p1', `gate-${g}`, g, { item: 'i1', lane: 'L3' }),
        project: 'p1',
      },
      { name: `gate ${g} p2`, res: pdpResource.gate('p2', `gate-${g}`, g), project: 'p2' },
    ]),
    { name: 'card p1', res: pdpResource.card('p1', 'card-1'), project: 'p1' },
    { name: 'card p2', res: pdpResource.card('p2', 'card-1'), project: 'p2' },
  ];

export const applicable = (a: ActionId, r: PdpResource): boolean =>
  (actionDef(a).resource_types as readonly string[]).includes(r.type);

export { ACTION_IDS, ROLE_CATALOGUE };
