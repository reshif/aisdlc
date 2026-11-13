import { readPrompt } from '@aisdlc/agents/files';
import { FakeAgentKeys } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ScriptedOnboarderModel,
  createCoreApp,
  toolUse,
  turnText,
  type ConsoleDeps,
  type CoreScope,
} from '../src/index.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';
import { makeHarness } from './harness.js';

// The console's routes over HTTP (docs/design/onboarding-console.md): the scope each needs, the PDP's yes on the
// session's project for every call (and `onboarding.console.steer` for pause, resume and stop), a person who cannot see
// the project, a session that does not exist, and the whole conversation: start, message, proposal, answer, steering.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
  none: 'none-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'onboard'],
  reader: ['read'],
  none: ['work'],
};
/** What the fake PDP allows, per person: a set of actions; anything else is a no. */
const allowed = new Map<string, Set<string>>();
const asks: Array<{ principal: string; action: string }> = [];
let script: ScriptedOnboarderModel;
const holder: { cards?: ConsoleDeps['cards'] } = {};

const h = makeHarness(() => s, 'och');
const { scenario, sync } = h;

beforeAll(async () => {
  s = await startCoreStack();
  const pdp = {
    async decide(q: { principal: string; action: string }) {
      asks.push({ principal: q.principal, action: q.action });
      const yes = allowed.get(q.principal)?.has(q.action) ?? false;
      return yes
        ? { decision: 'allow', reasons: [], policies: [] }
        : { decision: 'deny', reasons: ['no_policy_permits'], policies: [] };
    },
  };
  // the console is built per test from the script below, behind a stable object the app holds
  const deps = {
    pool: s.record.pool,
    clock: s.clock,
    keys: new FakeAgentKeys(),
    prompt: readPrompt,
    get model() {
      return script;
    },
  };
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp: pdp as never,
    console: new Proxy(deps as unknown as ConsoleDeps, {
      get: (t, k) => (k === 'cards' ? holder.cards : (t as never)[k as never]),
    }),
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s.stop();
});

