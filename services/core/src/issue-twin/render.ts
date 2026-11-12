import { CRITERIA_LIST } from '@aisdlc/catalogue';
import {
  ISSUE_TITLE_PREFIX,
  ISSUE_TWIN_LABEL,
  MAX_ISSUE_TITLE,
  gapMarker,
  gapSeverityLabel,
  type Gap,
  type GitSha,
  type IssueTwinDisclosure,
  type IssueTwinDisposition,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import { lintText } from '@aisdlc/text-lint';

// What a twin says on GitHub (OB §7 "Issue format", SEC-OB-4). Everything here is pure and rendered from the record's
// gap row and the criteria catalogue: the same gap renders the same bytes, so the hash a batch approved is the hash
// the tracker files.
//
//   - a hidden marker `<!-- asf-gap: <gap_id> v1 -->`;
//   - title `[onboarding] <criterion> (<RS-id>)`;
//   - body: what is missing, what it unlocks, how to fix it, the factory gap id. No repo text, no path, no commit and
//     no count of anything: the census's evidence stays in the factory (public-safe by construction);
//   - two labels only: `factory:onboarding-gap` + `gap:blocking|gap:tracked`.
//
// Disclosure: a `private_only` gap (a security finding) is never filed, whatever the repo's visibility (OB §5.3: no
// security issue on a public repo, generic text only on a private one, and the security card is the channel). Every
// body passes the shared content lint (which carries the secret ruleset) before it can be approved.

export interface RenderedTwin {
  readonly title: string;
  readonly body: string;
  readonly labels: readonly string[];
  readonly body_sha256: string;
}

const TITLES = new Map(CRITERIA_LIST.map((c) => [c.id as string, c.title]));

/** The criterion's title from the catalogue (the id when the catalogue does not know it). */
export const criterionTitle = (criterion: string): string => TITLES.get(criterion) ?? criterion;

export function twinTitle(g: Pick<Gap, 'criterion'>): string {
  const t = `${ISSUE_TITLE_PREFIX}${criterionTitle(g.criterion)} (${g.criterion})`;
  if (t.length <= MAX_ISSUE_TITLE) return t;
  const tail = ` (${g.criterion})`;
  return `${t.slice(0, MAX_ISSUE_TITLE - tail.length - 1).trimEnd()}…${tail}`;
}

export function renderTwin(g: Gap): RenderedTwin {
  const unlocks =
    g.severity === 'blocking'
      ? `This gap blocks the ${g.blocks_level ?? 'requested'} readiness level of this repository.`
      : 'This gap is tracked: it does not block the readiness level this repository was signed at.';
  const body = [
    gapMarker(g.gap_id),
    '',
    `**What is missing:** the repository does not yet meet ${g.criterion}, "${criterionTitle(g.criterion)}", on its default branch.`,
    '',
    `**What it unlocks:** ${unlocks}`,
    '',
    `**How to fix it:** change the repository so that it meets ${g.criterion}. Once the default branch meets it, the readiness check passes, a comment names the commit it was checked at, and this issue is closed. Closing this issue by hand does not close the gap: the criterion is checked again first.`,
    '',
    `**Factory gap id:** \`${g.gap_id}\``,
    '',
  ].join('\n');
  return {
    title: twinTitle(g),
    body,
    labels: [ISSUE_TWIN_LABEL, gapSeverityLabel(g.severity)],
    body_sha256: sha256Hex(body),
  };
}

/** The comment on a twin a person closed while the criterion is still not met (OB §7: once, never reopened). */
export function unverifiedComment(sha: GitSha | null): string {
  return sha
    ? `This issue was closed, but the criterion is not met at \`${sha}\` on the default branch. The gap stays open in the factory record; this issue is not reopened.`
    : 'This issue was closed, but the criterion could not be checked at the head of the default branch. The gap stays open in the factory record; this issue is not reopened.';
}

/** The comment on a twin the factory closes because its re-check passed. */
export const verifiedComment = (sha: GitSha): string =>
  `Verified at \`${sha}\` on the default branch: the criterion is met. Closing this issue.`;

/** Why a gap may or may not be filed (SEC-OB-4): `private_only` never; a body the lint flags never. */
export function disclosureOf(g: Gap, rendered: RenderedTwin = renderTwin(g)): IssueTwinDisclosure {
  if (g.visibility_class === 'private_only') return 'private_only';
  if (lintText(`${rendered.title}\n${rendered.body}`).length > 0) return 'lint_failed';
  return 'pass';
}

/** What a person may choose for a gap in a batch. A gap that may not be disclosed is tracked only. */
export function allowedTwinDispositions(g: Gap): IssueTwinDisposition[] {
  return disclosureOf(g) === 'pass' ? ['file_issue', 'track_only'] : ['track_only'];
}

/**
 * The default of a batch row (OB §7, DEC-20(a) "blocking, public-safe gaps by default"): file a blocking gap that may
 * be disclosed, or one card 1 already chose to file; track the rest.
 */
export function defaultTwinDisposition(g: Gap): IssueTwinDisposition {
  if (disclosureOf(g) !== 'pass') return 'track_only';
  return g.severity === 'blocking' || g.disposition === 'file_issue' ? 'file_issue' : 'track_only';
}
