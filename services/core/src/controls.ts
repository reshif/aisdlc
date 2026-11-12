import {
  Banner,
  BlastRadius,
  CONTROL_EVENT,
  ControlScope,
  OpsAction,
  OpsPreview,
  OpsControl,
  bannerStream,
  controlStream,
  isFleetScope,
  opsActionStream,
  opsPreviewStream,
  projectOfScope,
  scopeCoversQuery,
  type BannerSeverity,
  type BannerTarget,
  type ControlKind,
  type KillQuery,
  type LedgerEntryDraft,
  type OpsVerb,
  type PrincipalId,
  type RecordEvent,
  type Sha256Hex,
  type StepUpUse,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION, type StepUpPort } from '@aisdlc/decisions';
import {
  deterministicId,
  err,
  hashCanonical,
  newId,
  ok,
  sha256Hex,
  type Clock,
  type Result,
} from '@aisdlc/kernel';
import {
  appendLedgerEntryTx,
  importUnconfirmed,
  lockLedger,
  type PendingConfirm,
} from '@aisdlc/ledger';
import { EVENT_COLUMNS, toRecordEvent, type EventRow, type Executor } from '@aisdlc/record';
import type { CapacityPort } from '@aisdlc/ports';
import type { LoopSpec } from '@aisdlc/loops';
import type { Lane } from '@aisdlc/contracts';
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { clockOf, inCoreLedgerTx, inCoreTx, lockKeys, type CoreDeps } from './journal.js';
import { setHold } from './kill.js';
import { catchUpWork } from './work-projection.js';
import { readItem } from './work-items.js';

// Controls, OpsActions with their previews, and banners (PLAN M9.6; DM §3.10). A core module: PDP-guarded
// at the route (`control.apply`, `control.lift`, `banner.publish`, over the scope's own resource: the
// fleet only for a factory admin) and ledgered.
//
//   Control      hold (stop NEW agent work in a scope: its items are HELD), clamp (at most N agent
//                sessions in flight), halt (no release steps), maintenance (timers frozen, work held,
//                drafts kept). A control is a fact in the record and ends when lifted or expired. The
//                scopes enforced are the fleet, a project and a lane (the one `Scope` of the contracts);
//                team, release and budget are in the vocabulary and refused until something enforces them.
//   OpsAction    one act of an operator. It is EXECUTED first and LEDGERED after (DM FD-D8): the record
//                event is written in its own transaction, the ledger entry (through the Notary) next; if
//                the Notary is down the action stays `pending` and `backfillOpsLedger` ledgers it later,
//                marked `backfilled`.
//   OpsPreview   what the action would touch (the blast radius, counted from the record), with a nonce.
//                An apply names its preview, is refused when the radius is no longer what was shown, and
//                consumes the preview, so one look is one act.
//   Banner       a notice for a scope, published by an OpsAction, gone at its expiry.
//
// No control approves or decides anything: they only stop and slow work. Lifting one is not a decision
// either, but it is ledgered and guarded the same way.

export const OPS_ACTOR = 'system.ops';
export const OPS_LEDGER_ENTRY_TYPE = 'ops.action';
export const PREVIEW_TTL_MS = 10 * 60_000;

export type LedgeredDeps = CoreDeps & { readonly ledger: NonNullable<CoreDeps['ledger']> };

const enforceable = (s: { kind: string }): boolean =>
  s.kind === 'fleet' || s.kind === 'project' || s.kind === 'lane';

// ---------------------------------------------------------------- Reading

async function streamsOf(db: Executor, prefix: string): Promise<string[]> {
  const q = await db.query<{ stream: string }>(
    `SELECT DISTINCT stream FROM record.record_event WHERE stream LIKE $1 ORDER BY stream`,
    [`${prefix}:%`],
  );
  return q.rows.map((r) => r.stream);
}

