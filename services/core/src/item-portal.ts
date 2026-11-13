import {
  ARTEFACT_DOCUMENT_GROUP,
  GateArtefactRef,
  GateId,
  ITEM_EVENT,
  ItemDocumentsView,
  ItemRequestView,
  ItemTimelineKind,
  ItemTimelineView,
  PLANNING_EVENT,
  PrincipalId,
  StepId,
  TimelineCode,
  planningStream,
  type DocumentAuthor,
  type DocumentGateBinding,
  type ItemDocument,
  type ItemTimelineEntry,
  type RecordEvent,
} from '@aisdlc/contracts';
import { readGateState } from '@aisdlc/decisions';
import { EVENT_COLUMNS, toRecordEvent, type EventRow } from '@aisdlc/record';
import type { ItemState } from '@aisdlc/work';
import type pg from 'pg';
import { z } from 'zod';
import { catchUpAgentRuns } from './agent-runs.js';
import { itemGateLinks } from './item-gates.js';
import { loadItemArtefacts } from './planning/store.js';
import { laneOpensAt } from './requests.js';
import { readWork } from './work.js';
import { readItemEvents } from './work-items.js';

// The item page's tabs (P2-1): the request as kept, every document with its versions and the gates that bound each,
// and the timeline. Each is built from the record alone (the request's `work:` stream, the item's stream, the planning
// stream with the `core.artefact` bodies it names, the gates' streams and the ledger through `readGateState`); a gate's
// status is the ledger's fold, never a projection. The routes ask the PDP (`project.view`); the bff asks for the view
// level and cuts the text to the person's data class. Core answers uncut (`data_class: 'D2'`, what core itself reads).

const UNCUT = 'D2' as const;

// ---------------------------------------------------------------- Request

export async function itemRequestView(pool: pg.Pool, s: ItemState): Promise<ItemRequestView> {
  const w = await readWork(pool, s.request_id);
  const text = w?.request.request_text ?? null;
  const asked = w?.request.lane ?? null;
  return ItemRequestView.parse({
    item_id: s.item_id,
    project_id: s.project_id,
    repo: s.repo,
    request_id: s.request_id,
    requester: w?.request.requester ?? s.requester,
    channel: w?.request.channel ?? s.channel,
    request_text: text,
    text_withheld: false,
    text_sha256: s.intake.text_sha256,
    injection: s.intake.injection,
    dedupe_links: s.intake.dedupe_links,
    conflict_candidates: s.intake.conflict_candidates,
    asked_lane: asked,
    proposed_lane: s.proposed_lane,
    lane: s.lane,
    lane_bound_by: s.lane_bound_by,
    intake_route: s.intake.route,
    eligibility_reason: s.intake.eligibility_reason,
    lane_opens_at: asked === null ? null : laneOpensAt(asked),
    data_class: UNCUT,
  });
}

// ---------------------------------------------------------------- Documents

const Facts = z.looseObject({ artefacts: z.array(GateArtefactRef).optional() });

/** The gates of the item that bound artefacts, by artefact hash, as the ledger decides them. */
async function bindingsByHash(
  pool: pg.Pool,
  s: ItemState,
): Promise<Map<string, DocumentGateBinding[]>> {
  const ids = [...new Set(s.gates.map((g) => g.gate_instance_id))];
  const links = await itemGateLinks(pool, s.item_id, ids);
  const out = new Map<string, DocumentGateBinding[]>();
  const states = [];
  for (const id of ids) {
    const g = await readGateState(pool, id);
    if (g) states.push(g);
  }
  states.sort((a, b) => a.open.opened_at.localeCompare(b.open.opened_at));
  for (const g of states) {
    const facts = Facts.safeParse(g.open.payload.facts);
    const refs = facts.success ? (facts.data.artefacts ?? []) : [];
    const gate = GateId.safeParse(g.open.payload.gate_id);
    if (!gate.success) continue;
    const link = links.get(g.open.gate_instance_id);
    const binding: DocumentGateBinding = {
      gate: gate.data,
      gate_instance_id: g.open.gate_instance_id,
      subject_hash: g.open.payload.subject_hash as DocumentGateBinding['subject_hash'],
      status: g.status,
      outcome: g.outcome,
      approvers: g.approvers.filter((a) => PrincipalId.safeParse(a).success) as never,
      ended_at: g.ended_at,
      card_id: link?.card_id ?? null,
      ledger_entry_id: link?.ledger_entry_id ?? null,
    };
    for (const sha of new Set(refs.map((r) => r.sha256))) {
      out.set(sha, [...(out.get(sha) ?? []), binding]);
    }
  }
  return out;
}

/** The agent of each run named, from the agent-run read model (an unreadable model names none). */
async function agentsOfRuns(pool: pg.Pool, runs: readonly string[]): Promise<Map<string, string>> {
  if (runs.length === 0) return new Map();
  try {
    await catchUpAgentRuns(pool);
    const q = await pool.query<{ run_id: string; agent_id: string }>(
      'SELECT run_id::text AS run_id, agent_id FROM core.agent_run WHERE run_id = ANY($1::uuid[])',
      [[...runs]],
    );
    return new Map(q.rows.map((r) => [r.run_id, r.agent_id]));
  } catch {
    return new Map();
  }
}

