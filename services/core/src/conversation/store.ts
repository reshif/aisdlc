import type { Draft } from '@aisdlc/contracts';
import {
  AskSession,
  CONVERSATION_EVENT,
  Thread,
  ThreadOpenedPayload,
  Turn,
  TurnRecordedPayload,
  threadStream,
  type PayloadRedaction,
  type RecordEvent,
  type ThreadSubject,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, uuidv7, type Result } from '@aisdlc/kernel';
import { rebuild, runProjection, type Executor, type Projection, type Tx } from '@aisdlc/record';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';

// The Conversation context's record side (PLAN M18). Threads and turns are record events on `thread:<id>`; the TEXT
// of a turn is a RedactablePayload in `core.conversation_payload` (off the hash chain, erasable), named in the event by
// id and sha256. The read models (`conversation_thread`, `conversation_turn`, `ask_session`) are a fold of the events
// and are rebuilt by `rebuildConversations`; the text is joined from the payload table when a thread is read.

export const CONVERSATION_ACTOR = 'system.assistant';
const TITLE_MAX = 120;

/** A turn as the writer hands it over: its text (already masked) and its structure. */
export interface NewTurn {
  readonly role: Turn['role'];
  readonly kind: Turn['kind'];
  readonly text: string;
  readonly redactions: readonly PayloadRedaction[];
  readonly citations?: Turn['citations'];
  readonly proposals?: Turn['proposals'];
  /** Drafts: their text goes into the turn's payload, the event carries ids and hashes. */
  readonly drafts?: ReadonlyArray<Omit<Draft, 'draft_id'>>;
  readonly flags?: Turn['flags'];
  readonly refusal?: Turn['refusal'];
  readonly grounding_sha?: string | null;
  readonly ask_id?: string | null;
}

/** What a payload holds: the turn's words and, for an answer, the drafts' text (so one erasure removes both). */
interface PayloadBody {
  readonly text: string;
  readonly drafts: ReadonlyArray<{ title: string; text: string; lint: readonly string[] }>;
}
const payloadText = (b: PayloadBody): string => JSON.stringify(b);

