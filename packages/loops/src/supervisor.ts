import { systemClock, type Clock } from '@aisdlc/kernel';

// The loop supervisor (PLAN M5.4; RV §3.1 option B). core-worker runs many polling loops in one
// process; this is what keeps them from hurting each other and from hiding when they are sick:
//
//   - every loop is its own async runner: a loop that throws, backs off, hangs or has a poison item
//     never delays another loop;
//   - a tick that throws is retried after an exponential backoff; a tick that handled every item
//     but one (a poison item, `eachItem`) keeps its normal cadence so the other items are served
//     on time, and is counted as failing so the poison item cannot hide;
//   - one aggregated health report: unhealthy (HTTP 503) when any loop has been failing for longer
//     than its threshold, when a tick has run longer than its timeout, when a loop did not run
//     when it was due (stalled), or when an alert is active (for example dead-lettered outbox
//     messages);
//   - every log line is prefixed with the loop's name; per-loop metrics in Prometheus text.
//
// Time and sleeping are injected, so the tests run a day of loop time in milliseconds.

export type LogLevel = 'info' | 'warn' | 'error';
/** Writes one finished line. */
export type LogSink = (line: string) => void;

export interface LoopLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** `<loop>: {"level":"warn","msg":"...", ...fields}`: the loop name first, the rest structured. */
export function loopLogger(name: string, sink: LogSink, clock: Clock = systemClock): LoopLogger {
  const at = (level: LogLevel) => (msg: string, fields?: Record<string, unknown>) =>
    sink(`${name}: ${JSON.stringify({ level, msg, ...fields, at: clock.now().toISOString() })}`);
  return { info: at('info'), warn: at('warn'), error: at('error') };
}

export interface LoopContext {
  readonly name: string;
  readonly log: LoopLogger;
  /** Aborted when the tick has run past its timeout, and when the supervisor stops. */
  readonly signal: AbortSignal;
  /**
   * Runs `fn` for every item; a throw is logged and counted (in the tick's totals), and the next
   * item still runs: one poison item stops nothing. A tick that used it can simply return its
   * promise; the counts are not reported twice.
   */
  eachItem<T>(
    items: readonly T[],
    label: (item: T) => string,
    fn: (item: T) => Promise<void>,
  ): Promise<void>;
}

/** What a tick reports. A tick that returns nothing and does not throw succeeded. */
export interface TickResult {
  readonly ok?: number;
  readonly failed?: number;
}

export interface LoopSpec {
  /** `snake_case`; the prefix of the loop's log lines and its metrics label. */
  readonly name: string;
  readonly intervalMs: number;
  tick(ctx: LoopContext): Promise<TickResult | void>;
  /** Delay before the first tick (stagger the loops). Default 0. */
  readonly startDelayMs?: number;
  /** Backoff after a tick that throws: `min(maxMs, baseMs * 2^(n-1))` for the n-th in a row. */
  readonly retry?: { readonly baseMs: number; readonly maxMs: number };
  /** A tick running longer than this is stalled (and its `signal` aborted). Default `max(3 * interval, 60 s)`. */
  readonly tickTimeoutMs?: number;
  /** Failing for longer than this makes the loop, and `/healthz`, unhealthy. Default `max(3 * interval, 60 s)`. */
  readonly unhealthyAfterMs?: number;
}

export type LoopState =
  /** Not run yet, and not yet due by more than the grace. */
  | 'starting'
  | 'ok'
  /** The last tick failed, but not for longer than the threshold. */
  | 'degraded'
  /** Failing for longer than the threshold: unhealthy. */
  | 'failing'
  /** A tick is running past its timeout, or the loop did not run when due: unhealthy. */
  | 'stalled';

export interface LoopStatus {
  readonly name: string;
  readonly state: LoopState;
  readonly interval_ms: number;
  readonly consecutive_failures: number;
  readonly failing_since: string | null;
  readonly last_success_at: string | null;
  readonly last_tick_at: string | null;
  readonly last_error: string | null;
  readonly next_due_at: string | null;
  readonly running_since: string | null;
}

export interface Alert {
  readonly code: string;
  readonly message: string;
  readonly count?: number;
}

export interface HealthReport {
  readonly status: 'ok' | 'unhealthy';
  readonly loops: readonly LoopStatus[];
  readonly alerts: readonly Alert[];
}

export interface LoopMetrics {
  readonly name: string;
  readonly ticks_ok: number;
  readonly ticks_failed: number;
  readonly items_ok: number;
  readonly items_failed: number;
  readonly last_tick_duration_ms: number | null;
  readonly consecutive_failures: number;
  readonly last_success_at_ms: number | null;
}

