import { performance } from 'node:perf_hooks';
import type { PrincipalId } from '@aisdlc/contracts';
import type pg from 'pg';
import { ingestItem, readItem } from '../work-items.js';
import type { LoadPeople } from './seed.js';
import { loadRepoOf } from './seed.js';

// The load test's driver (PLAN M19, `aisdlc-load run`): submits the items through core's own API as the bff does
// (core's `bff` token, `on_behalf_of` the person; the PDP decides about the person on every call), lets the work
// engine in core-worker run them over the fakes behind its ports, and acts for the people while it measures:
//   - Ready (1.6) and G6 by the requester, every other gate by the approver (prepare, evidence, decide: the same three
//     calls the portal makes; each decision is a ledger entry signed by the Notary);
//   - the merge an item waits for is recorded as the code host's poll would record it (`item.merge_observed`: the
//     fake GitHub has no PR to merge for a load repo), and human-led work as done;
// and, all along, the reads a person makes: the floor of every project at core (with its per-item PDP probes) and
// at the bff (cut to the person, with the sandbox slots), the fleet, the inbox. At the end it reads the record for
// the engine's own numbers: the work driver's command latency (outbox) and admission (6.0) throughput.

export interface Timing {
  readonly n: number;
  readonly p50: number;
  readonly p95: number;
  readonly p99: number;
  readonly max: number;
  readonly mean: number;
}

export const timing = (xs: readonly number[]): Timing => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) =>
    s.length === 0 ? 0 : (s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] as number);
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: s.length,
    p50: r(q(50)),
    p95: r(q(95)),
    p99: r(q(99)),
    max: r(s.at(-1) ?? 0),
    mean: r(s.length === 0 ? 0 : s.reduce((a, b) => a + b, 0) / s.length),
  };
};

interface Answer {
  readonly status: number;
  readonly json: unknown;
  readonly ms: number;
}

/** core's API as the bff calls it. */
export class CoreCaller {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {}
  async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer> {
    const t0 = performance.now();
    const r = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    const ms = performance.now() - t0;
    let json: unknown;
    try {
      json = text === '' ? null : JSON.parse(text);
    } catch {
      json = text.slice(0, 200);
    }
    return { status: r.status, json, ms };
  }
}

/**
 * A person's portal session at the bff, signed in through the dev IdP as a browser would be (`FACTORY_ENV=local`):
 * the bff's login redirect, the IdP's form, the callback with the binder cookie. `rewrite` maps the browser's host
 * names (`localhost:8340`) onto the ones this container reaches.
 */
export class BffSession {
  private cookie = '';
  constructor(
    private readonly bffUrl: string,
    private readonly rewrite: (u: string) => string,
  ) {}

  private static cookiesOf(r: Response): string[] {
    return r.headers.getSetCookie().map((c) => c.split(';')[0] as string);
  }

  async signIn(subject: string): Promise<void> {
    const jar = new Map<string, string>();
    const keep = (r: Response) => {
      for (const c of BffSession.cookiesOf(r)) {
        const i = c.indexOf('=');
        jar.set(c.slice(0, i), c.slice(i + 1));
      }
    };
    const header = () => [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const login = await fetch(`${this.bffUrl}/auth/login`, { redirect: 'manual' });
    keep(login);
    const authorize = login.headers.get('location');
    if (!authorize) throw new Error(`bff /auth/login answered ${login.status} without a redirect`);
    const form = await fetch(this.rewrite(authorize), { redirect: 'manual' });
    const html = await form.text();
    const fields = new URLSearchParams();
    for (const m of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)) {
      fields.set(
        m[1] as string,
        (m[2] as string).replaceAll('&amp;', '&').replaceAll('&quot;', '"'),
      );
    }
    fields.set('dev_user', subject);
    const posted = await fetch(new URL('/authorize', this.rewrite(authorize)).toString(), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
      redirect: 'manual',
    });
    const back = posted.headers.get('location');
    if (!back) throw new Error(`the dev IdP answered ${posted.status} without a redirect`);
    const cb = await fetch(this.rewrite(back), {
      headers: { cookie: header() },
      redirect: 'manual',
    });
    keep(cb);
    this.cookie = header();
    const me = await this.get('/api/me');
    if (me.status !== 200) throw new Error(`signed in, but /api/me answered ${me.status}`);
  }

  async get(path: string): Promise<Answer> {
    const t0 = performance.now();
    const r = await fetch(`${this.bffUrl}${path}`, {
      headers: { cookie: this.cookie },
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    const ms = performance.now() - t0;
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: r.status, json, ms };
  }
}

