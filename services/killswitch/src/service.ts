import {
  KILL_EVENT,
  KILL_SIGNATURE_PENDING,
  KillDelegationGrant,
  KillRecord,
  KillScope,
  Lane,
  killScopeResource,
  PrincipalId,
  pdpResource,
  projectOfScope,
  scopeCoversQuery,
  type KillEvent,
  type KillQuery,
  type KillStatus,
  type PdpResource,
  type Scope,
} from '@aisdlc/contracts';
import { planQuorum } from '@aisdlc/decisions';
import { withTransaction } from '@aisdlc/db';
import { Pdp, StaticBundleSource, buildBundle } from '@aisdlc/pdp';
import { newId, err, ok, systemClock, type Clock, type Jwk, type Result } from '@aisdlc/kernel';
import type { KeyCustodyPort } from '@aisdlc/ports';
import type pg from 'pg';
import { KillswitchEntities } from './entities.js';
import { killswitchError, type KillswitchError } from './errors.js';
import { KillJournal, toEvent, type JournalRow } from './journal.js';

// The kill switch (PLAN M9.6, AR9). A separate service with its own database and its own key:
//
//   - no dependency on core, Temporal or the work engine, and no route to core's write or command
//     APIs. It never makes a request to core. Core reads it (status, events) and pushes to it (the
//     holders of each project), both over the kill switch's own API;
//   - who may kill is decided by the same Cedar policies as everywhere (`kill.request` and
//     `kill.release`, the fleet rule), over the kill switch's own entities (`KillswitchEntities`);
//   - every change is an entry in its own signed, hash-chained journal.
//
// Kill scopes: fleet (factory admins only), project (the project admin, the kill slot, a delegate),
// lane, session. A kill is in force until RELEASED. Release is a KillReleaseApproval per person: one
// approval, or two distinct people where the project's two-person setting is on (always on T2, and for
// the fleet, whose setting is the factory's and is always on).

export interface KillServiceOptions {
  readonly pool: pg.Pool;
  readonly custody: KeyCustodyPort;
  readonly keyId?: string;
  readonly clock?: Clock;
}

export const KILLSWITCH_KEY_ID = 'dev:killswitch';

type R<T> = Promise<Result<T, KillswitchError>>;

// an agent session is killed with the right to kill its project (the portal asks the same: contracts' function)
const resourceOf = (scope: KillScope): PdpResource => killScopeResource(scope);

interface KillRow {
  kill_id: string;
  scope_kind: 'fleet' | 'project' | 'lane' | 'session';
  scope_ref: string;
  project_id: string | null;
  state: 'active' | 'release_pending' | 'released';
  requested_by: string;
  reason: string;
  requested_at: Date;
  release_required: number;
  released_at: Date | null;
}

export class KillService {
  private readonly clock: Clock;
  private readonly journal: KillJournal;
  private readonly pdp: Pdp;
  private readonly keyId: string;
  private publicKey: Jwk | undefined;

  constructor(private readonly o: KillServiceOptions) {
    this.clock = o.clock ?? systemClock;
    this.keyId = o.keyId ?? KILLSWITCH_KEY_ID;
    this.journal = new KillJournal(o.custody, this.keyId, this.clock);
    // The policies are generated from the role and action catalogues in the contracts: the same text as
    // core's bundle, built here, in process, not read from core.
    this.pdp = new Pdp({
      source: new StaticBundleSource(buildBundle()),
      entities: new KillswitchEntities(o.pool),
      clock: this.clock,
    });
  }

  // ------------------------------------------------------------ authority

  private async allowed(
    principal: string,
    action: 'kill.request' | 'kill.release' | 'project.settings.edit',
    resource: PdpResource,
  ): Promise<Result<true, KillswitchError>> {
    const d = await this.pdp.decide({ principal, action, resource });
    return d.decision === 'allow'
      ? ok(true)
      : err(killswitchError('forbidden', `${action} denied`, d.reasons));
  }

