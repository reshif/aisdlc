import { foldAgentRuns, agentStats, type CallFact, type RunWithOutcome } from '@aisdlc/agents';
import {
  AGENT_STREAM_PREFIX,
  AgentRunView,
  GATEWAY_EVENT,
  ITEM_STREAM_PREFIX,
  ModelCallPayload,
  agentStream,
  itemStream,
  type AgentId,
  type AgentStats,
  type ProjectId,
  type RecordEvent,
} from '@aisdlc/contracts';
import {
  EVENT_COLUMNS,
  runProjection,
  toRecordEvent,
  type EventRow,
  type Executor,
  type Projection,
  type Tx,
} from '@aisdlc/record';
import type pg from 'pg';

// The `agent_run` read model (PLAN M11.2): an AgentRun and its AgentRunOutcome per command core handed
// to an agent. A function of the record alone: for an item, whenever its `item:` stream, its `agent:`
// stream or one of its gateway calls grows, the item's runs are folded again from the streams (up to
// the event being applied) by the pure `foldAgentRuns`, so dropping the tables and refolding gives the
// same rows. Never read on a write path.

interface CallRow {
  call_id: string;
  vkey_id: string;
  global_seq: string;
  tokens_in: string;
  tokens_out: string;
  cost_micro_usd: string;
  provider_id: string | null;
  model_id: string | null;
  outcome: string;
}

const toCall = (r: CallRow): CallFact => ({
  call_id: r.call_id,
  vkey_id: r.vkey_id,
  global_seq: Number(r.global_seq),
  tokens_in: Number(r.tokens_in),
  tokens_out: Number(r.tokens_out),
  cost_micro_usd: Number(r.cost_micro_usd),
  provider_id: r.provider_id,
  model_id: r.model_id,
  outcome: r.outcome,
});

async function refoldItem(tx: Tx, itemId: string, upTo: number): Promise<void> {
  const ev = await tx.query<EventRow>(
    `SELECT ${EVENT_COLUMNS} FROM record.record_event
      WHERE stream = ANY($1::text[]) AND global_seq <= $2::bigint
      ORDER BY record_event.global_seq`,
    [[itemStream(itemId), agentStream(itemId)], String(upTo)],
  );
  const calls = await tx.query<CallRow>(
    `SELECT call_id, vkey_id, global_seq::text, tokens_in::text, tokens_out::text,
            cost_micro_usd::text, provider_id, model_id, outcome
       FROM core.agent_call WHERE item_id = $1`,
    [itemId],
  );
  const runs = foldAgentRuns(ev.rows.map(toRecordEvent), calls.rows.map(toCall));
  await tx.query('DELETE FROM core.agent_run WHERE item_id = $1', [itemId]);
  let ord = 0;
  for (const r of runs) {
    await tx.query(
      `INSERT INTO core.agent_run
         (run_id, item_id, project_id, ord, unit_id, step, attempt, lane, agent_id, contract_version,
          prompt_ref, prompt_sha256, provider, model, vkey_id, calls, tokens_in, tokens_out,
          cost_micro_usd, state, result, failure_code, started_at, ended_at, verdict, back_edges,
          triggers, judgements)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,
               $24,$25,$26,$27,$28)`,
      [
        r.run_id,
        r.item_id,
        r.project_id,
        ord,
        r.unit_id,
        r.step,
        r.attempt,
        r.lane,
        r.agent_id,
        r.contract_version,
        r.prompt_ref,
        r.prompt_sha256,
        r.provider,
        r.model,
        r.vkey_id,
        r.calls,
        r.tokens_in,
        r.tokens_out,
        r.cost_micro_usd,
        r.state,
        r.result,
        r.failure_code,
        r.started_at,
        r.ended_at,
        r.outcome.verdict,
        r.outcome.back_edges,
        r.outcome.triggers,
        JSON.stringify(r.outcome.judgements),
      ],
    );
    ord += 1;
  }
}

export interface AgentRunSnapshot {
  runs: unknown[];
  calls: unknown[];
}