export interface RunOptions {
  readonly projects: readonly string[];
  readonly itemsPerProject: number;
  readonly people: LoadPeople;
  /** How many items the driver acts for at once. */
  readonly concurrency: number;
  /** Give up on items not done after this long. */
  readonly deadlineMs: number;
  /** How often the reads are sampled while the items run. */
  readonly sampleMs: number;
  /** Reads per project in each burst (all items submitted; at the end). */
  readonly burst: number;
  readonly log: (l: string) => void;
}

export interface RunDeps {
  readonly pool: pg.Pool;
  readonly core: CoreCaller;
  readonly bff: BffSession | null;
}

type Reads = Record<string, number[]>;
const push = (r: Reads, k: string, ms: number) => (r[k] ??= []).push(ms);

/** The ids of every card an item's gates were opened on, newest last, by gate. */
async function cardsOf(pool: pg.Pool, item: string): Promise<Map<string, string>> {
  const q = await pool.query<{ body: { gates?: Array<{ gate: string }>; card_ids?: string[] } }>(
    `SELECT body FROM record.record_event WHERE stream = $1 AND type = 'item.gates_opened' ORDER BY seq`,
    [`item:${item}`],
  );
  const out = new Map<string, string>();
  for (const { body } of q.rows) {
    const p = ((body as { payload?: unknown }).payload ?? body) as {
      gates?: Array<{ gate: string }>;
      card_ids?: string[];
    };
    for (const g of p.gates ?? []) if (p.card_ids?.[0]) out.set(g.gate, p.card_ids[0]);
  }
  return out;
}

/**
 * The cards this run decided: the item takes a decided gate into its stream on the work driver's next pass, and until
 * then still shows it pending; a person does not decide a card twice (core would answer 409 `gate_not_pending`).
 */
const decidedCards = new Set<string>();

