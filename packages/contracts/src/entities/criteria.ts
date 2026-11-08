import { z } from 'zod';
import { Level } from '../values.js';

// The agent-ready repo standard (OB §3): CRITERIA_V2 criteria and the safety floors. The data is in
// `@aisdlc/catalogue`; these are the shapes.

/** The set id the PRR pins as `criteria_set: CRITERIA_V2@<ver>` (OB §3.1). */
export const CRITERIA_SET_ID = 'CRITERIA_V2';

/**
 * The first column of OB §3.3, which the table headers "Pillar". These are the eleven criterion
 * families, not the four readiness pillars VRL/ERL/ORL/KRL of the PRR (see `ReadinessPillar`); the
 * specs do not map one onto the other.
 */
export const CriterionPillar = z.enum([
  'ID',
  'AI',
  'BT',
  'ST',
  'TH',
  'CC',
  'KN',
  'OP',
  'EN',
  'PUB',
  'SEC',
]);
export type CriterionPillar = z.infer<typeof CriterionPillar>;
export const CriterionPillarValues: readonly CriterionPillar[] = CriterionPillar.options;

/**
 * OB §3.1. FLOOR blocks the level (unknown counts as unmet). SCORED counts toward the pillar's 80%
 * rule. RECORDED must exist, any value passes. ADVISORY is proposed and never scored.
 */
export const CriterionClass = z.enum(['FLOOR', 'SCORED', 'RECORDED', 'ADVISORY']);
export type CriterionClass = z.infer<typeof CriterionClass>;
export const CriterionClassValues: readonly CriterionClass[] = CriterionClass.options;

/** `RS-<pillar>-<n>`, or `RS-SEC` (OB §3.3 writes the security row as `RS-SEC-*`, LF1 as `RS-SEC`). */
export const CriterionId = z.string().regex(/^RS-[A-Z]+(?:-\d+)?$/, 'RS-XX-n');
export type CriterionId = z.infer<typeof CriterionId>;

/** CF1-CF4 (Census), LF1-LF8 (Light), FF1-FF2 (Full) of OB §3.2. */
export const FloorId = z.enum([
  'CF1',
  'CF2',
  'CF3',
  'CF4',
  'LF1',
  'LF2',
  'LF3',
  'LF4',
  'LF5',
  'LF6',
  'LF7',
  'LF8',
  'FF1',
  'FF2',
]);
export type FloorId = z.infer<typeof FloorId>;
export const FloorIdValues: readonly FloorId[] = FloorId.options;

/** The level a floor belongs to, from its prefix. */
export function floorLevel(id: FloorId): Level {
  return id.startsWith('CF') ? 'census' : id.startsWith('LF') ? 'light' : 'full';
}

/**
 * OB §3.3 writes "SCORED (team: FLOOR)" and "SCORED (team + public: FLOOR)": in team mode (or team
 * mode on a public repo) the class rises to FLOOR.
 */
export const CriterionEscalationCondition = z.enum(['team', 'team_and_public']);
export type CriterionEscalationCondition = z.infer<typeof CriterionEscalationCondition>;

export const CriterionEscalation = z.strictObject({
  when: CriterionEscalationCondition,
  class: z.literal('FLOOR'),
});
export type CriterionEscalation = z.infer<typeof CriterionEscalation>;

/**
 * One CRITERIA_V2 row. `class_by_level` is `null` where the table shows "—" (the criterion does not
 * apply at that level). `floors` links the criterion to the floors it belongs to (OB §3.2).
 */
export const Criterion = z
  .strictObject({
    id: CriterionId,
    pillar: CriterionPillar,
    title: z.string().min(1),
    class_by_level: z.record(Level, CriterionClass.nullable()),
    floors: z.array(FloorId),
    escalations: z.array(CriterionEscalation),
    /** A rule the table states in words (for example "N/A on public or user-owned repos"). */
    note: z.string().min(1).nullable(),
  })
  .refine((c) => c.id === `RS-${c.pillar}` || c.id.startsWith(`RS-${c.pillar}-`), {
    message: 'the id names its pillar',
    path: ['id'],
  });
export type Criterion = z.infer<typeof Criterion>;

/** A safety floor (OB §3.2): the only gating list. */
export const FloorDef = z
  .strictObject({
    id: FloorId,
    level: Level,
    title: z.string().min(1),
    criteria: z.array(CriterionId).min(1),
    /** D deterministic, A agent, H human, as written in the table (`D+H`, `D→A→H`). `null` for the Full floors, whose table has no method column. */
    method: z.string().min(1).nullable(),
    why: z.string().min(1).nullable(),
  })
  .refine((f) => floorLevel(f.id) === f.level, {
    message: 'the floor id prefix (CF, LF, FF) fixes its level',
    path: ['level'],
  });
export type FloorDef = z.infer<typeof FloorDef>;
