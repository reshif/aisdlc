import { CONTROL_EVENT, controlStream, type OpsControl } from '@aisdlc/contracts';
import { bindProject, grantFleetRole, seedPrincipals } from '@aisdlc/identity/testing';
import { IdentityPdpEntities } from '@aisdlc/identity/read';
import { Pdp, RecordDecisionLog, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { FakeCapacity, FakeStagePorts } from '@aisdlc/ports';
import { ServiceAuth, listen } from '@aisdlc/service-kit';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  activeBanners,
  activeControls,
  applyControl,
  backfillOpsLedger,
  blastRadius,
  createCoreApp,
  driveWork,
  liftControl,
  listControls,
  previewControl,
  publishBanner,
  readItem,
  readOpsAction,
  requestWork,
  withdrawBanner,
  type CoreScope,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_OFF,
  approvers,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
  type Seeded,
} from './work-fixtures.js';

// Controls, previews, banners and OpsActions (PLAN M9.6): preview before apply, one look one act, the
// effect on work in a scope (and only in it), ledgered after it is executed.

let s: CoreStack;
let n = 0;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: { message: string } }): T => {
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
};
const err = <T>(r: { ok: boolean; value?: T; error?: { code: string } }) =>
  r.ok ? 'ok' : r.error?.code;
const ALICE = pr('alice-ops');

async function seededProject(): Promise<Seeded> {
  const x = await seedActivePrr(s, { level: 'full', gating: GATING_OFF });
  approvers(s, x.project);
  return x;
}
async function item(x: Seeded, lane: 'L3' | 'L4' = 'L3') {
  n += 1;
  const r = ok(
    await requestWork(s.deps, {
      project_id: pid(x.project),
      repo: x.repo,
      lane,
      requester: pr('alice'),
      request_id: `ctl-${n}`,
      create_item: true,
    }),
  );
  return r.item_id as string;
}
const st = async (id: string) => (await readItem(s.record.pool, id))?.state;
const scopeOf = (project: string) => ({ kind: 'project', ref: project }) as const;

/** preview then apply, the way a screen does. */
async function apply(
  kind: 'hold' | 'clamp' | 'halt' | 'maintenance',
  scope: unknown,
  o: { params?: unknown; expires_at?: string | null; deps?: typeof s.deps } = {},
) {
  const deps = o.deps ?? s.deps;
  const p = ok(await previewControl(s.deps, { kind, scope, actor: ALICE }));
  return applyControl(deps, {
    preview_id: p.preview_id,
    nonce: p.nonce,
    kind,
    scope,
    actor: ALICE,
    ...(o.params === undefined ? {} : { params: o.params }),
    ...(o.expires_at === undefined ? {} : { expires_at: o.expires_at }),
  });
}

