import {
  InboundFactPayload,
  ProjectId,
  inboundFactStream,
  type CodeHostRead,
} from '@aisdlc/contracts';
import { withTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { FakeGitHub, FakeRegisteredRepos, readUnknown, type CodeHostSeed } from '@aisdlc/ports';
import { contractSeed } from '@aisdlc/ports/testing';
import { migrateRecord, verifyChain } from '@aisdlc/record';
import { describe, expect, it } from 'vitest';
import {
  FakeWorkInFlight,
  LoopSupervisor,
  defaultBranchHeadLoop,
  effectiveRulesLoop,
  installationLoop,
  recordObservation,
  type PollSource,
} from '../src/index.js';
import { ManualScheduler } from '../src/testing.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const SHA = (c: string) => c.repeat(40);

async function withDb<T>(fn: (t: TestDatabase) => Promise<T>): Promise<T> {
  return withTestDatabase(async (t) => {
    await migrateRecord(t.pool);
    return fn(t);
  });
}

async function facts(t: TestDatabase, kind: string, repo: string) {
  const r = await t.pool.query(
    'SELECT seq::text, idempotency_key, body, occurred_at FROM record.record_event WHERE stream = $1 ORDER BY seq',
    [inboundFactStream(kind as 'default_branch_head', repo)],
  );
  return r.rows.map((x) => ({
    seq: Number(x.seq),
    key: x.idempotency_key as string,
    at: (x.occurred_at as Date).toISOString(),
    body: InboundFactPayload.parse(x.body),
  }));
}

const withHead = (seed: CodeHostSeed, repo: string, branch: string, sha: string): CodeHostSeed => ({
  ...seed,
  heads: seed.heads.map((h) => (h.repo === repo && h.branch === branch ? { ...h, sha } : h)),
});

/** Waits (real time) for `cond`: the poll ticks do database I/O. */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  const until = Date.now() + 10_000;
  while (!cond()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function rig(t: TestDatabase) {
  const sched = new ManualScheduler('2026-11-08T00:00:00.000Z');
  const gh = new FakeGitHub(contractSeed());
  const registered = new FakeRegisteredRepos().set([
    { project_id: 'acme', repo: 'acme/app' },
    { project_id: 'acme', repo: 'acme/lib' },
  ]);
  const lines: string[] = [];
  const sup = new LoopSupervisor({
    clock: sched.clock,
    sleep: sched.sleep,
    log: (l) => lines.push(l),
    stopTimeoutMs: 100,
  });
  const base = { pool: t.pool, registered, clock: sched.clock };
  /** Advance and wait until every loop is sleeping again. */
  sched.isBusy = () => sup.busy;
  const advance = (ms: number) => sched.advance(ms);
  return { sched, gh, registered, sup, base, lines, advance };
}

describe('default-branch head poll', () => {
  it('writes a fact only when the head changed; a revert is a new fact; the chain stays valid', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      const outcomes: string[] = [];
      const spec = defaultBranchHeadLoop(
        { ...r.base, source: r.gh },
        { onOutcome: (_k, repo, o) => outcomes.push(`${repo}:${o}`) },
      );
      const sup = new LoopSupervisor({
        clock: r.sched.clock,
        sleep: r.sched.sleep,
        log: () => undefined,
      });
      sup.add(spec);
      sup.start();
      await waitFor(() => sup.metrics()[0]?.ticks_ok === 1, 'first tick');
      expect((await facts(t, 'default_branch_head', 'acme/app')).map((f) => f.body.value)).toEqual([
        { branch: 'main', sha: SHA('a') },
      ]);

      // Unchanged: ten minutes later, nothing is written.
      await r.sched.advance(10 * MIN);
      await waitFor(() => sup.metrics()[0]?.ticks_ok === 2, 'second tick');
      expect(await facts(t, 'default_branch_head', 'acme/app')).toHaveLength(1);
      expect(outcomes.filter((o) => o.endsWith('unchanged')).length).toBe(2); // app and lib

      // Changed, then changed back: three facts, three distinct keys, linked by previous_hash.
      r.gh.load(withHead(contractSeed(), 'acme/app', 'main', SHA('b')));
      await r.sched.advance(10 * MIN);
      await waitFor(() => sup.metrics()[0]?.ticks_ok === 3, 'third tick');
      r.gh.load(contractSeed());
      await r.sched.advance(10 * MIN);
      await waitFor(() => sup.metrics()[0]?.ticks_ok === 4, 'fourth tick');
      const all = await facts(t, 'default_branch_head', 'acme/app');
      expect(all.map((f) => (f.body.value as { sha: string }).sha)).toEqual([
        SHA('a'),
        SHA('b'),
        SHA('a'),
      ]);
      expect(new Set(all.map((f) => f.key)).size).toBe(3);
      expect(all[0]?.body.previous_hash).toBeNull();
      expect(all[1]?.body.previous_hash).toBe(all[0]?.body.value_hash);
      expect(all[2]?.body.previous_hash).toBe(all[1]?.body.value_hash);
      expect(
        all.every((f) => f.body.poll_interval_ms === 10 * MIN && f.body.project_id === 'acme'),
      ).toBe(true);
      expect(
        (await verifyChain(t.pool, inboundFactStream('default_branch_head', 'acme/app'))).valid,
      ).toBe(true);
      // acme/lib never changed: one fact.
      expect(await facts(t, 'default_branch_head', 'acme/lib')).toHaveLength(1);
      await sup.stop();
    });
  });

  it('latency equals the poll interval: a change is seen at the next tick, not before', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      r.sup.add(defaultBranchHeadLoop({ ...r.base, source: r.gh }));
      r.sup.start();
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 1, 'first tick');
      await r.advance(MIN); // t = 1 min: the push happens
      r.gh.load(withHead(contractSeed(), 'acme/app', 'main', SHA('c')));
      await r.advance(8 * MIN + 59_000); // t = 9:59: not yet
      expect(await facts(t, 'default_branch_head', 'acme/app')).toHaveLength(1);
      await r.advance(1_000); // t = 10:00: the tick
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 2, 'second tick');
      const all = await facts(t, 'default_branch_head', 'acme/app');
      expect(all).toHaveLength(2);
      expect(all[1]?.at).toBe('2026-11-08T00:10:00.000Z');
      await r.sup.stop();
    });
  });

  it('polls registered repos only, rereads the registry each tick, and refuses to poll when it cannot be read', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      r.registered.set([{ project_id: 'acme', repo: 'acme/app' }]);
      r.sup.add(defaultBranchHeadLoop({ ...r.base, source: r.gh }));
      r.sup.start();
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 1, 'first tick');
      expect(await facts(t, 'default_branch_head', 'acme/lib')).toHaveLength(0);
      expect(r.gh.requests.some((q) => q.path.includes('acme/lib'))).toBe(false);
      // A repo registered later is polled at the next tick; `poke` makes that now.
      r.registered.add('acme', 'acme/lib');
      r.sup.poke('default_branch_head');
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 2, 'poked tick');
      expect(await facts(t, 'default_branch_head', 'acme/lib')).toHaveLength(1);
      // An unreadable registry: the tick fails and no request is made for anyone.
      r.registered.breakIt();
      const before = r.gh.requests.length;
      r.sup.poke('default_branch_head');
      await waitFor(() => r.sup.metrics()[0]?.ticks_failed === 1, 'failed tick');
      expect(r.gh.requests.length).toBe(before);
      expect(r.sup.health().loops[0]?.last_error).toMatch(/registry/);
      await r.sup.stop();
    });
  });

  it('a repo that cannot be read fails its own item only; the others are recorded and the loop turns unhealthy past N', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      const poisoned: PollSource = {
        list_repos: () => r.gh.list_repos(),
        installation: () => r.gh.installation(),
        rules_for_branch: (q) => r.gh.rules_for_branch(q),
        branch_head: async (q): Promise<CodeHostRead<string>> =>
          q.repo === 'acme/app' ? readUnknown('network', 'cannot reach') : r.gh.branch_head(q),
      };
      r.sup.add(defaultBranchHeadLoop({ ...r.base, source: poisoned }, { intervalMs: 10 * MIN }));
      // A second, independent loop keeps going.
      r.sup.add(installationLoop({ ...r.base, source: r.gh }, { intervalMs: 10 * MIN }));
      r.sup.start();
      await waitFor(
        () => r.sup.metrics().every((m) => m.ticks_failed + m.ticks_ok >= 1),
        'first ticks',
      );
      expect(await facts(t, 'default_branch_head', 'acme/lib')).toHaveLength(1);
      expect(await facts(t, 'default_branch_head', 'acme/app')).toHaveLength(0);
      expect(r.sup.metrics().find((m) => m.name === 'default_branch_head')).toMatchObject({
        items_ok: 1,
        items_failed: 1,
      });
      // Healthy until the failure has lasted longer than 3 intervals.
      expect(r.sup.health().status).toBe('ok');
      for (let i = 0; i < 4; i++) await r.advance(10 * MIN);
      const h = r.sup.health();
      expect(h.status).toBe('unhealthy');
      expect(Object.fromEntries(h.loops.map((l) => [l.name, l.state]))).toEqual({
        default_branch_head: 'failing',
        installation: 'ok',
      });
      expect(h.loops[0]?.last_error).toContain('acme/app');
      await r.sup.stop();
    });
  });

  it('two workers that see the same change write one event', async () => {
    await withDb(async (t) => {
      const obs = {
        kind: 'default_branch_head' as const,
        repo: 'acme/app',
        project_id: ProjectId.parse('acme'),
        value: { branch: 'main', sha: SHA('a') },
        poll_interval_ms: 600_000,
      };
      const out = await Promise.all(
        Array.from({ length: 6 }, () => recordObservation(t.pool, obs)),
      );
      expect(out.filter((o) => o === 'recorded')).toHaveLength(1);
      expect(await facts(t, 'default_branch_head', 'acme/app')).toHaveLength(1);
      const next = { ...obs, value: { branch: 'main', sha: SHA('b') } };
      const out2 = await Promise.all(
        Array.from({ length: 6 }, () => recordObservation(t.pool, next)),
      );
      expect(out2.filter((o) => o === 'recorded')).toHaveLength(1);
      expect(await facts(t, 'default_branch_head', 'acme/app')).toHaveLength(2);
    });
  });

  it('writes nothing when the host cannot answer (no news is not a fact)', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      r.gh.breakAll(readUnknown('rate_limited', 'slow down'));
      r.sup.add(defaultBranchHeadLoop({ ...r.base, source: r.gh }));
      r.sup.start();
      await waitFor(() => r.sup.metrics()[0]?.ticks_failed === 1, 'failed tick');
      expect(
        (await t.pool.query('SELECT count(*)::int AS n FROM record.record_event')).rows[0].n,
      ).toBe(0);
      await r.sup.stop();
    });
  });
});

