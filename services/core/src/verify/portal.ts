import {
  ITEM_EVENT,
  VERIFY_CHECK_OF_STEP,
  VERIFY_EVENT,
  VERIFY_STEPS,
  VerifyCheckRecordedPayload,
  repairClassOf,
  verifyResultHash,
  verifyStream,
  type EvidencePackContents,
  type EvidencePackSignedPayload,
  type EvidencePackSummary,
  type EvidencePackView,
  type GateOpenedPayload,
  type GateCardContext,
  type ItemVerifyView,
  type RaisedGateView,
  type StepId,
  type VerifyCheckResult,
  type VerifyStep,
  type VerifyStepView,
} from '@aisdlc/contracts';
import { readCardOpened, readCardState } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type { ObjectStorePort } from '@aisdlc/ports';
import type { ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { z } from 'zod';
import { listPushReceipts } from '../build/push.js';
import { packGateContext } from '../cards/pack.js';
import { coreError, type CoreError } from '../errors.js';
import { artefactByHash } from '../planning/store.js';
import { listUnits } from '../planning/units.js';
import { readItem, readItemEvents } from '../work-items.js';
import { listEvidencePacks, readSignedPack } from './evidence.js';

// The portal's reads of S7 (PLAN M14.6): the checks 7.1 to 7.5 of a Unit head, the signed Evidence Pack of 7.6 and
// what an exception or quarantine gate binds. Every answer is built from the record alone: the verify service's
// `verify.check_recorded` events on `verify:<item>` (each result re-hashed to its address), the item's stream, the
// `core.evidence_pack` fold, the gates' streams and the ledger (through the decision kernel's readers). Nothing is
// decided here; the routes ask the PDP and the bff cuts each view to the person's data class.

interface Recorded {
  readonly result: VerifyCheckResult;
  readonly result_sha256: string;
  readonly at: string;
}

/** Every recorded S7 result of an item, in record order; a result that does not hash to its address is an error. */
export async function recordedResults(pool: pg.Pool, itemId: string): Promise<Recorded[]> {
  const q = await pool.query<{ body: unknown; occurred_at: Date }>(
    `SELECT body, occurred_at FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY seq`,
    [verifyStream(itemId), VERIFY_EVENT.check_recorded],
  );
  return q.rows.map((r) => {
    const p = VerifyCheckRecordedPayload.parse(r.body);
    if (verifyResultHash(p.result) !== p.result_sha256) {
      throw new Error(`verify:${itemId}: a result does not hash to its address`);
    }
    return { result: p.result, result_sha256: p.result_sha256, at: r.occurred_at.toISOString() };
  });
}

/** The card that carries each gate instance of an item (from its `gates_opened` events). */
async function cardsOfGates(pool: pg.Pool, itemId: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (const e of await readItemEvents(pool, itemId)) {
    if (e.type !== ITEM_EVENT.gates_opened) continue;
    const ids = (e.payload as { card_ids?: unknown }).card_ids;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string') continue;
      const o = await readCardOpened(pool, id);
      for (const t of o?.open.targets ?? []) {
        if (t.target === 'gate') out.set(t.gate_instance_id, id);
      }
    }
  }
  return out;
}

/** The gate a step's raise opened (the newest instance at its station; ET10 opens the SECT triage). */
function raisedGate(
  s: ItemState,
  step: VerifyStep,
  r: VerifyCheckResult,
  cards: Map<string, string>,
): RaisedGateView | null {
  const raise = r.raised;
  if (raise === null) return null;
  const match =
    raise.kind === 'gate'
      ? s.gates.filter((g) => g.gate === raise.gate && g.station === `${step}!${raise.gate}`)
      : s.gates.filter((g) => g.gate === 'SECT' && g.station.startsWith('sect:'));
  const g = match.at(-1);
  if (!g) return null;
  return {
    gate: g.gate,
    gate_instance_id: g.gate_instance_id,
    status: g.status,
    outcome: g.outcome,
    card_id: cards.get(g.gate_instance_id) ?? null,
  };
}

