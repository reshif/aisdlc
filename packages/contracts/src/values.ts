import { z } from 'zod';
import { err, ok, type Result, taggedError, type TaggedError } from '@aisdlc/kernel';

// Convention for every enum in this package: a Zod enum, the TS type with the same name,
// and a readonly `<Name>Values` array taken from the Zod enum (so the list exists once).

// ---------------------------------------------------------------- Scope

export const ScopeKind = z.enum([
  'enterprise',
  'org',
  'team',
  'project',
  'repo',
  'service_env',
  'environment',
  'lane',
  'session',
  'item',
  'role',
  'model',
  'release',
  'budget',
  'fleet',
]);
export type ScopeKind = z.infer<typeof ScopeKind>;
export const ScopeKindValues: readonly ScopeKind[] = ScopeKind.options;

/** Every kind except `fleet`, whose ref is fixed. */
const KeyedScopeKind = ScopeKind.exclude(['fleet']);

/** The one `ref` a `fleet` scope can carry: the whole factory. */
export const FLEET_REF = '*';

/** `Scope{kind, ref}` (DM §8 gap 8). `fleet` is a singleton with ref `"*"`. */
export const Scope = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('fleet'), ref: z.literal(FLEET_REF) }),
  z.strictObject({ kind: KeyedScopeKind, ref: z.string().min(1) }),
]);
export type Scope = z.infer<typeof Scope>;

export const InvalidScopeKey = taggedError('InvalidScopeKey');
export type InvalidScopeKey = TaggedError<'InvalidScopeKey', { readonly input: string }>;

/** `kind:ref`. The ref may itself contain colons; the first colon splits. */
export function scopeKey(scope: Scope): string {
  return `${scope.kind}:${scope.ref}`;
}

export function parseScopeKey(key: string): Result<Scope, InvalidScopeKey> {
  const i = key.indexOf(':');
  if (i < 0) return err(InvalidScopeKey({ input: key }));
  const parsed = Scope.safeParse({ kind: key.slice(0, i), ref: key.slice(i + 1) });
  return parsed.success ? ok(parsed.data) : err(InvalidScopeKey({ input: key }));
}

// ---------------------------------------------------------------- Classification

/** D0 to D3. Meaning of each class is catalogue data (M1.5), not fixed here. */
export const DataClass = z.enum(['D0', 'D1', 'D2', 'D3']);
export type DataClass = z.infer<typeof DataClass>;
export const DataClassValues: readonly DataClass[] = DataClass.options;

/** Inherent risk tier (OB §2.2). Never posture. */
export const Tier = z.enum(['T0', 'T1', 'T2']);
export type Tier = z.infer<typeof Tier>;
export const TierValues: readonly Tier[] = Tier.options;

/** Onboarding level (OB §2.1). */
export const Level = z.enum(['census', 'light', 'full']);
export type Level = z.infer<typeof Level>;
export const LevelValues: readonly Level[] = Level.options;

/** Autonomy A0 to A3 (OB §2.3). */
export const Autonomy = z.enum(['A0', 'A1', 'A2', 'A3']);
export type Autonomy = z.infer<typeof Autonomy>;
export const AutonomyValues: readonly Autonomy[] = Autonomy.options;

// ---------------------------------------------------------------- Lane

export const Lane = z.enum(['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8']);
export type Lane = z.infer<typeof Lane>;
export const LaneValues: readonly Lane[] = Lane.options;

/**
 * Short labels. L0, L7 and L8 are named in the flow; L2 is called "remediation" in OB §1 and §7.
 * L1, L3, L4, L5, L6 have no name in the specs (the flow groups them as "L1/L2/L3 small lanes"
 * and "L4/L5/L6 full path", with 2.4-2.5 for L6 only, an "initiative" in PLAN M12.1), so they
 * stay `null`. Lane semantics belong to the catalogue (M1.5), not here.
 */
export const LANE_LABELS: Readonly<Record<Lane, string | null>> = {
  L0: 'hotfix',
  L1: null,
  L2: 'remediation',
  L3: null,
  L4: null,
  L5: null,
  L6: 'initiative',
  L7: 'spike',
  L8: 'human-led',
};

// ---------------------------------------------------------------- Stages and steps

