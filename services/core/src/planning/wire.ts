import { readPrompt } from '@aisdlc/agents/files';
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
 * The stage ports of a deployment that runs S2 and S3 with real agents (`CORE_WORKER_STAGE_PORTS=agents`):
 * `planning` is the `AgentPlanningPort` (its steps are S2 and S3; every other planning step goes to
 * `base.planning` until M12.3 and M12.4), the rest are `base`. Knowledge is the grounding (its latest census
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
  /** The locked prompt text; default: the files beside the bundle (`dist/prompts`). */
  readonly prompt?: (ref: string) => string;
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
    fallback: o.base.planning,
    prompt: o.prompt ?? readPrompt,
  });
  return { ...o.base, planning };
}
