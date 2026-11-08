import { z } from 'zod';
import * as flow from './flow.js';
import * as states from './states/index.js';
import * as values from './values.js';

/**
 * Every exported Zod schema of this package, by export name. A test fails when an exported schema
 * is missing here, so the generated JSON Schema cannot silently lag the contracts.
 */
export const SCHEMAS = {
  ScopeKind: values.ScopeKind,
  Scope: values.Scope,
  DataClass: values.DataClass,
  Tier: values.Tier,
  Level: values.Level,
  Autonomy: values.Autonomy,
  Lane: values.Lane,
  StageId: values.StageId,
  ActorKind: values.ActorKind,
  StepId: values.StepId,
  EntryChannel: values.EntryChannel,
  GateId: flow.GateId,
  GateFamily: flow.GateFamily,
  ProjectToggleGroup: flow.ProjectToggleGroup,
  HandoffId: flow.HandoffId,
  RelaneId: flow.RelaneId,
  HoldReason: flow.HoldReason,
  TerminalState: flow.TerminalState,
  WaitState: flow.WaitState,
  AbandonCause: flow.AbandonCause,
  BackEdgeId: flow.BackEdgeId,
  TriggerId: flow.TriggerId,
  WorkItemPhase: states.WorkItemPhase,
  GateStatus: states.GateStatus,
  LedgerDecision: states.LedgerDecision,
  OnboardingStatus: states.OnboardingStatus,
  ReadinessStatus: states.ReadinessStatus,
  ReadinessActor: states.ReadinessActor,
  UnitState: states.UnitState,
  AgentSessionState: states.AgentSessionState,
  HealthState: states.HealthState,
} as const satisfies Record<string, z.ZodType>;

export const JSON_SCHEMA_DIALECT = 'https://json-schema.org/draft/2020-12/schema';

/** One JSON Schema 2020-12 document with a `$defs` entry per exported schema, keys sorted. */
export function generateJsonSchema(): Record<string, unknown> {
  const $defs: Record<string, unknown> = {};
  for (const name of Object.keys(SCHEMAS).sort()) {
    const schema = SCHEMAS[name as keyof typeof SCHEMAS];
    const def: Record<string, unknown> = {
      ...z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'output' }),
    };
    delete def['$schema'];
    $defs[name] = def;
  }
  return {
    $schema: JSON_SCHEMA_DIALECT,
    $id: 'https://aisdlc.invalid/contracts.schema.json',
    title: '@aisdlc/contracts',
    $defs,
  };
}

export function generateJsonSchemaText(): string {
  return `${JSON.stringify(generateJsonSchema(), null, 2)}\n`;
}