async function eventsOf(db: Executor, stream: string): Promise<RecordEvent[]> {
  const q = await db.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 ORDER BY record_event.seq`,
    [stream],
  );
  return q.rows.map(toRecordEvent);
}

/** One control from its stream: applied, then lifted (by a person) or expired (by the clock). */
export function foldControl(events: readonly RecordEvent[], now: Date): OpsControl | null {
  let cur = null as OpsControl | null;
  for (const e of events) {
    if (e.type === CONTROL_EVENT.control_applied) cur = OpsControl.parse(e.payload);
    else if (cur !== null && e.type === CONTROL_EVENT.control_lifted) {
      cur = { ...cur, state: 'lifted', lifted_at: e.occurred_at };
    } else if (cur !== null && e.type === CONTROL_EVENT.control_expired && cur.state === 'active') {
      cur = { ...cur, state: 'expired', lifted_at: e.occurred_at };
    }
  }
  if (cur === null) return null;
  // Expiry never needs a sweep to take effect: a control past `expires_at` is not active.
  if (
    cur.state === 'active' &&
    cur.expires_at !== null &&
    Date.parse(cur.expires_at) <= now.getTime()
  ) {
    return { ...cur, state: 'expired', lifted_at: cur.expires_at };
  }
  return cur;
}

export async function listControls(db: Executor, now: Date): Promise<OpsControl[]> {
  const out: OpsControl[] = [];
  for (const stream of await streamsOf(db, 'control')) {
    const c = foldControl(await eventsOf(db, stream), now);
    if (c) out.push(c);
  }
  return out.sort(
    (a, b) => a.created_at.localeCompare(b.created_at) || a.control_id.localeCompare(b.control_id),
  );
}

export const activeControls = async (db: Executor, now: Date): Promise<OpsControl[]> =>
  (await listControls(db, now)).filter((c) => c.state === 'active');

/** The active controls of `kind` that cover what `q` asks about. */
export const controlsCovering = (
  all: readonly OpsControl[],
  q: KillQuery,
  kind: OpsControl['kind'],
): OpsControl[] => all.filter((c) => c.kind === kind && scopeCoversQuery(c.scope, q));

// ---------------------------------------------------------------- Preview

/** What the scope covers, counted from the record's work read model (caught up first). */
export async function blastRadius(
  pool: pg.Pool,
  scope: ControlScope,
  now: Date,
): Promise<BlastRadius> {
  await catchUpWork(pool);
  const project = projectOfScope(scope);
  const lane = scope.kind === 'lane' ? (scope.ref.split('/')[1] ?? null) : null;
  const q = await pool.query<{ project_id: string; lane: string | null; in_flight: boolean }>(
    `SELECT project_id, COALESCE(lane, proposed_lane) AS lane, in_flight FROM core.work_item
      WHERE terminal IS NULL AND ($1::text IS NULL OR project_id = $1)
        AND ($2::text IS NULL OR COALESCE(lane, proposed_lane) = $2)`,
    [project, lane],
  );
  const overlapping = (await activeControls(pool, now)).filter(
    (c) => isFleetScope(c.scope) || isFleetScope(scope) || projectOfScope(c.scope) === project,
  );
  return BlastRadius.parse({
    scope,
    projects: [...new Set(q.rows.map((r) => r.project_id))].sort(),
    lanes: [...new Set(q.rows.map((r) => r.lane).filter((l): l is string => l !== null))].sort(),
    items: q.rows.length,
    items_in_flight: q.rows.filter((r) => r.in_flight).length,
    overlapping_controls: overlapping.length,
  });
}

const verbOf = (kind: ControlKind): OpsVerb => `control.${kind}` as OpsVerb;

/** Shows what an action would touch, and binds the apply to this look with a nonce. */
export async function previewControl(
  deps: CoreDeps,
  o: { kind: ControlKind; scope: unknown; actor: PrincipalId },
): Promise<Result<OpsPreview, CoreError>> {
  const scope = ControlScope.safeParse(o.scope);
  if (!scope.success) return err(coreError('invalid_input', scope.error.message));
  if (!enforceable(scope.data)) {
    return err(
      coreError(
        'invalid_input',
        `no control is enforced on a ${scope.data.kind} scope yet (fleet, project, lane)`,
      ),
    );
  }
  const now = clockOf(deps).now();
  const radius = await blastRadius(deps.pool, scope.data, now);
  const preview = OpsPreview.parse({
    preview_id: newId<'OpsPreview'>(now.getTime()),
    verb: verbOf(o.kind),
    actor: o.actor,
    blast_radius: radius,
    blast_radius_hash: hashCanonical(radius),
    nonce: randomBytes(18).toString('base64url'),
    expires_at: new Date(now.getTime() + PREVIEW_TTL_MS).toISOString(),
    consumed_at: null,
  });
  const w = await inCoreTx(deps, async (j) =>
    j.emit(opsPreviewStream(preview.preview_id), CONTROL_EVENT.previewed, preview, o.actor),
  );
  return w.ok ? ok(preview) : w;
}

// ---------------------------------------------------------------- Applying

const ParamsOf = (
  kind: ControlKind,
  params: unknown,
): Result<Record<string, unknown>, CoreError> => {
  const p = (params ?? {}) as Record<string, unknown>;
  if (kind === 'clamp') {
    const n = p['max_in_flight'];
    if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) {
      return err(
        coreError('invalid_input', 'a clamp needs params.max_in_flight, an integer of at least 0'),
      );
    }
    return ok({ max_in_flight: n });
  }
  return ok({});
};

export interface ApplyControlInput {
  readonly preview_id: string;
  readonly nonce: string;
  readonly kind: ControlKind;
  readonly scope: unknown;
  readonly actor: PrincipalId;
  readonly params?: unknown;
  readonly expires_at?: string | null;
  readonly origin_kind?: 'operator' | 'security' | 'automation';
  /**
   * M19 (StepUpUse): a step-up proof bound to the preview's blast radius hash. When given it is verified and consumed,
   * recorded with the action and carried into its ledger entry (also by the backfill after a Notary outage). A proof
   * that does not verify refuses the action; a proof with no verifier configured refuses it too (fail closed).
   */
  readonly step_up?: { readonly proof: string };
}

/** The step-up verifier an apply may use (the decision kernel's `StepUpPort`). */
export type ApplyControlDeps = CoreDeps & { readonly stepUp?: StepUpPort | undefined };

export interface OpsResult {
  readonly action: OpsAction;
  readonly control?: OpsControl;
  readonly banner?: Banner;
}

/**
 * Applies a control: checks the preview (same actor, same verb, the nonce, not consumed, not expired, the
 * radius unchanged), writes the action and the control and consumes the preview in one transaction, then
 * ledgers the action. If the ledger cannot be written the control is IN FORCE and the action `pending`.
 */
export async function applyControl(
  deps: ApplyControlDeps,
  i: ApplyControlInput,
): Promise<Result<OpsResult, CoreError>> {
  const scope = ControlScope.safeParse(i.scope);
  if (!scope.success) return err(coreError('invalid_input', scope.error.message));
  if (!enforceable(scope.data)) {
    return err(
      coreError('invalid_input', `no control is enforced on a ${scope.data.kind} scope yet`),
    );
  }
  const params = ParamsOf(i.kind, i.params);
  if (!params.ok) return params;
  const now = clockOf(deps).now();
  const expires = i.expires_at ?? null;
  if (expires !== null && Date.parse(expires) <= now.getTime()) {
    return err(coreError('invalid_input', 'expires_at is in the past'));
  }
  const action_id = newId<'OpsAction'>(now.getTime());
  const control_id = newId<'Control'>(now.getTime());
  const done = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [opsPreviewStream(i.preview_id)]);
    const evs = await j.events(opsPreviewStream(i.preview_id));
    const shown = evs.find((e) => e.type === CONTROL_EVENT.previewed);
    if (!shown) return err(coreError('not_found', 'no such preview'));
    const preview = OpsPreview.parse(shown.payload);
    if (evs.some((e) => e.type === CONTROL_EVENT.preview_consumed)) {
      return err(coreError('conflict', 'the preview was already used: preview again'));
    }
    if (preview.actor !== i.actor)
      return err(coreError('forbidden', "the preview is another person's"));
    if (preview.nonce !== i.nonce)
      return err(coreError('forbidden', 'the preview nonce does not match'));
    if (preview.verb !== verbOf(i.kind))
      return err(coreError('conflict', 'the preview is for another action'));
    if (Date.parse(preview.expires_at) <= now.getTime()) {
      return err(coreError('conflict', 'the preview expired: preview again'));
    }
    if (hashCanonical(preview.blast_radius.scope) !== hashCanonical(scope.data)) {
      return err(coreError('conflict', 'the preview is for another scope'));
    }
    const radius = await blastRadius(deps.pool, scope.data, now);
    if (hashCanonical(radius) !== preview.blast_radius_hash) {
      return err(
        coreError(
          'conflict',
          'what the action would touch changed since the preview: preview again',
        ),
      );
    }
    let stepUp: StepUpUse | null = null;
    if (i.step_up) {
      if (!deps.stepUp) {
        return err(coreError('unavailable', 'no step-up verifier is configured: refused'));
      }
      const v = await deps.stepUp.verify(
        i.step_up.proof,
        preview.blast_radius_hash as Sha256Hex,
        i.actor,
      );
      if (!v.ok) return err(coreError('refused', `step_up_invalid: ${v.error.message}`));
      stepUp = {
        principal: i.actor,
        bound_hash: preview.blast_radius_hash,
        proof_sha256: sha256Hex(i.step_up.proof),
        used_for: { kind: 'ops_action', id: action_id },
        used_at: now.toISOString(),
      };
    }
    const consumed = await j.emit(
      opsPreviewStream(i.preview_id),
      CONTROL_EVENT.preview_consumed,
      { preview_id: i.preview_id, action_id },
      i.actor,
    );
    if (!consumed.ok) return consumed;
    const action = OpsAction.parse({
      action_id,
      verb: verbOf(i.kind),
      action_class: 'O-T',
      tier: i.kind === 'halt' ? 'R' : 'L',
      actor: i.actor,
      scope: scope.data,
      ledger_state: 'pending',
      ledger_entry_id: null,
      backfilled: false,
      created_at: now.toISOString(),
      ...(stepUp ? { step_up: stepUp } : {}),
    });
    const a = await j.emit(opsActionStream(action_id), CONTROL_EVENT.action, action, i.actor);
    if (!a.ok) return a;
    const control = OpsControl.parse({
      control_id,
      kind: i.kind,
      scope: scope.data,
      origin_kind: i.origin_kind ?? 'operator',
      state: 'active',
      expires_at: expires,
      params: params.value,
      created_by_action: action_id,
      created_at: now.toISOString(),
      lifted_at: null,
    });
    const c = await j.emit(
      controlStream(control_id),
      CONTROL_EVENT.control_applied,
      control,
      i.actor,
    );
    if (!c.ok) return c;
    return ok({ action, control });
  });
  if (!done.ok) return done;
  const ledgered = await ledgerOpsAction(deps, done.value.action.action_id, false);
  return ok({
    ...done.value,
    action: ledgered.ok ? ledgered.value : done.value.action,
  });
}

/** Lifts a control. Guarded and ledgered like an apply; needs no preview (it takes nothing away). */
export async function liftControl(
  deps: CoreDeps,
  o: { control_id: string; actor: PrincipalId; reason: string },
): Promise<Result<OpsResult, CoreError>> {
  const now = clockOf(deps).now();
  const action_id = newId<'OpsAction'>(now.getTime());
  const done = await inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [controlStream(o.control_id)]);
    const cur = foldControl(await j.events(controlStream(o.control_id)), now);
    if (!cur) return err(coreError('not_found', 'no such control'));
    if (cur.state !== 'active')
      return err(coreError('conflict', `the control is already ${cur.state}`));
    const action = OpsAction.parse({
      action_id,
      verb: 'control.lift',
      action_class: 'O-T',
      tier: 'L',
      actor: o.actor,
      scope: cur.scope,
      ledger_state: 'pending',
      ledger_entry_id: null,
      backfilled: false,
      created_at: now.toISOString(),
    });
    const a = await j.emit(opsActionStream(action_id), CONTROL_EVENT.action, action, o.actor);
    if (!a.ok) return a;
    const l = await j.emit(
      controlStream(o.control_id),
      CONTROL_EVENT.control_lifted,
      { control_id: o.control_id, action_id, reason: o.reason },
      o.actor,
    );
    if (!l.ok) return l;
    return ok({
      action,
      control: { ...cur, state: 'lifted' as const, lifted_at: now.toISOString() },
    });
  });
  if (!done.ok) return done;
  const ledgered = await ledgerOpsAction(deps, action_id, false, {
    control_id: o.control_id,
    reason: o.reason,
  });
  return ok({ ...done.value, action: ledgered.ok ? ledgered.value : done.value.action });
}

// ---------------------------------------------------------------- Banners

export async function publishBanner(
  deps: CoreDeps,
  o: {
    actor: PrincipalId;
    scope: unknown;
    target?: BannerTarget;
    severity: BannerSeverity;
    text: string;
    expires_at: string;
  },
): Promise<Result<OpsResult, CoreError>> {
  const scope = ControlScope.safeParse(o.scope);
  if (!scope.success) return err(coreError('invalid_input', scope.error.message));
  const now = clockOf(deps).now();
  if (Date.parse(o.expires_at) <= now.getTime()) {
    return err(coreError('invalid_input', 'a banner needs an expiry in the future'));
  }
  const action_id = newId<'OpsAction'>(now.getTime());
  const banner_id = newId<'Banner'>(now.getTime());
  const done = await inCoreTx(deps, async (j) => {
    const action = OpsAction.parse({
      action_id,
      verb: 'banner.publish',
      action_class: 'O-N',
      tier: 'L',
      actor: o.actor,
      scope: scope.data,
      ledger_state: 'pending',
      ledger_entry_id: null,
      backfilled: false,
      created_at: now.toISOString(),
    });
    const a = await j.emit(opsActionStream(action_id), CONTROL_EVENT.action, action, o.actor);
    if (!a.ok) return a;
    const banner = Banner.parse({
      banner_id,
      target: o.target ?? 'banner',
      severity: o.severity,
      source: action_id,
      scope: scope.data,
      text: o.text,
      expires_at: o.expires_at,
      published_at: now.toISOString(),
      withdrawn_at: null,
    });
    const b = await j.emit(
      bannerStream(banner_id),
      CONTROL_EVENT.banner_published,
      banner,
      o.actor,
    );
    if (!b.ok) return b;
    return ok({ action, banner });
  });
  if (!done.ok) return done;
  const ledgered = await ledgerOpsAction(deps, action_id, false);
  return ok({ ...done.value, action: ledgered.ok ? ledgered.value : done.value.action });
}

export async function withdrawBanner(
  deps: CoreDeps,
  o: { banner_id: string; actor: PrincipalId },
): Promise<Result<{ banner_id: string }, CoreError>> {
  const now = clockOf(deps).now();
  return inCoreTx(deps, async (j, tx) => {
    await lockKeys(tx, [bannerStream(o.banner_id)]);
    const evs = await j.events(bannerStream(o.banner_id));
    if (evs.length === 0) return err(coreError('not_found', 'no such banner'));
    if (evs.some((e) => e.type === CONTROL_EVENT.banner_withdrawn))
      return ok({ banner_id: o.banner_id });
    const w = await j.emit(
      bannerStream(o.banner_id),
      CONTROL_EVENT.banner_withdrawn,
      { banner_id: o.banner_id, at: now.toISOString() },
      o.actor,
    );
    return w.ok ? ok({ banner_id: o.banner_id }) : w;
  });
}

/** The banners in force: published, not withdrawn, not expired. */
export async function activeBanners(db: Executor, now: Date): Promise<Banner[]> {
  const out: Banner[] = [];
  for (const stream of await streamsOf(db, 'banner')) {
    const evs = await eventsOf(db, stream);
    const pub = evs.find((e) => e.type === CONTROL_EVENT.banner_published);
    if (!pub) continue;
    const b = Banner.parse(pub.payload);
    if (evs.some((e) => e.type === CONTROL_EVENT.banner_withdrawn)) continue;
    if (Date.parse(b.expires_at) <= now.getTime()) continue;
    out.push(b);
  }
  return out.sort((a, b) => a.published_at.localeCompare(b.published_at));
}

// ---------------------------------------------------------------- Ledgering (execute first, ledger after)

/** An OpsAction as its stream holds it: the action, and whether a `ops.ledgered` followed. */
export async function readOpsAction(db: Executor, action_id: string): Promise<OpsAction | null> {
  const evs = await eventsOf(db, opsActionStream(action_id));
  const a = evs.find((e) => e.type === CONTROL_EVENT.action);
  if (!a) return null;
  const action = OpsAction.parse(a.payload);
  const l = evs.find((e) => e.type === CONTROL_EVENT.ledgered);
  if (!l) return action;
  const p = l.payload as { ledger_entry_id: string; backfilled: boolean };
  return {
    ...action,
    ledger_state: 'ledgered',
    ledger_entry_id: p.ledger_entry_id,
    backfilled: p.backfilled,
  };
}

/**
 * Writes the ledger entry of an action already executed, through the Notary, and records that it is
 * ledgered. A Notary that is down leaves it `pending` (the action stays in force). Once per action.
 */
export async function ledgerOpsAction(
  deps: CoreDeps,
  action_id: string,
  backfilled: boolean,
  extra: Record<string, unknown> = {},
): Promise<Result<OpsAction, CoreError>> {
  const ledger = deps.ledger;
  if (!ledger)
    return err(coreError('unavailable', 'no ledger is configured: the action stays pending'));
  const r = await inCoreLedgerTx({ ...deps, ledger }, async (j, tx) => {
    await lockKeys(tx, [opsActionStream(action_id)]);
    await lockLedger(tx);
    const pending: PendingConfirm[] = [];
    const caught = await importUnconfirmed(tx, ledger);
    if (!caught.ok) return err(coreError('unavailable', caught.error.message));
    pending.push(...caught.value.pending);
    const evs = await j.events(opsActionStream(action_id));
    const a = evs.find((e) => e.type === CONTROL_EVENT.action);
    if (!a) return err(coreError('not_found', 'no such action'));
    const action = OpsAction.parse(a.payload);
    if (evs.some((e) => e.type === CONTROL_EVENT.ledgered)) {
      return ok({ value: (await readOpsAction(tx, action_id)) as OpsAction, pending });
    }
    const entry_id = deterministicId<'LedgerEntry'>(`ops.action:${action_id}`);
    const w = await j.emit(
      opsActionStream(action_id),
      CONTROL_EVENT.ledgered,
      { action_id, ledger_entry_id: entry_id, backfilled },
      OPS_ACTOR,
    );
    if (!w.ok) return w;
    const draft: LedgerEntryDraft = {
      entry_id,
      entry_type: OPS_LEDGER_ENTRY_TYPE,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: null,
      subject_id: null,
      subject_hash: null,
      decision: null,
      actor: action.actor,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: {
        kind: 'ops_action',
        action_id,
        verb: action.verb,
        action_class: action.action_class,
        tier: action.tier,
        scope: action.scope,
        backfilled,
        executed_at: action.created_at,
        // M19: the step-up the action consumed, ledgered with it (also when the backfill writes the entry)
        ...(action.step_up ? { step_up: action.step_up } : {}),
        ...extra,
      } as never,
      created_at: clockOf(deps).now().toISOString(),
    };
    const l = await appendLedgerEntryTx(tx, ledger, draft);
    if (!l.ok) return err(coreError('unavailable', l.error.message));
    pending.push(...l.value.pending);
    return ok({
      value: {
        ...action,
        ledger_state: 'ledgered' as const,
        ledger_entry_id: entry_id,
        backfilled,
      },
      pending,
    });
  });
  return r;
}

/** After a Notary outage: ledgers every action that was executed and left `pending`, marked backfilled. */
export async function backfillOpsLedger(
  deps: CoreDeps,
): Promise<{ ledgered: number; failed: number }> {
  let ledgered = 0;
  let failed = 0;
  for (const stream of await streamsOf(deps.pool, 'ops_action')) {
    const id = stream.slice('ops_action:'.length);
    const a = await readOpsAction(deps.pool, id);
    if (!a || (a.ledger_state !== 'none' && a.ledger_state !== 'pending')) continue;
    const r = await ledgerOpsAction(deps, id, true);
    if (r.ok) ledgered += 1;
    else failed += 1;
  }
  return { ledgered, failed };
}

// ---------------------------------------------------------------- Enforcement (read by the work driver)

/**
 * Why a stage command must wait for the scope it belongs to, or `null`. `hold` and `maintenance` stop
 * every stage command in the scope; `halt` stops the release steps. A `clamp` is not a refusal here: it
 * limits admission at 6.0 (`clampAdmission`).
 */
export function controlRefusal(
  all: readonly OpsControl[],
  q: KillQuery,
  port: string,
): OpsControl | null {
  for (const c of all) {
    if (!scopeCoversQuery(c.scope, q)) continue;
    if (c.kind === 'hold' || c.kind === 'maintenance') return c;
    if (c.kind === 'halt' && port === 'release') return c;
  }
  return null;
}

/**
 * The room a clamp leaves for one more agent session in the scope: `null` when no clamp applies,
 * else `max_in_flight` minus the items of its scope with an agent session or lease open.
 */
export async function clampRoom(
  pool: pg.Pool,
  all: readonly OpsControl[],
  q: KillQuery,
): Promise<{ room: number; control: OpsControl } | null> {
  let worst: { room: number; control: OpsControl } | null = null;
  for (const c of all) {
    if (c.kind !== 'clamp' || !scopeCoversQuery(c.scope, q)) continue;
    const max = (c.params as { max_in_flight?: number }).max_in_flight ?? 0;
    const project = projectOfScope(c.scope);
    const lane = c.scope.kind === 'lane' ? (c.scope.ref.split('/')[1] ?? null) : null;
    const n = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM core.work_item
        WHERE terminal IS NULL AND in_flight AND ($1::text IS NULL OR project_id = $1)
          AND ($2::text IS NULL OR COALESCE(lane, proposed_lane) = $2)`,
      [project, lane],
    );
    const room = max - Number(n.rows[0]?.n ?? 0);
    if (worst === null || room < worst.room) worst = { room, control: c };
  }
  return worst;
}

