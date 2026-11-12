import {
  S0_DEFAULT_FAILURE_MODEL,
  S0_EVENT,
  S0_CONFIG_KEYS,
  s0Stream,
  type OnboardingStepId,
} from '@aisdlc/contracts';
import { expectRebuildEqualsLive } from '@aisdlc/record/testing';
import { businessCalendar } from '@aisdlc/decisions';
import type { FakeGitHub } from '@aisdlc/ports';
import { readUnknown } from '@aisdlc/ports';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DEFAULT_S0_SETTINGS,
  FakeKnowledge,
  completeStep,
  coreProjection,
  driveS0,
  getRepo,
  readS0,
  requestOnboarding,
  resumeS0,
  s0DriverLoop,
  sendBackStep,
  withdrawS0,
  type DriveAction,
  type DriverDeps,
} from '../src/index.js';
import {
  driverDeps,
  fakeHost,
  pid,
  request,
  setHost,
  startCoreStack,
  type CoreStack,
} from '../src/testing.js';
import { ConfigRegistry } from '@aisdlc/config';
import { registerCoreConfig } from '../src/index.js';

// Scenario tests of the S0 step driver, one per failure edge, on real Postgres with a manual clock
// and fakes behind the code host and knowledge ports. 2026-11-09 is a Monday.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
});
afterAll(async () => {
  await s.stop();
});

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** 10:00 UTC on the Monday `week` weeks after 2026-11-09 (each test lives in its own week). */
const monday = (week: number): Date => new Date(Date.UTC(2026, 10, 9, 10) + week * 7 * 24 * HOUR);
let week = 0;
const nextWeek = (): Date => {
  week += 1;
  const t = monday(week);
  s.clock.set(t);
  return t;
};

let n = 0;
interface Scenario {
  id: string;
  repo: string;
  host: FakeGitHub;
  knowledge: FakeKnowledge;
  d: DriverDeps;
  go(): Promise<DriveAction>;
  events(
    type?: string,
  ): Promise<Array<{ type: string; body: Record<string, unknown>; at: string }>>;
  state(): ReturnType<typeof readS0>;
}

async function scenario(
  o: {
    level?: 'census' | 'light' | 'full';
    installed?: boolean;
    blank?: boolean;
    settings?: DriverDeps['settings'];
  } = {},
): Promise<Scenario> {
  n += 1;
  const repo = `acme/scn-${n}`;
  const host = fakeHost(
    o.installed === false ? {} : { installed: [repo], blank: o.blank ? [repo] : [] },
  );
  const knowledge = new FakeKnowledge();
  const r = await requestOnboarding(
    s.deps,
    request({ project_id: pid(`scn-${n}`), repo, level: o.level ?? 'census' }),
    // Full is only a level-up of a Light repo (user decision 2026-11-12): a Full scenario stands for that path
    o.level === 'full' ? { levelUp: { from_version: 1, from_level: 'light' } } : {},
  );
  if (!r.ok) throw new Error(r.error.message);
  const id = r.value.s0_id;
  const d = driverDeps(s, host, knowledge, o.settings ? { settings: o.settings } : {});
  return {
    id,
    repo,
    host,
    knowledge,
    d,
    go: async () => (await driveS0(d, id)).action,
    async events(type) {
      const q = await s.record.pool.query<{
        type: string;
        body: Record<string, unknown>;
        at: Date;
      }>(
        `SELECT type, body, occurred_at AS at FROM record.record_event
          WHERE stream = $1 ${type ? 'AND type = $2' : ''} ORDER BY seq`,
        type ? [s0Stream(id), type] : [s0Stream(id)],
      );
      return q.rows.map((x) => ({ type: x.type, body: x.body, at: x.at.toISOString() }));
    },
    state: () => readS0(s.record.pool, id),
  };
}

/** Drives until the record waits at a card (an instant knowledge). */
async function toCard(c: Scenario): Promise<void> {
  c.knowledge.auto = 'done';
  for (let i = 0; i < 8; i++) {
    await c.go();
    if ((await c.state())?.record.status === 'card') return;
  }
  throw new Error('never reached a card');
}

