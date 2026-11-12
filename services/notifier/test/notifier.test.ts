import { GATE_EVENT, NOTIFIER_EVENT, gateStream } from '@aisdlc/contracts';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { deliverOnce } from '../src/deliver.js';
import { raiseOnce } from '../src/raise.js';
import { listNotifications, rebuildNotifier, setPreferences } from '../src/store.js';
import {
  EMAIL_ROW,
  PROJECT,
  SLACK_ROW,
  escalatedCard,
  killObserved,
  startWorld,
  type World,
} from './fixture.js';

// PLAN M18, the notifier end to end on a real Postgres: record first (a notification is raised from the record, in
// one transaction with the cursor), at-least-once delivery under the delivery id with retries and backoff, the
// rendering capped by the channel's and the person's class, a failed channel blocking nothing, the read models
// rebuilt from the record, and the least-privilege role.

let w: World;

beforeAll(async () => {
  w = await startWorld();
  // the first pass only places the cursor at the record's head
  const first = await raiseOnce(w.raiseDeps());
  expect(first.read).toBe(0);
}, 120_000);
afterAll(async () => w?.stop());

beforeEach(() => {
  w.rows = [SLACK_ROW, EMAIL_ROW];
  w.slack.received.length = 0;
  w.email.received.length = 0;
  w.slack.setDown(false);
  w.email.setDown(false);
});

const drain = async () => {
  let total = 0;
  for (;;) {
    const r = await raiseOnce(w.raiseDeps());
    total += r.raised;
    if (r.read === 0) return total;
  }
};

const eventsOf = async (principal: string) =>
  (
    await w.db.pool.query<{ type: string; body: Record<string, unknown> }>(
      `SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq`,
      [`notifier:${principal}`],
    )
  ).rows;