async function insertPayload(
  tx: Tx,
  owner: string,
  body: PayloadBody,
  redactions: readonly PayloadRedaction[],
  at: Date,
): Promise<{ payload_id: string; sha256: string; redactions: PayloadRedaction[] }> {
  const text = payloadText(body);
  const payload_id = uuidv7(at.getTime());
  const sha256 = sha256Hex(text);
  await tx.query(
    `INSERT INTO core.conversation_payload (payload_id, owner, sha256, text, redactions, created_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
    [payload_id, owner, sha256, text, JSON.stringify(redactions), at.toISOString()],
  );
  return { payload_id, sha256, redactions: [...redactions] };
}

/** Opens a thread with its first turn (the person's question), in one transaction. */
export async function openThread(
  d: CoreDeps,
  o: { owner: string; subject: ThreadSubject; first: NewTurn },
): Promise<Result<{ thread_id: string }, CoreError>> {
  const at = clockOf(d).now();
  const thread_id = uuidv7(at.getTime());
  return inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [threadStream(thread_id)]);
    const turn = await turnEvent(tx, o.owner, thread_id, 1, o.first, at);
    const opened = ThreadOpenedPayload.parse({
      thread_id,
      owner: o.owner,
      subject: o.subject,
      title_payload: turn.payload,
    });
    const w = await j.emitAll(threadStream(thread_id), [
      { type: CONVERSATION_EVENT.thread_opened, body: opened, actor: CONVERSATION_ACTOR },
      { type: CONVERSATION_EVENT.turn_recorded, body: turn, actor: CONVERSATION_ACTOR },
    ]);
    return w.ok ? ok({ thread_id }) : w;
  });
}

async function turnEvent(
  tx: Tx,
  owner: string,
  thread_id: string,
  seq: number,
  t: NewTurn,
  at: Date,
): Promise<TurnRecordedPayload> {
  const drafts = (t.drafts ?? []).map((x) => ({ title: x.title, text: x.text, lint: [...x.lint] }));
  const payload = await insertPayload(tx, owner, { text: t.text, drafts }, t.redactions, at);
  return TurnRecordedPayload.parse({
    thread_id,
    seq,
    role: t.role,
    kind: t.kind,
    payload,
    citations: t.citations ?? [],
    proposals: t.proposals ?? [],
    drafts: (t.drafts ?? []).map((x, i) => ({
      draft_id: `d${i + 1}`,
      card: x.card,
      sha256: sha256Hex(x.text),
    })),
    flags: t.flags ?? [],
    refusal: t.refusal ?? null,
    grounding_sha: t.grounding_sha ?? null,
    ask_id: t.ask_id ?? null,
  });
}

/**
 * Appends turns (and, for an answer, its AskSession) to a thread. The thread's head is read under its lock, so two
 * asks on one thread are serialised and their turns numbered in order.
 */
export async function appendTurns(
  d: CoreDeps,
  o: { owner: string; thread_id: string; turns: readonly NewTurn[]; ask?: AskSession },
): Promise<Result<{ seqs: number[] }, CoreError>> {
  const at = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    const stream = threadStream(o.thread_id);
    await lockKeys(tx, [stream]);
    const events = await j.events(stream);
    if (events.length === 0) return err(coreError('not_found', 'no such thread'));
    let seq = events.filter((e) => e.type === CONVERSATION_EVENT.turn_recorded).length;
    const drafts = [];
    const seqs: number[] = [];
    for (const t of o.turns) {
      seq += 1;
      seqs.push(seq);
      drafts.push({
        type: CONVERSATION_EVENT.turn_recorded,
        body: await turnEvent(tx, o.owner, o.thread_id, seq, t, at),
        actor: CONVERSATION_ACTOR,
      });
    }
    if (o.ask) {
      drafts.push({
        type: CONVERSATION_EVENT.ask_recorded,
        body: AskSession.parse(o.ask) as unknown as Record<string, unknown>,
        actor: CONVERSATION_ACTOR,
        idempotency_key: `conversation.ask:${o.ask.ask_id}`,
      });
    }
    const w = await j.emitAll(stream, drafts as never);
    return w.ok ? ok({ seqs }) : w;
  });
}

/**
 * Erases a payload the person owns: its text is gone, its hash stays (`conversation.payload_erased` on the thread).
 * Not offered in the portal yet; the retention service (M19 audit-backend) is its caller.
 */
export async function erasePayload(
  d: CoreDeps,
  o: { owner: string; thread_id: string; payload_id: string },
): Promise<Result<void, CoreError>> {
  const at = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    const stream = threadStream(o.thread_id);
    await lockKeys(tx, [stream]);
    const q = await tx.query<{ sha256: string }>(
      `UPDATE core.conversation_payload SET text = NULL, erased_at = $3
        WHERE payload_id = $1 AND owner = $2 AND erased_at IS NULL RETURNING sha256`,
      [o.payload_id, o.owner, at.toISOString()],
    );
    const row = q.rows[0];
    if (!row) return err(coreError('not_found', 'no such payload'));
    const w = await j.emitAll(stream, [
      {
        type: CONVERSATION_EVENT.payload_erased,
        body: { thread_id: o.thread_id, payload_id: o.payload_id, sha256: row.sha256 },
        actor: CONVERSATION_ACTOR,
      },
    ]);
    return w.ok ? ok(undefined) : w;
  });
}

// ---------------------------------------------------------------- the read models

export const conversationProjection: Projection<{ threads: unknown[]; turns: unknown[] }> = {
  name: 'conversation',
  version: 1,
  tables: ['core.conversation_thread', 'core.conversation_turn', 'core.ask_session'],

  async apply(tx: Tx, e: RecordEvent) {
    if (e.type === CONVERSATION_EVENT.thread_opened) {
      const p = ThreadOpenedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO core.conversation_thread
           (thread_id, owner, subject_kind, s0_id, project_id, title_payload, turns, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, 0, $7, $7) ON CONFLICT (thread_id) DO NOTHING`,
        [
          p.thread_id,
          p.owner,
          p.subject.kind,
          p.subject.kind === 's0' ? p.subject.s0_id : null,
          p.subject.project_id,
          p.title_payload.payload_id,
          e.occurred_at,
        ],
      );
    } else if (e.type === CONVERSATION_EVENT.turn_recorded) {
      const p = TurnRecordedPayload.parse(e.payload);
      await tx.query(
        `INSERT INTO core.conversation_turn
           (thread_id, seq, role, kind, at, payload_id, payload_sha, redactions, body, ask_id, global_seq)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb, $10, $11::bigint)
         ON CONFLICT (thread_id, seq) DO NOTHING`,
        [
          p.thread_id,
          p.seq,
          p.role,
          p.kind,
          e.occurred_at,
          p.payload.payload_id,
          p.payload.sha256,
          JSON.stringify(p.payload.redactions),
          JSON.stringify({
            citations: p.citations,
            proposals: p.proposals,
            drafts: p.drafts,
            flags: p.flags,
            refusal: p.refusal,
            grounding_sha: p.grounding_sha,
          }),
          p.ask_id,
          String(e.global_seq),
        ],
      );
      await tx.query(
        `UPDATE core.conversation_thread SET turns = GREATEST(turns, $2), updated_at = $3 WHERE thread_id = $1`,
        [p.thread_id, p.seq, e.occurred_at],
      );
    } else if (e.type === CONVERSATION_EVENT.ask_recorded) {
      const p = AskSession.parse(e.payload);
      await tx.query(
        `INSERT INTO core.ask_session (ask_id, thread_id, principal, budget_group, body, finished_at, global_seq)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::bigint) ON CONFLICT (ask_id) DO NOTHING`,
        [
          p.ask_id,
          p.thread_id,
          p.principal,
          p.budget_group,
          JSON.stringify(p),
          p.finished_at,
          String(e.global_seq),
        ],
      );
    }
  },

  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.conversation_turn');
    await tx.query('DELETE FROM core.ask_session');
    await tx.query('DELETE FROM core.conversation_thread');
  },

  async snapshot(db: Executor) {
    const t = await db.query(
      `SELECT thread_id, owner, subject_kind, s0_id, project_id, title_payload, turns, created_at, updated_at
         FROM core.conversation_thread ORDER BY thread_id`,
    );
    const u = await db.query(
      `SELECT thread_id, seq, role, kind, at, payload_id, payload_sha, redactions, body, ask_id
         FROM core.conversation_turn ORDER BY thread_id, seq`,
    );
    return { threads: t.rows, turns: u.rows };
  },
};