const cardsOf = async (c: Scenario) =>
  (await c.events(S0_EVENT.card_required)).map((e) => `${e.body['step']}:${e.body['card']}`);
const statusTrail = async (c: Scenario) =>
  (await c.events(S0_EVENT.status_changed)).map((e) => `${e.body['from']}>${e.body['to']}`);

describe('0.1 precondition: the App is installed on the repo (DEC-2)', () => {
  it('App not installed: status app, "0.1 waiting: App not installed", no job, items stay N8; then installed: the census runs', async () => {
    nextWeek();
    const c = await scenario({ installed: false });
    expect(await c.go()).toBe('waiting_app');
    let st = (await c.state())!;
    expect(st.record.status).toBe('app');
    expect(st.waiting).toBe('0.1 waiting: App not installed');
    expect(st.steps.get('0.1')?.state).toBe('todo');
    expect(c.knowledge.started).toEqual([]);
    // Waiting is recorded once, not on every tick.
    const before = (await c.events()).length;
    expect(await c.go()).toBe('waiting_app');
    expect(await c.go()).toBe('waiting_app');
    expect((await c.events()).length).toBe(before);
    // The code host was only read.
    expect(c.host.requests.every((r) => r.method === 'GET')).toBe(true);

    // The owner installs the App on that repo.
    setHost(c.host, { installed: [c.repo] });
    c.knowledge.auto = 'done';
    expect(await c.go()).toBe('job_pending'); // 0.1 starts
    st = (await c.state())!;
    expect(st.record.status).toBe('running');
    expect(st.waiting).toBeNull();
    expect(st.steps.get('0.1')?.state).toBe('running');
    expect(await c.go()).toBe('job_started');
    expect(c.knowledge.started).toEqual([c.repo]);
    expect(await c.go()).toBe('card_raised');
    st = (await c.state())!;
    expect(st.record.status).toBe('card');
    expect(st.steps.get('0.1')?.state).toBe('card');
    expect(await cardsOf(c)).toEqual(['0.1:C1']);
    expect(await statusTrail(c)).toEqual(['app>running', 'running>card']);
    // What the code host said of the repo is on the Repo.
    expect(await getRepo(s.record.pool, c.repo)).toMatchObject({
      visibility: 'private',
      owner_type: 'org',
      default_branch: 'main',
    });
  });

  it('an App that is suspended is waiting too', async () => {
    nextWeek();
    const c = await scenario();
    setHost(c.host, { installed: [c.repo], suspended: true });
    expect(await c.go()).toBe('waiting_app');
    expect((await c.state())?.waiting).toBe('0.1 waiting: App suspended');
  });

  it('a blank repo goes to starter, and runs on once it has a commit and a person resumes it', async () => {
    nextWeek();
    const c = await scenario({ blank: true });
    expect(await c.go()).toBe('job_pending');
    expect(await c.go()).toBe('starter');
    expect((await c.state())?.record.status).toBe('starter');
    expect(c.knowledge.started).toEqual([]);
    // Parked at starter: the driver does nothing more.
    expect(await c.go()).toBe('none');
    setHost(c.host, { installed: [c.repo] });
    await resumeS0(s.deps, c.id, { actor: 'alice', reason: 'starter merged' });
    c.knowledge.auto = 'done';
    expect(await c.go()).toBe('job_started');
    expect(await c.go()).toBe('card_raised');
    expect(await statusTrail(c)).toEqual([
      'app>running',
      'running>starter',
      'starter>running',
      'running>card',
    ]);
  });
});

