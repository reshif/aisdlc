import {
  label,
  lookupTerm,
  type GateId,
  type GlossaryFamily,
  type PortalInboxItem,
  type StageId,
} from '@aisdlc/contracts';
import type { NeedsYouRow } from '../ui';

// The Work squad's words (portal v2, docs/design/screen-map.md §2.1-2.8): every label from the glossary, every value
// off the wire through `lookupTerm` so an unknown value reads "Unknown", never its code. Times follow glossary §1:
// relative under 7 days, a date otherwise, the full time in the tooltip.

/** A value off the wire in plain words; "Unknown" when the glossary does not have it. */
export const wire = (family: GlossaryFamily, value: string | null | undefined): string =>
  value === null || value === undefined
    ? 'Unknown'
    : (lookupTerm(family, value)?.label ?? 'Unknown');

/** Its tooltip, or nothing. */
export const wireTip = (family: GlossaryFamily, value: string | null | undefined): string =>
  value === null || value === undefined ? '' : (lookupTerm(family, value)?.explain ?? '');

/** The item number people read ("Item 1acc2b3c"): the first 8 characters of its id. */
export const itemNo = (id: string): string => id.replace(/-/g, '').slice(0, 8);

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const span = (ms: number): string => {
  const a = Math.abs(ms);
  if (a < HOUR) return `${Math.max(1, Math.round(a / 60_000))} min`;
  if (a < DAY) return `${Math.round(a / HOUR)} h`;
  const d = Math.round(a / DAY);
  return `${d} ${d === 1 ? 'day' : 'days'}`;
};

/** "13 Nov 2026". */
export const dateText = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

/** The full time with its zone, for a tooltip. */
export const fullTime = (iso: string): string =>
  `${new Date(iso).toISOString().replace('T', ' ').slice(0, 16)} UTC`;

/** "2 h ago", "3 days ago", or the date beyond a week. */
export function ago(iso: string, now: number = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (Number.isNaN(ms)) return 'Unknown';
  if (ms > 7 * DAY) return dateText(iso);
  if (ms < 60_000) return 'just now';
  return `${span(ms)} ago`;
}

/** "Due in 2 h", "Overdue by 1 day", "No time limit". */
export function dueText(iso: string | null, overdue: boolean, now: number = Date.now()): string {
  if (iso === null) return 'No time limit';
  const ms = Date.parse(iso) - now;
  if (Number.isNaN(ms)) return 'Unknown';
  if (overdue || ms < 0) return `Overdue by ${span(ms)}`;
  if (ms > 7 * DAY) return `Due ${dateText(iso)}`;
  return `Due in ${span(ms)}`;
}

/** The plain name of an approval off the wire. */
export const gateName = (g: string | null | undefined): string => wire('gate', g);

/** Names of people, never ids: the name when known, else "someone". */
export const nameOf =
  (names: Readonly<Record<string, string>>) =>
  (p: string): string =>
    names[p] ?? 'someone';