export const StageId = z.enum([
  'S0',
  'S1',
  'S2',
  'S3',
  'S4',
  'S5',
  'S6',
  'S7',
  'S8',
  'S8a',
  'S8b',
  'S9',
]);
export type StageId = z.infer<typeof StageId>;
export const StageIdValues: readonly StageId[] = StageId.options;

/** Who acts at a step, as written in the flow: Deterministic, Agent, Human, or a pair. */
export const ActorKind = z.enum(['D', 'A', 'H', 'D+A', 'A+H', 'D+H']);
export type ActorKind = z.infer<typeof ActorKind>;
export const ActorKindValues: readonly ActorKind[] = ActorKind.options;

export const StepId = z.enum([
  '0.1',
  '0.2',
  '0.3',
  '0.4',
  '0.5',
  '1.1',
  '1.2',
  '1.3',
  '1.4',
  '1.5',
  '1.6',
  '2.1',
  '2.1b',
  '2.2',
  '2.3',
  '2.4',
  '2.5',
  '3.1',
  '3.2',
  '3.3',
  '3.4',
  '3.5',
  '4.1',
  '4.2',
  '4.3',
  '4.4',
  '4.5',
  '4.6',
  '5.1',
  '5.2',
  '5.3',
  '5.4',
  '5.5',
  '5.6',
  '5.7',
  '5.8',
  '6.0',
  '6.1',
  '6.2',
  '6.3',
  '6.4',
  '6.5',
  '6.6',
  '7.1',
  '7.2',
  '7.3',
  '7.4',
  '7.5',
  '7.6',
  '8.1',
  '8.2',
  'S8b',
  '9.2',
  '9.3',
  '9.4',
  '9.5',
]);
export type StepId = z.infer<typeof StepId>;
export const StepIdValues: readonly StepId[] = StepId.options;

type StepInfo = { readonly stage: StageId; readonly actor: ActorKind; readonly title: string };

/**
 * Stage and actor per step, as drawn in flow-corrected.mmd. Titles are the flow's node text.
 * 8.1 and 8.2 sit in the S8 box; `S8b` (Release) is both a step and a stage id.
 */