describe('0.1 census and DEC-9 machine failures', () => {
  it('BLOCKED after 3 machine retries with a cause code (knowledge job error), then a person can resume', async () => {
    nextWeek();
    const c = await scenario();
    c.knowledge.auto = 'error';
    const seen: DriveAction[] = [];
    for (let i = 0; i < 40 && (await c.state())?.record.status !== 'blocked'; i++) {
      seen.push(await c.go());
      s.clock.advance(61_000); // past the retry delay
    }
    const st = (await c.state())!;
    expect(st.record.status).toBe('blocked');
    expect(st.steps.get('0.1')).toMatchObject({
      state: 'blocked',
      blocked_cause: 'knowledge.job_error',
    });
    const failures = await c.events(S0_EVENT.machine_failed);
    // The first failure and the three retries: four failed attempts, then BLOCKED.
    expect(failures.map((e) => e.body['attempt'])).toEqual([1, 2, 3, 4]);
    expect(failures.every((e) => e.body['cause'] === 'knowledge.job_error')).toBe(true);
    expect(c.knowledge.started.length).toBe(4);
    expect(seen).toContain('machine_failed');
    expect(seen.at(-1)).toBe('blocked');
    expect(await c.go()).toBe('none'); // blocked: nothing until a person acts

    // A person resumes: the step runs again from a clean count.
    c.knowledge.auto = 'done';
    await resumeS0(s.deps, c.id, { actor: 'alice', reason: 'knowledge fixed' });
    const after = (await c.state())!;
    expect(after.record.status).toBe('running');
    expect(after.steps.get('0.1')).toMatchObject({ state: 'running', failures: 0 });
    for (let i = 0; i < 4 && (await c.state())?.record.status !== 'card'; i++) await c.go();
    expect((await c.state())?.record.status).toBe('card');
  });

  it('a retry waits out the retry delay', async () => {
    nextWeek();
    const c = await scenario();
    c.knowledge.auto = 'error';
    await c.go(); // starts 0.1
    await c.go(); // job started (and errors)
    expect(await c.go()).toBe('machine_failed');
    expect(await c.go()).toBe('retry_wait');
    s.clock.advance(59_000);
    expect(await c.go()).toBe('retry_wait');
    s.clock.advance(2_000);
    expect(await c.go()).toBe('job_started');
  });

  it('codehost unreachable counts too: cause codehost.unreachable, BLOCKED after the retries, the record leaves app on the first failure', async () => {
    nextWeek();
    const c = await scenario();
    c.host.breakAll(readUnknown('network', 'codehost did not answer'));
    expect(await c.go()).toBe('machine_failed');
    expect((await c.state())?.record.status).toBe('running');
    for (let i = 0; i < 20 && (await c.state())?.record.status !== 'blocked'; i++) {
      s.clock.advance(61_000);
      await c.go();
    }
    const st = (await c.state())!;
    expect(st.record.status).toBe('blocked');
    expect(st.steps.get('0.1')?.blocked_cause).toBe('codehost.unreachable');
    expect(c.knowledge.started).toEqual([]);
    expect(await statusTrail(c)).toEqual(['app>running', 'running>blocked']);
  });

  it('a job that does not finish in its machine time box (30 min) is a machine failure', async () => {
    nextWeek();
    const c = await scenario();
    await c.go();
    expect(await c.go()).toBe('job_started');
    s.clock.advance(29 * MINUTE);
    expect(await c.go()).toBe('job_pending');
    s.clock.advance(2 * MINUTE);
    expect(await c.go()).toBe('machine_failed');
    const f = await c.events(S0_EVENT.machine_failed);
    expect(f[0]?.body).toMatchObject({ cause: 'machine.timebox', attempt: 1 });
    // The next attempt starts a new job.
    s.clock.advance(61_000);
    expect(await c.go()).toBe('job_started');
    expect(c.knowledge.started.length).toBe(2);
  });

  it('time boxes and the failure model are configuration: one retry, then BLOCKED', async () => {
    nextWeek();
    const c = await scenario({
      settings: () => ({
        ...DEFAULT_S0_SETTINGS,
        failure: {
          ...S0_DEFAULT_FAILURE_MODEL,
          machine_retries: 1,
          machine_retry_delay_seconds: 0,
        },
      }),
    });
    c.knowledge.auto = 'error';
    for (let i = 0; i < 12 && (await c.state())?.record.status !== 'blocked'; i++) await c.go();
    expect((await c.events(S0_EVENT.machine_failed)).length).toBe(2);
    expect((await c.state())?.record.status).toBe('blocked');
  });

  it('the census that does not belong to the job is a failure (census.missing)', async () => {
    nextWeek();
    const c = await scenario();
    await c.go();
    await c.go();
    const job = (await c.state())!.job!;
    c.knowledge.finish(job.job_id);
    // The newest census of the repo is another job's.
    c.knowledge.setCensus(c.repo, {
      census_id: 'census:x',
      census_hash: 'c'.repeat(64),
      job_id: 'another-job',
      b1_blocked: false,
      secrets_not_met: false,
    });
    expect(await c.go()).toBe('machine_failed');
    expect((await c.events(S0_EVENT.machine_failed))[0]?.body['cause']).toBe('census.missing');
  });

  it('an open secret lowers the signable level to Census and raises the security card too', async () => {
    nextWeek();
    const c = await scenario({ level: 'light' });
    c.knowledge.withCensus((repo, jobId) =>
      c.knowledge.censusFor(repo, { b1_blocked: true })(jobId),
    );
    await toCard(c);
    const st = (await c.state())!;
    expect(st.record).toMatchObject({ requested_level: 'light', signable_level: 'census' });
    expect(st.steps.get('0.2')?.state).toBe('skip');
    expect((await cardsOf(c)).sort()).toEqual(['0.1:C1', '0.1:SECR']);
    const lvl = await c.events(S0_EVENT.signable_level_set);
    expect(lvl[0]?.body).toMatchObject({
      requested_level: 'light',
      signable_level: 'census',
      reason: 'security.open_secret',
    });
    // The census itself is recorded on the stream.
    expect((await c.events(S0_EVENT.census_ready))[0]?.body).toMatchObject({ b1_blocked: true });
  });

  it('a write whose record changed under the driver is dropped (a withdraw during the job start)', async () => {
    nextWeek();
    const c = await scenario();
    await c.go();
    const original = c.knowledge.startCensus.bind(c.knowledge);
    c.knowledge.startCensus = async (repo) => {
      await withdrawS0(s.deps, c.id, { actor: 'alice' });
      return original(repo);
    };
    expect(await c.go()).toBe('stale');
    expect((await c.state())?.record.status).toBe('withdrawn');
    expect(await c.events(S0_EVENT.job_started)).toEqual([]);
  });
});

