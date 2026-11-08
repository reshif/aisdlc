import {
  MAX_WAIVER_DAYS,
  cardPayloadItemKey,
  levelRank,
  type CardPayloadItem,
  type Gap,
  type GapDisposition,
  type GapDispositionInput,
} from '@aisdlc/contracts';
import { err, hashCanonical, ok, type Result } from '@aisdlc/kernel';
import { coreError, type CoreError } from '../errors.js';

// The gap dispositions of card 1 (OB §7). Filing is a decision event on the step's card, not a gate:
// the exact list and its hash are what the ledger entry carries. Defaults: a blocking gap that is
// public-safe is filed as an issue; a tracked gap is tracked; a security gap is tracked, always.
// Waivers last at most 90 days, and a blocking gap can never be waived (P-MUST-12): fix it, or sign
// a lower level.

const DAY_MS = 24 * 3600 * 1000;

/** Security findings (and everything derived from them) are `private_only`: tracked, never filed or waived. */
export const isPrivateOnly = (g: Gap): boolean => g.visibility_class === 'private_only';

export function defaultDisposition(g: Gap): GapDisposition {
  if (isPrivateOnly(g)) return 'track_only';
  return g.severity === 'blocking' ? 'file_issue' : 'track_only';
}

export function allowedDispositions(g: Gap): GapDisposition[] {
  if (isPrivateOnly(g)) return ['track_only'];
  return g.severity === 'blocking'
    ? ['file_issue', 'track_only']
    : ['file_issue', 'track_only', 'waive'];
}

/**
 * Checks that `rows` dispose of every gap exactly once and that each disposition is allowed, and
 * returns the payload rows, ordered by gap id. Nothing is defaulted: a gap the person did not
 * dispose of is refused ("every gap disposed" is a condition of the step's exit).
 */
export function gapPayload(
  gaps: readonly Gap[],
  rows: readonly GapDispositionInput[],
  now: Date,
): Result<CardPayloadItem[], CoreError> {
  const byId = new Map(gaps.map((g) => [g.gap_id, g]));
  const seen = new Set<string>();
  const out: CardPayloadItem[] = [];
  for (const r of rows) {
    const g = byId.get(r.gap_id);
    if (!g) return err(coreError('invalid_input', `${r.gap_id} is not a gap of this census`));
    if (seen.has(r.gap_id)) return err(coreError('invalid_input', `${r.gap_id} is disposed twice`));
    seen.add(r.gap_id);
    if (r.disposition === 'waive' && g.severity === 'blocking') {
      return err(
        coreError(
          'refused',
          `${r.gap_id} is blocking at ${g.blocks_level ?? 'its level'} and cannot be waived: fix it, or sign a lower level`,
        ),
      );
    }
    if (!allowedDispositions(g).includes(r.disposition)) {
      return err(
        coreError(
          'refused',
          isPrivateOnly(g)
            ? `${r.gap_id} is a security gap: it is tracked only, never filed or waived`
            : `${r.disposition} is not allowed for ${r.gap_id}`,
        ),
      );
    }
    if (r.disposition === 'waive') {
      if (!r.waiver) {
        return err(
          coreError('invalid_input', `${r.gap_id}: a waiver needs a reason and an expiry`),
        );
      }
      const exp = Date.parse(r.waiver.expires_at);
      if (!(exp > now.getTime())) {
        return err(coreError('invalid_input', `${r.gap_id}: the waiver must expire in the future`));
      }
      if (exp - now.getTime() > MAX_WAIVER_DAYS * DAY_MS) {
        return err(
          coreError('refused', `${r.gap_id}: a waiver lasts at most ${MAX_WAIVER_DAYS} days`),
        );
      }
    } else if (r.waiver) {
      return err(coreError('invalid_input', `${r.gap_id}: only a waived gap has a waiver`));
    }
    out.push({
      kind: 'gap_disposition',
      gap_id: g.gap_id,
      criterion: g.criterion,
      disposition: r.disposition,
      ...(r.waiver ? { waiver: r.waiver } : {}),
    });
  }
  const missing = gaps.filter((g) => !seen.has(g.gap_id));
  if (missing.length > 0) {
    return err(
      coreError(
        'refused',
        `every gap is disposed of: ${missing.length} left (${missing
          .slice(0, 3)
          .map((g) => g.gap_id)
          .join(', ')}${missing.length > 3 ? ', ...' : ''})`,
      ),
    );
  }
  return ok(out.sort((a, b) => cmp(cardPayloadItemKey(a), cardPayloadItemKey(b))));
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The hash of the gap ledger as card 1 disposed it: every gap with its disposition and waiver, in
 * gap id order. One of the three hashes M4 will sign (OB §6.2 row 0.5).
 */
export function gapLedgerHash(gaps: readonly Gap[], payload: readonly CardPayloadItem[]): string {
  const rows = new Map<string, Extract<CardPayloadItem, { kind: 'gap_disposition' }>>();
  for (const p of payload) if (p.kind === 'gap_disposition') rows.set(p.gap_id, p);
  return hashCanonical(
    [...gaps]
      .sort((a, b) => cmp(a.gap_id, b.gap_id))
      .map((g) => ({
        gap_id: g.gap_id,
        criterion: g.criterion,
        severity: g.severity,
        blocks_level: g.blocks_level,
        visibility_class: g.visibility_class,
        disposition: rows.get(g.gap_id)?.disposition ?? null,
        waiver: rows.get(g.gap_id)?.waiver ?? null,
      })),
  );
}

/** True when `level` is above `than`; kept here so the card code reads the ranks one way. */
export const above = (
  level: Parameters<typeof levelRank>[0],
  than: Parameters<typeof levelRank>[0],
) => levelRank(level) > levelRank(than);
