import { CONFIG_NOTIFY_CHANNEL, type ConfigLineage, type ProjectId } from '@aisdlc/contracts';
import { FACTORY_SCOPE } from '@aisdlc/contracts';
import { hashCanonical } from '@aisdlc/kernel';
import { runProjection } from '@aisdlc/record';
import type pg from 'pg';
import { configProjection, loadEffective } from './projection.js';
import type { ConfigRegistry } from './registry.js';

// Consumers read configuration through a `ConfigReader` (PLAN M3.5): `current()` is a synchronous,
// immutable snapshot of the effective config (defaults, then the published factory layer, then the
// published project layer for the keys marked overridable). It changes by revision, without a
// restart: a publish sends a Postgres NOTIFY on commit, and a poll covers a missed notification,
// a dropped listener connection, or a consumer that cannot LISTEN. A revision that is only
// proposed, or whose M1 gate is undecided, is never in a snapshot.

export interface EffectiveConfig {
  /** Every registered key with its effective value. */
  readonly values: Readonly<Record<string, unknown>>;
  /** The published revisions the values come from; `null`: nothing published for that layer yet. */
  readonly revisions: { readonly factory: string | null; readonly project: string | null };
  /** Changes exactly when one of the two revisions does. */
  readonly token: string;
  /** Keys whose published value no longer fits their schema (the default was used instead). */
  readonly rejected: readonly string[];
  get<T = unknown>(key: string): T | undefined;
}

export interface ConfigReaderOptions {
  readonly pool: pg.Pool;
  readonly registry: ConfigRegistry;
  /** Read the project layer of this project too. Without it, factory config only. */
  readonly project?: ProjectId;
  /** Poll fallback in ms; 0 turns polling off. Default 5000. */
  readonly pollIntervalMs?: number;
  /** LISTEN for publishes. Default true. */
  readonly listen?: boolean;
  /**
   * Fold the record into the config read model before each load. Default true. A reader whose database
   * role may not write the read model (the model gateway's) passes false and reads what the writers'
   * readers (core, core-worker) and every publish have already folded.
   */
  readonly catchUp?: boolean;
  /** Errors of background refreshes. A failed refresh keeps the last good snapshot. */
  readonly onError?: (e: unknown) => void;
}

export interface ConfigChange {
  readonly from: EffectiveConfig;
  readonly to: EffectiveConfig;
}

export class ConfigReader {
  private snapshot: EffectiveConfig;
  private readonly listeners = new Set<(c: ConfigChange) => void>();
  private timer: NodeJS.Timeout | null = null;
  private client: pg.PoolClient | null = null;
  private running = false;
  private inFlight: Promise<boolean> | null = null;
  private again = false;

  private constructor(
    private readonly o: ConfigReaderOptions,
    first: EffectiveConfig,
  ) {
    this.snapshot = first;
  }

  /** Loads the first snapshot, then returns; call `start()` for push and poll reloads. */
  static async create(o: ConfigReaderOptions): Promise<ConfigReader> {
    return new ConfigReader(o, await loadSnapshot(o));
  }

  /** The effective configuration now. Never throws, never blocks. */
  current(): EffectiveConfig {
    return this.snapshot;
  }

  /** Calls `fn` after the snapshot changed to another revision. Returns the unsubscribe. */
  subscribe(fn: (c: ConfigChange) => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  /** Reloads now. Resolves true if the snapshot changed. Concurrent calls share one reload. */
  refresh(): Promise<boolean> {
    if (this.inFlight) {
      this.again = true; // a publish landed during the load: load once more afterwards
      return this.inFlight;
    }
    this.inFlight = (async () => {
      let changed = false;
      try {
        do {
          this.again = false;
          const next = await loadSnapshot(this.o);
          if (next.token !== this.snapshot.token) {
            const from = this.snapshot;
            this.snapshot = next;
            changed = true;
            for (const l of [...this.listeners]) {
              try {
                l({ from, to: next });
              } catch (e) {
                this.o.onError?.(e);
              }
            }
          }
        } while (this.again);
      } finally {
        this.inFlight = null;
      }
      return changed;
    })();
    return this.inFlight;
  }

  /** Starts LISTEN and the poll timer. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    const every = this.o.pollIntervalMs ?? 5000;
    if (every > 0) {
      this.timer = setInterval(() => void this.background(), every);
      this.timer.unref();
    }
    if (this.o.listen ?? true) await this.listen();
  }

  private background(): void {
    this.refresh().catch((e) => this.o.onError?.(e));
  }

  private async listen(): Promise<void> {
    try {
      const c = await this.o.pool.connect();
      this.client = c;
      c.on('notification', (m) => {
        if (m.channel === CONFIG_NOTIFY_CHANNEL) this.background();
      });
      c.on('error', (e) => {
        this.o.onError?.(e);
        this.dropClient(); // the poll keeps working; the next poll tick re-listens
      });
      await c.query(`LISTEN ${CONFIG_NOTIFY_CHANNEL}`);
      // Anything published between the first load and the LISTEN.
      this.background();
    } catch (e) {
      this.o.onError?.(e);
      this.dropClient();
    }
  }

  private dropClient(): void {
    const c = this.client;
    this.client = null;
    c?.removeAllListeners();
    try {
      c?.release(true);
    } catch {
      /* already released */
    }
  }

  /** Stops the timer and releases the LISTEN connection. Safe to call twice. */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    const c = this.client;
    if (c) {
      this.client = null;
      c.removeAllListeners();
      await c.query('UNLISTEN *').catch(() => undefined);
      c.release();
    }
    await this.inFlight?.catch(() => undefined);
  }
}

async function loadSnapshot(o: ConfigReaderOptions): Promise<EffectiveConfig> {
  if (o.catchUp !== false) {
    const caught = await runProjection(o.pool, configProjection);
    if (!caught.ok) throw new Error(`config projection: ${JSON.stringify(caught.error)}`);
  }
  const factory = await loadEffective(o.pool, { layer: 'factory', scope: FACTORY_SCOPE });
  const projectLineage: ConfigLineage | null = o.project
    ? { layer: 'project', scope: { kind: 'project', ref: o.project } }
    : null;
  const project = projectLineage ? await loadEffective(o.pool, projectLineage) : null;

  const values: Record<string, unknown> = { ...o.registry.defaults() };
  const rejected: string[] = [];
  const apply = (doc: Record<string, unknown> | undefined, layer: 'factory' | 'project') => {
    for (const [key, raw] of Object.entries(doc ?? {})) {
      const def = o.registry.get(key);
      // A key this consumer does not know is not exposed: unknown means unmet.
      if (!def) continue;
      if (layer === 'project' && !def.overridable) continue;
      const parsed = def.schema.safeParse(raw);
      if (parsed.success) values[key] = parsed.data;
      else rejected.push(key);
    }
  };
  apply(factory?.doc, 'factory');
  apply(project?.doc, 'project');

  const revisions = { factory: factory?.rev_hash ?? null, project: project?.rev_hash ?? null };
  const frozen = Object.freeze({ ...values });
  return Object.freeze({
    values: frozen,
    revisions: Object.freeze(revisions),
    token: hashCanonical(revisions),
    rejected: Object.freeze(rejected.sort()),
    get: <T = unknown>(key: string) => frozen[key] as T | undefined,
  });
}
