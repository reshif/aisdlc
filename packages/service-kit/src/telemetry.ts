import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { ServiceConfigError } from './auth.js';
import type { Env } from './config.js';

// Telemetry (PLAN M19; ADR-0003 §2 "one OpenTelemetry collector"): every service built on this kit can export its
// HTTP server spans and request metrics to the collector as OTLP/HTTP JSON. It is a small exporter of our own, not the
// OpenTelemetry SDK: two fixed signals, no dependency, and it decides exactly what leaves the process.
//
// What it sends is content-free: per request the method, the ROUTE TEMPLATE (`/v1/items/:id`, never the path with its
// ids, never the query), the status code and the duration, plus the trace and span ids (a W3C `traceparent` from the
// caller is continued). Never a header, a body, a principal or a token. It is off unless
// `OTEL_EXPORTER_OTLP_ENDPOINT` is set; it never blocks or fails a request: the spans wait in a bounded queue (the
// oldest dropped and counted when it is full), each export has a deadline, and an export that fails is counted and
// dropped (the collector being down loses telemetry, never work).

export interface TelemetryConfig {
  /** The collector's OTLP/HTTP base URL (`/v1/traces` and `/v1/metrics` are appended). */
  readonly endpoint: string;
  readonly serviceName: string;
  /** How often spans and metrics are sent (ms). */
  readonly exportIntervalMs: number;
  /** Spans kept while waiting for an export; beyond it the oldest are dropped. */
  readonly maxQueue: number;
  readonly timeoutMs: number;
}

const SERVICE_NAME = /^[a-z][a-z0-9-]{0,47}$/;

/**
 * The switch: `OTEL_EXPORTER_OTLP_ENDPOINT` (http(s); unset or empty: off), `OTEL_SERVICE_NAME` (default
 * `defaultName`), `OTEL_METRIC_EXPORT_INTERVAL` (ms, default 15000), `OTEL_BSP_MAX_QUEUE_SIZE` (default 2048).
 */
export function telemetryFromEnv(env: Env, defaultName: string): TelemetryConfig | null {
  const raw = env['OTEL_EXPORTER_OTLP_ENDPOINT'];
  if (raw === undefined || raw === '') return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new ServiceConfigError('OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL');
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || u.username || u.password) {
    throw new ServiceConfigError(
      'OTEL_EXPORTER_OTLP_ENDPOINT must be an http(s) URL without credentials',
    );
  }
  const name = env['OTEL_SERVICE_NAME'] || defaultName;
  if (!SERVICE_NAME.test(name)) {
    throw new ServiceConfigError('OTEL_SERVICE_NAME must be [a-z0-9-], 1 to 48 characters');
  }
  const int = (k: string, dflt: number, min: number): number => {
    const v = env[k];
    if (v === undefined || v === '') return dflt;
    const n = Number(v);
    if (!Number.isInteger(n) || n < min) {
      throw new ServiceConfigError(`${k} must be an integer of at least ${min}`);
    }
    return n;
  };
  return {
    endpoint: u.toString().replace(/\/$/, ''),
    serviceName: name,
    exportIntervalMs: int('OTEL_METRIC_EXPORT_INTERVAL', 15_000, 100),
    maxQueue: int('OTEL_BSP_MAX_QUEUE_SIZE', 2_048, 1),
    timeoutMs: int('OTEL_EXPORTER_OTLP_TIMEOUT', 2_000, 100),
  };
}

/** A finished server span, as this exporter keeps it. */
export interface ServerSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly method: string;
  readonly route: string;
  readonly status: number;
  readonly startNs: bigint;
  readonly endNs: bigint;
}

/** The request duration buckets (seconds), the OpenTelemetry HTTP semantic-convention defaults. */
export const DURATION_BOUNDS_S = [
  0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 7.5, 10,
] as const;

interface Histogram {
  method: string;
  route: string;
  status: number;
  count: number;
  sum: number;
  buckets: number[];
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;
const ZERO_TRACE = '0'.repeat(32);
const ZERO_SPAN = '0'.repeat(16);

/** The trace a request continues, from its W3C `traceparent` header; `null`: a new trace. */
export function parentOf(header: unknown): { traceId: string; spanId: string } | null {
  if (typeof header !== 'string') return null;
  const m = TRACEPARENT.exec(header.trim());
  if (!m || m[1] === ZERO_TRACE || m[2] === ZERO_SPAN) return null;
  return { traceId: m[1] as string, spanId: m[2] as string };
}

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
const str = (key: string, v: string) => ({ key, value: { stringValue: v } });
const int = (key: string, v: number) => ({ key, value: { intValue: String(v) } });

export interface ExporterStats {
  readonly spans_exported: number;
  readonly spans_dropped: number;
  readonly exports_failed: number;
}

export class OtlpExporter {
  private queue: ServerSpan[] = [];
  private readonly hist = new Map<string, Histogram>();
  private readonly startNs = process.hrtime.bigint();
  private readonly startUnixNs = BigInt(Date.now()) * 1_000_000n;
  private s = { spans_exported: 0, spans_dropped: 0, exports_failed: 0 };
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> | null = null;