// ---------------------------------------------------------------- Effects on items

export const CONTROL_HOLD_ID = 'control';
export const MAINTENANCE_CONTROL_HOLD_ID = 'mc';

/**
 * Puts a `control` hold on the items an active `hold` control covers and a `maintenance` hold (timers
 * frozen, drafts kept) on those a `maintenance` control covers, and takes them off when the control is
 * lifted or has expired. One hold per kind, whatever number of controls cover an item.
 */
export async function syncControlHolds(
  deps: CoreDeps,
  itemIds: readonly string[],
): Promise<{ placed: number; released: number }> {
  const all = await activeControls(deps.pool, clockOf(deps).now());
  let placed = 0;
  let released = 0;
  for (const id of itemIds) {
    const item = await readItem(deps.pool, id);
    if (!item || item.state.terminal !== null) continue;
    const s = item.state;
    const q = { project_id: s.project_id, lane: (s.lane ?? s.proposed_lane) as Lane };
    for (const [kind, hold_id, reason] of [
      ['hold', CONTROL_HOLD_ID, 'control'],
      ['maintenance', MAINTENANCE_CONTROL_HOLD_ID, 'maintenance'],
    ] as const) {
      const cover = controlsCovering(all, q, kind)[0];
      const r = await setHold(deps, id, s, {
        hold_id,
        reason,
        origin: cover?.control_id ?? null,
        want: cover !== undefined,
      });
      if (r === 'placed') placed += 1;
      if (r === 'released') released += 1;
    }
  }
  return { placed, released };
}

