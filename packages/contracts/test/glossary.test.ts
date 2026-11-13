import { describe, expect, it } from 'vitest';
import * as contracts from '../src/index.js';
import {
  GLOSSARY,
  GLOSSARY_ROLE_IDS,
  PROPOSED_TERMS,
  ROLE_IDS,
  CONFIG_KEY_TERMS,
  codeShows,
  explain,
  label,
  lookupTerm,
  term,
  type GlossaryFamily,
  type Term,
} from '../src/index.js';

// The glossary (docs/design/glossary.md §21) as a property of the contracts: every value of every enum a
// person can see has a plain label, the words follow the style rules (§1), and a changed word is a visible
// diff (`glossary.snapshot.json`, reviewed like the catalogue: `npx vitest run --project contracts glossary -u`).

/** The family keyed by each contract enum. The types already refuse a missing value; this says it at run time. */
const BY_ENUM: ReadonlyArray<readonly [GlossaryFamily, { readonly options: readonly string[] }]> = [
  ['stage', contracts.StageId],
  ['step', contracts.StepId],
  ['gate', contracts.GateId],
  ['gateFamily', contracts.GateFamily],
  ['toggleGroup', contracts.ProjectToggleGroup],
  ['decision', contracts.LedgerDecision],
  ['gateStatus', contracts.GateStatus],
  ['cardStatus', contracts.CardStatus],
  ['feasibility', contracts.GateFeasibilityState],
  ['inboxReason', contracts.InboxEntryReason],
  ['lane', contracts.Lane],
  ['relane', contracts.RelaneId],
  ['level', contracts.Level],
  ['tier', contracts.Tier],
  ['autonomy', contracts.Autonomy],
  ['reviewMode', contracts.ReviewMode],
  ['card', contracts.CardKind],
  ['claimVerdict', contracts.ClaimVerdict],
  ['gapDisposition', contracts.GapDisposition],
  ['gapStatus', contracts.GapStatus],
  ['posture', contracts.PostureState],
  ['blocker', contracts.BlockerId],
  ['control', contracts.ControlId],
  ['lightFloor', contracts.LightFloorId],
  ['onboarding', contracts.OnboardingStatus],
  ['readiness', contracts.ReadinessStatus],
  ['pillar', contracts.ReadinessPillar],
  ['driftEffect', contracts.DriftEffect],
  ['servedFile', contracts.ServedFileState],
  ['examGrade', contracts.ExamGrade],
  ['seedStatus', contracts.SeedStatus],
  ['phase', contracts.WorkItemPhase],
  ['wait', contracts.WaitState],
  ['room', contracts.FloorRoom],
  ['floorStatus', contracts.FloorItemStatus],
  ['floorMove', contracts.FloorMoveKind],
  ['backEdge', contracts.BackEdgeId],
  ['handoff', contracts.HandoffId],
  ['trigger', contracts.TriggerId],
  ['hold', contracts.HoldReason],
  ['unitState', contracts.UnitState],
  ['unitSize', contracts.UnitSize],
  ['verifyCheck', contracts.VerifyCheckId],
  ['verdict', contracts.CheckVerdict],
  ['repairClass', contracts.RepairClass],
  ['roleSlot', contracts.RoleSlot],
  ['principalKind', contracts.PrincipalKind],
  ['action', contracts.ActionId],
  ['viewLevel', contracts.ViewLevel],
  ['dataClass', contracts.DataClass],
  ['agent', contracts.AgentId],
  ['sessionState', contracts.AgentSessionState],
  ['evalCaseKind', contracts.EvalCaseKind],
  ['killState', contracts.KillState],
  ['controlKind', contracts.ControlKind],
  ['controlState', contracts.ControlState],
  ['bannerSeverity', contracts.BannerSeverity],
  ['sandboxClass', contracts.SandboxClass],
  ['health', contracts.HealthState],
  ['integrationKind', contracts.IntegrationKind],
  ['integrationAdapter', contracts.IntegrationAdapter],
  ['integrationStatus', contracts.IntegrationStatus],
  ['notificationKind', contracts.NotificationKind],
  ['notificationReason', contracts.NotificationReason],
  ['configLayer', contracts.ConfigLayerKind],
  ['configRevision', contracts.ConfigRevisionState],
];

