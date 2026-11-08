import {
  type CensusInventory,
  type CensusRiskCategory,
  type DetectorId,
  type InventoryKind,
} from '@aisdlc/contracts';
import type { CensusContext } from './context.js';
import { uniqSorted } from './context.js';

// RiskCategory (OB §2.2): the detector floor with its evidence, who raised it, and what the owner
// must still attest. Regulatory and criticality are owner attestation only: never inferred, never
// defaulted to a value. A tier floor from detectors that did not all run is a lower bound, and the
// record says so (`floor_basis: incomplete`, which also blocks M4 until a human looks).

const TIER_DETECTORS: readonly DetectorId[] = [
  'tier_data_class',
  'tier_exposure',
  'tier_blast_radius',
];

export function assembleRisk(c: CensusContext): CensusRiskCategory {
  const d = c.d;
  const signals = c
    .facts('tier_signal')
    .map((f) => ({
      signal: f.signal,
      criterion: f.criterion,
      floor: f.floor,
      raised_by: f.detector,
      evidence: f.evidence,
    }))
    .sort((a, b) =>
      a.signal !== b.signal
        ? a.signal < b.signal
          ? -1
          : 1
        : (a.evidence[0]?.path ?? '') < (b.evidence[0]?.path ?? '')
          ? -1
          : (a.evidence[0]?.path ?? '') > (b.evidence[0]?.path ?? '')
            ? 1
            : (a.evidence[0]?.line ?? 0) - (b.evidence[0]?.line ?? 0),
    );
  const complete = d !== null && TIER_DETECTORS.every((id) => c.ok(id));
  // The floor is the highest signal's (OB §2.2); the detectors' own assessment is the source, and a
  // signal fact list that disagrees with it can only mean a truncated list, which is `incomplete`.
  const floor = d?.tier.floor ?? 'T0';
  const t = c.att.tier;
  const regulatory = t?.regulatory_attested === true ? 'attested' : 'unattested';
  const criticality = t?.criticality_attested === true ? 'attested' : 'unattested';
  const t0 =
    floor !== 'T0' || (t !== undefined && t.signed !== 'T0')
      ? 'not_applicable'
      : t?.t0_attested === true
        ? 'attested'
        : 'unattested';
  const reasons: CensusRiskCategory['blocks_m4_reasons'] = [];
  if (t0 === 'unattested') reasons.push('t0_unattested');
  if (regulatory === 'unattested') reasons.push('regulatory_unattested');
  if (criticality === 'unattested') reasons.push('criticality_unattested');
  if (!complete) reasons.push('detectors_incomplete');
  return {
    tier_floor: floor,
    signals,
    raised_by: uniqSorted(signals.map((s) => s.raised_by)) as DetectorId[],
    regulatory,
    criticality,
    t0,
    floor_basis: complete ? 'complete' : 'incomplete',
    blocks_m4_until_attested: reasons.length > 0,
    blocks_m4_reasons: reasons,
  };
}

/** The instruction and harness inventory as a summary: kinds, counts, what runs on its own. */
export function assembleInventory(c: CensusContext): CensusInventory {
  const facts = c.facts('instruction_file');
  const kinds = facts.map((f) => ({
    inventory: f.inventory,
    state: f.state,
    file_count: f.file_count,
    auto_run: f.auto_run,
  }));
  const agents = c.inventory('agents_md');
  const num = (v: unknown): number | null => (typeof v === 'number' ? v : null);
  const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
  return {
    status: c.ok('inventory') ? 'complete' : 'incomplete',
    kinds,
    files_total: facts.reduce((n, f) => n + f.file_count, 0),
    auto_run_kinds: facts
      .filter((f) => f.auto_run === 'yes')
      .map((f) => f.inventory) as InventoryKind[],
    agents:
      agents === undefined
        ? null
        : {
            root_present: bool(agents.detail['root_present']),
            root_lines: num(agents.detail['root_lines']),
            chain_bytes: num(agents.detail['max_chain_bytes']),
            nested: num(agents.detail['nested_count']),
          },
  };
}