describe('installation poll', () => {
  it('records the installation and each repo, and a change of scope or permissions', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      r.sup.add(installationLoop({ ...r.base, source: r.gh }));
      r.sup.start();
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 1, 'first tick');
      const first = (await facts(t, 'installation', 'acme/app'))[0];
      expect(first?.body.value).toMatchObject({
        installation: {
          installation_id: 4242,
          permissions: { contents: 'read', metadata: 'read', statuses: 'write' },
        },
        repo: { default_branch: 'main', private: true },
      });
      // The installation gains a permission: every registered repo gets a fact.
      const seed = contractSeed();
      r.gh.load({
        ...seed,
        installation: {
          ...seed.installation,
          permissions: { ...seed.installation.permissions, issues: 'write' },
        },
      });
      await r.advance(10 * MIN);
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 2, 'second tick');
      expect(await facts(t, 'installation', 'acme/app')).toHaveLength(2);
      expect(await facts(t, 'installation', 'acme/lib')).toHaveLength(2);
      // acme/lib leaves the installation: the fact is `repo: null`.
      r.gh.load({
        ...seed,
        installation: {
          ...seed.installation,
          permissions: { ...seed.installation.permissions, issues: 'write' },
        },
        repos: seed.repos.filter((x) => x.full_name !== 'acme/lib'),
      });
      await r.advance(10 * MIN);
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 3, 'third tick');
      const lib = await facts(t, 'installation', 'acme/lib');
      expect(lib).toHaveLength(3);
      expect(lib[2]?.body.value).toMatchObject({ repo: null });
      expect(await facts(t, 'installation', 'acme/app')).toHaveLength(2);
      await r.sup.stop();
    });
  });
});