export const agentRunProjection: Projection<AgentRunSnapshot> = {
  name: 'agent_run',
  version: 1,
  tables: ['core.agent_run', 'core.agent_call'],

  async apply(tx: Tx, e: RecordEvent) {
    if (e.type === GATEWAY_EVENT.model_call) {
      const p = ModelCallPayload.parse(e.payload);
      // only calls of a key minted for an item can belong to a run
      if (p.item_id === null) return;
      await tx.query(
        `INSERT INTO core.agent_call
           (call_id, vkey_id, item_id, global_seq, tokens_in, tokens_out, cost_micro_usd,
            provider_id, model_id, outcome)
         VALUES ($1,$2,$3,$4::bigint,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (call_id) DO NOTHING`,
        [
          p.call_id,
          p.vkey_id,
          p.item_id,
          String(e.global_seq),
          p.tokens_in,
          p.tokens_out,
          p.cost_micro_usd,
          p.provider_id,
          p.model_id,
          p.outcome,
        ],
      );
      const owner = await tx.query<{ item_id: string }>(
        'SELECT item_id FROM core.agent_run WHERE vkey_id = $1 LIMIT 1',
        [p.vkey_id],
      );
      const item = owner.rows[0]?.item_id;
      if (item) await refoldItem(tx, item, e.global_seq);
      return;
    }
    const isAgent = e.stream_id.startsWith(AGENT_STREAM_PREFIX);
    if (!isAgent && !e.stream_id.startsWith(ITEM_STREAM_PREFIX)) return;
    const itemId = e.stream_id.slice(
      isAgent ? AGENT_STREAM_PREFIX.length : ITEM_STREAM_PREFIX.length,
    );
    // an item with no agent facts has no runs: the common case costs one indexed lookup
    const has = await tx.query(
      'SELECT 1 FROM record.record_event WHERE stream = $1 AND global_seq <= $2::bigint LIMIT 1',
      [agentStream(itemId), String(e.global_seq)],
    );
    if (has.rows.length === 0) return;
    await refoldItem(tx, itemId, e.global_seq);
  },

  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.agent_run');
    await tx.query('DELETE FROM core.agent_call');
  },

  async snapshot(db: Executor) {
    const runs = await db.query('SELECT * FROM core.agent_run ORDER BY run_id');
    const calls = await db.query('SELECT * FROM core.agent_call ORDER BY call_id');
    return { runs: runs.rows, calls: calls.rows };
  },
};

/** Catches the agent_run read model up with the record. */
export async function catchUpAgentRuns(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, agentRunProjection);
  if (!r.ok) throw new Error('the agent_run read model needs a rebuild');
}

// ---------------------------------------------------------------- Reads

const toView = (r: Record<string, unknown>): AgentRunView =>
  AgentRunView.parse({
    run_id: r['run_id'],
    item_id: r['item_id'],
    project_id: r['project_id'],
    unit_id: r['unit_id'],
    step: r['step'],
    attempt: r['attempt'],
    lane: r['lane'],
    agent_id: r['agent_id'],
    contract_version: r['contract_version'],
    prompt_ref: r['prompt_ref'],
    prompt_sha256: r['prompt_sha256'],
    provider: r['provider'],
    model: r['model'],
    vkey_id: r['vkey_id'],
    calls: Number(r['calls']),
    tokens_in: Number(r['tokens_in']),
    tokens_out: Number(r['tokens_out']),
    cost_micro_usd: Number(r['cost_micro_usd']),
    state: r['state'],
    result: r['result'],
    failure_code: r['failure_code'],
    started_at: (r['started_at'] as Date).toISOString(),
    ended_at: r['ended_at'] === null ? null : (r['ended_at'] as Date).toISOString(),
    outcome: {
      run_id: r['run_id'],
      verdict: r['verdict'],
      judgements: r['judgements'],
      back_edges: r['back_edges'],
      triggers: r['triggers'],
    },
  });

/** The runs of an item, in the order they were dispatched, each with its outcome. */
export async function listAgentRuns(pool: pg.Pool, itemId: string): Promise<AgentRunView[]> {
  await catchUpAgentRuns(pool);
  const q = await pool.query('SELECT * FROM core.agent_run WHERE item_id = $1 ORDER BY ord', [
    itemId,
  ]);
  return q.rows.map(toView);
}

/** Acceptance rate, back-edge rate and cost per run of one agent, over the fleet or one project. */
export async function agentStatsOf(
  pool: pg.Pool,
  agent: AgentId,
  project: ProjectId | null,
): Promise<AgentStats> {
  await catchUpAgentRuns(pool);
  const q = await pool.query(
    `SELECT * FROM core.agent_run WHERE agent_id = $1 AND ($2::text IS NULL OR project_id = $2)`,
    [agent, project],
  );
  return agentStats(agent, q.rows.map(toView) as RunWithOutcome[], project);
}
