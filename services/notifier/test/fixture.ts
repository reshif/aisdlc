import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CARD_EVENT,
  GATE_EVENT,
  KILL_OBSERVED_EVENT,
  KILL_OBSERVED_STREAM,
  cardStream,
  gateStream,
  type EmailSmtpChannel,
  type GateId,
  type NotificationChannelRow,
  type RoleSlot,
  type SlackWebhookChannel,
} from '@aisdlc/contracts';
import { createPool, migrate, withTransaction } from '@aisdlc/db';
import { createTestDatabase, type TestDatabase } from '@aisdlc/db/testing';
import { identityProjection } from '@aisdlc/identity/read';
import {
  bindProject,
  grantFleetRole,
  linkEmail,
  seedPrincipals,
  setStatusForTest,
} from '@aisdlc/identity/testing';
import { manualClock, newId, type ManualClock } from '@aisdlc/kernel';
import { FakeNotificationChannel, FakeProjectSettings } from '@aisdlc/ports';
import { appendEvents, runProjection, type JsonObject } from '@aisdlc/record';
import type pg from 'pg';
import type { ChannelFactory } from '../src/channels.js';
import type { DeliverDeps, RetryPolicy } from '../src/deliver.js';
import type { RaiseDeps } from '../src/raise.js';
import { IdentityRecipients } from '../src/recipients.js';

// The world of the notifier tests (PLAN M18): ONE real Postgres with the WHOLE migrate plan, identity's real read
// model (principals, the role-map reconcile, a fleet grant, email links) folded from identity's own journal, the
// notifier running as a least-privilege login role in `aisdlc_notifier`, and fake channels behind the port. Source
// events are appended to the record as their owners would (gate, card and kill streams).

export const PROJECT = 'acme';
export const T0 = '2026-11-12T10:00:00.000Z';
const planDir = join(import.meta.dirname, '..', '..', '..', 'packages', 'migrate');

export const SLACK_ROW: SlackWebhookChannel = {
  channel_id: 'team-slack',
  kind: 'slack_webhook',
  display_name: 'Team channel',
  enabled: true,
  data_class_max: 'D1',
  default_on: true,
  webhook_ref: 'file:/run/secrets/slack-team',
};
export const EMAIL_ROW: EmailSmtpChannel = {
  channel_id: 'mail',
  kind: 'email_smtp',
  display_name: 'Email',
  enabled: true,
  data_class_max: 'D0',
  default_on: true,
  host: 'smtp.example.com',
  port: 587,
  tls: 'starttls',
  from: 'factory@example.com',
  username_ref: null,
  password_ref: null,
};

export const FAST_RETRY: RetryPolicy = { maxAttempts: 3, baseDelayMs: 1_000, maxDelayMs: 10_000 };

export interface World {
  readonly db: TestDatabase;
  readonly rolePool: pg.Pool;
  readonly roleUrl: string;
  readonly clock: ManualClock;
  readonly slack: FakeNotificationChannel;
  readonly email: FakeNotificationChannel;
  rows: NotificationChannelRow[] | null;
  readonly factory: ChannelFactory;
  raiseDeps(over?: Partial<RaiseDeps>): RaiseDeps;
  deliverDeps(over?: Partial<DeliverDeps>): DeliverDeps;
  /** Appends a source event as its owner would (the test database's owner role). */
  append(stream: string, type: string, body: object): Promise<void>;
  gateOpened(o: { gate: GateId; slot: RoleSlot; id?: string }): Promise<string>;
  stop(): Promise<void>;
}

const urlFor = (url: string, user: string, password: string) => {
  const u = new URL(url);
  u.username = user;
  u.password = password;
  return u.toString();
};