export const STEPS: Readonly<Record<StepId, StepInfo>> = {
  '0.1': { stage: 'S0', actor: 'D+A', title: 'Census' },
  '0.2': { stage: 'S0', actor: 'A+H', title: 'Light baseline' },
  '0.3': { stage: 'S0', actor: 'A+H', title: 'Full baseline' },
  '0.4': { stage: 'S0', actor: 'D+H', title: 'Controls and environment' },
  '0.5': { stage: 'S0', actor: 'H', title: 'Sign-off' },
  '1.1': { stage: 'S1', actor: 'D', title: 'Normalise + taint-mark input' },
  '1.2': { stage: 'S1', actor: 'D+A', title: 'De-dupe and conflict scan' },
  '1.3': { stage: 'S1', actor: 'D+A', title: 'Classify, propose lane' },
  '1.4': { stage: 'S1', actor: 'D+A', title: 'Eligibility and suitability' },
  '1.5': { stage: 'S1', actor: 'A+H', title: 'Clarify questions + intent block' },
  '1.6': { stage: 'S1', actor: 'H', title: 'Ready decision' },
  '2.1': { stage: 'S2', actor: 'A', title: 'Ground in code/docs' },
  '2.1b': { stage: 'S2', actor: 'A', title: 'Focused reverse-engineering' },
  '2.2': { stage: 'S2', actor: 'A', title: 'Impact and stakeholders' },
  '2.3': { stage: 'S2', actor: 'A', title: 'Options and decision brief' },
  '2.4': { stage: 'S2', actor: 'A', title: 'Initiative elaboration (L6 only)' },
  '2.5': { stage: 'S2', actor: 'H', title: 'G1 intent acceptance, final (L6 only)' },
  '3.1': { stage: 'S3', actor: 'A', title: 'Locate affected requirements' },
  '3.2': { stage: 'S3', actor: 'A', title: 'Draft delta spec' },
  '3.3': { stage: 'S3', actor: 'D', title: 'Validate' },
  '3.4': { stage: 'S3', actor: 'A', title: 'Oracle specs' },
  '3.5': { stage: 'S3', actor: 'A', title: 'Clean-context review' },
  '4.1': { stage: 'S4', actor: 'A', title: 'Decisions / ADRs' },
  '4.2': { stage: 'S4', actor: 'D+A', title: 'Contracts' },
  '4.3': { stage: 'S4', actor: 'A', title: 'Data and migration' },
  '4.4': { stage: 'S4', actor: 'A', title: 'NFR, threat, ops' },
  '4.5': { stage: 'S4', actor: 'D+A', title: 'Constitution check, design-time' },
  '4.6': { stage: 'S4', actor: 'H', title: 'Design and threat review' },
  '5.1': { stage: 'S5', actor: 'A', title: 'Split into Units' },
  '5.2': { stage: 'S5', actor: 'A', title: 'Sequence' },
  '5.3': { stage: 'S5', actor: 'A', title: 'Task plan per Unit' },
  '5.4': { stage: 'S5', actor: 'A', title: 'Bind verification' },
  '5.5': { stage: 'S5', actor: 'D', title: 'Budget envelope' },
  '5.6': { stage: 'S5', actor: 'D+A', title: 'Capacity input' },
  '5.7': { stage: 'S5', actor: 'H', title: 'Schedule' },
  '5.8': { stage: 'S5', actor: 'H', title: 'Plan approval' },
  '6.0': { stage: 'S6', actor: 'D', title: 'Admission' },
  '6.1': { stage: 'S6', actor: 'D', title: 'Provision / rehydrate' },
  '6.2': { stage: 'S6', actor: 'D', title: 'Baseline' },
  '6.3': { stage: 'S6', actor: 'D', title: 'Oracles red' },
  '6.4': { stage: 'S6', actor: 'A', title: 'Implement task loop' },
  '6.5': { stage: 'S6', actor: 'D', title: 'Self-check and tripwires' },
  '6.6': { stage: 'S6', actor: 'A', title: 'Draft PR via Push Broker' },
  '7.1': { stage: 'S7', actor: 'D', title: 'Deterministic checks' },
  '7.2': { stage: 'S7', actor: 'D', title: 'Test integrity + oracle quality' },
  '7.3': { stage: 'S7', actor: 'D+A', title: 'Spec conformance' },
  '7.4': { stage: 'S7', actor: 'D', title: 'Secrets and dependencies' },
  '7.5': { stage: 'S7', actor: 'D+A', title: 'Constitution check, all lanes' },
  '7.6': { stage: 'S7', actor: 'D', title: 'Pack assembly + sign' },
  '8.1': { stage: 'S8', actor: 'H', title: 'G4 review' },
  '8.2': { stage: 'S8', actor: 'H', title: 'Human merges on GitHub' },
  S8b: { stage: 'S8b', actor: 'H', title: 'Release' },
  '9.2': { stage: 'S9', actor: 'H', title: 'Requester acceptance' },
  '9.3': { stage: 'S9', actor: 'D', title: 'Close-out record' },
  '9.4': { stage: 'S9', actor: 'A', title: 'Learn' },
  '9.5': { stage: 'S9', actor: 'H', title: 'Mode-E audit sample, async' },
};

// ---------------------------------------------------------------- Entry channels

export const EntryChannel = z.enum(['N1', 'N2', 'N3', 'N4', 'N5', 'N6', 'N7', 'N8']);
export type EntryChannel = z.infer<typeof EntryChannel>;
export const EntryChannelValues: readonly EntryChannel[] = EntryChannel.options;

/**
 * The flow lists the four sources "portal Ask, Teams, API, code-host issue" under the range
 * N1-N8 without saying which code is which, so those stay `null`. N6 and N8 are named in OB.
 */
export const ENTRY_CHANNEL_DESCRIPTIONS: Readonly<Record<EntryChannel, string | null>> = {
  N1: null,
  N2: null,
  N3: null,
  N4: null,
  N5: null,
  N6: 'factory-proposed remediation item (a gap becomes an N6 item, enters S1 as L2, then G0)',
  N7: null,
  N8: 'no active Project Readiness Record: item is held',
};

/** The request sources the flow names for the entry node, in the flow's order. */
export const ENTRY_SOURCES_IN_FLOW = ['portal Ask', 'Teams', 'API', 'code-host issue'] as const;