function stepView(
  s: ItemState,
  step: VerifyStep,
  runs: readonly Recorded[],
  cards: Map<string, string>,
): VerifyStepView {
  const latest = runs.at(-1);
  if (!latest) {
    return {
      step,
      check: VERIFY_CHECK_OF_STEP[step],
      status: 'not_run',
      verdict: null,
      result_sha256: null,
      recorded_at: null,
      raised: null,
      gate: null,
      mutation: null,
      rules_version: null,
      kits: { total: 0, answered: 0 },
      findings: { total: 0, failing: 0, items: [] },
      runs: 0,
    };
  }
  const r = latest.result;
  const failing = r.findings.filter((f) => f.severity === 'high' || f.severity === 'critical');
  // the failing findings first, then the rest, at most 100 (the counts say how many there are)
  const shown = [...failing, ...r.findings.filter((f) => !failing.includes(f))].slice(0, 100);
  return {
    step,
    check: r.check,
    status: r.raised !== null ? 'raised' : r.verdict,
    verdict: r.verdict,
    result_sha256: latest.result_sha256,
    recorded_at: latest.at,
    raised: r.raised,
    gate: raisedGate(s, step, r, cards),
    mutation: r.mutation,
    rules_version: r.rules_version,
    kits: { total: r.kits.length, answered: r.kits.filter((k) => k.status === 'answered').length },
    findings: {
      total: r.findings.length,
      failing: failing.length,
      items: shown.map((f) => ({
        kind: f.kind,
        severity: f.severity,
        repair_class: repairClassOf(f, step),
        rule_id: f.rule_id,
        path: f.path,
        line: f.line,
        message: f.message,
        withheld: false,
      })),
    },
    runs: runs.length,
  };
}

const summaryOf = (p: EvidencePackSignedPayload): EvidencePackSummary => ({
  pack_sha256: p.pack_sha256,
  unit_key: p.unit_key,
  base_sha: p.base_sha,
  head_sha: p.head_sha,
  passing: p.passing,
  disposition: p.disposition,
  key_id: p.key_id,
  bucket: p.bucket,
  object_key: p.object_key,
  handoff_pack_sha256: p.handoff_pack_sha256,
  produced_at: p.produced_at,
});

/** The heads S7 has results for, newest first. */
function headsOf(all: readonly Recorded[]): ItemVerifyView['heads'] {
  const m = new Map<string, { unit_key: string; results: number; last: string; order: number }>();
  all.forEach((x, i) => {
    const h = m.get(x.result.head_sha);
    m.set(x.result.head_sha, {
      unit_key: x.result.unit_key,
      results: (h?.results ?? 0) + 1,
      last: x.at,
      order: i,
    });
  });
  return [...m.entries()]
    .sort((a, b) => b[1].order - a[1].order)
    .map(([head_sha, v]) => ({
      head_sha,
      unit_key: v.unit_key,
      results: v.results,
      last_recorded_at: v.last,
    }));
}

/** The head the portal shows by default: the newest with a result, else the newest Unit head core knows. */
async function currentHead(
  pool: pg.Pool,
  itemId: string,
  all: readonly Recorded[],
): Promise<string | null> {
  const last = all.at(-1);
  if (last) return last.result.head_sha;
  const units = await listUnits(pool, itemId);
  const withHead = units.filter((u) => u.head_sha !== null);
  return withHead.at(-1)?.head_sha ?? null;
}

/** `GET /v1/items/:id/verify`: the checks of one head (`head`, else the current one), uncut (data class D2). */
export async function itemVerifyView(
  pool: pg.Pool,
  itemId: string,
  head?: string,
): Promise<Result<ItemVerifyView, CoreError>> {
  const item = await readItem(pool, itemId);
  if (!item) return err(coreError('not_found', 'no such item'));
  const s = item.state;
  const all = await recordedResults(pool, itemId);
  const shown = head ?? (await currentHead(pool, itemId, all));
  if (head !== undefined && !all.some((x) => x.result.head_sha === head)) {
    return err(coreError('not_found', 'S7 has no result for that head'));
  }
  const ofHead = all.filter((x) => x.result.head_sha === shown);
  const cards = await cardsOfGates(pool, itemId);
  const packs = (await listEvidencePacks(pool, itemId)).filter((p) => p.head_sha === shown);
  const first = ofHead[0]?.result;
  const units = first ? null : await listUnits(pool, itemId);
  const unit = units?.find((u) => u.head_sha === shown) ?? null;
  return ok({
    item_id: s.item_id as never,
    project_id: s.project_id as never,
    lane: s.lane ?? s.proposed_lane,
    phase: s.phase,
    step: stepOf(s),
    unit_key: first?.unit_key ?? unit?.unit_key ?? null,
    base_sha: first?.base_sha ?? unit?.base_sha ?? null,
    head_sha: shown,
    heads: headsOf(all),
    steps: VERIFY_STEPS.map((step) =>
      stepView(
        s,
        step,
        ofHead.filter((x) => x.result.step === step),
        cards,
      ),
    ),
    pack: packs.length > 0 ? summaryOf(packs[packs.length - 1] as EvidencePackSignedPayload) : null,
    data_class: 'D2',
  });
}