  /** What `principal` may do for a project: the answer the portal uses to show or hide the kill button. */
  async capabilities(
    principal: string,
    target: { project_id: string | null },
  ): R<{ kill: boolean; release: boolean; delegate: boolean; fleet_kill: boolean }> {
    const res =
      target.project_id === null ? pdpResource.fleet() : pdpResource.project(target.project_id);
    const [k, r, g, f] = await Promise.all([
      this.pdp.decide({ principal, action: 'kill.request', resource: res }, { log: false }),
      this.pdp.decide({ principal, action: 'kill.release', resource: res }, { log: false }),
      target.project_id === null
        ? Promise.resolve({ decision: 'deny' as const })
        : this.pdp.decide(
            { principal, action: 'project.settings.edit', resource: res },
            { log: false },
          ),
      this.pdp.decide(
        { principal, action: 'kill.request', resource: pdpResource.fleet() },
        { log: false },
      ),
    ]);
    return ok({
      kill: k.decision === 'allow',
      release: r.decision === 'allow',
      delegate: g.decision === 'allow',
      fleet_kill: f.decision === 'allow',
    });
  }

  // ------------------------------------------------------------ kills

  private async toRecord(db: pg.Pool | pg.PoolClient, r: KillRow): Promise<KillRecord> {
    const a = await db.query<{ approver: string }>(
      'SELECT approver FROM killswitch.release_approval WHERE kill_id = $1 ORDER BY approved_at, approver',
      [r.kill_id],
    );
    return KillRecord.parse({
      kill_id: r.kill_id,
      scope: { kind: r.scope_kind, ref: r.scope_ref },
      state: r.state,
      requested_by: r.requested_by,
      reason: r.reason,
      requested_at: r.requested_at.toISOString(),
      release_required: r.release_required,
      release_approvals: a.rows.map((x) => x.approver),
      released_at: r.released_at?.toISOString() ?? null,
    });
  }

  /** The people who hold the right to release a kill of `project`: its holders and the factory admins. */
  private async holdersOf(
    db: pg.Pool | pg.PoolClient,
    project: string | null,
  ): Promise<PrincipalId[]> {
    const admins = await db.query<{ principal: string }>(
      'SELECT principal FROM killswitch.factory_admin',
    );
    const out = new Set(admins.rows.map((r) => r.principal));
    if (project !== null) {
      const h = await db.query<{ principal: string }>(
        'SELECT principal FROM killswitch.holder WHERE project_id = $1',
        [project],
      );
      for (const r of h.rows) out.add(r.principal);
      const d = await db.query<{ delegate: string }>(
        `SELECT delegate FROM killswitch.delegation WHERE project_id = $1 AND revoked_at IS NULL`,
        [project],
      );
      for (const r of d.rows) out.add(r.delegate);
    }
    return [...out] as PrincipalId[];
  }

  /**
   * How many people the release needs, from the project's setting (DEC-28): two where it is on, always
   * on T2, and always for the fleet. `null`: it can never be released as configured (T2 with fewer than
   * two holders: no waiver exists), which the caller reports instead of leaving a kill nobody can lift.
   */
  private async releaseRequired(
    db: pg.Pool | pg.PoolClient,
    project: string | null,
  ): Promise<{ required: number; waiver: boolean } | { infeasible: string }> {
    const pol =
      project === null
        ? null
        : ((
            await db.query<{ tier: 'T0' | 'T1' | 'T2' | null; two_person: boolean }>(
              'SELECT tier, two_person FROM killswitch.project_policy WHERE project_id = $1',
              [project],
            )
          ).rows[0] ?? null);
    // Unknown means the safer setting: a project the kill switch has not been told about is two-person.
    const ctx = {
      tier: pol?.tier ?? null,
      two_person: {
        enabled: project === null ? true : (pol?.two_person ?? true),
        default: 'on_if_2plus' as const,
        locked_on: project === null || pol?.tier === 'T2',
      },
    };
    // The one who raised the alarm is not kept from clearing it; two distinct people are what counts.
    const plan = planQuorum('kill_release', ctx, await this.holdersOf(db, project), null);
    return plan.ok
      ? { required: plan.value.required, waiver: plan.value.waiver }
      : { infeasible: plan.error.message };
  }

