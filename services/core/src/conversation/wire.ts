import { readPrompt } from '@aisdlc/agents/files';
import { HttpCodeHostReads } from '@aisdlc/ports';
import type pg from 'pg';
import { GatewayAgentKeys } from '../agent-keys.js';
import { HttpKnowledge, HttpKnowledgeSearch } from '../clients.js';
import type { AssistantDeps } from './assistant.js';
import { GatewayAdminHttp } from './gateway.js';

interface Remote {
  readonly url: string;
  readonly token: string;
}

/**
 * The assistant of a deployment (core with CORE_GATEWAY_URL): knowledge's census is the grounding and, with the
 * `search` scope, the KnowledgeSearch backend; the code host's default-branch head says when the head moved past the
 * census; the gateway mints the per-ask key on the person's day group and serves `/v1/messages`.
 */
export function assistantDepsFrom(o: {
  readonly pool: pg.Pool;
  readonly knowledge: Remote;
  readonly codehost: Remote;
  readonly gateway: Remote;
  readonly extraModels?: readonly string[];
}): AssistantDeps {
  const admin = new GatewayAdminHttp({ baseUrl: o.gateway.url, token: o.gateway.token });
  const host = new HttpCodeHostReads({ baseUrl: o.codehost.url, token: o.codehost.token });
  return {
    pool: o.pool,
    knowledge: new HttpKnowledge({ baseUrl: o.knowledge.url, token: o.knowledge.token }),
    search: new HttpKnowledgeSearch({ baseUrl: o.knowledge.url, token: o.knowledge.token }),
    head: async (repo) => {
      const repos = await host.list_repos();
      if (repos.state !== 'ok') return null;
      const r = repos.value.find((x) => x.full_name.toLowerCase() === repo.toLowerCase());
      if (!r) return null;
      const h = await host.branch_head({ repo: r.full_name, branch: r.default_branch });
      return h.state === 'ok' ? h.value : null;
    },
    keys: new GatewayAgentKeys(admin, { extraModels: o.extraModels ?? [] }),
    budget: admin,
    gateway: { baseUrl: o.gateway.url },
    prompt: readPrompt,
  };
}