describe('preview: show what it would affect before applying', () => {
  it('counts what the scope covers, from the record', async () => {
    const x = await seededProject();
    const y = await seededProject();
    await item(x, 'L3');
    await item(x, 'L4');
    await item(y, 'L3');
    const forProject = await blastRadius(s.record.pool, scopeOf(x.project), s.clock.now());
    expect(forProject).toMatchObject({
      projects: [x.project],
      lanes: ['L3', 'L4'],
      items: 2,
      items_in_flight: 0,
    });
    const forLane = await blastRadius(
      s.record.pool,
      { kind: 'lane', ref: `${x.project}/L3` },
      s.clock.now(),
    );
    expect(forLane).toMatchObject({ lanes: ['L3'], items: 1 });
    const fleet = await blastRadius(s.record.pool, { kind: 'fleet', ref: '*' }, s.clock.now());
    expect(fleet.items).toBeGreaterThanOrEqual(3);
    expect(fleet.projects).toEqual(expect.arrayContaining([x.project, y.project]));
  });

  it('the preview is bound to a nonce, the actor, the verb, the scope; one look is one act', async () => {
    const x = await seededProject();
    const scope = scopeOf(x.project);
    const p = ok(await previewControl(s.deps, { kind: 'hold', scope, actor: ALICE }));
    expect(p.nonce.length).toBeGreaterThanOrEqual(16);
    const base = { preview_id: p.preview_id, kind: 'hold' as const, scope, actor: ALICE };
    expect(err(await applyControl(s.deps, { ...base, nonce: 'wrong-wrong-wrong-wrong' }))).toBe(
      'forbidden',
    );
    expect(err(await applyControl(s.deps, { ...base, nonce: p.nonce, actor: pr('mallory') }))).toBe(
      'forbidden',
    );
    expect(err(await applyControl(s.deps, { ...base, nonce: p.nonce, kind: 'halt' }))).toBe(
      'conflict',
    );
    expect(
      err(await applyControl(s.deps, { ...base, nonce: p.nonce, scope: scopeOf('other') })),
    ).toBe('conflict');
    expect(
      err(
        await applyControl(s.deps, {
          preview_id: '018f3c1e-7b2a-7c3d-8e4f-0123456789ab',
          nonce: p.nonce,
          kind: 'hold',
          scope,
          actor: ALICE,
        }),
      ),
    ).toBe('not_found');
    const applied = ok(await applyControl(s.deps, { ...base, nonce: p.nonce }));
    expect(applied.control?.state).toBe('active');
    // used: it cannot be applied twice
    expect(err(await applyControl(s.deps, { ...base, nonce: p.nonce }))).toBe('conflict');
  });

  it('is refused when what it would touch changed since it was shown, and when it has expired', async () => {
    const x = await seededProject();
    const scope = scopeOf(x.project);
    await item(x);
    const p = ok(await previewControl(s.deps, { kind: 'hold', scope, actor: ALICE }));
    await item(x); // a new item in the scope after the look
    const r = await applyControl(s.deps, {
      preview_id: p.preview_id,
      nonce: p.nonce,
      kind: 'hold',
      scope,
      actor: ALICE,
    });
    expect(err(r)).toBe('conflict');
    expect(
      (await activeControls(s.record.pool, s.clock.now())).filter((c) => c.scope.ref === x.project),
    ).toEqual([]);
    // a fresh look works
    ok(await apply('hold', scope));
    // expired
    const y = await seededProject();
    const q = ok(
      await previewControl(s.deps, { kind: 'hold', scope: scopeOf(y.project), actor: ALICE }),
    );
    s.clock.advance(11 * 60_000);
    expect(
      err(
        await applyControl(s.deps, {
          preview_id: q.preview_id,
          nonce: q.nonce,
          kind: 'hold',
          scope: scopeOf(y.project),
          actor: ALICE,
        }),
      ),
    ).toBe('conflict');
  });

  it('refuses a scope nothing enforces yet, and a clamp without a number', async () => {
    const x = await seededProject();
    expect(
      err(
        await previewControl(s.deps, {
          kind: 'hold',
          scope: { kind: 'budget', ref: 'b1' },
          actor: ALICE,
        }),
      ),
    ).toBe('invalid_input');
    expect(
      err(
        await previewControl(s.deps, {
          kind: 'hold',
          scope: { kind: 'repo', ref: 'x' },
          actor: ALICE,
        }),
      ),
    ).toBe('invalid_input');
    expect(err(await apply('clamp', scopeOf(x.project)))).toBe('invalid_input');
    expect(err(await apply('clamp', scopeOf(x.project), { params: { max_in_flight: -1 } }))).toBe(
      'invalid_input',
    );
  });
});

