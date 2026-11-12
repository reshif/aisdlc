import { describe, expect, it } from 'vitest';
import {
  OtlpExporter,
  ServiceConfigError,
  instrumentApp,
  listen,
  listenConfig,
  newApp,
  parentOf,
  telemetryFromEnv,
  type TelemetryConfig,
} from '../src/index.js';

// M19: the OTLP/HTTP JSON exporter. Off unless OTEL_EXPORTER_OTLP_ENDPOINT is set; per request it sends the route
// TEMPLATE, the method, the status and the duration (never the path's ids, the query, a header or a body); a caller's
// traceparent is continued; the collector being down never touches a request.

type Json = Record<string, unknown>;

async function fakeCollector() {
  const got: { traces: Json[]; metrics: Json[] } = { traces: [], metrics: [] };
  const app = newApp();
  let status = 200;
  app.post('/v1/traces', async (req, reply) => {
    got.traces.push(req.body as Json);
    return reply.code(status).send({});
  });
  app.post('/v1/metrics', async (req, reply) => {
    got.metrics.push(req.body as Json);
    return reply.code(status).send({});
  });
  const url = await listen(app);
  return {
    url,
    got,
    setStatus: (s: number) => {
      status = s;
    },
    close: () => app.close(),
  };
}

const cfg = (endpoint: string, over: Partial<TelemetryConfig> = {}): TelemetryConfig => ({
  endpoint,
  serviceName: 'core',
  exportIntervalMs: 600_000,
  maxQueue: 100,
  timeoutMs: 1_000,
  ...over,
});

/* eslint-disable @typescript-eslint/no-explicit-any -- walking OTLP JSON in assertions */
const spansOf = (body: any): any[] => body.resourceSpans[0].scopeSpans[0].spans;
const attrs = (o: any): Record<string, unknown> =>
  Object.fromEntries(
    o.attributes.map((a: any) => [a.key, a.value.stringValue ?? a.value.intValue]),
  );

describe('telemetryFromEnv: the switch', () => {
  it('off without an endpoint; on with one, named after the service prefix', () => {
    expect(telemetryFromEnv({}, 'core')).toBeNull();
    expect(telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: '' }, 'core')).toBeNull();
    expect(
      telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://otel-collector:4318/' }, 'core'),
    ).toEqual({
      endpoint: 'http://otel-collector:4318',
      serviceName: 'core',
      exportIntervalMs: 15_000,
      maxQueue: 2_048,
      timeoutMs: 2_000,
    });
    expect(
      listenConfig(
        { CORE_WORKER_PORT: '1', OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318' },
        'CORE_WORKER',
        8360,
      ).telemetry?.serviceName,
    ).toBe('core-worker');
    expect(listenConfig({}, 'CORE', 8380)).toEqual({ host: '127.0.0.1', port: 8380 });
  });

  it('refuses an endpoint that is not plain http(s), credentials in it, or a bad name', () => {
    for (const e of ['nope', 'ftp://c:4318', 'http://u:p@c:4318']) {
      expect(() => telemetryFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: e }, 'core')).toThrow(
        ServiceConfigError,
      );
    }
    expect(() =>
      telemetryFromEnv(
        { OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SERVICE_NAME: 'Bad Name' },
        'core',
      ),
    ).toThrow(/OTEL_SERVICE_NAME/);
  });
});

describe('parentOf: the W3C traceparent', () => {
  it('continues a valid one, starts a new trace otherwise', () => {
    const t = '4bf92f3577b34da6a3ce929d0e0e4736';
    expect(parentOf(`00-${t}-00f067aa0ba902b7-01`)).toEqual({
      traceId: t,
      spanId: '00f067aa0ba902b7',
    });
    expect(parentOf(`00-${'0'.repeat(32)}-00f067aa0ba902b7-01`)).toBeNull();
    expect(parentOf('garbage')).toBeNull();
    expect(parentOf(undefined)).toBeNull();
  });
});

