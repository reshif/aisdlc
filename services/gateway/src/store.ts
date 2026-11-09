import { randomBytes } from 'node:crypto';
import type {
  BudgetGroupSpec,
  BudgetGroupView,
  DataClass,
  Lane,
  StepId,
  VKeyScopeKind,
  VKeyView,
} from '@aisdlc/contracts';
import { sha256Hex } from '@aisdlc/kernel';
import type { Executor } from '@aisdlc/record';

// Virtual keys and budget groups in the gateway's schema. A key's secret is `aisk_` plus 48 hex
// characters; only its sha256 is stored, and the secret is returned once, at mint.

export const newVKeySecret = (): string => `aisk_${randomBytes(24).toString('hex')}`;
export const hashVKeySecret = (secret: string): string => sha256Hex(secret);

export interface VKeyRow {
  readonly vkey_id: string;
  readonly scope: { kind: VKeyScopeKind; ref: string };
  readonly project_id: string;
  readonly lane: Lane | null;
  readonly data_class_max: DataClass;
  readonly models: readonly string[];
  readonly tools: readonly string[];
  readonly budget_group: string;
  readonly item_id: string | null;
  readonly unit_id: string | null;
  readonly step: StepId | null;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

interface RawVKey {
  vkey_id: string;
  scope_kind: VKeyScopeKind;
  scope_ref: string;
  project_id: string;
  lane: Lane | null;
  data_class_max: DataClass;
  models: string[];
  tools: string[];
  budget_group: string;
  item_id: string | null;
  unit_id: string | null;
  step: StepId | null;
  expires_at: Date;
  revoked_at: Date | null;
}

const VKEY_COLUMNS = `vkey_id, scope_kind, scope_ref, project_id, lane, data_class_max, models, tools,
  budget_group, item_id, unit_id, step, expires_at, revoked_at`;

const toRow = (r: RawVKey): VKeyRow => ({
  vkey_id: r.vkey_id,
  scope: { kind: r.scope_kind, ref: r.scope_ref },
  project_id: r.project_id,
  lane: r.lane,
  data_class_max: r.data_class_max,
  models: r.models,
  tools: r.tools,
  budget_group: r.budget_group,
  item_id: r.item_id,
  unit_id: r.unit_id,
  step: r.step,
  expires_at: r.expires_at,
  revoked_at: r.revoked_at,
});

export const vkeyView = (r: VKeyRow): VKeyView => ({
  vkey_id: r.vkey_id,
  scope: r.scope,
  project_id: r.project_id,
  lane: r.lane,
  data_class_max: r.data_class_max,
  models: [...r.models],
  tools: [...r.tools],
  budget_group: r.budget_group,
  expires_at: r.expires_at.toISOString(),
  revoked_at: r.revoked_at?.toISOString() ?? null,
  item_id: r.item_id,
  unit_id: r.unit_id,
  step: r.step,
});

export async function findVKeyBySecret(db: Executor, secret: string): Promise<VKeyRow | null> {
  const q = await db.query<RawVKey>(
    `SELECT ${VKEY_COLUMNS} FROM gateway.vkey WHERE key_hash = $1`,
    [hashVKeySecret(secret)],
  );
  return q.rows[0] ? toRow(q.rows[0]) : null;
}

export async function findVKey(db: Executor, id: string): Promise<VKeyRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const q = await db.query<RawVKey>(`SELECT ${VKEY_COLUMNS} FROM gateway.vkey WHERE vkey_id = $1`, [
    id,
  ]);
  return q.rows[0] ? toRow(q.rows[0]) : null;
}

export interface NewVKey {
  readonly vkey_id: string;
  readonly key_hash: string;
  readonly scope: { kind: VKeyScopeKind; ref: string };
  readonly project_id: string;
  readonly lane: Lane | null;
  readonly data_class_max: DataClass;
  readonly models: readonly string[];
  readonly tools: readonly string[];
  readonly budget_group: string;
  readonly item_id: string | null;
  readonly unit_id: string | null;
  readonly step: StepId | null;
  readonly expires_at: string;
  readonly created_at: string;
  readonly minted_by: string;
}

