import { z } from 'zod';
import { PrincipalId } from './ids.js';

// Where every factory setting lives on the Settings screen (portal v2, docs/design/screen-map.md §2.11 and
// docs/design/settings-catalogue.md): its section, what a change does (one plain sentence) and when it applies.
// The labels of the keys and sections are the glossary's (`configKey`, `settingsSection`, `settingsApplies`); this
// file says only where a key goes. A key the registry has and this table does not is shown under "Other settings"
// (a test lists the keys core registers and fails when one is missing here).

export const SettingsSection = z.enum([
  'general',
  'tracks',
  'approvals',
  'onboarding',
  'factory_rules',
  'sandboxes',
  'retention',
  'agents',
  'integrations',
  'project_defaults',
  'access_policy',
  'other',
]);
export type SettingsSection = z.infer<typeof SettingsSection>;

/**
 * When a published change takes effect. `now`: the next use, no restart. `new_items`: new requests and items only
 * (a catalogue change is a new process version; running items keep theirs). `new_onboardings`: new onboarding
 * records only. `next_start`: when the service that reads it next starts.
 */
export const SettingApplies = z.enum(['now', 'new_items', 'new_onboardings', 'next_start']);
export type SettingApplies = z.infer<typeof SettingApplies>;

export interface SettingPlacement {
  readonly section: SettingsSection;
  readonly applies: SettingApplies;
  /** What a change does, in one sentence (settings-catalogue.md, "Effect"). */
  readonly effect: string;
  /** Shown read-only: generated (the access policy) or changed on another screen (`edit_on`). */
  readonly read_only?: boolean;
  /** The screen where it is changed, when that is not Settings (`/agents`, `/roles`, `/integrations`). */
  readonly edit_on?: string;
}

const p = (
  section: SettingsSection,
  applies: SettingApplies,
  effect: string,
  extra: Pick<SettingPlacement, 'read_only' | 'edit_on'> = {},
): SettingPlacement => ({ section, applies, effect, ...extra });