describe('0.2 to 0.5 advance to card-needed (DEC-3)', () => {
  it('Census: 0.2 and 0.3 are not requested; 0.4 (reduced), 0.5 and M4 always run', async () => {
    nextWeek();
    const c = await scenario({ level: 'census' });
    await toCard(c);
    await must(completeStep(s.deps, c.id, '0.1', { actor: 'alice' }));
    expect(await c.go()).toBe('card_raised');
    let st = (await c.state())!;
    expect(st.steps.get('0.4')?.state).toBe('card');
    await must(completeStep(s.deps, c.id, '0.4', { actor: 'alice' }));
    expect(await c.go()).toBe('card_raised');
    await must(completeStep(s.deps, c.id, '0.5', { actor: 'alice' }));
    st = (await c.state())!;
    expect(await cardsOf(c)).toEqual(['0.1:C1', '0.4:C4', '0.5:C5']);
    const c4 = (await c.events(S0_EVENT.card_required)).find((e) => e.body['card'] === 'C4');
    expect(c4?.body['reduced']).toBe(true);
    const steps = Object.fromEntries([...st.steps].map(([k, v]) => [k, v.state]));
    expect(steps).toEqual({
      '0.1': 'done',
      '0.2': 'skip',
      '0.3': 'skip',
      '0.4': 'done',
      '0.5': 'done',
    });
    // M4 is M7.5's: the driver stops here and never signs.
    expect(await c.go()).toBe('none');
    expect(st.record.status).toBe('running');
  });

  it('Full: every step raises its card in order, 0.4 is not reduced', async () => {
    nextWeek();
    const c = await scenario({ level: 'full' });
    await toCard(c);
    for (const step of ['0.1', '0.2', '0.3', '0.4'] as OnboardingStepId[]) {
      await must(completeStep(s.deps, c.id, step, { actor: 'alice' }));
      expect(await c.go()).toBe('card_raised');
    }
    expect(await cardsOf(c)).toEqual(['0.1:C1', '0.2:C2', '0.3:C3', '0.4:C4', '0.5:C5']);
    const c4 = (await c.events(S0_EVENT.card_required)).find((e) => e.body['card'] === 'C4');
    expect(c4?.body['reduced']).toBe(false);
  });
});