/** A list in words: "Ana, Ben and Chen". */
export const listText = (xs: readonly string[]): string =>
  xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} and ${xs.at(-1) as string}`;

// ---------------------------------------------------------------- stages

/** The stage of the stage strip an item's phase stands in; `null` when it stands in none (ended, before intake). */
export function stageOfPhase(phase: string): StageId | null {
  switch (phase) {
    case 'Draft':
    case 'Clarifying':
    case 'Parked':
    case 'S1':
      return 'S1';
    case 'S2':
    case 'S3':
    case 'S4':
    case 'S5':
    case 'S6':
    case 'S7':
    case 'S9':
      return phase;
    case 'Scheduling':
      return 'S6';
    case 'G4':
    case 'S8':
    case 'S8a':
      return 'S8';
    case 'S8b':
    case 'G5':
      return 'S8b';
    case 'G6':
      return 'S9';
    default:
      return null;
  }
}

/** The stages of an item in order (S8a is part of review and merge on the strip). */
export const STRIP_STAGES: readonly StageId[] = [
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S8b',
  'S9',
];

// ---------------------------------------------------------------- what an item waits on

/** What an item waits for, in one sentence (the item view's `waiting` is "kind:detail"). */
export function waitingSentence(waiting: string | null, terminal: string | null): string {
  if (terminal !== null) return `${wire('phase', terminal)}. Nothing more happens to this item.`;
  if (waiting === null) return 'The agents are working on it.';
  const [kind, ...rest] = waiting.split(':');
  const detail = rest.join(':');
  switch (kind) {
    case 'human':
      return (
        (
          {
            ready: 'Waiting for someone to say the request is ready for its first approval.',
            plan: 'Waiting for a person to write the plan: the agents’ plan was sent back twice.',
            schedule: 'Waiting for a person to schedule the work.',
            merge: 'Waiting for a person to merge the pull request on GitHub.',
            human_led: 'A person is doing this work. They mark it done when it is ready.',
          } as Record<string, string>
        )[detail] ?? 'Waiting for a person.'
      );
    case 'gates': {
      const names = detail
        .split('+')
        .filter((g) => g !== '')
        .map((g) => gateName(g));
      return names.length === 0
        ? 'Waiting for an approval.'
        : `Waiting for ${names.length === 1 ? 'the approval' : 'the approvals'}: ${listText(names)}.`;
    }
    case 'questions':
      return 'Waiting for answers to the questions the factory asked.';
    case 'parked':
      return 'Paused until the questions are answered; it ends if nobody answers in time.';
    case 'blocked':
      return 'Blocked: the build environment needs fixing before the work can go on.';
    case 'stuck':
      return 'Stopped: a person needs to look at it.';
    case 'handoff':
      return 'The agents stopped: a person must choose what happens next.';
    default:
      return 'Waiting.';
  }
}

// ---------------------------------------------------------------- inbox rows

/** Where an inbox entry opens: a decision (work gate, onboarding card) on Decide; the rest on their own page. */
export const inboxHref = (i: PortalInboxItem): string =>
  i.kind === 'access_grant'
    ? `/access/grants/${encodeURIComponent(i.id)}`
    : i.kind === 'settings_revision'
      ? `/revisions/${encodeURIComponent(i.id)}`
      : i.kind === 'work_gate'
        ? i.card_id !== null
          ? `/decide/${encodeURIComponent(i.card_id)}`
          : `/items/${encodeURIComponent(i.item_id ?? '')}`
        : i.kind === 'onboarding_card'
          ? `/decide/${encodeURIComponent(i.id)}`
          : `/projects/${encodeURIComponent(i.project_id)}/drift`;

/** What an inbox entry is, in plain words. */
export function inboxWhat(i: PortalInboxItem): string {
  switch (i.kind) {
    case 'work_gate':
      return gateName(i.gate);
    case 'onboarding_card':
      return i.label ? wire('card', i.label) : label('gate', 'M4');
    case 'settings_revision':
      return label('gate', 'M1');
    case 'access_grant':
      return label('concept', 'role_assignment');
    default:
      return `${AFTER_ONBOARDING[i.kind] ?? label('concept', 'drift')}: ${i.id}`;
  }
}

/** After onboarding: one entry per repo, decided on the project's changes page. */
const AFTER_ONBOARDING: Readonly<Record<string, string>> = {
  drift_reaffirm: 'Re-affirm changed instruction text',
  prr_restore: 'Restore a suspended readiness record',
  prr_resign: 'Sign the readiness record again',
  drift_security: 'Security change: agent work held',
  reonboard: 'Re-onboarding proposed',
};

/** The one verb of an inbox entry. */
export const inboxVerb = (i: PortalInboxItem): string =>
  i.kind === 'work_gate' || i.kind === 'onboarding_card' || i.kind === 'settings_revision'
    ? i.may_decide
      ? 'Decide'
      : 'Open'
    : 'Review';

/** An inbox entry as a row of Home's "Needs you" table. */
export function needsYouRow(i: PortalInboxItem, now: number = Date.now()): NeedsYouRow {
  const kind: NeedsYouRow['kind'] =
    i.kind === 'work_gate' && i.gate
      ? { kind: 'gate', gate: i.gate as GateId }
      : i.kind === 'onboarding_card'
        ? { kind: 'onboarding' }
        : i.kind === 'access_grant'
          ? { kind: 'access' }
          : { kind: 'gate', gate: 'M1' };
  return {
    id: `${i.kind}:${i.id}`,
    kind,
    what: i.item_id ? `Item ${itemNo(i.item_id)}` : inboxWhat(i),
    project: i.project_id,
    due: {
      text: dueText(i.sla_due_at, i.overdue, now),
      overdue: i.overdue,
      ...(i.sla_due_at ? { at: i.sla_due_at } : {}),
    },
    to: inboxHref(i),
    verb: inboxVerb(i),
  };
}

/** Whether a person reads codes as secondary chips (auditors: `audit.read` on the fleet). */
export const showsCodes = (fleetActions: readonly string[]): boolean =>
  fleetActions.includes('audit.read');
