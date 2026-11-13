import { readPrompt } from '@aisdlc/agents/files';
import type {
  AgentsSettingsConfig,
  Constitution,
  PlanningSizeShareConfig,
  ReonboardTriggersConfig,
} from '@aisdlc/contracts';
import type { Clock } from '@aisdlc/kernel';
import {
  type KnowledgeSearchPort,
  type PlanningPort,
  type RunKeyLender,
  type StagePorts,
} from '@aisdlc/ports';
import type pg from 'pg';
import { HttpKnowledge, HttpKnowledgeSearch } from '../clients.js';
import { CensusGrounding } from './grounding.js';
import { AgentPlanningPort } from './port.js';

/**
 * The stage ports of a deployment that runs S1 to S5 with real agents (`CORE_WORKER_STAGE_PORTS=agents`):
 * `planning` is the `AgentPlanningPort` (its steps are 1.3, 1.5 and S2 to S5; the steps no agent acts at go to
 * `base.planning`), the rest are `base`. Knowledge is the grounding (its latest census
 * is the merged head) and, with the `search` scope, the `KnowledgeSearch` tool's backend. The gateway's
 * `/v1/messages` is called under each run's own key, borrowed from `keys`.
 */
export function agentStagePorts(o: {
  readonly pool: pg.Pool;
  readonly clock?: Clock;
  readonly base: StagePorts;
  readonly gatewayUrl: string;
  readonly keys: RunKeyLender;
  readonly knowledge: { readonly url: string; readonly token: string };
  /** Defaults to the same knowledge with the same token (it must carry scope `search` to be offered). */
  readonly search?: KnowledgeSearchPort;
  /** The factory constitution (`factory.constitution` from the config reader); default: the built-in one. */
  readonly constitution?: () => Constitution | null;
  /** `onboarding.reonboard_triggers` (M17); default: the spec's 3 knowledge defects in 30 days. */
  readonly reonboardTriggers?: () => ReonboardTriggersConfig;
  /** The locked prompt text; default: the files beside the bundle (`dist/prompts`). */
  readonly prompt?: (ref: string) => string;
  /** Portal v2: `agents.config` and `planning.size_share` from the config reader. */
  readonly agentSettings?: () => AgentsSettingsConfig | null;
  readonly sizeShare?: () => PlanningSizeShareConfig | null;
}): StagePorts {
  const knowledge = new HttpKnowledge({ baseUrl: o.knowledge.url, token: o.knowledge.token });
  const planning: PlanningPort = new AgentPlanningPort({
    pool: o.pool,
    ...(o.clock ? { clock: o.clock } : {}),
    gateway: { baseUrl: o.gatewayUrl },
    keys: o.keys,
    grounding: new CensusGrounding(knowledge),
    search:
      o.search ?? new HttpKnowledgeSearch({ baseUrl: o.knowledge.url, token: o.knowledge.token }),
    ...(o.constitution ? { constitution: o.constitution } : {}),
    ...(o.reonboardTriggers ? { reonboardTriggers: o.reonboardTriggers } : {}),
    ...(o.agentSettings ? { agentSettings: o.agentSettings } : {}),
    ...(o.sizeShare ? { sizeShare: o.sizeShare } : {}),
    fallback: o.base.planning,
    prompt: o.prompt ?? readPrompt,
  });
  return { ...o.base, planning };
}
