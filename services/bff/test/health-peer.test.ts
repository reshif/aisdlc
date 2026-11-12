import { listen, newApp } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startBffStack, type BffStack } from '../src/testing.js';

// M19: the health tile of a profile service only the bff reaches (the notifier) is read through the bff: it relays the
// peer's liveness answer, the status and each loop's name and state only; no answer is 502 (core-worker reads unknown).

let s: BffStack;
let peer: FastifyInstance;
let answer: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  peer = newApp();
  peer.get('/healthz', async (_req, reply) => reply.code(answer.status).send(answer.body));
  const peerUrl = await listen(peer);
  s = await startBffStack({
    override: { healthPeers: { notifier: peerUrl, gone: 'http://127.0.0.1:9' } },
  });
});
afterAll(async () => {
  await s?.stop();
  await peer?.close();
});

const get = async (path: string) => {
  const r = await fetch(`${s.base}${path}`);
  return { status: r.status, json: (await r.json()) as unknown };
};

describe('GET /healthz/peer/:name', () => {
  it("relays the peer's status and its loops' states, nothing else of its answer", async () => {
    answer = {
      status: 200,
      body: {
        status: 'ok',
        loops: [{ name: 'delivery', state: 'ok', consecutive_failures: 0, last_error: 'secret' }],
        alerts: [{ code: 'x', detail: 'secret' }],
        token: 'secret',
      },
    };
    const r = await get('/healthz/peer/notifier');
    expect(r).toEqual({
      status: 200,
      json: {
        status: 'ok',
        loops: [{ name: 'delivery', state: 'ok', consecutive_failures: 0 }],
        alerts: [],
      },
    });
    expect(JSON.stringify(r.json)).not.toContain('secret');
  });

  it('an unhealthy peer is 503, an unreachable one 502, an unknown name 404', async () => {
    answer = { status: 503, body: { status: 'unhealthy' } };
    expect((await get('/healthz/peer/notifier')).status).toBe(503);
    expect((await get('/healthz/peer/gone')).status).toBe(502);
    expect((await get('/healthz/peer/core')).status).toBe(404);
    expect((await get('/healthz/peer/__proto__')).status).toBe(404);
  });
});