/** Approved labels longer than four words (glossary.md has them so; the owner approved them). */
const LONG_LABELS = new Set([
  'Overdue: you are the backup',
  'Restart waiting for second person',
  'Agents stopped (cannot reach the stop switch)',
  'Agents on/off, models, turns, timeouts, budgets',
  'Low risk needs owner confirmation',
  'Who may merge without the check',
  'Moved to a bigger track',
  'Moved to a lighter track',
  'Agents paused on this track',
  'Fix now (PR or issue)',
  'App limited to this repo',
  'Waiting for the GitHub App',
  'Design found a spec gap',
  'Waiting for a coding slot',
  'Mark ready / Answer questions',
  'Report a bug after merge',
  'See who can do what',
  'Coding image and isolation tests',
  'Repos agents may run code in',
  'Not checked at this level',
]);

/** Approved tooltips of two sentences. */
const TWO_SENTENCES = new Set([
  'Nobody decided in time. Nothing was approved.',
  'Waited over 1 working day; sent to the backup approver. Never approved automatically.',
  'You decided your own request because you are the only person who can. Recorded.',
  'You are deciding outside the normal rules. Your name and reason are recorded.',
  'A code owner approves the PR. Always required.',
  'Approve deploying the merged change. Needs "confirm it\'s you".',
  'Confirm the repo is ready for the level asked. Needs "confirm it\'s you".',
  'Nobody answered for 5 working days. Resume when ready.',
  'The work turned out bigger; steps were added. No approval needed.',
]);

