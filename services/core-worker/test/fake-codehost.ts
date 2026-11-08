import type { CodeHostRead } from '@aisdlc/contracts';
import { FakeGitHub, type CodeHostPort } from '@aisdlc/ports';
import { contractSeed } from '@aisdlc/ports/testing';
import { listen, newApp } from '@aisdlc/service-kit';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

/** The codehost's read routes over a `FakeGitHub`, with the same status mapping and a bearer check. */
export async function startFakeCodehost(token: string, gh = new FakeGitHub(contractSeed())) {
  const app: FastifyInstance = newApp();
  const seen: string[] = [];
  app.addHook('onRequest', async (req, reply) => {
    seen.push(req.url);
    if (req.headers.authorization !== `Bearer ${token}`) {
      return reply.code(401).send({ error: { code: 'unauthenticated', message: 'no' } });
    }
  });
  const send = <T>(reply: FastifyReply, r: CodeHostRead<T>) =>
    r.state === 'ok' ? reply.send(r) : reply.code(r.state === 'unknown' ? 503 : 422).send(r);
  const q = (req: FastifyRequest) => req.query as Record<string, string>;
  const p = (req: FastifyRequest) => {
    const x = req.params as { owner: string; name: string };
    return `${x.owner}/${x.name}`;
  };
  app.get('/v1/repos', async (_req, reply) => send(reply, await gh.list_repos()));
  app.get('/v1/installation', async (_req, reply) => send(reply, await gh.installation()));
  app.get('/v1/repos/:owner/:name/head', async (req, reply) =>
    send(reply, await gh.branch_head({ repo: p(req), branch: q(req)['branch'] ?? '' })),
  );
  app.get('/v1/repos/:owner/:name/rules', async (req, reply) =>
    send(reply, await gh.rules_for_branch({ repo: p(req), branch: q(req)['branch'] ?? '' })),
  );
  const url = await listen(app);
  return {
    url,
    gh: gh as CodeHostPort & FakeGitHub,
    seen,
    stop: () => app.close(),
  };
}
