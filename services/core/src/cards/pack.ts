import {
  ONBOARDING_PACK_EPOCH,
  ONBOARDING_PACK_LANE,
  ONBOARDING_PACK_UNIT,
  PACK_EVENT,
  PackRenderedPayload,
  PackX2OpenedPayload,
  PushIntendedPayload,
  PushReceipt,
  PushRefusalCode,
  packStream,
  unitBranchOf,
  type PackProjectionView,
  type PatchSet,
} from '@aisdlc/contracts';
import { openCard, readGateState } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { LoopContext, LoopSpec } from '@aisdlc/loops';
import { renderOnboardingPack, type PackClaim, type PackInstruction } from '@aisdlc/onboarding';
import type { CodeHostPort } from '@aisdlc/ports';
import type { Tx } from '@aisdlc/record';
import { scanText } from '@aisdlc/secrets-rules';
import type pg from 'pg';
import {
  listPushReceipts,
  receiptIdOf,
  recordPushIntent,
  recordPushReceipt,
  type CorePushDeps,
} from '../build/push.js';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys } from '../journal.js';
import { activeS0Ids } from '../queries.js';
import { lightProposalOf, reviewsOf } from './light.js';
import { decisionsFor, SYSTEM_CARDS_ACTOR, type CardDeps } from './model.js';
import { appliedCards } from './sync.js';
import { loadS0, s0Cards, type LoadedS0 } from './read.js';

// The affirmed pack's git projection (PLAN M16 R2b; onboarding-roadmap §4.1 item 7, §6.4; DEC-12(a), DEC-13(a)(i)).
//
//   1. card 2 applied (approved): the pack is rendered from the RECORD (the affirmed text by hash, the claims as
//      decided) by `renderOnboardingPack`, secret-scanned, and recorded first (`pack.rendered` on `pack:<s0>`);
//   2. X2 is opened on the S0 record (subject `s0_record`, the record's UUID), its subject hash the patch hash and its
//      facts the pack's files as an artefact of step 0.2 (`pack.x2_opened`). Only the `x` slot decides it;
//   3. X2 approved in the LEDGER (`readGateState`, never a projection): the factory asks the Push Broker for a draft PR
//      on `agent/<s0>/onboarding-pack`, with the intent recorded first and the receipt as a record event and a ledger
//      entry (`recordPushIntent`, `recordPushReceipt`). The broker asks core for the lease and the X2 binding itself
//      (`CorePushGuards`: `packLeaseFacts`, `x2BoundToPatch`) and refuses a different patch;
//   4. X2 rejected: nothing is pushed. A person merges the PR or not; the factory never merges.
//
// The rows `core.onboarding_pack` fold `pack.*` events and are rebuilt from them (`rebuildPacks`).

export const PACK_ACTOR = 'system.pack';

export interface PackDeps {
  readonly cards: CardDeps;
  /** The ledger client the push receipts need (the record and the ledger, the lock order). */
  readonly push: CorePushDeps;
  /** The Push Broker (`HttpCodeHostPush`); absent: the pack waits at `x2_approved`. */
  readonly broker?: Pick<CodeHostPort, 'apply_patch'>;
}

// ---------------------------------------------------------------- read model