export async function insertVKey(db: Executor, k: NewVKey): Promise<void> {
  await db.query(
    `INSERT INTO gateway.vkey (vkey_id, key_hash, scope_kind, scope_ref, project_id, lane,
        data_class_max, models, tools, budget_group, item_id, unit_id, step, expires_at, created_at,
        minted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9::text[],$10,$11,$12,$13,$14,$15,$16)`,
    [
      k.vkey_id,
      k.key_hash,
      k.scope.kind,
      k.scope.ref,
      k.project_id,
      k.lane,
      k.data_class_max,
      [...k.models],
      [...k.tools],
      k.budget_group,
      k.item_id,
      k.unit_id,
      k.step,
      k.expires_at,
      k.created_at,
      k.minted_by,
    ],
  );
}

/** Revokes a key once; the first revocation time stays. Returns the row, or null if there is none. */
export async function revokeVKey(db: Executor, id: string, at: string): Promise<VKeyRow | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const q = await db.query<RawVKey>(
    `UPDATE gateway.vkey SET revoked_at = coalesce(revoked_at, $2) WHERE vkey_id = $1
     RETURNING ${VKEY_COLUMNS}`,
    [id, at],
  );
  return q.rows[0] ? toRow(q.rows[0]) : null;
}

// ---------------------------------------------------------------- budget groups

interface RawGroup {
  group_id: string;
  max_tokens: string;
  max_cost_micro_usd: string;
  used_tokens: string;
  used_cost_micro_usd: string;
  reserved_tokens: string;
  reserved_cost_micro_usd: string;
  exhausted_at: Date | null;
}

const GROUP_COLUMNS = `group_id, max_tokens::text, max_cost_micro_usd::text, used_tokens::text,
  used_cost_micro_usd::text, reserved_tokens::text, reserved_cost_micro_usd::text, exhausted_at`;

const toGroup = (r: RawGroup): BudgetGroupView => ({
  group_id: r.group_id,
  max_tokens: Number(r.max_tokens),
  max_cost_micro_usd: Number(r.max_cost_micro_usd),
  used_tokens: Number(r.used_tokens),
  used_cost_micro_usd: Number(r.used_cost_micro_usd),
  reserved_tokens: Number(r.reserved_tokens),
  reserved_cost_micro_usd: Number(r.reserved_cost_micro_usd),
  exhausted_at: r.exhausted_at?.toISOString() ?? null,
});

