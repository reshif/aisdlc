import { LaneValues, type Lane, type WorkItemId } from '@aisdlc/contracts';
import { CATALOGUE } from '@aisdlc/catalogue';

// S1 step 1.2: de-dupe and conflict scan (FL; deterministic part). The same repo, the same normalised
// text hash and an item that is still open is a DUPLICATE: the new item is LINKED to it and nothing is
// merged (the factory never merges items, and a person decides what to do with a link). Open
// agent-lane items on the same repo are listed as CONFLICT candidates, for the card; they change
// nothing.

export interface OpenItemSummary {
  readonly item_id: WorkItemId;
  readonly repo: string;
  readonly text_sha256: string | null;
  /** The lane it is bound to, else the one proposed. */
  readonly lane: Lane;
}

/** Lanes whose build ends in a pull request: L0-L6 (S6 is `full`, so it includes step 6.6). */
export const WRITE_LANES: readonly Lane[] = LaneValues.filter(
  (l) => CATALOGUE.lanes[l].stages.find((s) => s.stage === 'S6')?.mode === 'full',
);

export interface DedupeResult {
  readonly dedupe_links: WorkItemId[];
  readonly conflict_candidates: WorkItemId[];
}

export const MAX_CONFLICT_CANDIDATES = 20;

export function dedupeScan(
  candidate: { readonly repo: string; readonly text_sha256: string | null; readonly lane: Lane },
  open: readonly OpenItemSummary[],
): DedupeResult {
  const repo = candidate.repo.toLowerCase();
  const sameRepo = open.filter((o) => o.repo.toLowerCase() === repo);
  const dup = new Set(
    candidate.text_sha256 === null
      ? []
      : sameRepo.filter((o) => o.text_sha256 === candidate.text_sha256).map((o) => o.item_id),
  );
  const conflicts = WRITE_LANES.includes(candidate.lane)
    ? sameRepo
        .filter((o) => !dup.has(o.item_id) && WRITE_LANES.includes(o.lane))
        .map((o) => o.item_id)
    : [];
  const sort = (xs: Iterable<WorkItemId>) => [...xs].sort();
  return {
    dedupe_links: sort(dup),
    conflict_candidates: sort(conflicts).slice(0, MAX_CONFLICT_CANDIDATES),
  };
}