describe('DEC-9 human steps: one send-back, then rejected_at; PARK after 5 business days', () => {
  it('send back once (the card is raised again), a second reject is rejected_at:<step>; a restore starts the step fresh', async () => {
    nextWeek();
    const c = await scenario();
    await toCard(c);
    await must(completeStep(s.deps, c.id, '0.1', { actor: 'alice' }));
    await c.go(); // 0.4 card
    const limit = S0_DEFAULT_FAILURE_MODEL.send_backs_per_step;
    expect(
      await must(
        sendBackStep(s.deps, c.id, '0.4', { actor: 'alice', limit, reason: 'wrong owner' }),
      ),
    ).toEqual({
      outcome: 'sent_back',
      count: 1,
    });
    let st = (await c.state())!;
    expect(st.record.status).toBe('running');
    expect(st.steps.get('0.4')).toMatchObject({ state: 'running', send_backs: 1 });
    expect(await c.go()).toBe('card_raised'); // the factory re-drafts and raises the card again
    const raised = (await c.events(S0_EVENT.card_required)).filter((e) => e.body['card'] === 'C4');
    expect(raised.map((e) => e.body['occasion'])).toEqual(['first', 'again']);

    expect(await must(sendBackStep(s.deps, c.id, '0.4', { actor: 'alice', limit }))).toEqual({
      outcome: 'rejected',
      count: 2,
    });
    st = (await c.state())!;
    expect(st.record).toMatchObject({ status: 'rejected', rejected_at: '0.4' });
    expect(await c.go()).toBe('none');

    // Restore request: rejected -> running, the rejected step has a fresh allowance.
    await must(resumeS0(s.deps, c.id, { actor: 'alice', reason: 'restore' }));
    st = (await c.state())!;
    expect(st.record).toMatchObject({ status: 'running', rejected_at: null });
    expect(st.steps.get('0.4')).toMatchObject({ state: 'running', send_backs: 0 });
    expect(await c.go()).toBe('card_raised');
    expect(await statusTrail(c)).toEqual([
      'app>running',
      'running>card',
      'card>running',
      'running>card',
      'card>running',
      'running>card',
      'card>rejected',
      'rejected>running',
      'running>card',
    ]);
  });

  it('PARKs after 5 business days of silence at a human step, the reminder comes at 2 on 0.1, resume raises the card again', async () => {
    const t0 = nextWeek(); // Monday 10:00
    const c = await scenario();
    await toCard(c);
    const raisedAt = (await c.events(S0_EVENT.card_required))[0]!.at;
    expect(raisedAt).toBe(t0.toISOString());

    s.clock.set(new Date(t0.getTime() + 24 * HOUR)); // Tuesday 10:00
    expect(await c.go()).toBe('none');
    s.clock.set(new Date(t0.getTime() + 48 * HOUR - MINUTE)); // Wednesday 09:59
    expect(await c.go()).toBe('none');
    s.clock.set(new Date(t0.getTime() + 48 * HOUR)); // Wednesday 10:00: 2 business days
    expect(await c.go()).toBe('reminded');
    expect(await c.go()).toBe('none'); // once
    expect((await c.events(S0_EVENT.reminder))[0]?.body).toMatchObject({
      step: '0.1',
      due_at: new Date(t0.getTime() + 48 * HOUR).toISOString(),
    });

    s.clock.set(new Date(t0.getTime() + 7 * 24 * HOUR - MINUTE)); // next Monday 09:59: 4 bd + the weekend
    expect(await c.go()).toBe('none');
    expect((await c.state())?.record.status).toBe('card');
    s.clock.set(new Date(t0.getTime() + 7 * 24 * HOUR)); // next Monday 10:00: 5 business days
    expect(await c.go()).toBe('parked');
    const st = (await c.state())!;
    expect(st.record.status).toBe('parked');
    expect(st.steps.get('0.1')?.state).toBe('running');
    const trail = await c.events(S0_EVENT.status_changed);
    expect(
      trail.slice(-2).map((e) => `${e.body['from']}>${e.body['to']}:${e.body['cause']}`),
    ).toEqual(['card>running:transit', 'running>parked:park.timeout']);
    expect(await c.go()).toBe('none'); // parked: the driver leaves it

    // Resume (owner returns): the card is raised again and the silence clock starts over.
    await must(resumeS0(s.deps, c.id, { actor: 'alice' }));
    expect(await c.go()).toBe('card_raised');
    const raised = (await c.events(S0_EVENT.card_required)).filter((e) => e.body['card'] === 'C1');
    expect(raised.map((e) => e.body['occasion'])).toEqual(['first', 'again']);
    s.clock.advance(24 * HOUR);
    expect(await c.go()).toBe('none');
  });

  it('weekends and holidays are not business days: a card raised on a Friday parks the Friday after', async () => {
    const t0 = new Date(nextWeek().getTime() + 4 * 24 * HOUR); // Friday 10:00
    s.clock.set(t0);
    const c = await scenario();
    await toCard(c);
    s.clock.set(new Date(t0.getTime() + 7 * 24 * HOUR - MINUTE));
    expect(await c.go()).not.toBe('parked');
    s.clock.set(new Date(t0.getTime() + 7 * 24 * HOUR));
    expect(await c.go()).toBe('parked');

    // With the Monday after a holiday, the same silence takes a day longer.
    const t1 = new Date(t0.getTime() + 8 * 24 * HOUR); // Saturday after: start fresh the next Monday
    s.clock.set(new Date(t1.getTime() + 2 * 24 * HOUR)); // Monday 10:00
    const holiday = new Date(s.clock.nowMs() + 24 * HOUR).toISOString().slice(0, 10); // the Tuesday
    const h = await scenario({
      settings: () => ({
        ...DEFAULT_S0_SETTINGS,
        calendar: businessCalendar({ holidays: [holiday] }),
      }),
    });
    await toCard(h);
    const start = s.clock.nowMs();
    s.clock.set(new Date(start + 7 * 24 * HOUR));
    expect(await h.go()).not.toBe('parked');
    s.clock.set(new Date(start + 8 * 24 * HOUR));
    expect(await h.go()).toBe('parked');
  });

  it('the overall time box of 0.2 (10 business days) is recorded once, and changes nothing else', async () => {
    const t0 = nextWeek();
    const c = await scenario({
      level: 'light',
      // Never park in this scenario: only the time box is under test.
      settings: () => ({
        ...DEFAULT_S0_SETTINGS,
        failure: { ...S0_DEFAULT_FAILURE_MODEL, park_business_days: 60 },
      }),
    });
    await toCard(c);
    await must(completeStep(s.deps, c.id, '0.1', { actor: 'alice' }));
    expect(await c.go()).toBe('card_raised'); // 0.2
    const started = s.clock.nowMs();
    s.clock.set(new Date(started + 13 * 24 * HOUR)); // < 10 business days (the weekends)
    expect(await c.go()).toBe('none');
    s.clock.set(new Date(started + 14 * 24 * HOUR)); // 10 business days
    expect(await c.go()).toBe('overdue');
    expect(await c.go()).toBe('none');
    expect((await c.events(S0_EVENT.timebox_exceeded))[0]?.body).toMatchObject({
      step: '0.2',
      overall_business_days: 10,
    });
    expect((await c.state())?.record.status).toBe('card');
    void t0;
  });
});