describe('effective rules poll', () => {
  it('hourly for a repo with work in flight, nightly otherwise; an unknown work engine counts as busy', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      const work = new FakeWorkInFlight().set('acme/app', true);
      r.sup.add(effectiveRulesLoop({ ...r.base, source: r.gh, workInFlight: work }));
      r.sup.start();
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 1, 'first tick');
      const reads = (repo: string) =>
        r.gh.requests.filter((q) => q.path.startsWith(`/repos/${repo}/rules/branches`)).length;
      expect([reads('acme/app'), reads('acme/lib')]).toEqual([1, 1]);
      await r.advance(HOUR + 5 * MIN);
      expect([reads('acme/app'), reads('acme/lib')]).toEqual([2, 1]);
      await r.advance(10 * HOUR);
      expect(reads('acme/app')).toBeGreaterThanOrEqual(10);
      expect(reads('acme/lib')).toBe(1);
      // After a day the idle repo is polled again.
      await r.advance(13 * HOUR);
      expect(reads('acme/lib')).toBe(2);
      // The work engine cannot say: acme/lib is polled at the busy rate.
      work.breakIt();
      const before = reads('acme/lib');
      await r.advance(HOUR + 5 * MIN);
      expect(reads('acme/lib')).toBe(before + 1);
      await r.sup.stop();
    });
  });

  it('records the effective rules and only their changes; latency is the repo period', async () => {
    await withDb(async (t) => {
      const r = rig(t);
      const work = new FakeWorkInFlight().set('acme/app', true);
      r.sup.add(effectiveRulesLoop({ ...r.base, source: r.gh, workInFlight: work }));
      r.sup.start();
      await waitFor(() => r.sup.metrics()[0]?.ticks_ok === 1, 'first tick');
      const first = (await facts(t, 'effective_rules', 'acme/app'))[0];
      expect(first?.body.value).toMatchObject({
        branch: 'main',
        required_checks: [
          { context: 'gate-check', integration_id: 99 },
          { context: 'lint', integration_id: null },
        ],
      });
      expect(first?.body.poll_interval_ms).toBe(HOUR);
      // The rules are loosened (the lint check is removed) 10 minutes in; seen at the 1 h poll.
      await r.advance(10 * MIN);
      const seed = contractSeed();
      r.gh.load({
        ...seed,
        rules: seed.rules.map((x) => ({
          ...x,
          rules: (x.rules as Array<{ type: string }>).filter(
            (rule) => rule.type !== 'required_status_checks',
          ),
        })),
      });
      await r.advance(45 * MIN);
      expect(await facts(t, 'effective_rules', 'acme/app')).toHaveLength(1);
      await r.advance(10 * MIN);
      const all = await facts(t, 'effective_rules', 'acme/app');
      expect(all).toHaveLength(2);
      expect(all[1]?.body.value).toMatchObject({ required_checks: [] });
      await r.sup.stop();
    });
  });
});