describe('the exporter on a service', () => {
  it('exports a server span per request with the route template only, and the duration histogram', async () => {
    const col = await fakeCollector();
    const app = newApp();
    app.get('/v1/items/:id', async () => ({ ok: true }));
    app.post('/v1/fail', async (_req, reply) => reply.code(503).send({}));
    const exporter = new OtlpExporter(cfg(col.url));
    instrumentApp(app, exporter);
    const url = await listen(app);
    try {
      const parent = '4bf92f3577b34da6a3ce929d0e0e4736';
      await fetch(new URL('/v1/items/0193-secret-id?token=abc', url), {
        headers: { traceparent: `00-${parent}-00f067aa0ba902b7-01`, authorization: 'Bearer x' },
      });
      await fetch(new URL('/v1/fail', url), { method: 'POST', body: 'secret body' });
      await fetch(new URL('/no/such/path/123', url));
      await exporter.flush();
      const spans = spansOf(col.got.traces[0]);
      expect(spans.map((s) => s.name)).toEqual([
        'GET /v1/items/:id',
        'POST /v1/fail',
        'GET <unmatched>',
      ]);
      expect(spans[0]).toMatchObject({
        traceId: parent,
        parentSpanId: '00f067aa0ba902b7',
        kind: 2,
      });
      expect(attrs(spans[0])).toEqual({
        'http.request.method': 'GET',
        'http.route': '/v1/items/:id',
        'http.response.status_code': '200',
      });
      expect(spans[1].status.code).toBe(2);
      expect(spans[2].traceId).toMatch(/^[0-9a-f]{32}$/);
      // nothing of the request's content left the process
      const wire = JSON.stringify(col.got);
      for (const leak of ['secret-id', 'token=abc', 'Bearer', 'secret body', '/no/such'])
        expect(wire).not.toContain(leak);
      expect((col.got.traces[0] as any).resourceSpans[0].resource.attributes[0]).toEqual({
        key: 'service.name',
        value: { stringValue: 'core' },
      });
      const metric = (col.got.metrics[0] as any).resourceMetrics[0].scopeMetrics[0].metrics[0];
      expect(metric.name).toBe('http.server.request.duration');
      expect(metric.histogram.aggregationTemporality).toBe(2);
      const points = metric.histogram.dataPoints as any[];
      expect(points).toHaveLength(3);
      for (const p of points) {
        expect(p.bucketCounts).toHaveLength(p.explicitBounds.length + 1);
        expect(p.count).toBe('1');
      }
      expect(exporter.stats()).toMatchObject({ spans_exported: 3, exports_failed: 0 });
    } finally {
      await app.close();
      await col.close();
    }
  });

  it('the collector down or refusing never fails a request; the loss is counted', async () => {
    const col = await fakeCollector();
    col.setStatus(500);
    const app = newApp();
    app.get('/x', async () => ({ ok: true }));
    const exporter = new OtlpExporter(cfg(col.url));
    instrumentApp(app, exporter);
    const url = await listen(app);
    try {
      expect((await fetch(new URL('/x', url))).status).toBe(200);
      await exporter.flush();
      expect(exporter.stats()).toMatchObject({ spans_exported: 0, spans_dropped: 1 });
      await col.close();
      expect((await fetch(new URL('/x', url))).status).toBe(200);
      await exporter.flush();
      expect(exporter.stats().exports_failed).toBeGreaterThanOrEqual(3);
    } finally {
      await app.close();
    }
  });

  it('a full queue drops the oldest spans, counted', () => {
    const e = new OtlpExporter(cfg('http://127.0.0.1:1', { maxQueue: 2 }));
    const span = (i: number) => ({
      traceId: 'a'.repeat(32),
      spanId: String(i).padStart(16, '0'),
      parentSpanId: null,
      method: 'GET',
      route: '/x',
      status: 200,
      startNs: 0n,
      endNs: 1_000_000n,
    });
    for (let i = 1; i <= 5; i++) e.record(span(i));
    expect(e.stats().spans_dropped).toBe(3);
    const spans = spansOf(e.tracesBody([span(4), span(5)]));
    expect(spans).toHaveLength(2);
  });

  it('listen instruments the app when the listen options carry telemetry, and flushes on close', async () => {
    const col = await fakeCollector();
    const app = newApp();
    app.get('/healthz', async () => ({ ok: true }));
    const url = await listen(app, {
      ...listenConfig({ OTEL_EXPORTER_OTLP_ENDPOINT: col.url }, 'WITNESS', 0),
      port: 0,
    });
    await fetch(new URL('/healthz', url));
    await app.close();
    expect(spansOf(col.got.traces[0])[0].name).toBe('GET /healthz');
    expect(
      (col.got.traces[0] as any).resourceSpans[0].resource.attributes[0].value.stringValue,
    ).toBe('witness');
    await col.close();
  });
});