/** Where the item is: the step of what it waits for, or of its outstanding stage command. */
function stepOf(s: ItemState): StepId | null {
  const w = s.waiting;
  if (w?.kind === 'gates' && w.conditional !== null) return w.conditional.step;
  for (const c of s.outstanding) if (c.type === 'run_stage') return c.step;
  return null;
}

const verifyCommand = (p: EvidencePackSummary, itemId: string): string =>
  `aisdlc-verify-pack --pack ${p.object_key}.json --notary-key notary-evidence.jwk --head ${p.head_sha} --item ${itemId} --object-key ${p.object_key}${p.passing ? '' : ' --allow-not-passing'}`;

/** `GET /v1/items/:id/evidence`: the item's packs, and the contents of one read back and verified from the store. */
export async function evidencePackView(
  pool: pg.Pool,
  objects: ObjectStorePort | undefined,
  itemId: string,
  pack?: string,
): Promise<Result<EvidencePackView, CoreError>> {
  const item = await readItem(pool, itemId);
  if (!item) return err(coreError('not_found', 'no such item'));
  const recorded = await listEvidencePacks(pool, itemId);
  const chosen =
    pack === undefined ? recorded.at(-1) : recorded.find((p) => p.pack_sha256 === pack);
  if (pack !== undefined && !chosen) return err(coreError('not_found', 'no such pack'));
  let contents: EvidencePackContents | null = null;
  let problem: string | null = null;
  if (chosen) {
    if (!objects) problem = 'the object store is not configured for this service';
    else {
      const got = await readSignedPack(objects, chosen);
      if (!got.ok) problem = `the signed pack could not be read: ${got.error}`.slice(0, 200);
      else {
        const p = got.value.signed.pack;
        contents = {
          format: p.format,
          lane: p.lane,
          tier: p.tier,
          profile_sha256: p.profile_sha256,
          catalogue_ref: p.catalogue_ref,
          units: p.units.map((u) => u.unit_key),
          steps: p.steps,
          gates: p.gates,
          push_receipt: p.push_receipt,
          oracle_locks: Object.keys(p.oracle_locks).length,
          signature: {
            alg: got.value.signed.signature.alg,
            key_id: got.value.signed.signature.key_id,
          },
          verified: true,
        };
      }
    }
  }
  const s = item.state;
  const summary = chosen ? summaryOf(chosen) : null;
  return ok({
    item_id: s.item_id as never,
    project_id: s.project_id as never,
    packs: recorded.map(summaryOf).reverse(),
    pack: summary,
    contents,
    contents_problem: problem,
    verify_command: summary ? verifyCommand(summary, s.item_id) : null,
  });
}

/** The signed bytes of one pack of the item, read back and checked (the object key, then the pack id). */
export async function signedPackBytes(
  pool: pg.Pool,
  objects: ObjectStorePort | undefined,
  itemId: string,
  pack: string,
): Promise<Result<{ bytes: Uint8Array; project_id: string; object_key: string }, CoreError>> {
  const item = await readItem(pool, itemId);
  if (!item) return err(coreError('not_found', 'no such item'));
  const p = (await listEvidencePacks(pool, itemId)).find((x) => x.pack_sha256 === pack);
  if (!p) return err(coreError('not_found', 'no such pack'));
  if (!objects) return err(coreError('unavailable', 'the object store is not configured'));
  const got = await readSignedPack(objects, p);
  if (!got.ok) return err(coreError('unavailable', 'the signed pack could not be read'));
  return ok({
    bytes: got.value.bytes,
    project_id: item.state.project_id,
    object_key: p.object_key,
  });
}

// ---------------------------------------------------------------- gate context