describe('effects on work: hold, maintenance, halt, clamp, and expiry', () => {
  it('hold: items in the scope are HELD and nothing else is; lifting resumes them and they finish', async () => {
    const x = await seededProject();
    const y = await seededProject();
    const ports = new FakeStagePorts();
    const d = driverOver(s, { ports });
    const a = await item(x);
    const b = await item(y);
    const applied = ok(await apply('hold', scopeOf(x.project)));
    await driveWork(d);
    expect((await st(a))?.holds).toMatchObject([
      { reason: 'control', origin: applied.control?.control_id },
    ]);
    expect((await st(b))?.holds).toEqual([]);
    // nothing of x's reached a stage port while it was held; y's did
    expect(ports.calls().every((c) => c.project_id !== x.project)).toBe(true);
    expect((await runItem(s, d, b))?.state.terminal).toBe('Done');
    ok(
      await liftControl(s.deps, {
        control_id: applied.control?.control_id as string,
        actor: ALICE,
        reason: 'all clear',
      }),
    );
    s.clock.advance(60_000);
    const done = await runItem(s, d, a);
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.holds).toEqual([]);
  });

  it('a lane hold stops that lane of the project, not the project', async () => {
    const x = await seededProject();
    const ports = new FakeStagePorts();
    const d = driverOver(s, { ports });
    const l3 = await item(x, 'L3');
    const l4 = await item(x, 'L4');
    ok(await apply('hold', { kind: 'lane', ref: `${x.project}/L3` }));
    await driveWork(d);
    expect((await st(l3))?.holds[0]?.reason).toBe('control');
    expect((await st(l4))?.holds).toEqual([]);
  });

  it('maintenance: timers freeze and work is held, drafts kept; lifted, it resumes', async () => {
    const x = await seededProject();
    const d = driverOver(s);
    const id = await item(x);
    const applied = ok(await apply('maintenance', scopeOf(x.project)));
    await driveWork(d);
    const frozen = await st(id);
    expect(frozen?.holds).toMatchObject([
      { reason: 'maintenance', origin: applied.control?.control_id },
    ]);
    expect(frozen?.clock.frozen_since).not.toBeNull();
    s.clock.advance(3_600_000);
    ok(
      await liftControl(s.deps, {
        control_id: applied.control?.control_id as string,
        actor: ALICE,
        reason: 'done',
      }),
    );
    await driveWork(d);
    const after = await st(id);
    expect(after?.holds).toEqual([]);
    expect(after?.clock.frozen_ms).toBeGreaterThanOrEqual(3_600_000);
    expect((await runItem(s, d, id))?.state.terminal).toBe('Done');
  });

  it('halt: nothing is released while it is on (the release steps wait), everything before it runs', async () => {
    const x = await seededProject();
    const ports = new FakeStagePorts();
    const d = driverOver(s, { ports });
    const id = await item(x);
    const applied = ok(await apply('halt', scopeOf(x.project)));
    const out = await runItem(s, d, id, {
      passes: 25,
      stop: (q) => q.phase === 'S8b' || q.phase === 'S9',
    });
    expect(out?.state.terminal ?? null).toBeNull();
    expect(ports.release.calls.length).toBe(0);
    expect(ports.coding.calls.length).toBeGreaterThan(0);
    ok(
      await liftControl(s.deps, {
        control_id: applied.control?.control_id as string,
        actor: ALICE,
        reason: 'ok',
      }),
    );
    s.clock.advance(60_000);
    expect((await runItem(s, d, id))?.state.terminal).toBe('Done');
  });

  it('clamp: no more agent sessions than it allows; the rest are HELD (WIP) and go on as room is made', async () => {
    const x = await seededProject();
    const ports = new FakeStagePorts();
    const cap = new FakeCapacity();
    const d = driverOver(s, { ports, capacity: cap });
    const a = await item(x);
    const applied = ok(await apply('clamp', scopeOf(x.project), { params: { max_in_flight: 0 } }));
    await runItem(s, d, a, { passes: 20, stop: (q) => q.holds.some((h) => h.reason === 'WIP') });
    expect((await st(a))?.holds[0]?.reason).toBe('WIP');
    expect(ports.coding.calls.length).toBe(0);
    // capacity is there, but the clamp leaves no room: still held
    cap.grant('WIP', 5);
    await driveWork(d);
    expect((await st(a))?.holds[0]?.reason).toBe('WIP');
    ok(
      await liftControl(s.deps, {
        control_id: applied.control?.control_id as string,
        actor: ALICE,
        reason: 'ok',
      }),
    );
    await driveWork(d);
    expect((await runItem(s, d, a))?.state.terminal).toBe('Done');
  });

  it('expiry needs no sweep: past `expires_at` the control is not in force and its hold is lifted', async () => {
    const x = await seededProject();
    const d = driverOver(s);
    const id = await item(x);
    const at = new Date(s.clock.now().getTime() + 30 * 60_000).toISOString();
    const applied = ok(await apply('hold', scopeOf(x.project), { expires_at: at }));
    await driveWork(d);
    expect((await st(id))?.holds[0]?.reason).toBe('control');
    s.clock.advance(31 * 60_000);
    const c = (await listControls(s.record.pool, s.clock.now())).find(
      (q) => q.control_id === applied.control?.control_id,
    ) as OpsControl;
    expect(c.state).toBe('expired');
    await driveWork(d);
    expect((await st(id))?.holds).toEqual([]);
    expect(
      err(await liftControl(s.deps, { control_id: c.control_id, actor: ALICE, reason: 'x' })),
    ).toBe('conflict');
  });

  it('a lifted control cannot be lifted again', async () => {
    const x = await seededProject();
    const applied = ok(await apply('hold', scopeOf(x.project)));
    ok(
      await liftControl(s.deps, {
        control_id: applied.control?.control_id as string,
        actor: ALICE,
        reason: 'one',
      }),
    );
    expect(
      err(
        await liftControl(s.deps, {
          control_id: applied.control?.control_id as string,
          actor: ALICE,
          reason: 'two',
        }),
      ),
    ).toBe('conflict');
    expect(
      err(
        await liftControl(s.deps, {
          control_id: '018f3c1e-7b2a-7c3d-8e4f-0123456789ab',
          actor: ALICE,
          reason: 'x',
        }),
      ),
    ).toBe('not_found');
  });
});