export const SETTING_PLACEMENTS: Readonly<Record<string, SettingPlacement>> = {
  // General
  's0.calendar': p('general', 'now', 'Every timer counts working days by this calendar.'),
  'factory.m1_policy': p(
    'general',
    'now',
    'Who approves a settings change, and whether it takes one or two people.',
  ),
  'factory.learn': p(
    'general',
    'now',
    'When the factory proposes improvements from finished work.',
  ),
  'factory.floor': p('general', 'now', 'When the floor draws an item as stuck or an agent as low.'),
  'session.policy': p(
    'general',
    'now',
    'People are signed out after this idle time and after the maximum.',
  ),
  'gateway.limits': p('general', 'now', 'The most model calls one gateway process makes.'),
  'ops.health': p(
    'general',
    'now',
    'When health reads unknown, how often it is read and when it alerts (the reading interval at the next start).',
  ),
  'codehost.polls': p('general', 'next_start', 'How often the factory reads GitHub.'),
  'work.request': p('general', 'now', 'A longer request is refused.'),
  'ops.maintenance.mm2': p(
    'general',
    'now',
    'Freezes timers and decisions everywhere while it is on.',
    { edit_on: '/operate/pauses' },
  ),
  // Tracks
  'catalogue.lanes': p(
    'tracks',
    'new_items',
    'What each track runs: its steps, approvals and default budget.',
  ),
  'catalogue.back_edge_limits': p(
    'tracks',
    'new_items',
    'When a loop of sending work back stops, and where the work goes then.',
  ),
  'catalogue.rework_budget': p('tracks', 'new_items', 'When a person takes the work over.'),
  'catalogue.envelope_extension': p('tracks', 'new_items', 'How far a budget may be extended.'),
  'catalogue.flow_limits': p(
    'tracks',
    'new_items',
    'How often work may be handed back or an alternative tried.',
  ),
  'catalogue.triggers': p('tracks', 'new_items', 'What each escalation does and when it trips.'),
  'catalogue.gating': p(
    'tracks',
    'new_items',
    'The approvals each group and track has by default.',
  ),
  'catalogue.eligibility': p('tracks', 'new_items', 'Which tracks each onboarding level opens.'),
  'catalogue.autonomy': p(
    'tracks',
    'new_onboardings',
    'The caps a readiness scorecard gives agents.',
  ),
  'planning.size_share': p(
    'tracks',
    'now',
    'The share of the coding budget each part size may spend, for plans made from then on.',
  ),
  // Approvals
  'gates.policy': p(
    'approvals',
    'now',
    'Who decides each approval, the requester rule, confirm-it’s-you, sharing a card and two people.',
  ),
  'gates.timers': p(
    'approvals',
    'now',
    'When an approval expires (never approves) and how long a confirmation and a prepared decision last.',
  ),
  // Onboarding
  's0.failure_model': p(
    'onboarding',
    'new_onboardings',
    'Retries, send-backs and when onboarding pauses for silence.',
  ),
  's0.timeboxes': p('onboarding', 'new_onboardings', 'How long each onboarding step may take.'),
  's0.t0_attestation_required': p(
    'onboarding',
    'new_onboardings',
    'Whether the owner must confirm “no production, no real data” for low risk.',
  ),
  'onboarding.instruction_template': p(
    'onboarding',
    'new_onboardings',
    'What agent instructions may and may not contain.',
  ),
  'onboarding.reonboard_triggers': p(
    'onboarding',
    'now',
    'How many knowledge errors in how many days suggest re-onboarding.',
  ),
  'readiness.policy': p(
    'onboarding',
    'now',
    'Scorecard validity, waiver length and the facts to confirm (the first three can only be lowered).',
  ),
  'catalogue.criteria': p(
    'onboarding',
    'new_onboardings',
    'The criteria and floors a repo must meet.',
  ),
  // Factory rules
  'factory.constitution': p(
    'factory_rules',
    'now',
    'Every design and change is checked against these rules.',
  ),
  // Sandboxes
  'sandbox.caps': p(
    'sandboxes',
    'now',
    'How many sandboxes, and how many coding sandboxes, run at once (at most 8 coding).',
  ),
  'sandbox.exec_allowed_repos': p('sandboxes', 'now', 'Agents run code only in these repos.'),
  'sandbox.profiles': p(
    'sandboxes',
    'now',
    'Lower the memory, CPU, processes, time and output of each sandbox kind.',
  ),
  'sandbox.probe': p(
    'sandboxes',
    'now',
    'The onboarding test run gives back its sandbox after this.',
  ),
  'onboarding.sandbox_image': p(
    'sandboxes',
    'new_onboardings',
    'The image the onboarding test run uses.',
  ),
  'onboarding.console': p(
    'agents',
    'now',
    'Whether the onboarding agent runs, and which of its checks it does by itself.',
  ),
  'onboarding.agent_guidelines': p(
    'agents',
    'now',
    'The factory’s guidelines for the onboarding agent.',
  ),
  'onboarding.light_tests': p(
    'sandboxes',
    'now',
    'The coding image and the thresholds of its isolation tests.',
  ),
  // Retention
  'audit.retention': p('retention', 'now', 'How long each kind of data is kept.'),
  // Agents
  'agents.config': p(
    'agents',
    'now',
    'An agent that is off runs nothing; models, budget, turns and time limits go into its next run.',
    { edit_on: '/agents' },
  ),
  'evals.gate': p('agents', 'now', 'How a new agent version is compared with its baseline.'),
  // Integrations
  'integrations.registry': p('integrations', 'now', 'The outside services the factory uses.', {
    edit_on: '/integrations',
  }),
  'integrations.installs': p(
    'integrations',
    'now',
    'Which repos and models each project may use.',
    { edit_on: '/integrations' },
  ),
  'gateway.models': p('integrations', 'now', 'The models agents may use, with limits and prices.', {
    edit_on: '/integrations/models',
  }),
  'gateway.routes': p('integrations', 'now', 'Which model handles each data sensitivity.', {
    edit_on: '/integrations/models',
  }),
  'notifications.channels': p(
    'integrations',
    'now',
    'The Slack and email channels and who gets what.',
    { edit_on: '/integrations/notifications' },
  ),
  'codehost.merge_bypass': p(
    'project_defaults',
    'now',
    'GitHub users allowed to merge around the factory check, per repo.',
  ),
  // Access policy
  'access.roles': p('access_policy', 'now', 'The roles and who holds each action.', {
    edit_on: '/roles',
  }),
  'pdp.bundle': p(
    'access_policy',
    'now',
    'The permission rules in force, generated from the roles.',
    { read_only: true },
  ),
};

/** Where a key goes; a key starting `project.` is a project default, anything else unknown is "Other". */
export function placementOf(key: string): SettingPlacement {
  const known = SETTING_PLACEMENTS[key];
  if (known) return known;
  if (key.startsWith('project.')) {
    return p(
      'project_defaults',
      'now',
      'The value every project has until it sets its own on its Settings page.',
    );
  }
  return p('other', 'now', 'A setting of the factory.');
}

// ---------------------------------------------------------------- preview (screen map N8)

/** `POST /v1/config/keys/:key/preview` (core) and `/api/config/keys/:key/preview` (bff): a draft's effect. */
export const SettingPreviewRequest = z.strictObject({ value: z.unknown() });
/** Core's body: the draft and the person the bff asks for. */
export const SettingPreviewCoreRequest = z.strictObject({
  value: z.unknown(),
  on_behalf_of: PrincipalId,
});

export const SettingPreview = z.strictObject({
  key: z.string().min(1),
  applies: SettingApplies,
  /** The draft fits the key's schema (the registry checks the whole document again on propose). */
  valid: z.boolean(),
  problems: z.array(z.string()),
  changes: z.array(z.strictObject({ path: z.string(), before: z.unknown(), after: z.unknown() })),
  /** What the change does, in plain sentences built from the glossary's words. */
  effects: z.array(z.string()),
  /** Items not finished now (a `new_items` change leaves them on the process version they pinned). */
  items_in_progress: z.number().int().min(0),
});
export type SettingPreview = z.infer<typeof SettingPreview>;