export async function applyPackEvent(
  tx: Pick<Tx, 'query'>,
  e: { type: string; payload: unknown; global_seq: number },
): Promise<void> {
  if (e.type === PACK_EVENT.rendered) {
    const p = PackRenderedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.onboarding_pack
         (patch_hash, s0_id, project_id, repo, base_sha, c2_card_id, files, rendered_at, event_gseq)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (s0_id, patch_hash) DO NOTHING`,
      [
        p.patch_hash,
        p.s0_id,
        p.project_id,
        p.repo,
        p.base_sha,
        p.c2_card_id,
        JSON.stringify(p.files),
        p.rendered_at,
        e.global_seq,
      ],
    );
    return;
  }
  if (e.type === PACK_EVENT.x2_opened) {
    const p = PackX2OpenedPayload.parse(e.payload);
    await tx.query(
      `UPDATE core.onboarding_pack SET x2_card_id = $3, x2_gate_instance_id = $4, event_gseq = $5
        WHERE s0_id = $1 AND patch_hash = $2`,
      [p.s0_id, p.patch_hash, p.card_id, p.gate_instance_id, e.global_seq],
    );
  }
}

export async function rebuildPacks(d: Pick<CardDeps, 'pool' | 'clock'>, s0Id: string) {
  const q = await d.pool.query<{ type: string; body: unknown; global_seq: string }>(
    `SELECT type, body, global_seq::text AS global_seq FROM record.record_event
      WHERE stream = $1 ORDER BY record_event.global_seq`,
    [packStream(s0Id)],
  );
  const w = await inCoreTx(d, async (_j, tx) => {
    await lockKeys(tx, [packStream(s0Id)]);
    await tx.query('DELETE FROM core.onboarding_pack WHERE s0_id = $1', [s0Id]);
    for (const e of q.rows) {
      await applyPackEvent(tx, { type: e.type, payload: e.body, global_seq: Number(e.global_seq) });
    }
    return ok(q.rows.length);
  });
  if (!w.ok) throw new Error(w.error.message);
  return w.value;
}

interface PackRow {
  patch_hash: string;
  base_sha: string;
  repo: string;
  project_id: string;
  files: PackRenderedPayload['files'];
  x2_card_id: string | null;
  x2_gate_instance_id: string | null;
}

async function latestPack(db: Pick<pg.Pool, 'query'>, s0Id: string): Promise<PackRow | null> {
  const q = await db.query<PackRow>(
    `SELECT patch_hash, base_sha, repo, project_id, files, x2_card_id, x2_gate_instance_id
       FROM core.onboarding_pack WHERE s0_id = $1 ORDER BY event_gseq DESC LIMIT 1`,
    [s0Id],
  );
  return q.rows[0] ?? null;
}

// ---------------------------------------------------------------- what card 2 decided, from the record

interface Affirmed {
  readonly card_id: string;
  readonly payload_hash: string;
  readonly instructions: PackInstruction[];
  readonly claims: PackClaim[];
  readonly base_sha: string;
}

/** Card 2's newest approved AND applied decision, read back from the record: what the pack renders. */
export function affirmedOf(
  loaded: LoadedS0,
  cards: Awaited<ReturnType<typeof s0Cards>>,
): Result<Affirmed | null, CoreError> {
  const applied = appliedCards(loaded);
  const c2 = [...cards]
    .filter(
      (c) =>
        c.kind === 'C2' &&
        c.state.status === 'decided' &&
        c.state.steps[0]?.decision === 'approve' &&
        applied.has(c.card_id),
    )
    .sort((a, b) => b.occurrence - a.occurrence)[0];
  if (!c2) return ok(null);
  const payload = c2.state.payload?.payload ?? [];
  const payloadHash = c2.state.payload?.payload_hash ?? c2.state.decided[0]?.payload_hash;
  if (!payloadHash) return err(coreError('conflict', 'card 2 was decided without a payload hash'));
  const proposal = lightProposalOf(loaded, c2.occurrence);
  if (!proposal) return err(coreError('conflict', 'card 2 has no recorded proposal'));
  // every text the record holds for this raising, by hash: the proposal's and each edit's
  const texts = new Map<string, string>();
  for (const r of proposal.instructions) {
    if (r.proposed.text !== null && r.proposed.text_sha256 !== null) {
      texts.set(r.proposed.text_sha256, r.proposed.text);
    }
  }
  for (const r of reviewsOf(loaded, c2.occurrence, proposal).values()) {
    if (r.proposed.text !== null && r.proposed.text_sha256 !== null) {
      texts.set(r.proposed.text_sha256, r.proposed.text);
    }
  }
  const instructions: PackInstruction[] = [];
  for (const row of payload) {
    if (row.kind !== 'instruction_affirmation') continue;
    const text = texts.get(row.text_sha256);
    if (text === undefined) {
      return err(coreError('conflict', `the affirmed text of ${row.path} is not on the record`));
    }
    const source = proposal.instructions.find((r) => r.path === row.path);
    instructions.push({
      path: row.path,
      text,
      text_sha256: row.text_sha256,
      source_text_sha256: source?.source_text_sha256 ?? null,
    });
  }
  const verdicts = new Map(
    payload.flatMap((r) => (r.kind === 'claim_verdict' ? [[r.claim_id, r] as const] : [])),
  );
  const claims: PackClaim[] = proposal.claims.map((c) => {
    const v = verdicts.get(c.claim_id);
    return {
      claim_id: c.claim_id,
      category: c.category,
      text: c.text,
      verdict: v?.verdict ?? 'unknown',
      correction: v?.correction ?? null,
      evidence: c.evidence.map((e) => ({ path: e.path, line: e.line })),
    };
  });
  return ok({
    card_id: c2.card_id,
    payload_hash: payloadHash,
    instructions,
    claims,
    base_sha: proposal.baseline_sha,
  });
}

// ---------------------------------------------------------------- the step

const view = (
  s0Id: string,
  state: PackProjectionView['state'],
  row: PackRow | null,
  extra: Partial<PackProjectionView> = {},
): PackProjectionView => ({
  s0_id: s0Id as never,
  state,
  patch_hash: (row?.patch_hash ?? null) as never,
  files: row?.files ?? [],
  x2_card_id: row?.x2_card_id ?? null,
  pr_number: null,
  head_sha: null,
  refusal: null,
  ...extra,
});

/**
 * Moves an S0 record's pack projection as far as it can go now, and says where it stands. Idempotent: each step is
 * recorded once (the pack by its patch hash, X2 by its card, the push by its receipt), and a step that already
 * happened is read back, never repeated.
 */
export async function projectPack(
  d: PackDeps,
  s0Id: string,
): Promise<Result<PackProjectionView, CoreError>> {
  const pool = d.cards.pool;
  const loaded = await loadS0(pool, s0Id);
  if (!loaded) return err(coreError('not_found', `no S0 record ${s0Id}`));
  const cards = await s0Cards(pool, s0Id);
  const aff = affirmedOf(loaded, cards);
  if (!aff.ok) return aff;
  if (aff.value === null) return ok(view(s0Id, 'waiting_for_c2', null));
  const a = aff.value;
  let rendered;
  try {
    rendered = renderOnboardingPack({
      s0_id: s0Id,
      repo: loaded.s0.repo,
      base_sha: a.base_sha,
      c2_card_id: a.card_id,
      c2_payload_hash: a.payload_hash,
      instructions: a.instructions,
      claims: a.claims,
    });
  } catch (e) {
    return err(coreError('conflict', (e as Error).message));
  }
  if (rendered === null) return err(coreError('conflict', 'card 2 affirmed nothing to write'));

  // 1. record first: the pack, by its patch hash (secret-scanned before it is stored or offered)
  for (const f of rendered.patch.files) {
    if (f.op === 'put' && scanText(Buffer.from(f.content_b64, 'base64').toString('utf8')).length) {
      return err(
        coreError('refused', `the pack's ${f.path} would hold a secret: nothing recorded`),
      );
    }
  }
  let row = await latestPack(pool, s0Id);
  if (row?.patch_hash !== rendered.patch_hash) {
    const payload = PackRenderedPayload.parse({
      s0_id: s0Id,
      project_id: loaded.s0.record.project_id,
      repo: loaded.s0.repo,
      base_sha: a.base_sha,
      c2_card_id: a.card_id,
      c2_payload_hash: a.payload_hash,
      renderer: 'onboarding-pack/1',
      files: rendered.files,
      patch_hash: rendered.patch_hash,
      rendered_at: clockOf(d.cards).now().toISOString(),
    });
    const w = await inCoreTx(d.cards, async (j, tx) => {
      await lockKeys(tx, [packStream(s0Id)]);
      const e = await j.emit(packStream(s0Id), PACK_EVENT.rendered, payload, PACK_ACTOR);
      if (!e.ok) return e;
      await applyPackEvent(tx, { type: e.value.type, payload, global_seq: e.value.global_seq });
      return ok(true);
    });
    if (!w.ok) return w;
    row = await latestPack(pool, s0Id);
  }
  if (!row) return err(coreError('database', 'the pack row was not written'));

  // 2. X2 on the S0 record, bound to exactly this patch
  if (row.x2_gate_instance_id === null) {
    const opened = await openCard(decisionsFor(d.cards, s0Id), {
      project_id: loaded.s0.record.project_id as never,
      subject_kind: 's0_record',
      subject_id: s0Id,
      gates: [
        {
          gate_id: 'X2',
          subject_hash: rendered.patch_hash as never,
          facts: {
            kind: 'onboarding_pack',
            repo: loaded.s0.repo,
            base_sha: a.base_sha,
            branch: unitBranchOf(s0Id, ONBOARDING_PACK_UNIT),
            card_2: { card_id: a.card_id, payload_hash: a.payload_hash },
            artefacts: [{ step: '0.2', type: 'onboarding_pack', sha256: rendered.patch_hash }],
            files: rendered.files,
          } as never,
        },
      ],
      requester: null,
      label: 'X2',
      opened_by: SYSTEM_CARDS_ACTOR,
    });
    if (!opened.ok) return err(coreError('unavailable', `X2: ${opened.error.message}`));
    const gi = opened.value.gate_instance_ids[0];
    if (!gi) return err(coreError('database', 'X2 opened without a gate instance'));
    const x = PackX2OpenedPayload.parse({
      s0_id: s0Id,
      patch_hash: rendered.patch_hash,
      card_id: opened.value.card_id,
      gate_instance_id: gi,
    });
    const w = await inCoreTx(d.cards, async (j, tx) => {
      await lockKeys(tx, [packStream(s0Id)]);
      const e = await j.emit(packStream(s0Id), PACK_EVENT.x2_opened, x, PACK_ACTOR);
      if (!e.ok) return e;
      await applyPackEvent(tx, { type: e.value.type, payload: x, global_seq: e.value.global_seq });
      return ok(true);
    });
    if (!w.ok) return w;
    row = { ...row, x2_card_id: x.card_id, x2_gate_instance_id: gi };
  }

  // 3. the decision, from the ledger
  const gate = await readGateState(pool, row.x2_gate_instance_id as string);
  if (!gate || gate.status === 'pending') return ok(view(s0Id, 'x2_pending', row));
  if (gate.status !== 'decided' || gate.outcome !== 'approve') {
    return ok(view(s0Id, 'x2_rejected', row));
  }
  const receipts = (await listPushReceipts(pool, s0Id)).filter(
    (r) => r.unit_key === ONBOARDING_PACK_UNIT && r.patch_hash === row.patch_hash,
  );
  const applied = receipts.find((r) => r.status === 'applied');
  if (applied) {
    return ok(
      view(s0Id, 'pushed', row, { pr_number: applied.pr_number, head_sha: applied.head_sha }),
    );
  }
  const refused = receipts.find((r) => r.status !== 'applied');
  if (refused) return ok(view(s0Id, 'refused', row, { refusal: refused.code }));
  if (!d.broker) return ok(view(s0Id, 'x2_approved', row));
  return pushPack(d, s0Id, row, rendered.patch);
}