describe('OpsAction: executed first, ledgered after, backfilled after a Notary outage', () => {
  it('an action is ledgered through the Notary with its verb and scope', async () => {
    const x = await seededProject();
    const applied = ok(await apply('hold', scopeOf(x.project)));
    expect(applied.action).toMatchObject({
      verb: 'control.hold',
      action_class: 'O-T',
      ledger_state: 'ledgered',
      backfilled: false,
    });
    const led = await s.record.pool.query(
      `SELECT entry_type, actor, body FROM ledger.ledger_entry WHERE entry_id = $1`,
      [applied.action.ledger_entry_id],
    );
    expect(led.rows[0]).toMatchObject({ entry_type: 'ops.action', actor: ALICE });
    expect(led.rows[0].body).toMatchObject({
      verb: 'control.hold',
      scope: { kind: 'project', ref: x.project },
      backfilled: false,
    });
    const lifted = ok(
      await liftControl(s.deps, {
        control_id: applied.control?.control_id as string,
        actor: ALICE,
        reason: 'r',
      }),
    );
    expect(lifted.action).toMatchObject({ verb: 'control.lift', ledger_state: 'ledgered' });
  });

  it('with the Notary unreachable the control is still in force and the action waits; the backfill ledgers it, marked', async () => {
    const x = await seededProject();
    const noLedger = { pool: s.record.pool, clock: s.clock };
    const id = await item(x);
    const applied = ok(await apply('hold', scopeOf(x.project), { deps: noLedger as never }));
    expect(applied.action.ledger_state).toBe('pending');
    // in force at once
    await driveWork(driverOver(s));
    expect((await st(id))?.holds[0]?.reason).toBe('control');
    expect((await readOpsAction(s.record.pool, applied.action.action_id))?.ledger_state).toBe(
      'pending',
    );
    // the Notary is back
    const r = await backfillOpsLedger(s.deps);
    expect(r.ledgered).toBeGreaterThanOrEqual(1);
    const after = await readOpsAction(s.record.pool, applied.action.action_id);
    expect(after).toMatchObject({ ledger_state: 'ledgered', backfilled: true });
    // once
    expect((await backfillOpsLedger(s.deps)).ledgered).toBe(0);
    const led = await s.record.pool.query(
      `SELECT body FROM ledger.ledger_entry WHERE entry_id = $1`,
      [after?.ledger_entry_id],
    );
    expect(led.rows[0].body.backfilled).toBe(true);
    // the control's own stream says what was done
    const evs = await s.record.pool.query(
      `SELECT type FROM record.record_event WHERE stream = $1`,
      [controlStream(applied.control?.control_id as string)],
    );
    expect(evs.rows.map((e) => e.type)).toEqual([CONTROL_EVENT.control_applied]);
  });
});

describe('banners', () => {
  it('are published by an action, shown until withdrawn or expired', async () => {
    const x = await seededProject();
    const exp = new Date(s.clock.now().getTime() + 3_600_000).toISOString();
    const b = ok(
      await publishBanner(s.deps, {
        actor: ALICE,
        scope: scopeOf(x.project),
        severity: 'warning',
        text: 'Deploys are paused until 15:00',
        expires_at: exp,
      }),
    );
    expect(b.action).toMatchObject({
      verb: 'banner.publish',
      action_class: 'O-N',
      ledger_state: 'ledgered',
    });
    expect(b.banner?.source).toBe(b.action.action_id);
    expect((await activeBanners(s.record.pool, s.clock.now())).map((q) => q.banner_id)).toContain(
      b.banner?.banner_id,
    );
    ok(await withdrawBanner(s.deps, { banner_id: b.banner?.banner_id as string, actor: ALICE }));
    expect(
      (await activeBanners(s.record.pool, s.clock.now())).map((q) => q.banner_id),
    ).not.toContain(b.banner?.banner_id);
    const b2 = ok(
      await publishBanner(s.deps, {
        actor: ALICE,
        scope: scopeOf(x.project),
        severity: 'info',
        text: 'x',
        expires_at: exp,
      }),
    );
    s.clock.advance(2 * 3_600_000);
    expect(
      (await activeBanners(s.record.pool, s.clock.now())).map((q) => q.banner_id),
    ).not.toContain(b2.banner?.banner_id);
    expect(
      err(
        await publishBanner(s.deps, {
          actor: ALICE,
          scope: scopeOf(x.project),
          severity: 'info',
          text: 'x',
          expires_at: new Date(0).toISOString(),
        }),
      ),
    ).toBe('invalid_input');
  });
});