  /** Kills a scope. Idempotent: a scope already in force returns its kill. */
  async requestKill(principal: string, input: { scope: unknown; reason: string }): R<KillRecord> {
    const scope = KillScope.safeParse(input.scope);
    if (!scope.success) return err(killswitchError('invalid_request', scope.error.message));
    if (scope.data.kind === 'lane') {
      const lane = scope.data.ref.split('/')[1];
      if (!Lane.safeParse(lane).success) {
        return err(
          killswitchError('invalid_request', `lane scope ref ${scope.data.ref} names no lane`),
        );
      }
    }
    const reason = input.reason.trim();
    if (reason === '') return err(killswitchError('invalid_request', 'a kill needs a reason'));
    const may = await this.allowed(principal, 'kill.request', resourceOf(scope.data));
    if (!may.ok) return may;
    const project = projectOfScope(scope.data);
    const need = await this.releaseRequired(this.o.pool, project);
    const required = 'infeasible' in need ? 2 : need.required;
    return this.tx(async (tx) => {
      const have = await tx.query<KillRow>(
        `SELECT * FROM killswitch.kill WHERE scope_kind = $1 AND scope_ref = $2 AND state <> 'released'`,
        [scope.data.kind, scope.data.ref],
      );
      if (have.rows[0]) return ok(await this.toRecord(tx, have.rows[0]));
      const kill_id = newId<'Kill'>();
      const now = this.clock.now();
      await tx.query(
        `INSERT INTO killswitch.kill (kill_id, scope_kind, scope_ref, project_id, state, requested_by, reason,
                                      requested_at, release_required)
         VALUES ($1, $2, $3, $4, 'active', $5, $6, $7, $8)`,
        [
          kill_id,
          scope.data.kind,
          scope.data.ref,
          project,
          principal,
          reason,
          now.toISOString(),
          required,
        ],
      );
      const j = await this.journal.append(
        tx,
        KILL_EVENT.requested,
        kill_id,
        principal,
        {
          kill_id,
          scope: scope.data,
          reason,
          release_required: required,
        },
        { allowUnsigned: true },
      );
      if (!j.ok) return j;
      const row = await tx.query<KillRow>('SELECT * FROM killswitch.kill WHERE kill_id = $1', [
        kill_id,
      ]);
      return ok(await this.toRecord(tx, row.rows[0] as KillRow));
    });
  }

