import {
  OPS_ALERT_EVENT,
  OPS_ALERT_SUBJECT_CHECKPOINT,
  opsAlertStream,
  type HealthSnapshot,
} from '@aisdlc/contracts';
import { newId } from '@aisdlc/kernel';
import { appendLedgerEntry } from '@aisdlc/ledger';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AlertTracker, checkpointLag, verdictOf } from '../src/alerts.js';
import { startCoreStack, type CoreStack } from '../src/testing.js';

// RC-NOT-3 on a real Postgres: a tile that reads bad for a minute (a service down or degraded, a loop stalled) and a
// ledger checkpoint that is overdue become ONE `ops.alert_raised` each on the subject's own stream, and
// `ops.alert_cleared` when the subject reads healthy; the notifier pages the factory admins from the raise.

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
}, 120_000);
afterAll(async () => s?.stop());

const snap = (
  tile_id: string,
  state: HealthSnapshot['state'],
  domain: HealthSnapshot['domain'] = 'service',
  detail_code: string | null = state === 'down' ? 'unreachable' : 'ok',
): HealthSnapshot => ({
  tile_id,
  domain,
  state,
  detail_code,
  sli_value: null,
  reporter: 'core-worker',
  as_of: '2026-11-12T10:00:00.000Z',
});

const eventsOf = async (subject: string) =>
  (
    await s.record.pool.query<{ type: string; body: Record<string, unknown> }>(
      `SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq`,
      [opsAlertStream(subject)],
    )
  ).rows;

const at = (ms: number) => new Date(Date.parse('2026-11-12T10:00:00.000Z') + ms);

describe('alerts to a person (RC-NOT-3)', () => {
  it('reads a verdict per tile: a degraded loop pages nobody, a down one does; unknown neither', () => {
    expect(verdictOf(snap('service.notary', 'down'))).toEqual({
      bad: 'service_down',
      code: 'unreachable',
    });
    expect(verdictOf(snap('service.gateway', 'degraded'))).toMatchObject({
      bad: 'service_degraded',
    });
    expect(verdictOf(snap('loop.core-worker.x', 'degraded', 'loop'))).toBe('unknown');
    expect(verdictOf(snap('loop.core-worker.x', 'down', 'loop', 'stalled'))).toEqual({
      bad: 'loop_stalled',
      code: 'stalled',
    });
    expect(verdictOf(snap('service.bff', 'unknown'))).toBe('unknown');
  });

  it('raises once after a minute of bad readings, clears when healthy, raises a new episode again', async () => {
    const t = new AlertTracker({ afterMs: 60_000 });
    const notary = [
      snap('service.notary', 'down'),
      snap('loop.core-worker.drive', 'down', 'loop', 'stalled'),
    ];
    const ev = (ms: number, xs = notary) =>
      t.evaluate(s.record.pool, xs, at(ms), { checkpoint: false });
    expect(await ev(0)).toEqual({ raised: [], cleared: [] });
    expect(await ev(30_000)).toEqual({ raised: [], cleared: [] });
    expect((await ev(60_000)).raised.sort()).toEqual(['loop.core-worker.drive', 'service.notary']);
    expect(await ev(90_000)).toEqual({ raised: [], cleared: [] });
    const [r] = await eventsOf('service.notary');
    expect(r?.type).toBe(OPS_ALERT_EVENT.raised);
    expect(r?.body).toMatchObject({
      subject: 'service.notary',
      kind: 'service_down',
      detail_code: 'unreachable',
      since: '2026-11-12T10:00:00.000Z',
    });
    // an unknown reading neither clears nor raises
    expect(await ev(120_000, [snap('service.notary', 'unknown')])).toEqual({
      raised: [],
      cleared: [],
    });
    expect(await ev(150_000, [snap('service.notary', 'ok')])).toEqual({
      raised: [],
      cleared: ['service.notary'],
    });
    // a new episode is a new alert
    await ev(200_000, [snap('service.notary', 'down')]);
    expect((await ev(260_000, [snap('service.notary', 'down')])).raised).toEqual([
      'service.notary',
    ]);
    const all = await eventsOf('service.notary');
    expect(all.map((e) => e.type)).toEqual([
      OPS_ALERT_EVENT.raised,
      OPS_ALERT_EVENT.cleared,
      OPS_ALERT_EVENT.raised,
    ]);
    expect(all[0]?.body['alert_id']).not.toBe(all[2]?.body['alert_id']);
    expect(all[1]?.body['alert_id']).toBe(all[0]?.body['alert_id']);
  });

  it('pages when ledger entries wait behind the newest checkpoint for too long', async () => {
    const w = await appendLedgerEntry(s.record.pool, s.id.ledger, {
      entry_id: newId() as never,
      entry_type: 'test.alert',
      gate_instance_id: null,
      gate_id: null,
      subject_kind: null,
      subject_id: null,
      subject_hash: null,
      decision: null,
      actor: 'system.test' as never,
      sod_waiver: false,
      policy_bundle_version: 'test',
      created_at: '2026-11-12T10:00:00.000Z',
      body: {},
    } as never);
    if (!w.ok) throw new Error(JSON.stringify(w.error));
    const lag = await checkpointLag(s.record.pool);
    expect(lag).not.toBeNull();
    const t = new AlertTracker({ checkpointOverdueMs: 15 * 60_000 });
    const since = (lag?.uncovered_since as Date).getTime();
    expect((await t.evaluate(s.record.pool, [], new Date(since + 60_000))).raised).toEqual([]);
    expect((await t.evaluate(s.record.pool, [], new Date(since + 15 * 60_000))).raised).toEqual([
      OPS_ALERT_SUBJECT_CHECKPOINT,
    ]);
    const [e] = await eventsOf(OPS_ALERT_SUBJECT_CHECKPOINT);
    expect(e?.body).toMatchObject({ kind: 'checkpoint_overdue', subject: 'ledger.checkpoint' });
  });
});
