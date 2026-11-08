import { MAX_COVERAGE_ITEMS, type CoverageItem } from '@aisdlc/contracts';

/**
 * Adds the items another stage found (the detectors) to the scan's list. An item already listed
 * (same kind, object and path: a file over the cap is seen by both) is not counted twice. The list
 * stays under `MAX_COVERAGE_ITEMS`; counts are always complete (the scan's, plus what is new).
 */
export function mergeCoverage(
  items: readonly CoverageItem[],
  counts: Record<string, number>,
  extra: readonly CoverageItem[],
): { items: CoverageItem[]; counts: Record<string, number> } {
  const key = (i: CoverageItem): string => `${i.kind}\0${i.object ?? ''}\0${i.path ?? ''}`;
  const have = new Set(items.map(key));
  const merged = [...items];
  const out = { ...counts };
  for (const i of extra) {
    if (have.has(key(i))) continue;
    have.add(key(i));
    merged.push(i);
    out[i.kind] = (out[i.kind] ?? 0) + 1;
  }
  merged.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  if (merged.length <= MAX_COVERAGE_ITEMS) return { items: merged, counts: out };
  const kept = merged.filter((i) => i.kind !== 'list_truncated').slice(0, MAX_COVERAGE_ITEMS - 1);
  const dropped = merged.filter((i) => i.kind !== 'list_truncated').length - kept.length;
  kept.push({
    kind: 'list_truncated',
    path: null,
    object: null,
    reason: `${dropped} more coverage items exist; counts are complete`,
  });
  out['list_truncated'] = 1;
  return { items: kept, counts: out };
}