async function call(method: string, path: string, body?: unknown, token = TOKENS.bff) {
  const res = await fetch(new URL(path, url), {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, json: (text ? JSON.parse(text) : null) as Json };
}

const USE = ['project.view', 'onboarding.console.use'];
const grant = (who: string, ...actions: string[]) => allowed.set(who, new Set(actions));

describe('the console routes', () => {
  it('scope, then the PDP: no scope is 403; a person who cannot see the project is refused; a missing session is 404', async () => {
    const c = await scenario({ host: { codeowners: null } });
    holder.cards = c.deps;
    expect(await c.drive()).toBe('card');
    await sync(c);
    script = new ScriptedOnboarderModel([]);
    grant('alice', ...USE);

    // the wrong scope
    expect(
      (await call('GET', `/v1/s0/${c.s0}/console?on_behalf_of=alice`, undefined, TOKENS.none))
        .status,
    ).toBe(403);
    expect(
      (await call('POST', `/v1/s0/${c.s0}/console/start`, { on_behalf_of: 'alice' }, TOKENS.reader))
        .status,
    ).toBe(403);
    // a person the PDP says no to
    const nope = await call('GET', `/v1/s0/${c.s0}/console?on_behalf_of=mallory`);
    expect(nope.status).toBe(403);
    // nothing started yet
    expect((await call('GET', `/v1/s0/${c.s0}/console?on_behalf_of=alice`)).status).toBe(404);
    // not an onboarding
    expect(
      (
        await call(
          'GET',
          `/v1/s0/${'0190a000-0000-7000-8000-000000000999'}/console?on_behalf_of=alice`,
        )
      ).status,
    ).toBe(404);
    // a bad body
    expect(
      (await call('POST', `/v1/s0/${c.s0}/console/messages`, { on_behalf_of: 'alice' })).status,
    ).toBe(400);
  });

  it('start, a message with a proposal, the person’s answer and the steering, each as the person and under the PDP', async () => {
    const c = await scenario({ host: { codeowners: null } });
    holder.cards = c.deps;
    expect(await c.drive()).toBe('card');
    await sync(c);
    grant('alice', ...USE);
    script = new ScriptedOnboarderModel([
      { blocks: [turnText({ text: 'First look: nothing in the way but your decisions.' })] },
      {
        blocks: [
          toolUse('p', 'OnboardingPropose', {
            kind: 'tier',
            target: 'tier',
            title: 'Choose T1',
            why: 'The repo has no production use.',
            value: { tier: 'T1' },
          }),
        ],
      },
      { blocks: [turnText({ text: 'I propose T1; accept it or change it.' })] },
      { blocks: [turnText({ text: 'Good, T1 it is.' })] },
    ]);
    const started = await call('POST', `/v1/s0/${c.s0}/console/start`, { on_behalf_of: 'alice' });
    expect(started.status).toBe(201);
    expect(started.json.turns.map((t: Json) => t.role)).toEqual(['observation', 'agent']);
    expect(
      (await call('POST', `/v1/s0/${c.s0}/console/start`, { on_behalf_of: 'alice' })).status,
    ).toBe(200);

    const said = await call('POST', `/v1/s0/${c.s0}/console/messages`, {
      on_behalf_of: 'alice',
      text: 'Which tier?',
    });
    expect(said.status).toBe(200);
    expect(said.json.turns.at(-1)).toMatchObject({
      role: 'agent',
      text: 'I propose T1; accept it or change it.',
    });
    const p = said.json.proposals[0];
    expect(p).toMatchObject({ kind: 'tier', state: 'open', value: { tier: 'T1' } });

    // the answer is the person's; a hash they did not read is refused
    const bad = await call('POST', `/v1/s0/${c.s0}/console/proposals/${p.proposal_id}/decide`, {
      on_behalf_of: 'alice',
      decision: 'accept',
      proposal_sha256: 'f'.repeat(64),
    });
    expect(bad.status).toBe(409);
    const done = await call('POST', `/v1/s0/${c.s0}/console/proposals/${p.proposal_id}/decide`, {
      on_behalf_of: 'alice',
      decision: 'accept',
      proposal_sha256: p.proposal_sha256,
    });
    expect(done.status).toBe(200);
    expect(done.json.draft.tier).toBe('T1');
    expect(done.json.turns.at(-1).text).toBe('Good, T1 it is.');

    // the direct edit of the summary draft
    const patched = await call('PATCH', `/v1/s0/${c.s0}/summary`, {
      on_behalf_of: 'alice',
      two_person_enabled: true,
    });
    expect(patched.status).toBe(200);
    expect(patched.json.draft).toMatchObject({ tier: 'T1', two_person_enabled: true });
    expect(
      (await call('PATCH', `/v1/s0/${c.s0}/summary`, { on_behalf_of: 'alice', tier: 'T9' })).status,
    ).toBe(400);

    // steering needs onboarding.console.steer on top of use
    const refused = await call('POST', `/v1/s0/${c.s0}/console/pause`, { on_behalf_of: 'alice' });
    expect(refused.status).toBe(403);
    grant('alice', ...USE, 'onboarding.console.steer');
    const paused = await call('POST', `/v1/s0/${c.s0}/console/pause`, { on_behalf_of: 'alice' });
    expect(paused.json.state).toBe('paused');
    expect(
      (await call('POST', `/v1/s0/${c.s0}/console/stop`, { on_behalf_of: 'alice' })).json.state,
    ).toBe('stopped');
    // a stopped session takes no message
    expect(
      (
        await call('POST', `/v1/s0/${c.s0}/console/messages`, {
          on_behalf_of: 'alice',
          text: 'still there?',
        })
      ).status,
    ).toBe(409);
    // every call asked the PDP for the person, with the project-view action and the console one
    const mine = asks.filter((a) => a.principal === 'alice').map((a) => a.action);
    expect(new Set(mine)).toEqual(new Set([...USE, 'onboarding.console.steer']));
  });

  it('the session list shows only the projects the person may use the console on', async () => {
    const a = await scenario({ host: { codeowners: null } });
    holder.cards = a.deps;
    expect(await a.drive()).toBe('card');
    await sync(a);
    grant('alice', ...USE);
    script = new ScriptedOnboarderModel([{ blocks: [turnText({ text: 'Hello.' })] }]);
    expect(
      (await call('POST', `/v1/s0/${a.s0}/console/start`, { on_behalf_of: 'alice' })).status,
    ).toBe(201);
    const mine = await call('GET', '/v1/console/sessions?on_behalf_of=alice');
    expect(mine.status).toBe(200);
    expect(mine.json.sessions.map((x: Json) => x.s0_id)).toContain(a.s0);
    grant('bob', 'project.view'); // can see, may not use the console
    const bobs = await call('GET', '/v1/console/sessions?on_behalf_of=bob');
    expect(bobs.json.sessions).toEqual([]);
    expect(
      (await call('GET', '/v1/console/sessions?on_behalf_of=alice', undefined, TOKENS.none)).status,
    ).toBe(403);
  });
});