const Artefacts = z.array(
  z.looseObject({ step: z.string(), type: z.string(), sha256: z.string() }),
);
const Facts = z.looseObject({
  station: z.string().optional(),
  lane_profile_sha256: z.string().optional(),
  request_text_sha256: z.string().optional(),
  base_sha: z.string().optional(),
  artefacts: Artefacts.optional(),
  quarantine: z
    .looseObject({
      n: z.number(),
      cause: z.string(),
      origin_phase: z.string(),
      origin_step: z.string(),
      pack_sha256: z.string().nullable(),
    })
    .optional(),
});

const VERIFY_STEP_SET = new Set<string>(VERIFY_STEPS);

/** `GET /v1/cards/:id/gate/context`: the gate-specific facts of one work-item card, uncut (data class D2). */
export async function gateCardContext(
  pool: pg.Pool,
  cardId: string,
): Promise<Result<GateCardContext, CoreError>> {
  const opened = await readCardOpened(pool, cardId);
  if (opened?.open.subject_kind === 's0_record') return s0GateContext(pool, cardId);
  if (!opened || opened.open.subject_kind !== 'item') {
    return err(coreError('not_found', `${cardId} is not a work item card`));
  }
  const state = await readCardState(pool, cardId);
  const g = state?.gates[0];
  if (!state || !g) return err(coreError('not_found', 'the card has no gate'));
  const p: GateOpenedPayload = g.state.open.payload;
  const facts = Facts.safeParse(p.facts);
  const f = facts.success ? facts.data : {};
  const station = f.station ?? '';
  const conditional = /^(\d+\.\d+[a-z]?)!/.exec(station);
  const step = (conditional?.[1] ?? null) as StepId | null;
  const itemId = opened.open.subject_id;
  const item = await readItem(pool, itemId);
  if (!item) return err(coreError('not_found', 'the item of the card is gone'));

  // what the subject hash binds, as the gate opened with it (interpret.ts `openGates`)
  const binds: Array<{ label: string; value: string }> = [{ label: 'item', value: itemId }];
  if (station) binds.push({ label: 'station', value: station });
  if (f.lane_profile_sha256) binds.push({ label: 'lane profile', value: f.lane_profile_sha256 });
  if (f.request_text_sha256) binds.push({ label: 'request text', value: f.request_text_sha256 });
  for (const a of f.artefacts ?? []) binds.push({ label: `${a.step} ${a.type}`, value: a.sha256 });
  if (f.base_sha) binds.push({ label: 'base commit', value: f.base_sha });
  if (f.quarantine?.pack_sha256) {
    binds.push({ label: 'quarantine evidence', value: f.quarantine.pack_sha256 });
  }
  if (step !== null) {
    const approved = item.state.approved[step] ?? [];
    binds.push({
      label: `gates approved at ${step}`,
      value: approved.length > 0 ? approved.join(', ') : 'none',
    });
  }

  // the S7 check of the raising step, for the current head (a SECT triage: the 7.x step that raised ET10)
  const all = await recordedResults(pool, itemId);
  const head = await currentHead(pool, itemId, all);
  const checkStep =
    step !== null && VERIFY_STEP_SET.has(step)
      ? (step as VerifyStep)
      : f.quarantine && VERIFY_STEP_SET.has(f.quarantine.origin_step)
        ? (f.quarantine.origin_step as VerifyStep)
        : null;
  const cards = await cardsOfGates(pool, itemId);
  const check =
    checkStep === null || head === null
      ? null
      : stepView(
          item.state,
          checkStep,
          all.filter((x) => x.result.head_sha === head && x.result.step === checkStep),
          cards,
        );

  // X2: the patch the decision binds (6.6's artefact), else the Push Broker's receipt for the head
  let patch: GateCardContext['patch'] = null;
  if (p.gate_id === 'X2') {
    const bound = (f.artefacts ?? []).find((a) => a.type === 'patch');
    if (bound) patch = { patch_hash: bound.sha256, source: 'bound_artefact', bound: true };
    else if (head !== null) {
      const r = (await listPushReceipts(pool, itemId)).filter((x) => x.head_sha === head).at(-1);
      if (r) patch = { patch_hash: r.patch_hash, source: 'push_receipt', bound: false };
    }
  }

  // X3 and 7.4: the packages the check found new (licence and advisories: not known to the factory yet)
  const dependencies: GateCardContext['dependencies'] = [];
  if (p.gate_id === 'X3' || checkStep === '7.4') {
    const r74 = all.filter((x) => x.result.head_sha === head && x.result.step === '7.4').at(-1);
    for (const x of r74?.result.findings ?? []) {
      if (x.kind !== 'dependency_new' && x.kind !== 'dependency_unapproved') continue;
      dependencies.push({
        name: (x.rule_id ?? 'unknown').slice(0, 214),
        manifest: x.path,
        licence: null,
        advisories: null,
      });
    }
  }

  // E2 at 4.5: the constitution report the gate binds
  let constitution: GateCardContext['constitution'] = null;
  const report = (f.artefacts ?? []).find((a) => a.type === 'constitution_report');
  if (p.gate_id === 'E2' && report) {
    const a = await artefactByHash(pool, itemId, report.sha256);
    constitution = { sha256: report.sha256, intact: a !== null, markdown: a?.markdown ?? null };
  }

  return ok({
    card_id: cardId,
    project_id: opened.open.project_id as never,
    subject_kind: 'item',
    item_id: itemId as never,
    s0_id: null,
    gate: p.gate_id,
    gate_instance_id: g.gate_instance_id,
    station: station || p.gate_id,
    step,
    requester: p.requester,
    quorum_required: p.quorum.required,
    decisions: g.state.decisions.map((d) => ({
      ledger_seq: d.ledger_seq,
      actor: d.actor,
      decision: d.decision,
      at: d.created_at,
      sod_waiver: d.sod_waiver,
    })),
    subject_hash: p.subject_hash,
    binds,
    step_up: p.step_up,
    check,
    head_sha: head,
    quarantine: f.quarantine
      ? {
          n: f.quarantine.n,
          cause: f.quarantine.cause,
          origin_phase: f.quarantine.origin_phase,
          origin_step: f.quarantine.origin_step,
          pack_sha256: f.quarantine.pack_sha256,
        }
      : null,
    patch,
    dependencies,
    constitution,
    onboarding_pack: null,
    data_class: 'D2',
  });
}