/** Does one thing a person would do for the item now; `false` when it waits on nobody (the engine runs). */
async function actFor(
  d: RunDeps,
  o: Pick<RunOptions, 'people'>,
  item: string,
  errors: string[],
  hold: ReadonlySet<string> = new Set(),
): Promise<boolean> {
  const it = await readItem(d.pool, item);
  if (!it || it.state.terminal !== null) return false;
  const st = it.state;
  const w = st.waiting;
  const who = (p: PrincipalId) => p;
  if (w?.kind === 'human') {
    if (w.what === 'ready') {
      const r = await d.core.call('POST', `/v1/items/${item}/ready`, {
        on_behalf_of: who(o.people.requester),
      });
      if (r.status !== 200) errors.push(`ready ${r.status}`);
      return true;
    }
    if (w.what === 'merge') {
      const r = await ingestItem({ pool: d.pool }, item, {
        type: 'item.merge_observed',
        payload: { merged_sha: 'abcdef1234567' },
        actor: 'system.codehost',
        idempotency_key: `merge:${item}`,
      });
      if (!r.ok) errors.push(`merge ${r.error.code}`);
      return true;
    }
    if (w.what === 'human_led') {
      const r = await d.core.call('POST', `/v1/items/${item}/human-done`, {
        on_behalf_of: who(o.people.approver),
        key: `load-${item}`,
      });
      if (r.status !== 200) errors.push(`human-done ${r.status}`);
      return true;
    }
    if (w.what === 'schedule') {
      const r = await ingestItem({ pool: d.pool }, item, {
        type: 'item.scheduled',
        payload: { by: o.people.approver },
        actor: o.people.approver,
        idempotency_key: `schedule:${item}`,
      });
      if (!r.ok) errors.push(`schedule ${r.error.code}`);
      return true;
    }
  }
  const pending = st.gates.filter((g) => g.status === 'pending');
  if (pending.length === 0) return false;
  const cards = await cardsOf(d.pool, item);
  let acted = false;
  for (const g of pending) {
    if (hold.has(g.gate)) continue;
    const card = cards.get(g.gate);
    if (!card || decidedCards.has(card)) continue;
    const by = g.gate === 'G6' ? st.requester : o.people.approver;
    const prep = await d.core.call('POST', `/v1/cards/${card}/gate/prepare`, { on_behalf_of: by });
    if (prep.status !== 200) {
      errors.push(`${g.gate} prepare ${prep.status}`);
      continue;
    }
    const gates = (prep.json as { gates: Array<{ nonce: string; evidence_hash: string }> }).gates;
    const ev = await d.core.call('POST', `/v1/cards/${card}/gate/evidence`, {
      on_behalf_of: by,
      views: gates.map((x) => ({ nonce: x.nonce, evidence_hash: x.evidence_hash })),
    });
    if (ev.status !== 200) {
      errors.push(`${g.gate} evidence ${ev.status}`);
      continue;
    }
    const dec = await d.core.call('POST', `/v1/cards/${card}/gate/decide`, {
      on_behalf_of: by,
      decision: 'approve',
      votes: gates.map((x) => ({ nonce: x.nonce })),
    });
    if (dec.status !== 200) errors.push(`${g.gate} decide ${dec.status}`);
    else {
      decidedCards.add(card);
      acted = true;
    }
  }
  return acted;
}

const LANES = ['L4', 'L2', 'L4', 'L3'] as const;