describe('the notifier', () => {
  it('raises a gate waiting on its slot holders, active humans only, and delivers it at the allowed class', async () => {
    const gate = await w.gateOpened({ gate: 'G3d', slot: 'design' });
    expect(await drain()).toBe(1); // dana; `gone` is disabled
    const [n] = await listNotifications(w.rolePool, 'dana');
    expect(n?.content).toMatchObject({
      kind: 'gate_waiting',
      project_id: PROJECT,
      gate_id: 'G3d',
      gate_instance_id: gate,
    });
    expect(n?.reason).toBe('slot_holder');
    expect(n?.deliveries.map((d) => [d.channel_id, d.status])).toEqual([
      ['mail', 'pending'],
      ['team-slack', 'pending'],
    ]);
    expect(await listNotifications(w.rolePool, 'gone')).toEqual([]);

    const rep = await deliverOnce(w.deliverDeps());
    expect(rep).toEqual({ delivered: 2, failed: 0, given_up: 0 });
    // the D1 Slack channel names the project and the gate; the D0 mail channel says only "see the portal"
    const s = w.slack.received[0];
    expect(s?.text).toContain('G3d');
    expect(s?.text).toContain('project acme');
    expect(s?.text).toContain('https://factory.example/inbox');
    expect(s?.to).toEqual({ kind: 'slack', mention: null });
    const m = w.email.received[0];
    expect(m?.to).toEqual({ kind: 'email', address: 'dana@example.com' });
    expect(m?.text).not.toContain('acme');
    expect(m?.text).not.toContain('G3d');
    expect(m?.subject).toBe('AISDLC: Something waits for you in the factory portal');
    // the idempotency key of a delivery is its id
    const [after] = await listNotifications(w.rolePool, 'dana');
    expect(after?.deliveries.every((d) => d.status === 'delivered')).toBe(true);
    expect(w.slack.received.map((r) => r.idempotency_key)).toEqual(
      after?.deliveries.filter((d) => d.channel_id === 'team-slack').map((d) => d.delivery_id),
    );
  });

  it('raises nothing twice: the cursor moved in the same transaction, and a re-read keys on the source event', async () => {
    await w.gateOpened({ gate: 'G2', slot: 'x' });
    expect(await drain()).toBe(2); // xena and carol
    await w.db.pool.query('UPDATE notifier.source_cursor SET last_global_seq = 0');
    expect(await drain()).toBe(0);
    expect((await eventsOf('xena')).filter((e) => e.type === NOTIFIER_EVENT.raised)).toHaveLength(
      1,
    );
    await deliverOnce(w.deliverDeps());
  });

  it('does not notify about a gate that closed before it was read', async () => {
    const gate = await w.gateOpened({ gate: 'G4', slot: 'x' });
    await w.append(gateStream(gate), GATE_EVENT.closed, { outcome: 'approve' });
    expect(await drain()).toBe(0);
  });

  it('retries a failed channel with backoff, delivers the other channel at once, and gives up after the attempts', async () => {
    await w.gateOpened({ gate: 'Q1', slot: 'sec' });
    expect(await drain()).toBe(1);
    w.slack.setDown(true);
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 1, failed: 1, given_up: 0 });
    const [n] = await listNotifications(w.rolePool, 'sam');
    expect(n?.content.kind).toBe('quarantine');
    const slack = n?.deliveries.find((d) => d.channel_id === 'team-slack');
    expect(slack).toMatchObject({ status: 'pending', attempts: 1, last_error: 'unreachable' });
    expect(slack?.next_attempt_at).toBe('2026-11-12T10:00:01.000Z');
    // not due yet: nothing is tried
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 0, failed: 0, given_up: 0 });
    w.clock.advance(1_000);
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 0, failed: 1, given_up: 0 });
    w.clock.advance(2_000);
    // the third attempt is the last (FAST_RETRY.maxAttempts = 3)
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 0, failed: 0, given_up: 1 });
    const [gone] = await listNotifications(w.rolePool, 'sam');
    expect(gone?.deliveries.find((d) => d.channel_id === 'team-slack')).toMatchObject({
      status: 'given_up',
      attempts: 3,
      next_attempt_at: null,
    });
    // the failure events carry a code and a time, nothing the channel said
    const failed = (await eventsOf('sam')).filter((e) => e.type === NOTIFIER_EVENT.failed);
    expect(failed.map((e) => e.body['error_code'])).toEqual([
      'unreachable',
      'unreachable',
      'unreachable',
    ]);
    expect(failed.at(-1)?.body['retry_at']).toBeNull();
  });

  it('delivers at least once: a transient failure then a success under the same key', async () => {
    await w.gateOpened({ gate: 'E4', slot: 'admin' });
    expect(await drain()).toBe(1);
    w.slack.failNext(1, 'server_error', true);
    await deliverOnce(w.deliverDeps());
    w.clock.advance(1_000);
    await deliverOnce(w.deliverDeps());
    const [n] = await listNotifications(w.rolePool, 'root');
    expect(n?.content.kind).toBe('handoff');
    const d = n?.deliveries.find((x) => x.channel_id === 'team-slack');
    expect(d).toMatchObject({ status: 'delivered', attempts: 2 });
    expect(w.slack.received.map((r) => r.idempotency_key)).toEqual([d?.delivery_id]);
  });

  it('gives up at once on a permanent refusal, a missing channel or a disabled one', async () => {
    await w.gateOpened({ gate: 'G5', slot: 'sec' });
    expect(await drain()).toBe(1);
    w.slack.failNext(1, 'rejected', false);
    w.rows = [SLACK_ROW, { ...EMAIL_ROW, enabled: false }];
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 0, failed: 0, given_up: 2 });
    const [n] = await listNotifications(w.rolePool, 'sam');
    expect(n?.deliveries.map((d) => [d.channel_id, d.status, d.last_error])).toEqual([
      ['mail', 'given_up', 'channel_disabled'],
      ['team-slack', 'given_up', 'rejected'],
    ]);
  });

  it('waits (does not give up early) while the channel rows cannot be read', async () => {
    await w.gateOpened({ gate: 'G6', slot: 'sec' });
    expect(await drain()).toBe(1);
    w.rows = null;
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 0, failed: 2, given_up: 0 });
    w.rows = [SLACK_ROW, EMAIL_ROW];
    w.clock.advance(1_000);
    expect(await deliverOnce(w.deliverDeps())).toEqual({ delivered: 2, failed: 0, given_up: 0 });
  });

  it('follows the person’s preferences: muted kinds, chosen channels, a Slack mention', async () => {
    await setPreferences(
      w.rolePool,
      'xena',
      { channels: ['team-slack'], muted_kinds: ['sla_escalated'], slack_member_id: 'U0XENA1' },
      w.clock,
    );
    await setPreferences(
      w.rolePool,
      'carol',
      { channels: [], muted_kinds: [], slack_member_id: null },
      w.clock,
    );
    await w.gateOpened({ gate: 'X1', slot: 'x' });
    expect(await drain()).toBe(2);
    const [x] = await listNotifications(w.rolePool, 'xena');
    expect(x?.deliveries.map((d) => d.channel_id)).toEqual(['team-slack']);
    const [c] = await listNotifications(w.rolePool, 'carol');
    // the inbox only: a notification with no delivery
    expect(c?.content.gate_id).toBe('X1');
    expect(c?.deliveries).toEqual([]);
    await deliverOnce(w.deliverDeps());
    expect(w.slack.received.at(-1)?.to).toEqual({ kind: 'slack', mention: 'U0XENA1' });
  });

  it('raises B21: the backup the escalation named and the card’s own slot again', async () => {
    const gate = await w.gateOpened({ gate: 'G3', slot: 'design' });
    await drain();
    await escalatedCard(w, { gate, backup: ['root'] });
    expect(await drain()).toBe(2);
    const [r] = await listNotifications(w.rolePool, 'root');
    expect(r?.content).toMatchObject({
      kind: 'sla_escalated',
      gate_id: 'G3d',
      project_id: PROJECT,
    });
    expect(r?.reason).toBe('escalated_backup');
    const [d] = await listNotifications(w.rolePool, 'dana');
    expect(d?.content.kind).toBe('sla_escalated');
    expect(d?.reason).toBe('slot_holder');
    await deliverOnce(w.deliverDeps());
  });

  it('raises a kill: the project’s admin and kill slots, or the factory admins for the fleet; never the reason', async () => {
    await killObserved(w, {
      seq: 1,
      kind: 'kill.requested',
      scope: { kind: 'project', ref: PROJECT },
    });
    await killObserved(w, { seq: 2, kind: 'kill.released', scope: { kind: 'fleet', ref: '*' } });
    // muting a kill is refused by the schema; root and carol for the project, fran for the fleet
    expect(await drain()).toBe(3);
    const [k] = await listNotifications(w.rolePool, 'carol');
    expect(k?.content).toMatchObject({
      kind: 'kill_engaged',
      project_id: PROJECT,
      link_path: '/kill',
    });
    const [f] = await listNotifications(w.rolePool, 'fran');
    expect(f?.content).toMatchObject({ kind: 'kill_released', project_id: null });
    expect(f?.reason).toBe('factory_admin');
    await deliverOnce(w.deliverDeps());
    const all = JSON.stringify([...w.slack.received, ...w.email.received]);
    expect(all).not.toContain('free-text reason');
    expect(all).toContain('Kill switch released on the whole factory');
    const raised = await w.db.pool.query<{ body: unknown }>(
      `SELECT body FROM record.record_event WHERE stream LIKE 'notifier:%'`,
    );
    expect(JSON.stringify(raised.rows)).not.toContain('free-text reason');
    // no address is ever recorded
    expect(JSON.stringify(raised.rows)).not.toContain('@example.com');
  });

  it('rebuilds the read models from the record alone, equal to the live ones', async () => {
    const snap = async () =>
      (
        await w.db.pool.query(
          `SELECT n.notification_id, n.principal_id, n.kind, n.content, n.data_class, d.delivery_id, d.status, d.attempts,
                  d.last_error, d.next_attempt_at, d.delivered_at, d.rendered_class
             FROM notifier.notification n LEFT JOIN notifier.delivery d USING (notification_id)
            ORDER BY n.notification_id, d.delivery_id`,
        )
      ).rows;
    const prefs = async () =>
      (await w.db.pool.query('SELECT * FROM notifier.preference ORDER BY principal_id')).rows;
    const live = [await snap(), await prefs()];
    expect(await rebuildNotifier(w.db.pool)).toBeGreaterThan(10);
    expect([await snap(), await prefs()]).toEqual(live);
  });
});