describe('over HTTP: the PDP decides, over the resource of the scope', () => {
  let app: FastifyInstance;
  let url: string;
  let proj: Seeded;
  const TOKEN = 'ops-at-core-'.padEnd(32, 'x');
  beforeAll(async () => {
    await seedPrincipals(s.id.deps, ['ada', 'abe', 'zed']);
    await grantFleetRole(s.id.deps, 'ada', 'factory.admin');
    proj = await seededProject();
    await bindProject(s.id, proj.project, { admin: ['abe'], requesters: ['zed'] });
    const pdp = new Pdp({
      source: new StaticBundleSource(buildBundle()),
      entities: new IdentityPdpEntities({ pool: s.record.pool }),
      log: new RecordDecisionLog({ pool: s.record.pool }),
      clock: s.clock,
    });
    const callers: Record<string, readonly CoreScope[]> = {
      bff: ['read', 'ops'],
      reader: ['read'],
    };
    app = createCoreApp({
      pool: s.record.pool,
      auth: new ServiceAuth({ bff: TOKEN, reader: 'reader-at-core-'.padEnd(32, 'x') }),
      callers,
      registry: s.registry,
      clock: s.clock,
      pdp,
      config: s.config,
    });
    url = await listen(app);
  });
  afterAll(async () => {
    await app?.close();
  });
  const call = async (
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    token = TOKEN,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ): Promise<{ status: number; json: any }> => {
    const res = await fetch(new URL(path, url), {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const t = await res.text();
    return { status: res.status, json: t ? JSON.parse(t) : null };
  };
  const flow = async (who: string, scope: unknown, kind = 'hold') => {
    const p = await call('POST', '/v1/controls/preview', { on_behalf_of: who, kind, scope });
    if (p.status !== 201) return p;
    return call('POST', '/v1/controls', {
      on_behalf_of: who,
      kind,
      scope,
      preview_id: p.json.preview_id,
      nonce: p.json.nonce,
    });
  };

  it('the project admin controls the project; a requester and a stranger do not', async () => {
    const scope = { kind: 'project', ref: proj.project };
    expect((await flow('zed', scope)).status).toBe(403);
    expect((await flow('nobody', scope)).status).toBe(403);
    const ok1 = await flow('abe', scope);
    expect(ok1.status).toBe(201);
    expect(ok1.json.control).toMatchObject({ kind: 'hold', state: 'active' });
    const listed = await call('GET', `/v1/projects/${proj.project}/controls?on_behalf_of=abe`);
    expect(listed.json.controls.map((c: { control_id: string }) => c.control_id)).toContain(
      ok1.json.control.control_id,
    );
    const lift = await call('POST', `/v1/controls/${ok1.json.control.control_id}/lift`, {
      on_behalf_of: 'zed',
      reason: 'x',
    });
    expect(lift.status).toBe(403);
    expect(
      (
        await call('POST', `/v1/controls/${ok1.json.control.control_id}/lift`, {
          on_behalf_of: 'abe',
          reason: 'done',
        })
      ).status,
    ).toBe(200);
  });

  it('a fleet control is the factory admin only; a project admin cannot reach the fleet', async () => {
    const fleet = { kind: 'fleet', ref: '*' };
    expect((await flow('abe', fleet)).status).toBe(403);
    const r = await flow('ada', fleet, 'maintenance');
    expect(r.status).toBe(201);
    await call('POST', `/v1/controls/${r.json.control.control_id}/lift`, {
      on_behalf_of: 'ada',
      reason: 'x',
    });
  });

  it('needs the ops scope: a reader cannot preview', async () => {
    const r = await call(
      'POST',
      '/v1/controls/preview',
      { on_behalf_of: 'ada', kind: 'hold', scope: { kind: 'fleet', ref: '*' } },
      'reader-at-core-'.padEnd(32, 'x'),
    );
    expect(r.status).toBe(403);
  });

  it('banners: the project admin publishes for the project, not for the fleet', async () => {
    const exp = new Date(s.clock.now().getTime() + 3_600_000).toISOString();
    const body = (who: string, scope: unknown) => ({
      on_behalf_of: who,
      scope,
      severity: 'info',
      text: 'hello',
      expires_at: exp,
    });
    expect(
      (await call('POST', '/v1/banners', body('abe', { kind: 'project', ref: proj.project })))
        .status,
    ).toBe(201);
    expect(
      (await call('POST', '/v1/banners', body('abe', { kind: 'fleet', ref: '*' }))).status,
    ).toBe(403);
    expect(
      (await call('POST', '/v1/banners', body('ada', { kind: 'fleet', ref: '*' }))).status,
    ).toBe(201);
    expect(
      (await call('POST', '/v1/banners', body('zed', { kind: 'project', ref: proj.project })))
        .status,
    ).toBe(403);
  });
});
