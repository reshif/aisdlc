import { S0_EVENT, s0Stream, type OnboardingStatus } from '@aisdlc/contracts';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DbRegisteredRepos,
  FakeKnowledge,
  activeS0Ids,
  catchUp,
  completeStep,
  coreProjection,
  driveS0,
  getProject,
  getProjectState,
  getRepo,
  getS0Overview,
  listS0ForRepo,
  readS0,
  recordSigned,
  requestOnboarding,
  resumeS0,
  sendBackStep,
  setSignableLevel,
  withdrawS0,
} from '../src/index.js';
import {
  driverDeps,
  fakeHost,
  pid,
  request,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});

const req = (over: Parameters<typeof request>[0] = {}) => requestOnboarding(s.deps, request(over));

async function must<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
) {
  const r = await p;
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}

/** Drives a record with a working host and an instant knowledge until it waits at a card. */
async function toCard(id: string, repo = 'acme/app') {
  const host = fakeHost({ installed: [repo] });
  const knowledge = new FakeKnowledge();
  knowledge.auto = 'done';
  const d = driverDeps(s, host, knowledge);
  for (let i = 0; i < 6; i++) {
    await driveS0(d, id);
    if ((await readS0(s.record.pool, id))?.record.status === 'card') return;
  }
  throw new Error('no card');
}