/** A capacity port that never releases more WIP-held items than a clamp leaves room for. */
export function clampedCapacity(
  pool: pg.Pool,
  base: CapacityPort | undefined,
  clock: Clock,
): CapacityPort | undefined {
  if (!base) return base;
  return {
    async take(reason, scope, wanted) {
      if (reason === 'WIP') {
        const all = await activeControls(pool, clock.now());
        const clamp = await clampRoom(pool, all, { project_id: scope.project_id });
        if (clamp !== null) wanted = Math.max(0, Math.min(wanted, clamp.room));
      }
      return base.take(reason, scope, wanted);
    },
  };
}

/**
 * M19 (the Notary-down drill): core-worker's `ops_backfill` loop. After a Notary outage every action executed and
 * left `pending` is ledgered, marked `backfilled`, with the step-up it consumed. A failed one is a failed tick (the
 * supervisor's backoff and health show it); it is retried on the next.
 */
export function opsBackfillLoop(
  deps: LedgeredDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 60_000;
  return {
    name: 'ops_backfill',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(5_000, intervalMs), maxMs: Math.max(intervalMs, 60_000) },
    async tick() {
      const r = await backfillOpsLedger(deps);
      if (r.failed > 0) throw new Error(`${r.failed} ops action(s) could not be ledgered yet`);
      return { ok: r.ledgered, failed: 0 };
    },
  };
}