export async function getBudgetGroup(
  db: Executor,
  id: string,
  lock = false,
): Promise<BudgetGroupView | null> {
  const q = await db.query<RawGroup>(
    `SELECT ${GROUP_COLUMNS} FROM gateway.budget_group WHERE group_id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return q.rows[0] ? toGroup(q.rows[0]) : null;
}

/** Creates a group. `false`: it exists already (the limits are not changed by a second create). */
export async function insertBudgetGroup(
  db: Executor,
  spec: BudgetGroupSpec,
  at: string,
): Promise<boolean> {
  const q = await db.query(
    `INSERT INTO gateway.budget_group (group_id, max_tokens, max_cost_micro_usd, created_at)
     VALUES ($1,$2,$3,$4) ON CONFLICT (group_id) DO NOTHING`,
    [spec.group_id, spec.max_tokens, spec.max_cost_micro_usd, at],
  );
  return (q.rowCount ?? 0) === 1;
}

export async function addReservation(
  db: Executor,
  id: string,
  tokens: number,
  costMicro: number,
): Promise<void> {
  await db.query(
    `UPDATE gateway.budget_group
        SET reserved_tokens = reserved_tokens + $2, reserved_cost_micro_usd = reserved_cost_micro_usd + $3
      WHERE group_id = $1`,
    [id, tokens, costMicro],
  );
}

/** Records a reservation as a row (status `open`) and raises the group's `reserved_*` by it. */
export async function openReservation(
  db: Executor,
  r: { id: string; group: string; vkey_id: string; tokens: number; costMicro: number; at: string },
): Promise<void> {
  await db.query(
    `INSERT INTO gateway.reservation (reservation_id, budget_group, vkey_id, tokens, cost_micro_usd, reserved_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [r.id, r.group, r.vkey_id, r.tokens, r.costMicro, r.at],
  );
  await addReservation(db, r.group, r.tokens, r.costMicro);
}

/**
 * Closes a reservation, once: `true` when this call moved it from `open` (so the hold is still on the
 * group and the caller must release it), `false` when it was already closed (settled, or abandoned by
 * the sweep: the hold is gone and releasing it again would double-count).
 */
export async function closeReservation(
  db: Executor,
  id: string,
  status: 'settled' | 'abandoned',
  at: string,
): Promise<boolean> {
  const q = await db.query(
    `UPDATE gateway.reservation SET status = $2, closed_at = $3 WHERE reservation_id = $1 AND status = 'open'`,
    [id, status, at],
  );
  return (q.rowCount ?? 0) === 1;
}

export interface StaleReservation {
  readonly reservation_id: string;
  readonly vkey_id: string;
  readonly tokens: number;
  readonly cost_micro_usd: number;
  readonly reserved_at: Date;
}

/** Groups that hold an open reservation older than `before`. */
export async function groupsWithStale(db: Executor, before: string): Promise<string[]> {
  const q = await db.query<{ budget_group: string }>(
    `SELECT DISTINCT budget_group FROM gateway.reservation WHERE status = 'open' AND reserved_at < $1 ORDER BY 1`,
    [before],
  );
  return q.rows.map((r) => r.budget_group);
}

/** Abandons every open reservation of the group older than `before` (the group row must be locked by the caller). */
export async function abandonStale(
  db: Executor,
  group: string,
  before: string,
  at: string,
): Promise<StaleReservation[]> {
  const q = await db.query<{
    reservation_id: string;
    vkey_id: string;
    tokens: string;
    cost_micro_usd: string;
    reserved_at: Date;
  }>(
    `UPDATE gateway.reservation SET status = 'abandoned', closed_at = $3
      WHERE budget_group = $1 AND status = 'open' AND reserved_at < $2
      RETURNING reservation_id, vkey_id, tokens::text, cost_micro_usd::text, reserved_at`,
    [group, before, at],
  );
  return q.rows.map((r) => ({
    reservation_id: r.reservation_id,
    vkey_id: r.vkey_id,
    tokens: Number(r.tokens),
    cost_micro_usd: Number(r.cost_micro_usd),
    reserved_at: r.reserved_at,
  }));
}

/** Releases a reservation and adds what was really spent, in one statement. Returns the new state. */
export async function settleUsage(
  db: Executor,
  id: string,
  reserved: { tokens: number; costMicro: number },
  actual: { tokens: number; costMicro: number },
  now: string,
): Promise<BudgetGroupView> {
  const q = await db.query<RawGroup>(
    `UPDATE gateway.budget_group SET
        reserved_tokens = greatest(0, reserved_tokens - $2),
        reserved_cost_micro_usd = greatest(0, reserved_cost_micro_usd - $3),
        used_tokens = used_tokens + $4,
        used_cost_micro_usd = used_cost_micro_usd + $5,
        exhausted_at = CASE
          WHEN exhausted_at IS NOT NULL THEN exhausted_at
          WHEN used_tokens + $4 >= max_tokens OR used_cost_micro_usd + $5 >= max_cost_micro_usd THEN $6::timestamptz
          ELSE NULL END
      WHERE group_id = $1
      RETURNING ${GROUP_COLUMNS}`,
    [id, reserved.tokens, reserved.costMicro, actual.tokens, actual.costMicro, now],
  );
  return toGroup(q.rows[0] as RawGroup);
}

export async function markExhausted(db: Executor, id: string, now: string): Promise<void> {
  await db.query(
    `UPDATE gateway.budget_group SET exhausted_at = coalesce(exhausted_at, $2::timestamptz) WHERE group_id = $1`,
    [id, now],
  );
}
