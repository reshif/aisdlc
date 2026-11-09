import type { CatalogueData, Limit } from '@aisdlc/catalogue';
import type { BackEdgeId, TriggerId } from '@aisdlc/contracts';

// What the catalogue says about limits, read one way for the whole engine. No number is written in the
// engine: the back-edge limits, the rework budget, the envelope extension and the ET table are the
// pinned catalogue's (PLAN M1.5, FL B1-B28, FIX 14).

/** Limits counted in loops (a round, a time, a rejection); the others are a measure the stage reports. */
export const isCountUnit = (unit: Limit['unit']): boolean =>
  unit === 'count' || unit === 'rounds' || unit === 'times';

/**
 * The number a limit stands for. The flow names the S7 loops "ET3/ET4/ET5/ET6 limits" and gives them
 * no value of their own: where the edge's limit is `null` and its key names a trigger (`et3_rounds`),
 * the trigger's threshold is used (ET3: 3 rounds). A limit with no number anywhere is `null`: no
 * loop limit of its own, so only the item's rework budget bounds it.
 */
export function effectiveLimit(cat: CatalogueData, limit: Limit): number | null {
  if (limit.value !== null) return limit.value;
  const m = /^(et\d+)_/.exec(limit.key);
  if (!m) return null;
  const t = cat.triggers[(m[1] as string).toUpperCase() as TriggerId];
  return t?.thresholds.find((x) => x.value !== null)?.value ?? null;
}

/** One limit of an edge by its key, or `null` for an edge with no such limit. */
export function edgeLimit(cat: CatalogueData, edge: BackEdgeId, key: string): Limit | null {
  const e = cat.back_edge_limits[edge];
  if (e.kind !== 'limited') return null;
  return e.limits.find((l) => l.key === key) ?? null;
}

export function limitValue(cat: CatalogueData, edge: BackEdgeId, key: string): number | null {
  const l = edgeLimit(cat, edge, key);
  return l === null ? null : effectiveLimit(cat, l);
}

/** FIX 14: the per-item rework total at which an item goes straight to E4 (B28). */
export const reworkTotalLimit = (cat: CatalogueData): number | null =>
  cat.rework_budget.total.value;
/** FIX 14: the item age (business days) over which an item goes straight to E4 (B28). */
export const itemAgeLimitBd = (cat: CatalogueData): number | null =>
  cat.rework_budget.item_age.value;
/** B1's PARKED timeout, business days. */
export const parkBusinessDays = (cat: CatalogueData): number | null =>
  limitValue(cat, 'B1', 'park');

/** E4 -> E3/E5: how many extensions, and how much each may add (percent). */
export const extensionRules = (
  cat: CatalogueData,
): { max_extensions: number | null; max_percent: number | null } => ({
  max_extensions: cat.envelope_extension.max_extensions.value,
  max_percent: cat.envelope_extension.max_percent.value,
});

/**
 * B19: a gate-miss rate over a minimum sample suspends mode E. `missed` of `sampled`: above the
 * catalogue's percent over at least its sample size. Under the minimum sample nothing is suspended.
 */
export function modeESuspension(
  cat: CatalogueData,
  s: { sampled: number; missed: number },
): boolean {
  const rate = limitValue(cat, 'B19', 'miss_rate');
  const min = limitValue(cat, 'B19', 'min_sample');
  if (rate === null || min === null) return false;
  if (s.sampled < min || s.sampled === 0) return false;
  return (s.missed / s.sampled) * 100 > rate;
}

/** D4 "hand back once": how many times a developer may hand an item back to the agent. */
export const handBackLimit = (cat: CatalogueData): number | null =>
  cat.flow_limits.d4_hand_back.value;
/** X3 (and G3o at 6.3) "denied: find an alternative, 1x, else D1". */
export const alternativeLimit = (cat: CatalogueData): number | null =>
  cat.flow_limits.x3_alternative.value;
