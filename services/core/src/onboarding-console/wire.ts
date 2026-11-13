import { readPrompt } from '@aisdlc/agents/files';
import { GatewayAgentKeys } from '../agent-keys.js';
import { HttpKnowledgeSearch } from '../clients.js';
import type { CardDeps } from '../cards/model.js';
import { GatewayAdminHttp } from '../conversation/gateway.js';
import { consoleActsFrom, type ConsoleActsPort } from './acts.js';
import type { ConsoleDeps } from './engine.js';
import { GatewayOnboarderModel } from './model.js';

interface Remote {
  readonly url: string;
  readonly token: string;
}

/**
 * The console of a deployment (core with CORE_GATEWAY_URL): the cards' deps for what it reads, knowledge's search at the
 * census commit, the gateway's admin API for the per-session key and `/v1/messages` for the model. The kill switch is
 * the gateway's to check on every call (core stays off the kill switch's network), so nothing is passed as `admit`.
 */
export function consoleDepsFrom(o: {
  readonly cards: CardDeps;
  readonly knowledge: Remote;
  readonly gateway: Remote;
  readonly extraModels?: readonly string[];
  /** What the onboarder may do here; default: re-check and card sync only (the probe and the pack are the worker's). */
  readonly acts?: ConsoleActsPort;
  /** `onboarding.console` and the guidelines from the config reader; absent: the defaults and none. */
  readonly config?: ConsoleDeps['config'];
  readonly guidelines?: ConsoleDeps['guidelines'];
}): ConsoleDeps {
  const admin = new GatewayAdminHttp({ baseUrl: o.gateway.url, token: o.gateway.token });
  return {
    pool: o.cards.pool,
    ...(o.cards.clock ? { clock: o.cards.clock } : {}),
    cards: o.cards,
    keys: new GatewayAgentKeys(admin, { extraModels: o.extraModels ?? [] }),
    model: new GatewayOnboarderModel({ baseUrl: o.gateway.url }),
    acts: o.acts ?? consoleActsFrom({ cards: o.cards }),
    ...(o.config ? { config: o.config } : {}),
    ...(o.guidelines ? { guidelines: o.guidelines } : {}),
    search: new HttpKnowledgeSearch({ baseUrl: o.knowledge.url, token: o.knowledge.token }),
    prompt: readPrompt,
  };
}