describe('the notifier role (least privilege)', () => {
  it('reads only what it notifies about and appends only its own streams', async () => {
    const q = (sql: string) => w.rolePool.query(sql);
    for (const t of ['ledger.ledger_entry', 'core.repo', 'decisions.inbox_card', 'record.outbox']) {
      await expect(q(`SELECT 1 FROM ${t} LIMIT 1`), t).rejects.toThrow(/permission denied/);
    }
    // row-level security: no item stream is visible, a gate's votes neither
    await w.append(`item:${'0'.repeat(8)}-0000-7000-8000-000000000000`, 'item.created', { x: 1 });
    const seen = await q(
      `SELECT DISTINCT split_part(stream, ':', 1) AS s FROM record.record_event`,
    );
    expect(seen.rows.map((r) => r.s).sort()).toEqual([
      'card',
      'gate',
      'kill',
      'notifier',
      'notifier-pref',
    ]);
    await expect(
      q(
        `INSERT INTO record.record_event (stream, seq, event_id, type, body, actor, occurred_at, prev_hash, hash)
         VALUES ('item:x', 1, gen_random_uuid(), 't', '{}', 'a', now(), '', '')`,
      ),
    ).rejects.toThrow(/row-level security|permission denied|violates/);
    await expect(q('DELETE FROM notifier.notification')).rejects.toThrow(/permission denied/);
  });
});