/**
 * The X2 of an S0 record's onboarding pack (M16): what its subject hash binds is the pack's patch hash, and the pack
 * itself is read from the record (`packGateContext`). Any other S0 card is not a gate card here (404).
 */
async function s0GateContext(
  pool: pg.Pool,
  cardId: string,
): Promise<Result<GateCardContext, CoreError>> {
  const state = await readCardState(pool, cardId);
  const g = state?.gates[0];
  if (!state || !g || g.state.open.payload.gate_id !== 'X2') {
    return err(coreError('not_found', `${cardId} is not an onboarding pack's X2 card`));
  }
  const pack = await packGateContext(pool, cardId);
  if (!pack.ok) return pack;
  if (pack.value === null) {
    return err(coreError('not_found', `${cardId} is not an onboarding pack's X2 card`));
  }
  const k = pack.value;
  const p: GateOpenedPayload = g.state.open.payload;
  const step = k.kind === 'light' ? '0.2' : '0.3';
  const binds: Array<{ label: string; value: string }> = [
    { label: 'S0 record', value: k.s0_id },
    { label: 'station', value: 'X2' },
    { label: `${step} onboarding pack (patch)`, value: k.patch_hash },
    {
      label: `card ${k.deciding_card.card === 'C2' ? 2 : 3} payload`,
      value: k.deciding_card.payload_hash,
    },
    { label: 'base commit', value: k.base_sha },
    { label: 'branch', value: k.branch },
  ];
  return ok({
    card_id: cardId,
    project_id: state.open.project_id as never,
    subject_kind: 's0_record',
    item_id: null,
    s0_id: k.s0_id,
    gate: p.gate_id,
    gate_instance_id: g.gate_instance_id,
    station: 'X2',
    step: step as StepId,
    requester: p.requester,
    quorum_required: p.quorum.required,
    decisions: g.state.decisions.map((d) => ({
      ledger_seq: d.ledger_seq,
      actor: d.actor,
      decision: d.decision,
      at: d.created_at,
      sod_waiver: d.sod_waiver,
    })),
    subject_hash: p.subject_hash,
    binds,
    step_up: p.step_up,
    check: null,
    head_sha: null,
    quarantine: null,
    patch: { patch_hash: k.patch_hash, source: 'bound_artefact', bound: k.bound },
    dependencies: [],
    constitution: null,
    onboarding_pack: k,
    data_class: 'D2',
  });
}