async function pushPack(
  d: PackDeps & { broker?: Pick<CodeHostPort, 'apply_patch'> },
  s0Id: string,
  row: PackRow,
  patch: PatchSet,
): Promise<Result<PackProjectionView, CoreError>> {
  const broker = d.broker;
  if (!broker) return ok(view(s0Id, 'x2_approved', row));
  const branch = unitBranchOf(s0Id, ONBOARDING_PACK_UNIT);
  const prior = (await listPushReceipts(d.cards.pool, s0Id)).filter(
    (r) => r.unit_key === ONBOARDING_PACK_UNIT && r.status === 'applied',
  );
  const intent = PushIntendedPayload.parse({
    item_id: s0Id,
    unit_key: ONBOARDING_PACK_UNIT,
    repo: row.repo,
    branch,
    lease_epoch: ONBOARDING_PACK_EPOCH,
    base_sha: row.base_sha,
    patch_hash: row.patch_hash,
    files: patch.files.length,
    command_key: `pack:${s0Id}:${row.patch_hash}`,
  });
  const w = await recordPushIntent(d.push, intent);
  if (!w.ok) return w;
  const lines = patch.files.reduce(
    (n, f) =>
      n +
      (f.op === 'put'
        ? Buffer.from(f.content_b64, 'base64').toString('utf8').split('\n').length
        : 0),
    0,
  );
  const r = await broker.apply_patch({
    repo: row.repo,
    item_id: s0Id,
    unit_key: ONBOARDING_PACK_UNIT,
    lane: ONBOARDING_PACK_LANE,
    lease_epoch: ONBOARDING_PACK_EPOCH,
    branch,
    base_sha: row.base_sha,
    expected_head: prior.at(-1)?.head_sha ?? null,
    patch,
    message: 'Onboarding pack: the affirmed instruction text and knowledge',
    evidence: {
      title: 'Onboarding pack (Light, card 2 affirmed)',
      lane: ONBOARDING_PACK_LANE,
      base_sha: row.base_sha,
      oracles: [],
      files_changed: patch.files.length,
      lines_changed: lines,
      checks: [],
      refs: {
        s0_record: s0Id,
        x2_gate: row.x2_gate_instance_id ?? '',
        patch: row.patch_hash,
      },
    },
  } as never);
  const at = clockOf(d.cards).now().toISOString();
  const base = {
    item_id: s0Id,
    unit_key: ONBOARDING_PACK_UNIT,
    repo: row.repo,
    branch,
    lease_epoch: ONBOARDING_PACK_EPOCH,
    patch_hash: row.patch_hash,
    base_sha: row.base_sha,
    files: patch.files.length,
    at,
  };
  if (r.state === 'ok') {
    const receipt = PushReceipt.parse({
      ...base,
      receipt_id: receiptIdOf(s0Id, ONBOARDING_PACK_UNIT, row.patch_hash, 1, 'applied', null),
      status: 'applied',
      code: null,
      head_sha: r.value.commit_sha,
      pr_number: r.value.pr.number,
    });
    const rec = await recordPushReceipt(d.push, receipt, 's0_record');
    if (!rec.ok) return rec;
    return ok(
      view(s0Id, 'pushed', row, { pr_number: r.value.pr.number, head_sha: r.value.commit_sha }),
    );
  }
  const code = r.code ? PushRefusalCode.safeParse(r.code) : null;
  if (!code?.success) {
    // no verdict: unknown whether it ran. The intent stays; the next tick asks again.
    return err(
      coreError('unavailable', `the Push Broker gave no verdict (${r.state}/${r.reason})`),
    );
  }
  const status =
    code.data === 'stale_epoch'
      ? 'refused_stale_epoch'
      : code.data === 'no_lease'
        ? 'no_lease'
        : 'refused';
  const receipt = PushReceipt.parse({
    ...base,
    receipt_id: receiptIdOf(s0Id, ONBOARDING_PACK_UNIT, row.patch_hash, 1, status, code.data),
    status,
    code: code.data,
    head_sha: null,
    pr_number: null,
  });
  const rec = await recordPushReceipt(d.push, receipt, 's0_record');
  if (!rec.ok) return rec;
  return ok(view(s0Id, 'refused', row, { refusal: code.data }));
}

// ---------------------------------------------------------------- the loop

/**
 * `onboarding_pack`: the pack projection of every S0 record whose card 2 is applied and whose pack is not pushed yet.
 * A record still waiting for card 2 is a no-op.
 */
export function packLoop(
  d: PackDeps,
  o: { intervalMs?: number; startDelayMs?: number } = {},
): LoopSpec {
  const intervalMs = o.intervalMs ?? 30_000;
  return {
    name: 'onboarding_pack',
    intervalMs,
    ...(o.startDelayMs === undefined ? {} : { startDelayMs: o.startDelayMs }),
    retry: { baseMs: Math.min(10_000, intervalMs), maxMs: Math.max(intervalMs, 120_000) },
    async tick(ctx: LoopContext) {
      const ids = await activeS0Ids(d.cards.pool);
      return ctx.eachItem(
        ids,
        (id) => `pack ${id}`,
        async (id) => {
          const r = await projectPack(d, id);
          if (!r.ok && r.error.code !== 'conflict') throw new Error(r.error.message);
        },
      );
    },
  };
}
