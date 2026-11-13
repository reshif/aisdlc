import { SettingPreview, placementOf } from '@aisdlc/contracts';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createCoreApp, type CoreScope } from '../src/index.js';
import { diffPaths, effectSentences } from '../src/settings-preview.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// Settings › preview (screen map N8) on a real database: the effect of a draft, in plain words, before anything is
// proposed; it writes nothing, and only someone who may propose a change may ask.

let s: CoreStack;
let app: FastifyInstance;
let url: string;
const TOKENS = {
  bff: 'bff-at-core-'.padEnd(32, 'x'),
  reader: 'reader-at-core-'.padEnd(32, 'x'),
};
const CALLERS: Record<string, readonly CoreScope[]> = {
  bff: ['read', 'portal'],
  reader: ['read'],
};

beforeAll(async () => {
  s = await startCoreStack();
  await seedPrincipals(s.id.deps, ['alice', 'bob']);
  await grantFleetRole(s.id.deps, 'alice', 'factory.admin');
  const pdp = new Pdp({
    source: new StaticBundleSource(buildBundle()),
    entities: new IdentityPdpEntities({ pool: s.record.pool }),
    log: new RecordDecisionLog({ pool: s.record.pool }),
    clock: s.clock,
  });
  app = createCoreApp({
    pool: s.record.pool,
    auth: new ServiceAuth(TOKENS),
    callers: CALLERS,
    registry: s.registry,
    clock: s.clock,
    pdp,
    config: s.config,
  });
  url = await listen(app);
});
afterAll(async () => {
  await app?.close();
  await s?.stop();
});

async function preview(token: string, key: string, body: unknown) {
  const res = await fetch(new URL(`/v1/config/keys/${key}/preview`, url), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: (await res.json()) as unknown };
}

const events = async () =>
  (
    await s.record.pool.query<{ n: number }>(
      "SELECT count(*)::int AS n FROM record.record_event WHERE type <> 'pdp.decision'",
    )
  ).rows[0]?.n;

describe('settings preview', () => {
  it('says what a sandbox cap change does, and writes nothing', async () => {
    const before = await events();
    const r = await preview(TOKENS.bff, 'sandbox.caps', {
      value: { total: 4, coding: 2 },
      on_behalf_of: 'alice',
    });
    expect(r.status).toBe(200);
    const p = SettingPreview.parse(r.json);
    expect(p).toMatchObject({ key: 'sandbox.caps', applies: 'now', valid: true, problems: [] });
    expect(p.changes).toEqual([{ path: 'coding', before: 1, after: 2 }]);
    expect(p.effects).toContain('Coding sandboxes at once: 1 → 2.');
    expect(await events()).toBe(before);
  });

  it('reports a draft the schema refuses as problems, never as valid', async () => {
    const r = await preview(TOKENS.bff, 'sandbox.caps', {
      value: { total: 'many', coding: 1 },
      on_behalf_of: 'alice',
    });
    const p = SettingPreview.parse(r.json);
    expect(p.valid).toBe(false);
    expect(p.problems.join(' ')).toMatch(/total/);
  });

  it('is config.propose on the fleet, and the portal scope', async () => {
    const bob = await preview(TOKENS.bff, 'sandbox.caps', { value: {}, on_behalf_of: 'bob' });
    expect(bob.status).toBe(403);
    const reader = await preview(TOKENS.reader, 'sandbox.caps', {
      value: {},
      on_behalf_of: 'alice',
    });
    expect(reader.status).toBe(403);
    const none = await preview(TOKENS.bff, 'no.such_key', { value: 1, on_behalf_of: 'alice' });
    expect(none.status).toBe(404);
  });

  it('says a catalogue change is new items only and that a new process version is made', async () => {
    const view = await fetch(new URL('/v1/config/keys/catalogue.lanes', url), {
      headers: { authorization: `Bearer ${TOKENS.bff}` },
    });
    const body = (await view.json()) as {
      effective: { value: Record<string, { gates: Array<{ gate: string }> }> };
    };
    const draft = structuredClone(body.effective.value);
    const l2 = draft['L2'];
    if (!l2) throw new Error('no L2 track');
    const had = l2.gates.length;
    l2.gates = l2.gates.slice(1);
    const r = await preview(TOKENS.bff, 'catalogue.lanes', { value: draft, on_behalf_of: 'alice' });
    const p = SettingPreview.parse(r.json);
    expect(had).toBeGreaterThan(0);
    expect(p.applies).toBe('new_items');
    expect(p.items_in_progress).toBe(0);
    expect(p.effects.some((e) => /no longer has the approval/.test(e))).toBe(true);
    expect(p.effects.some((e) => /new process version/.test(e))).toBe(true);
  });

  it('places every key core registers in a section', () => {
    const unplaced = s.config.registry.keys().filter((k) => placementOf(k).section === 'other');
    expect(unplaced).toEqual([]);
  });
});

describe('the pure parts', () => {
  it('diffs by leaf path', () => {
    expect(diffPaths({ a: 1, b: { c: 2 } }, { a: 1, b: { c: 3 }, d: true })).toEqual([
      { path: 'b.c', before: 2, after: 3 },
      { path: 'd', before: undefined, after: true },
    ]);
  });

  it('names approvals and agents in plain words', () => {
    const lanes = (gates: string[]) => ({ L2: { gates: gates.map((gate) => ({ gate })) } });
    const e = effectSentences('catalogue.lanes', lanes(['G1']), lanes(['G1', 'G3']));
    expect(e).toHaveLength(1);
    expect(e[0]).not.toMatch(/\bG3\b|\bL2\b/);
    const a = effectSentences('agents.config', {}, { coder: { enabled: false } });
    expect(a[0]).toMatch(/^Coding agent is turned off/);
    const g = effectSentences(
      'gates.policy',
      { gates: { G3: { slot: 'tech_lead', step_up: false } }, two_person_gates: [] },
      { gates: { G3: { slot: 'tech_lead', step_up: true } }, two_person_gates: ['G3'] },
    );
    expect(g).toHaveLength(2);
    expect(g.join(' ')).not.toMatch(/\bG3\b/);
  });
});