export async function catchUpConversations(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, conversationProjection);
  if (!r.ok) throw new Error('the conversation read model needs a rebuild');
}

/** Drops the read models and refolds them from the record (the payload table is not touched: it is not derived). */
export async function rebuildConversations(pool: pg.Pool): Promise<void> {
  await rebuild(pool, conversationProjection);
}

const iso = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

interface ThreadRow {
  thread_id: string;
  owner: string;
  subject_kind: 's0' | 'project';
  s0_id: string | null;
  project_id: string;
  title_payload: string;
  turns: number;
  created_at: Date;
  updated_at: Date;
  title_text: string | null;
}

const THREAD_SELECT = `SELECT t.*, p.text AS title_text FROM core.conversation_thread t
  LEFT JOIN core.conversation_payload p ON p.payload_id = t.title_payload`;

function threadOf(r: ThreadRow): Thread {
  let title = '(erased)';
  if (r.title_text !== null) {
    const body = JSON.parse(r.title_text) as PayloadBody;
    const line = body.text.replace(/\s+/g, ' ').trim();
    title = line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line || '(empty)';
  }
  return Thread.parse({
    thread_id: r.thread_id,
    owner: r.owner,
    subject:
      r.subject_kind === 's0'
        ? { kind: 's0', s0_id: r.s0_id, project_id: r.project_id }
        : { kind: 'project', project_id: r.project_id },
    title,
    turns: r.turns,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at),
  });
}