describe('project.onboard intake (DEC-2)', () => {
  it('records the intake event; the S0 record stores s0_ref = record:<intake event>, its own UUID and the catalogue pin', async () => {
    const r = await must(req({ project_id: pid('p-intake'), repo: 'acme/intake', level: 'light' }));
    expect(r.project_created).toBe(true);
    expect(r.s0_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7/);
    const ev = await s.record.pool.query<{ event_id: string; type: string; seq: string }>(
      'SELECT event_id, type, seq::text FROM record.record_event WHERE stream = $1 ORDER BY seq',
      [s0Stream(r.s0_id)],
    );
    expect(ev.rows[0]?.type).toBe(S0_EVENT.requested);
    expect(r.s0_ref).toBe(`record:${ev.rows[0]?.event_id}`);

    const s0 = (await readS0(s.record.pool, r.s0_id))!;
    expect(s0.record).toMatchObject({
      s0_id: r.s0_id,
      project_id: 'p-intake',
      repo_id: 'acme.intake',
      status: 'app',
      requested_level: 'light',
      signable_level: 'light',
      intake_ref: r.s0_ref,
      rejected_at: null,
    });
    expect(s0.record.catalogue_ref.hash).toMatch(/^[0-9a-f]{64}$/);
    // The S0 record's UUID is a gate subject, not a delivery item: nothing in the work-item family.
    expect(s0Stream(r.s0_id).startsWith('s0:')).toBe(true);
  });

  it('records 0.2 and 0.3 as not requested unless the level asks for them (DEC-3)', async () => {
    const skips = async (level: 'census' | 'light' | 'full', n: string) => {
      const r = await must(req({ project_id: pid(`p-${n}`), repo: `acme/${n}`, level }));
      const o = (await getS0Overview(s.record.pool, r.s0_id))!;
      return Object.fromEntries(o.steps.map((x) => [x.step, x.state]));
    };
    expect(await skips('census', 'lvl-c')).toEqual({
      '0.1': 'todo',
      '0.2': 'skip',
      '0.3': 'skip',
      '0.4': 'todo',
      '0.5': 'todo',
    });
    expect(await skips('light', 'lvl-l')).toMatchObject({ '0.2': 'todo', '0.3': 'skip' });
    expect(await skips('full', 'lvl-f')).toMatchObject({ '0.2': 'todo', '0.3': 'todo' });
  });

  it('registers the project and repo as streams with read models; a second repo reuses the project', async () => {
    await must(req({ project_id: pid('p-two'), repo: 'acme/two-a', name: 'Two' }));
    const second = await must(
      req({ project_id: pid('p-two'), repo: 'acme/two-b', name: 'Ignored' }),
    );
    expect(second.project_created).toBe(false);
    expect(await getProject(s.record.pool, 'p-two')).toMatchObject({
      project_id: 'p-two',
      name: 'Two',
      team_id: null,
      classification: 'internal',
      tier: null,
      level: null,
    });
    expect(await getRepo(s.record.pool, 'ACME/Two-A')).toMatchObject({
      repo_id: 'acme.two-a',
      repo_ref: 'acme/two-a',
      project_id: 'p-two',
      host: 'github.com',
      visibility: null,
      default_branch: null,
      onboarding_level: 'none',
    });
    await catchUp(s.record.pool);
    const rows = await s.record.pool.query(
      "SELECT project_id, repo_ref FROM core.repo WHERE project_id = 'p-two' ORDER BY repo_ref",
    );
    expect(rows.rows).toEqual([
      { project_id: 'p-two', repo_ref: 'acme/two-a' },
      { project_id: 'p-two', repo_ref: 'acme/two-b' },
    ]);
  });

  it('refuses a repo that belongs to another project, and writes nothing', async () => {
    await must(req({ project_id: pid('p-own'), repo: 'acme/owned' }));
    const before = await s.record.pool.query('SELECT count(*)::int AS n FROM record.record_event');
    const r = await req({ project_id: pid('p-thief'), repo: 'Acme/Owned' });
    expect(r).toMatchObject({ ok: false, error: { code: 'conflict' } });
    const after = await s.record.pool.query('SELECT count(*)::int AS n FROM record.record_event');
    expect(after.rows[0]).toEqual(before.rows[0]);
    expect(await getProject(s.record.pool, 'p-thief')).toBeNull();
  });

  it('attestations are raise-only: a later one never lowers an earlier one', async () => {
    await must(
      req({
        project_id: pid('p-att'),
        repo: 'acme/att',
        attestations: { classification: 'confidential', tier_floor: 'T2', deploys: true },
      }),
    );
    await must(
      req({ project_id: pid('p-att'), repo: 'acme/att2', attestations: { tier_floor: 'T1' } }),
    );
    const st = (await getProjectState(s.record.pool, 'p-att'))!;
    expect(st.attestations).toEqual({
      classification: 'confidential',
      tier_floor: 'T2',
      deploys: true,
    });
    expect(st.project).toMatchObject({ classification: 'confidential', deploys: true, tier: null });
  });

  it('a request_id makes a retry the same record', async () => {
    const request_id = '0190c9a0-0000-7000-8000-0000000000a1';
    const a = await must(req({ project_id: pid('p-retry'), repo: 'acme/retry', request_id }));
    const b = await must(req({ project_id: pid('p-retry'), repo: 'acme/retry', request_id }));
    expect(b).toMatchObject({ s0_id: a.s0_id, s0_ref: a.s0_ref, duplicate: true });
    expect((await listS0ForRepo(s.record.pool, 'acme/retry')).length).toBe(1);
    expect(
      await req({ project_id: pid('p-retry'), repo: 'acme/retry', request_id, level: 'full' }),
    ).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});

describe('S0 state machine (contracts states/onboarding.ts, exactly)', () => {
  it('a newer S0 record for the same repo supersedes the old one, also when the old one waits at a card', async () => {
    const a = await must(req({ project_id: pid('p-sup'), repo: 'acme/sup' }));
    await toCard(a.s0_id, 'acme/sup');
    expect((await readS0(s.record.pool, a.s0_id))?.record.status).toBe('card');

    const b = await must(req({ project_id: pid('p-sup'), repo: 'acme/sup', level: 'light' }));
    expect(b.superseded).toEqual([a.s0_id]);
    const old = (await readS0(s.record.pool, a.s0_id))!;
    expect(old.record.status).toBe('superseded');
    // `card` has no edge to `superseded`: the record went through `running`, both edges recorded.
    const trail = await s.record.pool.query<{ payload: { from: string; to: string } }>(
      `SELECT body AS payload FROM record.record_event
        WHERE stream = $1 AND type = $2 ORDER BY seq`,
      [s0Stream(a.s0_id), S0_EVENT.status_changed],
    );
    const edges = trail.rows.map((r) => `${r.payload.from}>${r.payload.to}`);
    expect(edges.slice(-2)).toEqual(['card>running', 'running>superseded']);
    expect((await readS0(s.record.pool, b.s0_id))?.record.status).toBe('app');
    // A superseded record is over: it cannot be withdrawn or resumed.
    expect(await withdrawS0(s.deps, a.s0_id, { actor: 'alice' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    expect(await resumeS0(s.deps, a.s0_id, { actor: 'alice' })).toMatchObject({ ok: false });
    // Newest first.
    const list = await listS0ForRepo(s.record.pool, 'acme/sup');
    expect(list.map((o) => o.record.s0_id)).toEqual([b.s0_id, a.s0_id]);
  });

  it('a finished (done or withdrawn) record is not superseded', async () => {
    const a = await must(req({ project_id: pid('p-keep'), repo: 'acme/keep' }));
    await must(withdrawS0(s.deps, a.s0_id, { actor: 'alice', reason: 'changed my mind' }));
    const b = await must(req({ project_id: pid('p-keep'), repo: 'acme/keep' }));
    expect(b.superseded).toEqual([]);
    expect((await readS0(s.record.pool, a.s0_id))?.record.status).toBe('withdrawn');
  });

  it('withdraw works from every state the machine allows, is idempotent, and refuses a done record', async () => {
    const mk = async (n: string) =>
      (await must(req({ project_id: pid(`p-w-${n}`), repo: `acme/w-${n}` }))).s0_id;
    // app
    const app = await mk('app');
    expect(await must(withdrawS0(s.deps, app, { actor: 'alice' }))).toEqual({
      status: 'withdrawn',
      changed: true,
    });
    expect(await must(withdrawS0(s.deps, app, { actor: 'alice' }))).toEqual({
      status: 'withdrawn',
      changed: false,
    });
    // card
    const card = await mk('card');
    await toCard(card, 'acme/w-card');
    await must(withdrawS0(s.deps, card, { actor: 'alice' }));
    expect((await readS0(s.record.pool, card))?.record.status).toBe('withdrawn');
    // unknown
    expect(
      await withdrawS0(s.deps, '0190c9a0-0000-7000-8000-0000000000ff', { actor: 'a' }),
    ).toMatchObject({
      ok: false,
      error: { code: 'not_found' },
    });
  });

  it('the card layer hands back: send-back once, a second one rejects; completing a step returns to running', async () => {
    const a = await must(req({ project_id: pid('p-card'), repo: 'acme/cardflow' }));
    // Nothing is waiting at a card yet: refused.
    expect(await sendBackStep(s.deps, a.s0_id, '0.1', { actor: 'alice', limit: 1 })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    await toCard(a.s0_id, 'acme/cardflow');
    expect(await must(sendBackStep(s.deps, a.s0_id, '0.1', { actor: 'alice', limit: 1 }))).toEqual({
      outcome: 'sent_back',
      count: 1,
    });
    expect((await readS0(s.record.pool, a.s0_id))?.record.status).toBe('running');
    // completeStep needs a card too.
    expect(await completeStep(s.deps, a.s0_id, '0.1', { actor: 'alice' })).toMatchObject({
      ok: false,
    });
  });

  it('signable level is recorded next to the requested one, never above it', async () => {
    const a = await must(req({ project_id: pid('p-sign'), repo: 'acme/sign', level: 'full' }));
    const low = await must(
      setSignableLevel(s.deps, a.s0_id, 'light', { actor: 'alice', reason: 'human' }),
    );
    expect(low.record).toMatchObject({ requested_level: 'full', signable_level: 'light' });
    expect(low.steps.get('0.3')?.state).toBe('skip');
    expect(low.steps.get('0.2')?.state).toBe('todo');
    const b = await must(req({ project_id: pid('p-sign2'), repo: 'acme/sign2', level: 'light' }));
    expect(
      await setSignableLevel(s.deps, b.s0_id, 'full', { actor: 'alice', reason: 'human' }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_input' } });
  });

  it('every status of the machine is reachable only along its edges: illegal transitions are refused', async () => {
    const a = await must(req({ project_id: pid('p-illegal'), repo: 'acme/illegal' }));
    // `app` cannot be resumed (it is not blocked, parked, starter or rejected).
    expect(await resumeS0(s.deps, a.s0_id, { actor: 'alice' })).toMatchObject({
      ok: false,
      error: { code: 'conflict' },
    });
    // A withdrawn record has no way out.
    await must(withdrawS0(s.deps, a.s0_id, { actor: 'alice' }));
    expect(await resumeS0(s.deps, a.s0_id, { actor: 'alice' })).toMatchObject({ ok: false });
    const st = (await readS0(s.record.pool, a.s0_id))!;
    expect(st.record.status).toBe('withdrawn');
    const statuses = new Set<OnboardingStatus>();
    const evs = await s.record.pool.query<{ body: { to: OnboardingStatus } }>(
      'SELECT body FROM record.record_event WHERE stream = $1 AND type = $2',
      [s0Stream(a.s0_id), S0_EVENT.status_changed],
    );
    for (const e of evs.rows) statuses.add(e.body.to);
    expect([...statuses]).toEqual(['withdrawn']);
  });
});

describe('what M4 signs (written by M7.5)', () => {
  it('records the project tier and level and the repo level; never above the signable level, never below an attested floor', async () => {
    const a = await must(
      req({
        project_id: pid('p-signed'),
        repo: 'acme/signed',
        level: 'full',
        attestations: { tier_floor: 'T1' },
      }),
    );
    await must(setSignableLevel(s.deps, a.s0_id, 'light', { actor: 'alice', reason: 'human' }));
    const signed = (level: 'census' | 'light' | 'full', tier: 'T0' | 'T1' | 'T2') =>
      recordSigned(s.deps, { s0_id: a.s0_id, tier, level, actor: 'alice' });
    // Requested full, signable light: signing full is refused, and so is a tier below the attested floor.
    expect(await signed('full', 'T1')).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await signed('light', 'T0')).toMatchObject({ ok: false, error: { code: 'refused' } });
    expect(await getProject(s.record.pool, 'p-signed')).toMatchObject({ tier: null, level: null });
    // Signing below what was requested is allowed, and both stay on the record.
    await must(signed('census', 'T1'));
    await must(signed('light', 'T2'));
    expect(await getProject(s.record.pool, 'p-signed')).toMatchObject({
      tier: 'T2',
      level: 'light',
    });
    expect(await getRepo(s.record.pool, 'acme/signed')).toMatchObject({
      onboarding_level: 'light',
    });
    expect((await readS0(s.record.pool, a.s0_id))?.record).toMatchObject({
      requested_level: 'full',
      signable_level: 'light',
    });
    // A withdrawn record signs nothing.
    await must(withdrawS0(s.deps, a.s0_id, { actor: 'alice' }));
    expect(await signed('light', 'T2')).toMatchObject({ ok: false, error: { code: 'conflict' } });
  });
});

describe('registered repos (P-MUST-3)', () => {
  it('lists the repos that have a live or finished S0 record, and not withdrawn or superseded ones', async () => {
    const port = new DbRegisteredRepos(s.record.pool);
    const a = await must(req({ project_id: pid('p-reg'), repo: 'acme/reg-live' }));
    const b = await must(req({ project_id: pid('p-reg'), repo: 'acme/reg-gone' }));
    await must(withdrawS0(s.deps, b.s0_id, { actor: 'alice' }));
    const r = await port.list();
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toContainEqual({ project_id: 'p-reg', repo: 'acme/reg-live' });
    expect(r.value.map((x) => x.repo)).not.toContain('acme/reg-gone');
    expect(a.s0_id).toBeTruthy();
  });

  it('fails closed when the database cannot be read', async () => {
    const dead = { query: async () => Promise.reject(new Error('down')) } as never;
    const r = await new DbRegisteredRepos(dead).list();
    expect(r).toMatchObject({ ok: false, error: { code: 'unavailable' } });
  });
});

describe('the core read model', () => {
  it('rebuilds equal to live, and a record row equals what its stream folds to', async () => {
    const snap = await expectRebuildEqualsLive(s.record.pool, coreProjection);
    expect(snap.s0_records.length).toBeGreaterThan(5);
    expect(snap.projects.length).toBeGreaterThan(5);
    // The table row of a record equals what its stream folds to.
    const ids = await activeS0Ids(s.record.pool);
    for (const id of ids.slice(0, 3)) {
      const row = await s.record.pool.query(
        'SELECT status, requested_level FROM core.s0_record WHERE s0_id = $1',
        [id],
      );
      const live = (await readS0(s.record.pool, id))!;
      expect(row.rows[0]).toEqual({
        status: live.record.status,
        requested_level: live.record.requested_level,
      });
    }
  });
});
