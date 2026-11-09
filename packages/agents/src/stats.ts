import type { AgentId, AgentRun, AgentRunOutcome, AgentStats, ProjectId } from '@aisdlc/contracts';

// Acceptance rate, back-edge rate and cost per run (PLAN M11.2; DM §5.2 AgentScore). Pure over the
// runs and their outcomes, so the HTTP read and the tests compute it one way. A rate whose denominator
// is 0 is `null`, never 0 and never 1.

export type RunWithOutcome = AgentRun & { readonly outcome: AgentRunOutcome };

export function agentStats(
  agent_id: AgentId,
  runs: readonly RunWithOutcome[],
  project_id: ProjectId | null = null,
): AgentStats {
  const mine = runs.filter(
    (r) => r.agent_id === agent_id && (project_id === null || r.project_id === project_id),
  );
  const count = (v: AgentRunOutcome['verdict']) =>
    mine.filter((r) => r.outcome.verdict === v).length;
  const finished = mine.filter((r) => r.state === 'finished');
  const accepted = count('accepted');
  const judged = mine.filter((r) => r.outcome.verdict !== 'pending').length;
  const with_back_edge = finished.filter((r) => r.outcome.back_edges.length > 0).length;
  const cost = mine.reduce((n, r) => n + r.cost_micro_usd, 0);
  const metered = mine.filter((r) => r.calls > 0).length;
  return {
    agent_id,
    project_id,
    runs: mine.length,
    finished: finished.length,
    failed: mine.filter((r) => r.state === 'failed').length,
    judged,
    accepted,
    rejected: count('rejected'),
    sent_back: count('sent_back'),
    reworked: count('reworked'),
    handed_off: count('handed_off'),
    with_back_edge,
    acceptance_rate: judged === 0 ? null : accepted / judged,
    back_edge_rate: finished.length === 0 ? null : with_back_edge / finished.length,
    calls: mine.reduce((n, r) => n + r.calls, 0),
    tokens_in: mine.reduce((n, r) => n + r.tokens_in, 0),
    tokens_out: mine.reduce((n, r) => n + r.tokens_out, 0),
    cost_micro_usd: cost,
    cost_per_run_micro_usd: metered === 0 ? null : cost / metered,
  };
}
