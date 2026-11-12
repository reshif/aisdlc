import type {
  AgentDefinition,
  BudgetGroupSpec,
  Lane,
  ProjectId,
  StepId,
  VKeyMint,
} from '@aisdlc/contracts';

// The virtual key an agent runs under (PLAN M10.3, M11.2), as ONE pure function: what the gateway key
// carries is the agent CONTRACT's tools, data class, models and budget and nothing else. There is no
// parameter for a tool, a model, a budget or a data class, so no request, repo text or agent output
// can reach them (FL FIX 15; M11.4 planted-instruction test). Core's work driver mints with it.

export interface AgentKeyScope {
  /** `session`: the assistant's per-ask key (M18). */
  readonly kind: 'unit' | 'job' | 'session';
  readonly ref: string;
}

export interface AgentKeyContext {
  readonly scope: AgentKeyScope;
  readonly group: string;
  readonly project_id: ProjectId;
  readonly lane?: Lane;
  /** Where ET1 is attributed. The assistant's key (M18) is minted for no item and no step. */
  readonly item_id?: string;
  readonly step?: StepId;
  /** Set for a Unit's key (S6). */
  readonly unit_id?: string;
  readonly now: Date;
}

export function agentKeyRequest(
  def: AgentDefinition,
  c: AgentKeyContext,
): { budget: BudgetGroupSpec; mint: VKeyMint } {
  const contract = def.contract;
  return {
    budget: {
      group_id: c.group,
      max_tokens: contract.budget.max_tokens,
      max_cost_micro_usd: contract.budget.max_cost_micro_usd,
    },
    mint: {
      scope: { kind: c.scope.kind, ref: c.scope.ref },
      project_id: c.project_id,
      ...(c.lane === undefined ? {} : { lane: c.lane }),
      data_class_max: contract.data_class_max,
      models: [...contract.models],
      tools: [...contract.tools],
      budget_group: c.group,
      expires_at: new Date(c.now.getTime() + contract.budget.ttl_seconds * 1000).toISOString(),
      ...(c.item_id === undefined ? {} : { item_id: c.item_id }),
      ...(c.step === undefined ? {} : { step: c.step }),
      ...(c.unit_id === undefined ? {} : { unit_id: c.unit_id }),
    },
  };
}