export type Sleep = (ms: number, signal: AbortSignal) => Promise<void>;

/** `setTimeout`, cancelled by the signal (resolves when cancelled). */
export const realSleep: Sleep = (ms, signal) =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done(): void {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

export interface SupervisorOptions {
  readonly clock?: Clock;
  readonly sleep?: Sleep;
  /** Where log lines go. Default `console.log`. */
  readonly log?: LogSink;
  /** Extra time a loop may be late before it is `stalled`. Default 30 s. */
  readonly stallGraceMs?: number;
  /** How long `stop` waits for running ticks to return before giving up on them. Default 5 s. */
  readonly stopTimeoutMs?: number;
}

interface Runtime {
  readonly spec: LoopSpec;
  readonly tickTimeoutMs: number;
  readonly unhealthyAfterMs: number;
  readonly retry: { baseMs: number; maxMs: number };
  readonly log: LoopLogger;
  startedAt: number | null;
  nextDueAt: number | null;
  runningSince: number | null;
  lastTickAt: number | null;
  lastSuccessAt: number | null;
  failingSince: number | null;
  consecutiveFailures: number;
  lastError: string | null;
  lastTickThrew: boolean;
  sleeping: boolean;
  finished: boolean;
  ticksOk: number;
  ticksFailed: number;
  itemsOk: number;
  itemsFailed: number;
  lastDurationMs: number | null;
  wake: AbortController | null;
  tickAbort: AbortController | null;
  done: Promise<void> | null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class LoopSupervisor {
  private readonly clock: Clock;
  private readonly sleep: Sleep;
  private readonly sink: LogSink;
  private readonly stallGraceMs: number;
  private readonly stopTimeoutMs: number;
  private readonly loops = new Map<string, Runtime>();
  private readonly alerts = new Map<string, Alert>();
  private readonly stopping = new AbortController();
  private started = false;

  constructor(o: SupervisorOptions = {}) {
    this.clock = o.clock ?? systemClock;
    this.sleep = o.sleep ?? realSleep;
    this.sink = o.log ?? ((l) => console.log(l));
    this.stallGraceMs = o.stallGraceMs ?? 30_000;
    this.stopTimeoutMs = o.stopTimeoutMs ?? 5_000;
  }

  /** Adds a loop. Must be called before `start`. */
  add(spec: LoopSpec): this {
    if (this.started) throw new Error('loops are added before start');
    if (!/^[a-z][a-z0-9_]*$/.test(spec.name)) throw new RangeError(`bad loop name ${spec.name}`);
    if (this.loops.has(spec.name)) throw new Error(`loop ${spec.name} is already added`);
    if (!(spec.intervalMs >= 1)) throw new RangeError(`${spec.name}: intervalMs must be >= 1`);
    const floor = Math.max(3 * spec.intervalMs, 60_000);
    this.loops.set(spec.name, {
      spec,
      tickTimeoutMs: spec.tickTimeoutMs ?? floor,
      unhealthyAfterMs: spec.unhealthyAfterMs ?? floor,
      retry: spec.retry ?? { baseMs: Math.min(spec.intervalMs, 1_000), maxMs: spec.intervalMs },
      log: loopLogger(spec.name, this.sink, this.clock),
      startedAt: null,
      nextDueAt: null,
      runningSince: null,
      lastTickAt: null,
      lastSuccessAt: null,
      failingSince: null,
      consecutiveFailures: 0,
      lastError: null,
      lastTickThrew: false,
      sleeping: false,
      finished: false,
      ticksOk: 0,
      ticksFailed: 0,
      itemsOk: 0,
      itemsFailed: 0,
      lastDurationMs: null,
      wake: null,
      tickAbort: null,
      done: null,
    });
    return this;
  }

  /** Starts every loop. Each runs in its own async task from here on. */
  start(): void {
    if (this.started) throw new Error('already started');
    this.started = true;
    for (const rt of this.loops.values()) {
      rt.startedAt = this.clock.nowMs();
      rt.done = this.run(rt);
    }
  }

  /**
   * Stops the loops: pending sleeps end, running ticks get an aborted signal and are awaited, for
   * at most `stopTimeoutMs` (a tick that ignores its signal and never returns cannot hold the
   * process; it is named in the log).
   */
  async stop(): Promise<void> {
    this.stopping.abort();
    for (const rt of this.loops.values()) {
      rt.wake?.abort();
      rt.tickAbort?.abort();
    }
    let timer: NodeJS.Timeout | undefined;
    const gaveUp = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), this.stopTimeoutMs);
    });
    const all = Promise.all([...this.loops.values()].map((rt) => rt.done)).then(
      () => 'done' as const,
    );
    const r = await Promise.race([all, gaveUp]);
    clearTimeout(timer);
    if (r === 'timeout') {
      for (const rt of this.loops.values()) {
        if (rt.runningSince !== null) rt.log.error('tick did not return at shutdown; abandoned');
      }
    }
  }

  /**
   * Makes a sleeping loop run now (for example after the registry of repos changed). A loop that
   * is mid-tick runs again right after.
   */
  poke(name: string): boolean {
    const rt = this.loops.get(name);
    if (!rt) return false;
    rt.wake?.abort();
    return true;
  }

  /** True while any loop is between waking and going back to sleep (a tick is in progress). */
  get busy(): boolean {
    return [...this.loops.values()].some(
      (rt) => rt.startedAt !== null && !rt.finished && !rt.sleeping,
    );
  }

  /** Sets (or, with `null`, clears) an alert. An active alert makes the health report unhealthy. */
  setAlert(key: string, alert: Alert | null): void {
    if (alert === null) this.alerts.delete(key);
    else this.alerts.set(key, alert);
  }

  private async run(rt: Runtime): Promise<void> {
    const delay0 = rt.spec.startDelayMs ?? 0;
    rt.nextDueAt = this.clock.nowMs() + delay0;
    if (delay0 > 0) await this.nap(rt, delay0);
    while (!this.stopping.signal.aborted) {
      const ok = await this.tick(rt);
      if (this.stopping.signal.aborted) break;
      const wait = ok
        ? rt.spec.intervalMs
        : Math.min(rt.retry.maxMs, rt.retry.baseMs * 2 ** Math.max(0, rt.consecutiveFailures - 1));
      // A partial failure (poison item) keeps the normal cadence; only a throw backs off.
      const delay = rt.lastTickThrew ? wait : rt.spec.intervalMs;
      rt.nextDueAt = this.clock.nowMs() + delay;
      await this.nap(rt, delay);
    }
    rt.finished = true;
    rt.log.info('stopped');
  }

  private async nap(rt: Runtime, ms: number): Promise<void> {
    const wake = new AbortController();
    rt.wake = wake;
    rt.sleeping = true;
    const both = AbortSignal.any([wake.signal, this.stopping.signal]);
    await this.sleep(ms, both);
    rt.sleeping = false;
    rt.wake = null;
  }

  /** One tick. Returns whether it was clean (no throw, no failed item). */
  private async tick(rt: Runtime): Promise<boolean> {
    const started = this.clock.nowMs();
    rt.runningSince = started;
    const abort = new AbortController();
    rt.tickAbort = abort;
    const timeoutCtl = new AbortController();
    void this.sleep(rt.tickTimeoutMs, timeoutCtl.signal).then(() => {
      if (!timeoutCtl.signal.aborted) abort.abort();
    });
    let ok = 0;
    let failed = 0;
    let threw = false;
    let error: string | null = null;
    const ctx: LoopContext = {
      name: rt.spec.name,
      log: rt.log,
      signal: AbortSignal.any([abort.signal, this.stopping.signal]),
      eachItem: async (items, label, fn) => {
        for (const item of items) {
          try {
            await fn(item);
            ok += 1;
          } catch (e) {
            failed += 1;
            error = `${label(item)}: ${errText(e)}`;
            rt.log.error('item failed', { item: label(item), error: errText(e) });
          }
        }
      },
    };
    try {
      const r = await rt.spec.tick(ctx);
      if (r) {
        ok += r.ok ?? 0;
        failed += r.failed ?? 0;
      }
    } catch (e) {
      threw = true;
      error = errText(e);
      rt.log.error('tick failed', { error });
    } finally {
      timeoutCtl.abort();
      rt.tickAbort = null;
    }
    const finished = this.clock.nowMs();
    rt.runningSince = null;
    rt.lastTickAt = finished;
    rt.lastDurationMs = finished - started;
    rt.itemsOk += ok;
    rt.itemsFailed += failed;
    rt.lastTickThrew = threw;
    const clean = !threw && failed === 0;
    if (clean) {
      rt.ticksOk += 1;
      rt.lastSuccessAt = finished;
      rt.failingSince = null;
      rt.consecutiveFailures = 0;
      rt.lastError = null;
      rt.log.info('tick ok', { items: ok, ms: finished - started });
    } else {
      rt.ticksFailed += 1;
      rt.consecutiveFailures += 1;
      rt.failingSince ??= finished;
      rt.lastError = error;
      if (!threw) rt.log.warn('tick had failing items', { ok, failed });
    }
    return clean;
  }

  private status(rt: Runtime): LoopStatus {
    const now = this.clock.nowMs();
    let state: LoopState;
    const late =
      rt.nextDueAt !== null && rt.runningSince === null && now - rt.nextDueAt > this.stallGraceMs;
    if (
      (rt.runningSince !== null && now - rt.runningSince > rt.tickTimeoutMs) ||
      (late && rt.startedAt !== null)
    ) {
      state = 'stalled';
    } else if (rt.failingSince !== null) {
      state = now - rt.failingSince > rt.unhealthyAfterMs ? 'failing' : 'degraded';
    } else if (rt.lastSuccessAt === null) {
      state = 'starting';
    } else {
      state = 'ok';
    }
    const iso = (ms: number | null): string | null =>
      ms === null ? null : new Date(ms).toISOString();
    return {
      name: rt.spec.name,
      state,
      interval_ms: rt.spec.intervalMs,
      consecutive_failures: rt.consecutiveFailures,
      failing_since: iso(rt.failingSince),
      last_success_at: iso(rt.lastSuccessAt),
      last_tick_at: iso(rt.lastTickAt),
      last_error: rt.lastError,
      next_due_at: iso(rt.nextDueAt),
      running_since: iso(rt.runningSince),
    };
  }

  /** The aggregated health: unhealthy when any loop is failing or stalled, or any alert is active. */
  health(): HealthReport {
    const loops = [...this.loops.values()].map((rt) => this.status(rt));
    const alerts = [...this.alerts.values()];
    const bad = loops.some((l) => l.state === 'failing' || l.state === 'stalled');
    return { status: bad || alerts.length > 0 ? 'unhealthy' : 'ok', loops, alerts };
  }

  metrics(): LoopMetrics[] {
    return [...this.loops.values()].map((rt) => ({
      name: rt.spec.name,
      ticks_ok: rt.ticksOk,
      ticks_failed: rt.ticksFailed,
      items_ok: rt.itemsOk,
      items_failed: rt.itemsFailed,
      last_tick_duration_ms: rt.lastDurationMs,
      consecutive_failures: rt.consecutiveFailures,
      last_success_at_ms: rt.lastSuccessAt,
    }));
  }

  /** Prometheus text exposition of `metrics()` and the health state of every loop. */
  prometheus(): string {
    const lines: string[] = [];
    const family = (name: string, help: string, type: 'counter' | 'gauge') => {
      lines.push(`# HELP ${name} ${help}`, `# TYPE ${name} ${type}`);
    };
    const m = this.metrics();
    family('aisdlc_loop_ticks_total', 'Ticks finished, by outcome.', 'counter');
    for (const x of m) {
      lines.push(`aisdlc_loop_ticks_total{loop="${x.name}",outcome="ok"} ${x.ticks_ok}`);
      lines.push(`aisdlc_loop_ticks_total{loop="${x.name}",outcome="failed"} ${x.ticks_failed}`);
    }
    family('aisdlc_loop_items_total', 'Items handled, by outcome.', 'counter');
    for (const x of m) {
      lines.push(`aisdlc_loop_items_total{loop="${x.name}",outcome="ok"} ${x.items_ok}`);
      lines.push(`aisdlc_loop_items_total{loop="${x.name}",outcome="failed"} ${x.items_failed}`);
    }
    family('aisdlc_loop_consecutive_failures', 'Ticks in a row that failed.', 'gauge');
    for (const x of m)
      lines.push(`aisdlc_loop_consecutive_failures{loop="${x.name}"} ${x.consecutive_failures}`);
    family('aisdlc_loop_last_tick_duration_ms', 'Duration of the last tick.', 'gauge');
    for (const x of m) {
      if (x.last_tick_duration_ms !== null) {
        lines.push(
          `aisdlc_loop_last_tick_duration_ms{loop="${x.name}"} ${x.last_tick_duration_ms}`,
        );
      }
    }
    family(
      'aisdlc_loop_last_success_timestamp_seconds',
      'When the last clean tick finished.',
      'gauge',
    );
    for (const x of m) {
      if (x.last_success_at_ms !== null) {
        lines.push(
          `aisdlc_loop_last_success_timestamp_seconds{loop="${x.name}"} ${x.last_success_at_ms / 1000}`,
        );
      }
    }
    family('aisdlc_loop_unhealthy', '1 when the loop is failing or stalled.', 'gauge');
    const h = this.health();
    for (const l of h.loops) {
      lines.push(
        `aisdlc_loop_unhealthy{loop="${l.name}"} ${l.state === 'failing' || l.state === 'stalled' ? 1 : 0}`,
      );
    }
    family('aisdlc_alert_active', '1 for each active alert.', 'gauge');
    for (const a of h.alerts) lines.push(`aisdlc_alert_active{code="${a.code}"} ${a.count ?? 1}`);
    return `${lines.join('\n')}\n`;
  }
}