  constructor(
    private readonly cfg: TelemetryConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  /** Unix nanoseconds for a `process.hrtime.bigint()` reading. */
  unixNs(hr: bigint): bigint {
    return this.startUnixNs + (hr - this.startNs);
  }

  record(span: ServerSpan): void {
    const method = METHODS.has(span.method) ? span.method : 'OTHER';
    this.queue.push({ ...span, method });
    if (this.queue.length > this.cfg.maxQueue) {
      const over = this.queue.length - this.cfg.maxQueue;
      this.queue.splice(0, over);
      this.s.spans_dropped += over;
    }
    const key = `${method} ${span.route} ${span.status}`;
    let h = this.hist.get(key);
    if (!h) {
      h = {
        method,
        route: span.route,
        status: span.status,
        count: 0,
        sum: 0,
        buckets: new Array<number>(DURATION_BOUNDS_S.length + 1).fill(0),
      };
      this.hist.set(key, h);
    }
    const secs = Number(span.endNs - span.startNs) / 1e9;
    h.count += 1;
    h.sum += secs;
    let i = DURATION_BOUNDS_S.findIndex((b) => secs <= b);
    if (i < 0) i = DURATION_BOUNDS_S.length;
    h.buckets[i] = (h.buckets[i] ?? 0) + 1;
  }

  private resource() {
    return { attributes: [str('service.name', this.cfg.serviceName)] };
  }

  /** The OTLP/JSON trace request for some spans. */
  tracesBody(spans: readonly ServerSpan[]): unknown {
    return {
      resourceSpans: [
        {
          resource: this.resource(),
          scopeSpans: [
            {
              scope: { name: '@aisdlc/service-kit' },
              spans: spans.map((s) => ({
                traceId: s.traceId,
                spanId: s.spanId,
                ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
                name: `${s.method} ${s.route}`,
                kind: 2,
                startTimeUnixNano: this.unixNs(s.startNs).toString(),
                endTimeUnixNano: this.unixNs(s.endNs).toString(),
                attributes: [
                  str('http.request.method', s.method),
                  str('http.route', s.route),
                  int('http.response.status_code', s.status),
                ],
                status: { code: s.status >= 500 ? 2 : 0 },
              })),
            },
          ],
        },
      ],
    };
  }

  /** The OTLP/JSON metrics request: the request duration histogram, cumulative since start. */
  metricsBody(nowUnixNs: bigint = BigInt(Date.now()) * 1_000_000n): unknown {
    return {
      resourceMetrics: [
        {
          resource: this.resource(),
          scopeMetrics: [
            {
              scope: { name: '@aisdlc/service-kit' },
              metrics: [
                {
                  name: 'http.server.request.duration',
                  unit: 's',
                  histogram: {
                    aggregationTemporality: 2,
                    dataPoints: [...this.hist.values()].map((h) => ({
                      attributes: [
                        str('http.request.method', h.method),
                        str('http.route', h.route),
                        int('http.response.status_code', h.status),
                      ],
                      startTimeUnixNano: this.startUnixNs.toString(),
                      timeUnixNano: nowUnixNs.toString(),
                      count: String(h.count),
                      sum: h.sum,
                      bucketCounts: h.buckets.map(String),
                      explicitBounds: [...DURATION_BOUNDS_S],
                    })),
                  },
                },
              ],
            },
          ],
        },
      ],
    };
  }

  private async post(path: string, body: unknown): Promise<boolean> {
    try {
      const res = await this.fetchImpl(`${this.cfg.endpoint}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.cfg.timeoutMs),
      });
      await res.arrayBuffer().catch(() => undefined);
      return res.ok;
    } catch {
      return false;
    }
  }

  /** Sends what waits (spans, then the metrics). Never throws; one flush at a time. */
  flush(): Promise<void> {
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      const spans = this.queue;
      this.queue = [];
      if (spans.length > 0) {
        if (await this.post('/v1/traces', this.tracesBody(spans))) {
          this.s.spans_exported += spans.length;
        } else {
          this.s.exports_failed += 1;
          this.s.spans_dropped += spans.length;
        }
      }
      if (this.hist.size > 0 && !(await this.post('/v1/metrics', this.metricsBody()))) {
        this.s.exports_failed += 1;
      }
    })().finally(() => {
      this.flushing = null;
    });
    return this.flushing;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.cfg.exportIntervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.flush();
  }

  stats(): ExporterStats {
    return { ...this.s };
  }
}

const hex = (bytes: number): string => randomBytes(bytes).toString('hex');

/**
 * Records a server span for every request of `app` (the route template only) and flushes on close. Called by `listen`
 * when the service has telemetry configured; a hook added after the routes still applies to them.
 */
export function instrumentApp(app: FastifyInstance, exporter: OtlpExporter): void {
  const started = new WeakMap<
    object,
    { at: bigint; parent: { traceId: string; spanId: string } | null }
  >();
  app.addHook('onRequest', async (req) => {
    started.set(req, { at: process.hrtime.bigint(), parent: parentOf(req.headers.traceparent) });
  });
  app.addHook('onResponse', async (req, reply) => {
    const s = started.get(req);
    if (!s) return;
    // an unmatched path is one route ("not found"), so a scan of random paths cannot grow the metrics
    const route = req.routeOptions.url ?? '<unmatched>';
    exporter.record({
      traceId: s.parent?.traceId ?? hex(16),
      spanId: hex(8),
      parentSpanId: s.parent?.spanId ?? null,
      method: req.method,
      route,
      status: reply.statusCode,
      startNs: s.at,
      endNs: process.hrtime.bigint(),
    });
  });
  app.addHook('onClose', async () => {
    await exporter.stop();
  });
  exporter.start();
}