describe('the driver loop and the read model', () => {
  it('the loop drives every active record and skips the rest', async () => {
    nextWeek();
    const a = await scenario();
    const b = await scenario({ installed: false });
    const done = await scenario();
    await withdrawS0(s.deps, done.id, { actor: 'alice' });
    a.knowledge.auto = 'done';
    const outcomes: string[] = [];
    // One loop over the shared record database; each scenario has its own fakes, so the loop gets a
    // host that has every repo and one knowledge.
    const host = fakeHost({ installed: [a.repo] });
    const knowledge = a.knowledge;
    const spec = s0DriverLoop(driverDeps(s, host, knowledge), {
      onOutcome: (o) => outcomes.push(`${o.s0_id}:${o.action}`),
    });
    let failed = 0;
    await spec.tick({
      name: 's0_driver',
      log: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      async eachItem(items, label, fn) {
        for (const it of items) {
          try {
            await fn(it);
          } catch {
            failed += 1;
            void label;
          }
        }
      },
    });
    expect(failed).toBe(0);
    expect(outcomes.some((o) => o.startsWith(`${a.id}:`))).toBe(true);
    expect(outcomes.some((o) => o.startsWith(`${b.id}:waiting_app`))).toBe(true);
    expect(outcomes.some((o) => o.startsWith(`${done.id}:`))).toBe(false);
  });

  it('the loop drives records even when nobody observes the outcomes', async () => {
    nextWeek();
    const c = await scenario();
    const spec = s0DriverLoop(c.d);
    await spec.tick({
      name: 's0_driver',
      log: { info() {}, warn() {}, error() {} },
      signal: new AbortController().signal,
      async eachItem(items, _label, fn) {
        for (const it of items) await fn(it);
      },
    });
    // The first tick of a record whose App is installed starts 0.1.
    expect((await c.state())?.record.status).toBe('running');
  });

  it('every transition is a record event, and the read model rebuilds equal to live', async () => {
    const snap = await expectRebuildEqualsLive(s.record.pool, coreProjection);
    expect(snap.s0_steps.length).toBeGreaterThanOrEqual(5 * snap.s0_records.length);
    const live = await s.record.pool.query(
      `SELECT count(*)::int AS n FROM core.s0_record r
        WHERE r.waiting IS NOT NULL OR r.status IN ('parked', 'blocked', 'rejected', 'starter')`,
    );
    expect(live.rows[0].n).toBeGreaterThan(3);
  });

  it('registers the S0 tunables with their defaults, and refuses a value that does not fit', async () => {
    const reg = registerCoreConfig(new ConfigRegistry());
    expect(reg.get(S0_CONFIG_KEYS.failure_model)?.default).toEqual(S0_DEFAULT_FAILURE_MODEL);
    expect(
      reg.validate('factory', {
        [S0_CONFIG_KEYS.failure_model]: { ...S0_DEFAULT_FAILURE_MODEL, park_business_days: 0 },
      }),
    ).toMatchObject({ ok: false, error: { code: 'invalid_value' } });
    expect(reg.validate('factory', { [S0_CONFIG_KEYS.timeboxes]: { '0.1': {} } }).ok).toBe(false);
    // Core's own keys are factory-only; a project may not set them (the project settings keys it may).
    expect(
      reg.validate('project', { [S0_CONFIG_KEYS.failure_model]: S0_DEFAULT_FAILURE_MODEL }),
    ).toMatchObject({ ok: false, error: { code: 'not_overridable' } });
  });
});

async function must<T>(
  p: Promise<{ ok: true; value: T } | { ok: false; error: { message: string } }>,
): Promise<T> {
  const r = await p;
  if (!r.ok) throw new Error(r.error.message);
  return r.value;
}