/** Words that keep their capital inside a sentence-case label. */
const PROPER =
  /^(GitHub|App|PR|PRs|Slack|Anthropic|OpenAI-compatible|OIDC|AGENTS\.md|CODEOWNERS|I|I'm)$/;
const CODE = /\b([SGLXEDMQBH]\d+[a-z]?|ET\d+|LF\d|KRL|PRR|SECT|SECR)\b/;

const allTerms = (): Array<{ where: string; t: Term }> =>
  Object.entries(GLOSSARY).flatMap(([family, terms]) =>
    Object.entries(terms as Record<string, Term>).map(([value, t]) => ({
      where: `${family}.${value}`,
      t,
    })),
  );

describe('the glossary covers every value a person can see', () => {
  it.each(BY_ENUM)('%s has a term for every value of its enum, and nothing else', (family, e) => {
    expect(Object.keys(GLOSSARY[family]).sort()).toEqual([...e.options].sort());
  });

  it('roles: every role of the role catalogue', () => {
    expect([...GLOSSARY_ROLE_IDS].sort()).toEqual([...ROLE_IDS].sort());
    expect(Object.keys(GLOSSARY.role).sort()).toEqual([...ROLE_IDS].sort());
  });

  it('settings: every config key the contracts name (`*_KEY`, `*_KEYS`) has a term', () => {
    const named = new Set<string>();
    const dotted = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/;
    for (const [name, v] of Object.entries(contracts)) {
      if (/_KEY$/.test(name) && typeof v === 'string' && dotted.test(v)) named.add(v);
      if (/_KEYS$/.test(name) && v && typeof v === 'object' && !Array.isArray(v)) {
        for (const k of Object.values(v as Record<string, unknown>))
          if (typeof k === 'string' && dotted.test(k)) named.add(k);
      }
    }
    expect(named.size).toBeGreaterThan(20);
    const missing = [...named].filter((k) => !(CONFIG_KEY_TERMS as readonly string[]).includes(k));
    expect(missing).toEqual([]);
    expect(Object.keys(GLOSSARY.configKey).sort()).toEqual([...CONFIG_KEY_TERMS].sort());
  });

  it('proposed terms (not yet in glossary.md) exist, so the owner can find each one', () => {
    for (const [family, value] of PROPOSED_TERMS)
      expect(lookupTerm(family, value), `${family}.${value}`).not.toBeNull();
  });
});

describe('the words follow the style rules (glossary §1)', () => {
  it('labels: sentence case, at most four words, no code', () => {
    const bad: string[] = [];
    for (const { where, t } of allTerms()) {
      const words = t.label.split(/\s+/);
      if (words.length > 4 && !LONG_LABELS.has(t.label)) bad.push(`${where}: more than 4 words`);
      if (!/^[A-Z0-9"]/.test(t.label)) bad.push(`${where}: starts lower case`);
      // a new clause after " / " starts with a capital ("Mark ready / Answer questions")
      for (const w of t.label.split(' / ').flatMap((c) => c.split(/\s+/).slice(1))) {
        const bare = w.replace(/^[("]+|[),:;."]+$/g, '');
        if (/^[A-Z][a-z]/.test(bare) && !PROPER.test(bare))
          bad.push(`${where}: "${w}" is title case`);
      }
      if (CODE.test(t.label)) bad.push(`${where}: label has a code`);
    }
    expect(bad).toEqual([]);
  });

  it('tooltips: one sentence ending with a full stop, at most 160 characters, no code', () => {
    const bad: string[] = [];
    for (const { where, t } of allTerms()) {
      if (!t.explain.endsWith('.')) bad.push(`${where}: no full stop`);
      if (t.explain.length > 160) bad.push(`${where}: ${t.explain.length} characters`);
      const sentences = t.explain.split(/(?<=[a-z0-9)"])\. (?=[A-Z])/).length;
      if (sentences > 1 && !TWO_SENTENCES.has(t.explain))
        bad.push(`${where}: ${sentences} sentences`);
      if (CODE.test(t.explain)) bad.push(`${where}: tooltip has a code`);
    }
    expect(bad).toEqual([]);
  });

  it('one family never gives two different terms the same label', () => {
    const bad: string[] = [];
    for (const [family, terms] of Object.entries(GLOSSARY)) {
      const seen = new Map<string, Term>();
      for (const [value, t] of Object.entries(terms as Record<string, Term>)) {
        const prior = seen.get(t.label);
        // the same Term shared on purpose (ET4-ET6, A7/A8/A10, B4a-c, a stage as a phase) is one word
        if (prior && prior !== t && prior.explain !== t.explain)
          bad.push(`${family}.${value}: "${t.label}"`);
        seen.set(t.label, t);
      }
    }
    expect(bad).toEqual([]);
  });

  it('the three decision verbs are always the same words, in this order', () => {
    expect([
      label('decision', 'approve'),
      label('decision', 'request_changes'),
      label('decision', 'reject'),
    ]).toEqual(['Approve', 'Request changes', 'Reject']);
  });
});

describe('helpers', () => {
  it('term, label and explain read one entry', () => {
    expect(label('gate', 'G4')).toBe('Code review');
    expect(explain('lane', 'L3')).toBe(
      'A small change with a short spec and plan, no design step.',
    );
    expect(term('level', 'census')).toEqual({
      label: 'Read only',
      explain:
        "Agents may read the repo and plan, run experiments, and support people's own work; no agent code.",
      code: 'audit',
    });
    expect(label('phase', 'S6')).toBe('Build');
    expect(label('roleSlot', 'g4')).toBe('Code reviewer');
  });

  it('lookupTerm: an unknown value off the wire is null, never the raw code', () => {
    expect(lookupTerm('gate', 'G9')).toBeNull();
    expect(lookupTerm('gate', 'toString')).toBeNull();
    expect(lookupTerm('gate', 'G3d')?.label).toBe('Approve the design');
  });

  it('codeShows: secondary on screens, audit only on audit, none never', () => {
    expect(codeShows(term('gate', 'G4'), 'screen')).toBe(true);
    expect(codeShows(term('stage', 'S4'), 'screen')).toBe(false);
    expect(codeShows(term('stage', 'S4'), 'audit')).toBe(true);
    expect(codeShows(term('phase', 'Done'), 'audit')).toBe(false);
  });
});

describe('a changed word is a reviewed diff', () => {
  it('matches the committed snapshot', async () => {
    await expect(`${JSON.stringify(GLOSSARY, null, 2)}\n`).toMatchFileSnapshot(
      './glossary.snapshot.json',
    );
  });
});
