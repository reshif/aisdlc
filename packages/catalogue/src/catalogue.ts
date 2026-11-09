import {
  BACK_EDGES,
  GATES,
  HANDOFF_EDGES,
  QUARANTINE_EDGES,
  RELANE_EDGES,
  STEPS,
  WORK_ITEM_TRANSITIONS,
} from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import { AUTONOMY } from './autonomy.js';
import { CRITERIA } from './criteria.js';
import { ELIGIBILITY } from './eligibility.js';
import { GATING } from './gating.js';
import { LANES } from './lanes.js';
import {
  BACK_EDGE_LIMITS,
  ENVELOPE_EXTENSION,
  FLOW_LIMITS,
  REWORK_BUDGET,
  TRIGGERS,
} from './limits.js';
import { CatalogueData } from './schema.js';

/**
 * The catalogue version. A change to any value below needs a new version (the hash will differ).
 * 1.1.0 (M9.2): the pinned phase table gains S8b -> S9 and S9 -> Done, the edges a gate that is OFF
 * (G5, G6) leaves behind: off means absent, so the phase after it follows directly.
 * 1.2.0 (M9.4): the phase table gains `-> Handoff` from every active phase (E4 is reached directly from
 * B2, B23-B25 and B28), and `flow_limits` holds D4 "hand back once" and X3 "find alternative, 1x".
 * 1.3.0 (M9.5): ET14's `trip` threshold is 3 (the flow gives R3 no number), and the phase table is
 * unchanged. Released versions are immutable snapshots (`history.ts`); never edit one.
 */
export const CATALOGUE_VERSION = '1.3.0';

/** The catalogue, validated by `CatalogueData` when this module loads. An invalid catalogue throws. */
export const CATALOGUE: CatalogueData = CatalogueData.parse({
  version: CATALOGUE_VERSION,
  lanes: LANES,
  back_edge_limits: BACK_EDGE_LIMITS,
  rework_budget: REWORK_BUDGET,
  envelope_extension: ENVELOPE_EXTENSION,
  flow_limits: FLOW_LIMITS,
  triggers: TRIGGERS,
  gating: GATING,
  eligibility: ELIGIBILITY,
  autonomy: AUTONOMY,
  criteria: CRITERIA,
});

/**
 * The flow tables from contracts that the lifecycle reads together with the catalogue. They are part
 * of the pin: an item started under one gate, step or edge table must not silently move to another.
 */
export const PINNED_FLOW_TABLES = {
  gates: GATES,
  steps: STEPS,
  back_edges: BACK_EDGES,
  handoff_edges: HANDOFF_EDGES,
  relane_edges: RELANE_EDGES,
  quarantine_edges: QUARANTINE_EDGES,
  work_item_transitions: WORK_ITEM_TRANSITIONS,
} as const;

/**
 * sha256 of the canonical JSON (RFC 8785) of the catalogue data together with the pinned flow tables
 * from contracts, so a change to either changes the pin.
 */
export function catalogueHash(
  data: CatalogueData = CATALOGUE,
  flow: unknown = PINNED_FLOW_TABLES,
): string {
  return hashCanonical({ catalogue: data, flow });
}