  /**
   * One approval of a release (DM KillReleaseApproval). The kill is released when the approvals reach
   * what the project's two-person setting requires, counted now (the setting may have changed); until
   * then it is `release_pending` and still kills.
   */
  async approveRelease(principal: string, kill_id: string): R<KillRecord> {
    const k = await this.o.pool.query<KillRow>('SELECT * FROM killswitch.kill WHERE kill_id = $1', [
      kill_id,
    ]);
    const row = k.rows[0];
    if (!row) return err(killswitchError('not_found', `no kill ${kill_id}`));
    if (row.state === 'released')
      return err(killswitchError('conflict', 'the kill is already released'));
    const scope = KillScope.parse({ kind: row.scope_kind, ref: row.scope_ref });
    const may = await this.allowed(principal, 'kill.release', resourceOf(scope));
    if (!may.ok) return may;
    const need = await this.releaseRequired(this.o.pool, row.project_id);
    if ('infeasible' in need) {
      return err(
        killswitchError(
          'conflict',
          `the release cannot be approved as configured: ${need.infeasible}`,
        ),
      );
    }
    return this.tx(async (tx) => {
      const locked = await tx.query<KillRow>(
        'SELECT * FROM killswitch.kill WHERE kill_id = $1 FOR UPDATE',
        [kill_id],
      );
      const cur = locked.rows[0] as KillRow;
      if (cur.state === 'released')
        return err(killswitchError('conflict', 'the kill is already released'));
      const mine = await tx.query(
        'SELECT 1 FROM killswitch.release_approval WHERE kill_id = $1 AND approver = $2',
        [kill_id, principal],
      );
      if (mine.rowCount) {
        return err(killswitchError('conflict', `${principal} has already approved this release`));
      }
      await tx.query(
        'INSERT INTO killswitch.release_approval (kill_id, approver, approved_at) VALUES ($1, $2, $3)',
        [kill_id, principal, this.clock.now().toISOString()],
      );
      const n = Number(
        (
          await tx.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM killswitch.release_approval WHERE kill_id = $1',
            [kill_id],
          )
        ).rows[0]?.n,
      );
      const a = await this.journal.append(tx, KILL_EVENT.release_approved, kill_id, principal, {
        kill_id,
        approvals: n,
        required: need.required,
        sod_waiver: need.waiver,
      });
      if (!a.ok) return a;
      const done = n >= need.required;
      await tx.query(
        `UPDATE killswitch.kill SET state = $2, release_required = $3, released_at = $4 WHERE kill_id = $1`,
        [
          kill_id,
          done ? 'released' : 'release_pending',
          need.required,
          done ? this.clock.now().toISOString() : null,
        ],
      );
      if (done) {
        const r = await this.journal.append(tx, KILL_EVENT.released, kill_id, principal, {
          kill_id,
          scope,
          approvals: n,
        });
        if (!r.ok) return r;
      }
      const after = await tx.query<KillRow>('SELECT * FROM killswitch.kill WHERE kill_id = $1', [
        kill_id,
      ]);
      return ok(await this.toRecord(tx, after.rows[0] as KillRow));
    });
  }

  /** What enforcement points ask: every kill in force that covers the query. Read-only. */
  async status(q: KillQuery): R<KillStatus> {
    const r = await this.o.pool.query<KillRow>(
      `SELECT * FROM killswitch.kill
        WHERE state <> 'released' AND (project_id IS NULL OR project_id = $1) ORDER BY requested_at, kill_id`,
      [q.project_id],
    );
    const kills: KillRecord[] = [];
    for (const row of r.rows) {
      const k = await this.toRecord(this.o.pool, row);
      if (scopeCoversQuery(k.scope as Scope, q)) kills.push(k);
    }
    return ok({ killed: kills.length > 0, kills, as_of: this.clock.now().toISOString() });
  }

  async listKills(o: { active?: boolean; project_id?: string } = {}): R<KillRecord[]> {
    const r = await this.o.pool.query<KillRow>(
      `SELECT * FROM killswitch.kill
        WHERE ($1::boolean IS NOT TRUE OR state <> 'released')
          AND ($2::text IS NULL OR project_id = $2 OR project_id IS NULL)
        ORDER BY requested_at, kill_id`,
      [o.active ?? false, o.project_id ?? null],
    );
    return ok(await Promise.all(r.rows.map((x) => this.toRecord(this.o.pool, x))));
  }

  // ------------------------------------------------------------ delegation (DEC-29)

  /** The project admin gives a person the right to kill (and release) a project or a lane, until revoked. */
  async grantDelegation(
    principal: string,
    input: { delegate: string; scope: unknown },
  ): R<KillDelegationGrant> {
    const scope = KillScope.safeParse(input.scope);
    if (!scope.success || (scope.data.kind !== 'project' && scope.data.kind !== 'lane')) {
      return err(killswitchError('invalid_request', 'a delegation covers a project or a lane'));
    }
    const delegate = PrincipalId.safeParse(input.delegate);
    if (!delegate.success) return err(killswitchError('invalid_request', 'bad delegate'));
    const project = projectOfScope(scope.data) as string;
    // The right to grant it is the right to change the project's settings: its admin (or a factory admin).
    const may = await this.allowed(
      principal,
      'project.settings.edit',
      pdpResource.project(project),
    );
    if (!may.ok) return may;
    return this.tx(async (tx) => {
      const have = await tx.query(
        `SELECT 1 FROM killswitch.delegation
          WHERE delegate = $1 AND scope_kind = $2 AND scope_ref = $3 AND revoked_at IS NULL`,
        [delegate.data, scope.data.kind, scope.data.ref],
      );
      if (have.rowCount)
        return err(killswitchError('conflict', 'the delegation is already in force'));
      const delegation_id = newId<'KillDelegation'>();
      const at = this.clock.now().toISOString();
      await tx.query(
        `INSERT INTO killswitch.delegation (delegation_id, delegate, scope_kind, scope_ref, project_id, granted_by, granted_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [delegation_id, delegate.data, scope.data.kind, scope.data.ref, project, principal, at],
      );
      const j = await this.journal.append(
        tx,
        KILL_EVENT.delegation_granted,
        delegation_id,
        principal,
        {
          delegation_id,
          delegate: delegate.data,
          scope: scope.data,
        },
      );
      if (!j.ok) return j;
      return ok(
        KillDelegationGrant.parse({
          delegation_id,
          delegate: delegate.data,
          scope: scope.data,
          granted_by: principal,
          granted_at: at,
          revoked_at: null,
          revoked_by: null,
        }),
      );
    });
  }

  async revokeDelegation(principal: string, delegation_id: string): R<KillDelegationGrant> {
    const d = await this.o.pool.query<{ project_id: string }>(
      'SELECT project_id FROM killswitch.delegation WHERE delegation_id = $1',
      [delegation_id],
    );
    if (!d.rows[0]) return err(killswitchError('not_found', `no delegation ${delegation_id}`));
    const may = await this.allowed(
      principal,
      'project.settings.edit',
      pdpResource.project(d.rows[0].project_id),
    );
    if (!may.ok) return may;
    return this.tx(async (tx) => {
      const at = this.clock.now().toISOString();
      const u = await tx.query(
        `UPDATE killswitch.delegation SET revoked_at = $2, revoked_by = $3
          WHERE delegation_id = $1 AND revoked_at IS NULL`,
        [delegation_id, at, principal],
      );
      if (!u.rowCount) return err(killswitchError('conflict', 'the delegation is already revoked'));
      const j = await this.journal.append(
        tx,
        KILL_EVENT.delegation_revoked,
        delegation_id,
        principal,
        {
          delegation_id,
        },
      );
      if (!j.ok) return j;
      return ok(await this.delegation(tx, delegation_id));
    });
  }

  private async delegation(db: pg.Pool | pg.PoolClient, id: string): Promise<KillDelegationGrant> {
    const r = await db.query('SELECT * FROM killswitch.delegation WHERE delegation_id = $1', [id]);
    return toGrant(r.rows[0] as DelegationRow);
  }

  async listDelegations(project_id: string): R<KillDelegationGrant[]> {
    const r = await this.o.pool.query<DelegationRow>(
      'SELECT * FROM killswitch.delegation WHERE project_id = $1 ORDER BY granted_at, delegation_id',
      [project_id],
    );
    return ok(r.rows.map(toGrant));
  }

  // ------------------------------------------------------------ who holds what (pushed by core-worker)

  /**
   * Replaces what the kill switch knows about a project: who holds the admin and kill slots, and its
   * tier and two-person setting. Pushed by core-worker (the kill switch never asks core). The journal
   * records the push, so a change of authority is visible.
   */
  async syncHolders(
    project_id: string,
    input: {
      admins: readonly string[];
      kill_holders: readonly string[];
      tier: 'T0' | 'T1' | 'T2' | null;
      two_person: boolean;
    },
  ): R<{ project_id: string; admins: number; kill_holders: number }> {
    return this.tx(async (tx) => {
      // The same push again is not a change: no entry, so a loop that pushes every few seconds does
      // not fill the journal.
      const have = await tx.query<{ principal: string; slot: string }>(
        'SELECT principal, slot FROM killswitch.holder WHERE project_id = $1',
        [project_id],
      );
      const pol = await tx.query<{ tier: string | null; two_person: boolean }>(
        'SELECT tier, two_person FROM killswitch.project_policy WHERE project_id = $1',
        [project_id],
      );
      const want = new Set([
        ...[...new Set(input.admins)].map((p) => `admin:${p}`),
        ...[...new Set(input.kill_holders)].map((p) => `kill:${p}`),
      ]);
      const same =
        have.rowCount === want.size &&
        have.rows.every((r) => want.has(`${r.slot}:${r.principal}`)) &&
        pol.rows[0]?.tier === input.tier &&
        pol.rows[0]?.two_person === input.two_person;
      if (same) {
        return ok({
          project_id,
          admins: new Set(input.admins).size,
          kill_holders: new Set(input.kill_holders).size,
        });
      }
      await tx.query('DELETE FROM killswitch.holder WHERE project_id = $1', [project_id]);
      for (const p of new Set(input.admins)) {
        await tx.query(
          'INSERT INTO killswitch.holder (project_id, principal, slot) VALUES ($1, $2, $3)',
          [project_id, p, 'admin'],
        );
      }
      for (const p of new Set(input.kill_holders)) {
        await tx.query(
          'INSERT INTO killswitch.holder (project_id, principal, slot) VALUES ($1, $2, $3)',
          [project_id, p, 'kill'],
        );
      }
      const at = this.clock.now().toISOString();
      await tx.query(
        `INSERT INTO killswitch.project_policy (project_id, tier, two_person, synced_at) VALUES ($1, $2, $3, $4)
         ON CONFLICT (project_id) DO UPDATE SET tier = EXCLUDED.tier, two_person = EXCLUDED.two_person,
                                                synced_at = EXCLUDED.synced_at`,
        [project_id, input.tier, input.two_person, at],
      );
      const j = await this.journal.append(tx, KILL_EVENT.holders_synced, project_id, null, {
        project_id,
        admins: [...new Set(input.admins)].sort(),
        kill_holders: [...new Set(input.kill_holders)].sort(),
        tier: input.tier,
        two_person: input.two_person,
      });
      if (!j.ok) return j;
      return ok({
        project_id,
        admins: new Set(input.admins).size,
        kill_holders: new Set(input.kill_holders).size,
      });
    });
  }

  /** Factory admins are the kill switch's own configuration: seeded at start, never pushed from core. */
  async seedFactoryAdmins(principals: readonly string[]): R<{ added: number }> {
    return this.tx(async (tx) => {
      let added = 0;
      for (const p of principals) {
        const r = await tx.query(
          'INSERT INTO killswitch.factory_admin (principal) VALUES ($1) ON CONFLICT DO NOTHING',
          [p],
        );
        added += r.rowCount ?? 0;
      }
      if (added > 0) {
        const j = await this.journal.append(tx, KILL_EVENT.holders_synced, 'fleet', null, {
          project_id: '*',
          factory_admins: [...principals].sort(),
        });
        if (!j.ok) return j;
      }
      return ok({ added });
    });
  }

  // ------------------------------------------------------------ signing what could not be signed

  /**
   * Signs, later, the kills that were enforced while key custody was down: for each unsigned
   * `kill.requested` a signed `kill.signature_attested` entry names it (seq and hash). Stops at the first
   * failure (the KMS is still away) and tries again next time. Safe to run twice.
   */
  async backfillSignatures(): R<{ attested: number }> {
    const q = await this.o.pool.query<{ seq: string; entry_hash: string }>(
      `SELECT p.seq, p.entry_hash FROM killswitch.journal p
        WHERE p.signature = $1
          AND NOT EXISTS (SELECT 1 FROM killswitch.journal a
                           WHERE a.kind = $2 AND (a.body ->> 'pending_seq')::bigint = p.seq)
        ORDER BY p.seq`,
      [KILL_SIGNATURE_PENDING, KILL_EVENT.signature_attested],
    );
    let attested = 0;
    for (const row of q.rows) {
      const r = await this.tx(async (tx) => {
        const dup = await tx.query(
          `SELECT 1 FROM killswitch.journal WHERE kind = $1 AND (body ->> 'pending_seq')::bigint = $2`,
          [KILL_EVENT.signature_attested, row.seq],
        );
        if (dup.rowCount) return ok(false);
        const j = await this.journal.append(
          tx,
          KILL_EVENT.signature_attested,
          `seq:${row.seq}`,
          null,
          {
            pending_seq: Number(row.seq),
            pending_hash: row.entry_hash,
          },
        );
        return j.ok ? ok(true) : j;
      });
      if (!r.ok) return attested > 0 ? ok({ attested }) : r;
      if (r.value) attested += 1;
    }
    return ok({ attested });
  }

  // ------------------------------------------------------------ the journal

  /** The journal after `after`, in order, for core's observer and for an auditor. */
  async events(after = 0, limit = 200): R<KillEvent[]> {
    const r = await this.o.pool.query<JournalRow>(
      'SELECT * FROM killswitch.journal WHERE seq > $1 ORDER BY seq LIMIT $2',
      [after, Math.min(Math.max(limit, 1), 1000)],
    );
    return ok(r.rows.map(toEvent));
  }

  /** The public key that verifies the journal. */
  async journalKey(): R<Jwk> {
    if (this.publicKey) return ok(this.publicKey);
    const k = await this.o.custody.publicKey(this.keyId);
    if (!k.ok) return err(killswitchError('unavailable', k.error.message));
    this.publicKey = k.value;
    return ok(k.value);
  }

  private tx<T>(fn: (tx: pg.PoolClient) => Promise<Result<T, KillswitchError>>): R<T> {
    return withTransactionResult(this.o.pool, fn);
  }
}

interface DelegationRow {
  delegation_id: string;
  delegate: string;
  scope_kind: 'project' | 'lane';
  scope_ref: string;
  granted_by: string;
  granted_at: Date;
  revoked_at: Date | null;
  revoked_by: string | null;
}
const toGrant = (r: DelegationRow): KillDelegationGrant =>
  KillDelegationGrant.parse({
    delegation_id: r.delegation_id,
    delegate: r.delegate,
    scope: { kind: r.scope_kind, ref: r.scope_ref },
    granted_by: r.granted_by,
    granted_at: r.granted_at.toISOString(),
    revoked_at: r.revoked_at?.toISOString() ?? null,
    revoked_by: r.revoked_by,
  });

/** A transaction whose body returns a Result: an `Err` rolls back, a database failure is `unavailable`. */
async function withTransactionResult<T>(
  pool: pg.Pool,
  fn: (tx: pg.PoolClient) => Promise<Result<T, KillswitchError>>,
): Promise<Result<T, KillswitchError>> {
  const ROLLBACK = Symbol('rollback');
  let failure: KillswitchError | null = null;
  try {
    const v = await withTransaction(pool, async (tx) => {
      const r = await fn(tx);
      if (!r.ok) {
        failure = r.error;
        throw ROLLBACK;
      }
      return r.value;
    });
    return ok(v);
  } catch (e) {
    if (e === ROLLBACK && failure) return err(failure);
    return err(killswitchError('unavailable', e instanceof Error ? e.message : String(e)));
  }
}