/** A thread, only for its owner: a thread of anybody else reads as missing (never shown to others). */
export async function readThread(
  pool: pg.Pool,
  owner: string,
  threadId: string,
): Promise<{ thread: Thread; turns: Turn[] } | null> {
  await catchUpConversations(pool);
  const q = await pool.query<ThreadRow>(
    `${THREAD_SELECT} WHERE t.thread_id = $1 AND t.owner = $2`,
    [threadId, owner],
  );
  const row = q.rows[0];
  if (!row) return null;
  const turns = await pool.query<{
    seq: number;
    role: string;
    kind: string;
    at: Date;
    payload_id: string;
    payload_sha: string;
    redactions: PayloadRedaction[];
    body: Record<string, unknown> & {
      drafts: Array<{ draft_id: string; card: string | null; sha256: string }>;
    };
    ask_id: string | null;
    text: string | null;
    erased_at: Date | null;
  }>(
    `SELECT u.*, p.text, p.erased_at FROM core.conversation_turn u
       LEFT JOIN core.conversation_payload p ON p.payload_id = u.payload_id
      WHERE u.thread_id = $1 ORDER BY u.seq`,
    [threadId],
  );
  return {
    thread: threadOf(row),
    turns: turns.rows.map((t) => {
      const body = t.text === null ? null : (JSON.parse(t.text) as PayloadBody);
      return Turn.parse({
        thread_id: threadId,
        seq: t.seq,
        role: t.role,
        kind: t.kind,
        at: iso(t.at),
        payload: {
          payload_id: t.payload_id,
          sha256: t.payload_sha,
          redactions: t.redactions,
          erased_at: t.erased_at === null ? null : iso(t.erased_at),
        },
        text: body?.text ?? null,
        citations: t.body['citations'],
        proposals: t.body['proposals'],
        // a draft's text is in the payload: an erased payload has no drafts left to show
        drafts:
          body === null
            ? []
            : t.body.drafts.flatMap((dr, i) => {
                const b = body.drafts[i];
                return b
                  ? [
                      {
                        draft_id: dr.draft_id,
                        title: b.title,
                        text: b.text,
                        card: dr.card,
                        lint: b.lint,
                      },
                    ]
                  : [];
              }),
        flags: t.body['flags'],
        refusal: t.body['refusal'],
        grounding_sha: t.body['grounding_sha'],
        ask_id: t.ask_id,
      });
    }),
  };
}

/** The person's own threads, newest first; `subject` narrows to one S0 record or one project's "Ask" threads. */
export async function listThreads(
  pool: pg.Pool,
  owner: string,
  f: { s0_id?: string; project_id?: string; limit?: number } = {},
): Promise<Thread[]> {
  await catchUpConversations(pool);
  const q = await pool.query<ThreadRow>(
    `${THREAD_SELECT} WHERE t.owner = $1
        AND ($2::uuid IS NULL OR t.s0_id = $2::uuid)
        AND ($3::text IS NULL OR (t.project_id = $3 AND t.subject_kind = 'project'))
      ORDER BY t.updated_at DESC, t.thread_id DESC LIMIT $4`,
    [owner, f.s0_id ?? null, f.project_id ?? null, f.limit ?? 50],
  );
  return q.rows.map(threadOf);
}

/** The thread's owner and subject straight from its stream (a write path never reads the read model). */
export async function threadHead(
  db: Executor,
  threadId: string,
): Promise<{ owner: string; subject: ThreadSubject } | null> {
  const q = await db.query<{ type: string; body: unknown }>(
    `SELECT type, body FROM record.record_event WHERE stream = $1 ORDER BY seq`,
    [threadStream(threadId)],
  );
  const opened = q.rows.find((r) => r.type === CONVERSATION_EVENT.thread_opened);
  if (!opened) return null;
  const p = ThreadOpenedPayload.parse(opened.body);
  return { owner: p.owner, subject: p.subject };
}

/** The earlier turns of a thread with their text (the assistant reads them back as DATA). */
export async function threadHistory(
  pool: pg.Pool,
  owner: string,
  threadId: string,
  last = 6,
): Promise<Array<{ seq: number; role: string; text: string }>> {
  const t = await readThread(pool, owner, threadId);
  if (!t) return [];
  return t.turns
    .filter((x) => x.text !== null)
    .slice(-last)
    .map((x) => ({ seq: x.seq, role: x.role, text: x.text as string }));
}