const authorOf = (
  a: { run_id: string | null; command_key: string },
  agents: ReadonlyMap<string, string>,
): DocumentAuthor =>
  a.run_id !== null
    ? {
        kind: 'agent',
        agent_id: (agents.get(a.run_id) ?? null) as never,
        run_id: a.run_id,
      }
    : a.command_key.startsWith('human-plan:')
      ? { kind: 'person' }
      : { kind: 'factory' };

export async function itemDocumentsView(pool: pg.Pool, s: ItemState): Promise<ItemDocumentsView> {
  const { artefacts, not_intact } = await loadItemArtefacts(pool, s.item_id);
  const bindings = await bindingsByHash(pool, s);
  const agents = await agentsOfRuns(pool, [
    ...new Set(artefacts.flatMap((a) => (a.row.run_id === null ? [] : [a.row.run_id]))),
  ]);
  const byType = new Map<string, ItemDocument>();
  for (const a of artefacts) {
    const r = a.row;
    const doc = byType.get(r.type) ?? {
      type: r.type,
      group: ARTEFACT_DOCUMENT_GROUP[r.type],
      versions: [],
    };
    doc.versions.push({
      version: r.version,
      sha256: r.sha256 as never,
      step: r.step,
      stored_at: r.stored_at,
      bytes: r.bytes,
      author: authorOf(r, agents),
      markdown: a.markdown,
      withheld: false,
      gates: bindings.get(r.sha256) ?? [],
    });
    byType.set(r.type, doc);
  }
  for (const d of byType.values()) d.versions.sort((x, y) => x.version - y.version);
  return ItemDocumentsView.parse({
    item_id: s.item_id,
    project_id: s.project_id,
    documents: [...byType.values()],
    not_intact,
    data_class: UNCUT,
  });
}

// ---------------------------------------------------------------- Timeline

const Codes = z.looseObject({});

/** The short codes an event carries (an outcome, an edge, a reason code...): never text, never a hash. */
function codesOf(e: RecordEvent): string[] {
  const p = Codes.parse(e.payload) as Record<string, unknown>;
  const out: string[] = [];
  for (const k of [
    'outcome',
    'edge',
    'trigger',
    'reason_code',
    'reason',
    'cause',
    'to_lane',
    'lane',
    'proposed_lane',
    'route',
    'timer',
    'choice',
    'state',
    'code',
    'type',
    'kind',
  ]) {
    const v = p[k];
    if (typeof v === 'string' && TimelineCode.safeParse(v).success) out.push(`${k}:${v}`);
  }
  const version = p['version'];
  if (typeof version === 'number' && Number.isInteger(version)) out.push(`version:${version}`);
  const round = p['round'];
  if (typeof round === 'number' && Number.isInteger(round)) out.push(`round:${round}`);
  return out;
}

function gatesOf(p: Record<string, unknown>): GateId[] {
  const out: GateId[] = [];
  const one = GateId.safeParse(p['gate']);
  if (one.success) out.push(one.data);
  if (Array.isArray(p['gates'])) {
    for (const g of p['gates']) {
      const x = GateId.safeParse((g as { gate?: unknown } | null)?.gate ?? g);
      if (x.success && !out.includes(x.data)) out.push(x.data);
    }
  }
  return out;
}

function entryOf(e: RecordEvent): ItemTimelineEntry | null {
  const kind = ItemTimelineKind.safeParse(e.type);
  if (!kind.success) return null;
  const p = e.payload as Record<string, unknown>;
  const by = PrincipalId.safeParse(p['by']);
  const step = StepId.safeParse(p['step']);
  return {
    global_seq: e.global_seq,
    at: e.occurred_at as ItemTimelineEntry['at'],
    kind: kind.data,
    actor: e.actor,
    by: by.success && by.data !== e.actor ? by.data : null,
    step: step.success ? step.data : null,
    gates: gatesOf(p),
    codes: codesOf(e),
  };
}

/** The item's stream and its stored documents, in record order. The bookkeeping `item.command_done` is left out. */
export async function itemTimelineView(pool: pg.Pool, s: ItemState): Promise<ItemTimelineView> {
  const item = await readItemEvents(pool, s.item_id);
  const q = await pool.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event WHERE stream = $1 AND type = $2 ORDER BY record_event.seq`,
    [planningStream(s.item_id), PLANNING_EVENT.artefact_stored],
  );
  const events = [...item, ...q.rows.map(toRecordEvent)]
    .filter((e) => e.type !== ITEM_EVENT.command_done)
    .sort((a, b) => a.global_seq - b.global_seq);
  return ItemTimelineView.parse({
    item_id: s.item_id,
    project_id: s.project_id,
    entries: events.flatMap((e) => {
      const x = entryOf(e);
      return x === null ? [] : [x];
    }),
  });
}