/** Runs the load; returns the measurements (the caller adds the host's: memory, connections, the machine). */
export async function runLoad(d: RunDeps, o: RunOptions) {
  const t0 = Date.now();
  const startedAt = new Date(t0).toISOString();
  const reads: Reads = {};
  const visible: number[] = [];
  const errors: string[] = [];
  const submitted = new Map<string, number>();
  const finished = new Map<string, number>();

  // 1. the requests, all of them, as fast as core takes them
  const submitMs: number[] = [];
  for (let i = 0; i < o.itemsPerProject; i++) {
    for (const project of o.projects) {
      const r = await d.core.call('POST', '/v1/requests', {
        project_id: project,
        repo: loadRepoOf(project),
        lane: LANES[i % LANES.length],
        channel: 'N1',
        text: `Load item ${i + 1} of ${project}: add a CSV export of the audit log.`,
        on_behalf_of: o.people.requester,
      });
      submitMs.push(r.ms);
      const id = (r.json as { item_id?: string } | null)?.item_id;
      if (r.status === 201 && id) submitted.set(id, Date.now());
      else errors.push(`request ${r.status}: ${JSON.stringify(r.json).slice(0, 120)}`);
    }
  }
  o.log(`load: ${submitted.size} items submitted in ${Math.round((Date.now() - t0) / 1000)} s`);

  // 2. the reads a person makes, sampled while the items run
  const read = async (tag: string) => {
    for (const p of o.projects) {
      const f = await d.core.call('GET', `/v1/floor/${p}?on_behalf_of=${o.people.requester}`);
      if (f.status === 200) {
        push(reads, `${tag}.core.floor`, f.ms);
        const items = (f.json as { items?: unknown[] } | null)?.items;
        if (Array.isArray(items)) visible.push(items.length);
      } else errors.push(`core floor ${f.status}`);
      if (d.bff) {
        const b = await d.bff.get(`/api/floor/${p}`);
        if (b.status === 200) push(reads, `${tag}.bff.floor`, b.ms);
        else errors.push(`bff floor ${b.status}`);
      }
    }
    const fl = await d.core.call('GET', `/v1/fleet?on_behalf_of=${o.people.requester}`);
    if (fl.status === 200) push(reads, `${tag}.core.fleet`, fl.ms);
    else errors.push(`core fleet ${fl.status}`);
    const ib = await d.core.call('GET', '/v1/inbox');
    if (ib.status === 200) push(reads, `${tag}.core.inbox`, ib.ms);
    else errors.push(`core inbox ${ib.status}`);
    if (d.bff) {
      for (const path of ['/api/fleet', '/api/inbox']) {
        const b = await d.bff.get(path);
        if (b.status === 200) push(reads, `${tag}.bff.${path.slice(5)}`, b.ms);
        else errors.push(`bff ${path} ${b.status}`);
      }
    }
  };
  const burst = async (tag: string) => {
    for (let k = 0; k < o.burst; k++) await read(tag);
  };
  // wait until the engine has made every item (the floor's read model catches up when it is read), then the first
  // burst: every item in flight
  const deadline = t0 + o.deadlineMs;
  for (;;) {
    const q = await d.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM record.record_event WHERE type = 'item.created' AND stream = ANY($1::text[])`,
      [[...submitted.keys()].map((i) => `item:${i}`)],
    );
    if ((q.rows[0]?.n ?? 0) >= submitted.size || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  o.log('load: burst 1 (every item in flight)');
  await burst('burst_in_flight');

  // 3. the people act; the reads go on in the background
  let stop = false;
  const sampler = (async () => {
    while (!stop) {
      await read('during').catch((e: unknown) => errors.push(`read: ${String(e)}`));
      await new Promise((r) => setTimeout(r, o.sampleMs));
    }
  })();
  const open = new Set(submitted.keys());
  let lastLog = 0;
  while (open.size > 0 && Date.now() < deadline) {
    const batch = [...open];
    let i = 0;
    const worker = async () => {
      while (i < batch.length) {
        const id = batch[i++] as string;
        try {
          await actFor(d, o, id, errors);
          const it = await readItem(d.pool, id);
          if (it?.state.terminal != null) {
            open.delete(id);
            finished.set(id, Date.now());
          }
        } catch (e) {
          errors.push(`act: ${e instanceof Error ? e.message.slice(0, 120) : String(e)}`);
        }
      }
    };
    await Promise.all(Array.from({ length: o.concurrency }, worker));
    if (Date.now() - lastLog > 15_000) {
      lastLog = Date.now();
      o.log(
        `load: ${finished.size}/${submitted.size} done, ${errors.length} errors, ${Math.round((Date.now() - t0) / 1000)} s`,
      );
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  stop = true;
  await sampler;
  o.log('load: burst 2 (the end)');
  await burst('burst_end');
  const endedAt = new Date().toISOString();

  // 4. the engine's own numbers, from the record
  const ids = [...submitted.keys()];
  const cmd = await d.pool.query<{
    step: string | null;
    type: string;
    ms: number;
    attempts: number;
  }>(
    `SELECT payload -> 'command' ->> 'step' AS step, payload -> 'command' ->> 'type' AS type,
            extract(epoch FROM (dispatched_at - created_at)) * 1000 AS ms, attempts
       FROM record.outbox
      WHERE destination = 'work.commands' AND dispatched_at IS NOT NULL
        AND (payload ->> 'item_id')::uuid = ANY($1::uuid[])`,
    [ids],
  );
  const dead = await d.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM record.outbox WHERE destination = 'work.commands' AND dead_at IS NOT NULL
        AND (payload ->> 'item_id')::uuid = ANY($1::uuid[])`,
    [ids],
  );
  const admitted = await d.pool.query<{ at: Date }>(
    `SELECT occurred_at AS at FROM record.record_event WHERE type = 'unit.admitted'
        AND stream = ANY($1::text[]) ORDER BY occurred_at`,
    [ids.map((i) => `unit:${i}`)],
  );
  const held = await d.pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM record.record_event
      WHERE stream = ANY($1::text[]) AND type = 'item.stage_held'`,
    [ids.map((i) => `item:${i}`)],
  );
  const at = admitted.rows.map((r) => r.at.getTime());
  const spanS = at.length > 1 ? ((at.at(-1) as number) - (at[0] as number)) / 1000 : 0;
  const cmds = cmd.rows.map((r) => Number(r.ms));
  const s6 = cmd.rows.filter((r) => r.step === '6.0').map((r) => Number(r.ms));
  return {
    started_at: startedAt,
    ended_at: endedAt,
    duration_s: Math.round((Date.now() - t0) / 1000),
    items: {
      submitted: submitted.size,
      done: finished.size,
      not_done: submitted.size - finished.size,
      end_to_end_s: timing([...finished].map(([id, t]) => (t - (submitted.get(id) ?? t)) / 1000)),
      floor_items_seen: timing(visible),
    },
    submit_ms: timing(submitMs),
    reads_ms: Object.fromEntries(Object.entries(reads).map(([k, v]) => [k, timing(v)])),
    work_driver: {
      commands: cmds.length,
      latency_ms: timing(cmds),
      // an attempt is counted when a row is claimed: more than one is a retry
      retried: cmd.rows.filter((r) => r.attempts > 1).length,
      dead: dead.rows[0]?.n ?? 0,
    },
    admission: {
      admitted: at.length,
      span_s: Math.round(spanS),
      per_minute: spanS > 0 ? Math.round((at.length / spanS) * 60 * 10) / 10 : 0,
      command_6_0_ms: timing(s6),
      held_events: held.rows[0]?.n ?? 0,
    },
    errors: { count: errors.length, first: [...new Set(errors)].slice(0, 20) },
  };
}

/**
 * The runner-killed drill's item (docs/runbooks/drill-runner.md): one request in `project`, acted for until its Unit
 * holds an ACTIVE admission grant and the item waits at G4 (never decided here, so the grant stays active). Returns
 * the grant a sandbox session would name.
 */
export async function itemWithGrant(
  d: RunDeps,
  o: { project: string; people: LoadPeople; deadlineMs: number; log: (l: string) => void },
) {
  const r = await d.core.call('POST', '/v1/requests', {
    project_id: o.project,
    repo: loadRepoOf(o.project),
    lane: 'L4',
    channel: 'N1',
    text: 'Drill item: a coding session to kill.',
    on_behalf_of: o.people.requester,
  });
  const item = (r.json as { item_id?: string } | null)?.item_id;
  if (r.status !== 201 || !item) throw new Error(`the request answered ${r.status}`);
  const errors: string[] = [];
  const until = Date.now() + o.deadlineMs;
  while (Date.now() < until) {
    await actFor(d, o, item, errors, new Set(['G4']));
    const g = await d.pool.query<{
      grant_id: string;
      item_id: string;
      unit_id: string;
      lease_epoch: number;
    }>(
      `SELECT grant_id, item_id::text AS item_id, unit_id, lease_epoch FROM core.admission_grant
        WHERE item_id = $1 AND status = 'active'`,
      [item],
    );
    const it = await readItem(d.pool, item);
    const atG4 = it?.state.gates.some((x) => x.gate === 'G4' && x.status === 'pending') ?? false;
    if (g.rows[0] && atG4) return { item_id: item, grant: g.rows[0] };
    if (it?.state.terminal != null) throw new Error(`the item ended (${it.state.terminal})`);
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error(
    `no active grant at G4 within ${o.deadlineMs} ms (${errors.slice(0, 3).join('; ')})`,
  );
}