/** `start`: the clock the world is seeded at (default T0); a test of the booted service passes the real time. */
export async function startWorld(o: { start?: string } = {}): Promise<World> {
  const stoppers: Array<() => Promise<void>> = [];
  const db = await createTestDatabase();
  stoppers.push(() => db.drop());
  const plan = JSON.parse(readFileSync(join(planDir, 'plan.json'), 'utf8')) as {
    databases: { record: Array<{ scope: string; dir: string }> };
  };
  for (const e of plan.databases.record)
    await migrate(db.pool, { scope: e.scope, dir: join(planDir, e.dir) });
  const clock = manualClock(o.start ?? T0);

  // identity: people, a project's role map (reconciled into bindings), a factory admin, email links
  const ideps = { pool: db.pool, clock };
  await seedPrincipals(ideps, ['root', 'dana', 'xena', 'carol', 'sam', 'fran', 'gone']);
  const settings = new FakeProjectSettings();
  await bindProject({ deps: ideps, settings }, PROJECT, {
    admin: ['root'],
    design: ['dana', 'gone'],
    x: ['xena', 'carol'],
    sec: ['sam'],
    kill: ['carol'],
  });
  await grantFleetRole(ideps, 'fran', 'factory.admin');
  for (const p of ['root', 'dana', 'xena', 'carol', 'sam', 'fran'])
    await linkEmail(ideps, p, `${p}@example.com`);
  await setStatusForTest(ideps, 'gone', 'disabled');
  const folded = await runProjection(db.pool, identityProjection);
  if (!folded.ok) throw new Error('identity projection');

  const roleName = `nt_lp_${randomBytes(4).toString('hex')}`;
  const pw = randomBytes(12).toString('hex');
  await db.pool.query(`CREATE ROLE ${roleName} LOGIN PASSWORD '${pw}' IN ROLE aisdlc_notifier`);
  await db.pool.query(`GRANT CONNECT ON DATABASE "${db.name}" TO ${roleName}`);
  const roleUrl = urlFor(db.url, roleName, pw);
  const rolePool = createPool(roleUrl, 4);
  stoppers.push(() => rolePool.end());

  const slack = new FakeNotificationChannel('slack_webhook');
  const email = new FakeNotificationChannel('email_smtp');
  const world: World = {
    db,
    rolePool,
    roleUrl,
    clock,
    slack,
    email,
    rows: [SLACK_ROW, EMAIL_ROW],
    factory: (row) => ({ ok: true, port: row.kind === 'slack_webhook' ? slack : email }),
    raiseDeps: (over = {}) => ({
      pool: rolePool,
      recipients: new IdentityRecipients(rolePool, clock),
      channels: () => world.rows,
      clock,
      ...over,
    }),
    deliverDeps: (over = {}) => ({
      pool: rolePool,
      recipients: new IdentityRecipients(rolePool, clock),
      channels: () => world.rows,
      factory: world.factory,
      portalUrl: 'https://factory.example',
      retry: FAST_RETRY,
      clock,
      ...over,
    }),
    append: async (stream, type, body) => {
      await withTransaction(db.pool, async (tx) => {
        const head = await tx.query<{ seq: string }>(
          'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
          [stream],
        );
        const a = await appendEvents(
          tx,
          stream,
          Number(head.rows[0]?.seq ?? 0),
          [{ type, body: body as JsonObject, actor: 'system.test' }],
          { clock },
        );
        if (!a.ok) throw new Error(a.error._tag);
      });
    },
    gateOpened: async ({ gate, slot, id }) => {
      const gid = id ?? newId();
      await world.append(gateStream(gid), GATE_EVENT.opened, {
        gate_instance_id: gid,
        gate_id: gate,
        project_id: PROJECT,
        subject_kind: 'item',
        subject_id: newId(),
        subject_hash: 'a'.repeat(64),
        evidence_pack_hash: null,
        requester: 'root',
        facts: { expires_at: '2026-11-19T10:00:00.000Z' },
        quorum: { required: 1, slot, basis: 'single' },
        step_up: { required: false, bound_hash: 'a'.repeat(64) },
        supersedes: null,
        opened_by: 'system.test',
      });
      return gid;
    },
    stop: async () => {
      for (const s of stoppers.reverse()) await s().catch(() => undefined);
      const { default: pgmod } = await import('pg');
      const c = new pgmod.Pool({
        connectionString: new URL('/postgres', db.url).toString(),
        max: 1,
      });
      await c.query(`DROP ROLE IF EXISTS ${roleName}`).catch(() => undefined);
      await c.end();
    },
  };
  return world;
}

/** A card with one gate target, then its B21 escalation to `backup`. */
export async function escalatedCard(
  w: World,
  o: { gate: string; backup: string[] },
): Promise<string> {
  const card = newId();
  await w.append(cardStream(card), CARD_EVENT.opened, {
    card_id: card,
    project_id: PROJECT,
    subject_kind: 'item',
    subject_id: newId(),
    group: 'single',
    label: null,
    role: 'design',
    targets: [
      {
        target: 'gate',
        gate_instance_id: o.gate,
        gate_id: 'G3d',
        subject_hash: 'a'.repeat(64),
      },
    ],
    requester: null,
    sla_due_at: '2026-11-13T10:00:00.000Z',
    opened_by: 'system.test',
    key: null,
  });
  await w.append(cardStream(card), CARD_EVENT.escalated, {
    card_id: card,
    gate_instance_id: o.gate,
    level: 1,
    reason: 'sla_b21',
    due_at: '2026-11-13T10:00:00.000Z',
    escalated_at: T0,
    backup_slot: 'admin',
    backup: o.backup,
  });
  return card;
}

export async function killObserved(
  w: World,
  o: { seq: number; kind: 'kill.requested' | 'kill.released'; scope: object },
): Promise<string> {
  const kill = newId();
  await w.append(KILL_OBSERVED_STREAM, KILL_OBSERVED_EVENT, {
    ks_seq: o.seq,
    kind: o.kind,
    subject: kill,
    actor: 'root',
    entry_hash: 'b'.repeat(64),
    signature: 'sig',
    key_id: 'dev:killswitch',
    at: T0,
    body: { kill_id: kill, scope: o.scope, reason: 'a free-text reason that is never sent' },
  });
  return kill;
}
