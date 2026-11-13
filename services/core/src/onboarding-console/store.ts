import {
  ConsoleSessionRow,
  ConsoleSessionView,
  ONBOARDING_SESSION_ACTOR,
  ONBOARDING_SESSION_EVENT,
  ONBOARDING_SESSION_SYSTEM,
  ConsoleDraft,
  SessionOpenedPayload,
  SessionProposalDecidedPayload,
  SessionProposalRecordedPayload,
  SessionStateChangedPayload,
  SessionToolCalledPayload,
  SessionTurnPayload,
  onboardingSessionStream,
  proposalSha256,
  type ConsoleProposal,
  type ConsoleSessionState,
  type ConsoleStateCause,
  type PayloadRedaction,
  type RecordEvent,
  type SessionTurnRole,
} from '@aisdlc/contracts';
import { err, ok, sha256Hex, uuidv7, type Result } from '@aisdlc/kernel';
import { rebuild, runProjection, type Executor, type Projection, type Tx } from '@aisdlc/record';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';

// The onboarding console's record side (docs/design/onboarding-console.md, P2). A session is a stream
// `onboarding-session:<s0>`: opened, turns (the TEXT of each is a RedactablePayload in `core.console_payload`, off the
// hash chain and erasable, naming the S0 id so a deletion of the onboarding sweeps it), tool calls (ids and hashes
// only), proposals and the person's answers, and state changes. `core.console_*` are read models: a fold of those events,
// rebuilt by `rebuildConsole`. Each write applies its own fold inside its transaction, so a read after a write sees it.

const isoOf = (v: unknown): string => (v instanceof Date ? v : new Date(String(v))).toISOString();

/** What a turn is made of when it is written: the (already masked) text and who or what said it. */
export interface NewConsoleTurn {
  readonly role: SessionTurnRole;
  readonly text: string;
  readonly redactions?: readonly PayloadRedaction[];
  readonly prompt_sha256?: string | null;
  readonly guidelines_revision?: string | null;
  readonly observed?: string | null;
  readonly observed_sha?: string | null;
}

// ---------------------------------------------------------------- the fold

/** Folds one session event into the read models. Idempotent: refolding an event changes nothing. */
export async function applyConsoleEvent(tx: Pick<Tx, 'query'>, e: RecordEvent): Promise<void> {
  const T = ONBOARDING_SESSION_EVENT;
  if (e.type === T.opened) {
    const p = SessionOpenedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.console_session (s0_id, project_id, started_by, state, turns, opened_at, updated_at)
       VALUES ($1, $2, $3, 'running', 0, $4, $4) ON CONFLICT (s0_id) DO NOTHING`,
      [p.s0_id, p.project_id, p.started_by, p.opened_at],
    );
  } else if (e.type === T.turn_recorded) {
    const p = SessionTurnPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.console_turn
         (s0_id, seq, role, at, payload_id, payload_sha, observed, observed_sha, prompt_sha, guidelines_revision, global_seq)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::bigint) ON CONFLICT (s0_id, seq) DO NOTHING`,
      [
        p.s0_id,
        p.seq,
        p.role,
        p.recorded_at,
        p.payload.payload_id,
        p.payload.sha256,
        p.observed,
        p.observed_sha,
        p.prompt_sha256,
        p.guidelines_revision,
        String(e.global_seq),
      ],
    );
    await tx.query(
      `UPDATE core.console_session SET turns = GREATEST(turns, $2), updated_at = GREATEST(updated_at, $3) WHERE s0_id = $1`,
      [p.s0_id, p.seq, p.recorded_at],
    );
  } else if (e.type === T.state_changed) {
    const p = SessionStateChangedPayload.parse(e.payload);
    await tx.query(
      `UPDATE core.console_session SET state = $2, cause = $3, updated_at = GREATEST(updated_at, $4) WHERE s0_id = $1`,
      [p.s0_id, p.state, p.state === 'running' ? null : p.cause, p.at],
    );
  } else if (e.type === T.proposal_recorded) {
    const p = SessionProposalRecordedPayload.parse(e.payload);
    await tx.query(
      `INSERT INTO core.console_proposal (proposal_id, s0_id, kind, target, body, proposal_sha, turn_seq, global_seq, census_hash)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8::bigint, $9) ON CONFLICT (proposal_id) DO NOTHING`,
      [
        p.proposal.proposal_id,
        p.s0_id,
        p.proposal.kind,
        p.proposal.target,
        JSON.stringify(p.proposal),
        p.proposal_sha256,
        p.turn_seq,
        String(e.global_seq),
        p.census_hash,
      ],
    );
  } else if (e.type === T.proposal_decided) {
    const p = SessionProposalDecidedPayload.parse(e.payload);
    await tx.query(
      `UPDATE core.console_proposal
          SET state = $2, decided_by = $3, decided_at = $4,
              decided_value = CASE WHEN $2 = 'edited' THEN $5::jsonb
                                   WHEN $2 = 'accepted' THEN body -> 'value' ELSE NULL END
        WHERE proposal_id = $1`,
      [
        p.proposal_id,
        p.state,
        p.by,
        p.at,
        p.edited_value === undefined ? null : JSON.stringify(p.edited_value),
      ],
    );
  }
  // tool_called events are the record's own account; they have no read model
}

export const consoleProjection: Projection<{
  sessions: unknown[];
  turns: unknown[];
  proposals: unknown[];
}> = {
  name: 'onboarding_console',
  version: 1,
  tables: ['core.console_proposal', 'core.console_turn', 'core.console_session'],
  async apply(tx: Tx, e: RecordEvent) {
    await applyConsoleEvent(tx, e);
  },
  async reset(tx: Tx) {
    await tx.query('DELETE FROM core.console_proposal');
    await tx.query('DELETE FROM core.console_turn');
    await tx.query('DELETE FROM core.console_session');
  },
  async snapshot(db: Executor) {
    const s = await db.query(
      `SELECT s0_id, project_id, started_by, state, cause, turns, opened_at, updated_at FROM core.console_session ORDER BY s0_id`,
    );
    const t = await db.query(
      `SELECT s0_id, seq, role, at, payload_id, payload_sha, observed, observed_sha, prompt_sha, guidelines_revision
         FROM core.console_turn ORDER BY s0_id, seq`,
    );
    const p = await db.query(
      `SELECT proposal_id, s0_id, kind, target, body, proposal_sha, turn_seq, state, decided_by, decided_at,
              census_hash, decided_value
         FROM core.console_proposal ORDER BY proposal_id`,
    );
    return { sessions: s.rows, turns: t.rows, proposals: p.rows };
  },
};

export async function catchUpConsole(pool: pg.Pool): Promise<void> {
  const r = await runProjection(pool, consoleProjection);
  if (!r.ok) throw new Error('the onboarding console read model needs a rebuild');
}

/** Drops the read models and refolds them from the record (the payload table is not derived and is not touched). */
export async function rebuildConsole(pool: pg.Pool): Promise<void> {
  await rebuild(pool, consoleProjection);
}

// ---------------------------------------------------------------- writes

async function insertPayload(
  tx: Pick<Tx, 'query'>,
  o: {
    s0_id: string;
    owner: string;
    text: string;
    redactions: readonly PayloadRedaction[];
    at: Date;
  },
): Promise<{ payload_id: string; sha256: string; redactions: PayloadRedaction[] }> {
  const payload_id = uuidv7(o.at.getTime());
  const sha256 = sha256Hex(o.text);
  await tx.query(
    `INSERT INTO core.console_payload (payload_id, s0_id, owner, sha256, text, redactions, created_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)`,
    [
      payload_id,
      o.s0_id,
      o.owner,
      sha256,
      o.text,
      JSON.stringify(o.redactions),
      o.at.toISOString(),
    ],
  );
  return { payload_id, sha256, redactions: [...o.redactions] };
}

const actorOf = (role: SessionTurnRole): string =>
  role === 'agent' ? ONBOARDING_SESSION_ACTOR : ONBOARDING_SESSION_SYSTEM;

/** Opens the session of an S0 record (once: a second open is the same session). */
export async function openSession(
  d: CoreDeps,
  o: { s0_id: string; project_id: string; started_by: string },
): Promise<Result<{ opened: boolean }, CoreError>> {
  const at = clockOf(d).now();
  return inCoreTx<{ opened: boolean }>(d, async (j, tx) => {
    const stream = onboardingSessionStream(o.s0_id);
    await lockKeys(tx, [stream]);
    if ((await j.events(stream)).length > 0) return ok({ opened: false });
    const body = SessionOpenedPayload.parse({
      s0_id: o.s0_id,
      project_id: o.project_id,
      started_by: o.started_by,
      opened_at: at.toISOString(),
    });
    const w = await j.emitAll(stream, [
      { type: ONBOARDING_SESSION_EVENT.opened, body, actor: ONBOARDING_SESSION_SYSTEM },
    ]);
    if (!w.ok) return w;
    for (const e of w.value.events) await applyConsoleEvent(tx, e);
    return ok({ opened: true });
  });
}

/** Appends a turn and, when asked, a state change in the same transaction. Returns the turn's seq. */
export async function appendConsoleTurn(
  d: CoreDeps,
  o: {
    s0_id: string;
    owner: string;
    turn: NewConsoleTurn;
    state?: { state: ConsoleSessionState; cause: ConsoleStateCause; by: string | null };
  },
): Promise<Result<{ seq: number }, CoreError>> {
  const at = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    const stream = onboardingSessionStream(o.s0_id);
    await lockKeys(tx, [stream]);
    const events = await j.events(stream);
    if (events.length === 0) return err(coreError('not_found', 'no console session'));
    const seq = events.filter((e) => e.type === ONBOARDING_SESSION_EVENT.turn_recorded).length + 1;
    const payload = await insertPayload(tx, {
      s0_id: o.s0_id,
      owner: o.owner,
      text: o.turn.text,
      redactions: o.turn.redactions ?? [],
      at,
    });
    const turn = SessionTurnPayload.parse({
      s0_id: o.s0_id,
      seq,
      role: o.turn.role,
      payload,
      prompt_sha256: o.turn.prompt_sha256 ?? null,
      guidelines_revision: o.turn.guidelines_revision ?? null,
      observed: o.turn.observed ?? null,
      observed_sha: o.turn.observed_sha ?? null,
      recorded_at: at.toISOString(),
    });
    const drafts: Array<{ type: string; body: object; actor: string }> = [
      { type: ONBOARDING_SESSION_EVENT.turn_recorded, body: turn, actor: actorOf(o.turn.role) },
    ];
    if (o.state) {
      drafts.push({
        type: ONBOARDING_SESSION_EVENT.state_changed,
        body: SessionStateChangedPayload.parse({
          s0_id: o.s0_id,
          state: o.state.state,
          cause: o.state.cause,
          by: o.state.by,
          at: at.toISOString(),
        }),
        actor: ONBOARDING_SESSION_SYSTEM,
      });
    }
    const w = await j.emitAll(stream, drafts as never);
    if (!w.ok) return w;
    for (const e of w.value.events) await applyConsoleEvent(tx, e);
    return ok({ seq });
  });
}

/** Records a tool call: its name, outcome and the hash of what it returned, never the text. */
export async function recordToolCall(
  d: CoreDeps,
  o: Omit<SessionToolCalledPayload, 'recorded_at'>,
): Promise<Result<void, CoreError>> {
  const at = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    const stream = onboardingSessionStream(o.s0_id);
    await lockKeys(tx, [stream]);
    const body = SessionToolCalledPayload.parse({ ...o, recorded_at: at.toISOString() });
    const w = await j.emitAll(stream, [
      { type: ONBOARDING_SESSION_EVENT.tool_called, body, actor: ONBOARDING_SESSION_ACTOR },
    ]);
    return w.ok ? ok(undefined) : w;
  });
}

/** Changes the session's state (pause, resume, stop, awaiting, done). A no-op when it already is that state. */
export async function setConsoleState(
  d: CoreDeps,
  o: { s0_id: string; state: ConsoleSessionState; cause: ConsoleStateCause; by: string | null },
): Promise<Result<{ changed: boolean }, CoreError>> {
  const at = clockOf(d).now();
  return inCoreTx<{ changed: boolean }>(d, async (j, tx) => {
    const stream = onboardingSessionStream(o.s0_id);
    await lockKeys(tx, [stream]);
    const events = await j.events(stream);
    if (events.length === 0) return err(coreError('not_found', 'no console session'));
    const cur = await tx.query<{ state: string; cause: string | null }>(
      'SELECT state, cause FROM core.console_session WHERE s0_id = $1',
      [o.s0_id],
    );
    const same =
      cur.rows[0]?.state === o.state &&
      (cur.rows[0]?.cause ?? null) === (o.state === 'running' ? null : o.cause);
    if (same) return ok({ changed: false });
    const body = SessionStateChangedPayload.parse({
      s0_id: o.s0_id,
      state: o.state,
      cause: o.cause,
      by: o.by,
      at: at.toISOString(),
    });
    const w = await j.emitAll(stream, [
      { type: ONBOARDING_SESSION_EVENT.state_changed, body, actor: ONBOARDING_SESSION_SYSTEM },
    ]);
    if (!w.ok) return w;
    for (const e of w.value.events) await applyConsoleEvent(tx, e);
    return ok({ changed: true });
  });
}

/** Records a proposal of the agent (or the person's own edit as one) and returns its id and hash. */
export async function recordConsoleProposal(
  d: CoreDeps,
  o: {
    s0_id: string;
    proposal: Omit<ConsoleProposal, 'proposal_id'>;
    census_hash: string | null;
    /** The factory's own marks: `by` decides at once (a person's direct edit) and no chip is left open. */
    decided?: { state: 'edited'; by: string };
  },
): Promise<
  Result<{ proposal_id: string; proposal_sha256: string; superseded: string[] }, CoreError>
> {
  const at = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    const stream = onboardingSessionStream(o.s0_id);
    await lockKeys(tx, [stream]);
    if ((await j.events(stream)).length === 0)
      return err(coreError('not_found', 'no console session'));
    const proposal_id = uuidv7(at.getTime());
    const proposal: ConsoleProposal = { ...o.proposal, proposal_id };
    // the same thing proposed again replaces the open one (the person never sees two chips for one question)
    const open = await tx.query<{ proposal_id: string; proposal_sha: string }>(
      `SELECT proposal_id, proposal_sha FROM core.console_proposal
        WHERE s0_id = $1 AND kind = $2 AND target = $3 AND state = 'open'`,
      [o.s0_id, proposal.kind, proposal.target],
    );
    const turns = await tx.query<{ n: string }>(
      'SELECT count(*)::text AS n FROM core.console_turn WHERE s0_id = $1',
      [o.s0_id],
    );
    const sha = proposalSha256(proposal);
    const drafts: Array<{ type: string; body: object; actor: string }> = [];
    for (const old of open.rows) {
      drafts.push({
        type: ONBOARDING_SESSION_EVENT.proposal_decided,
        body: SessionProposalDecidedPayload.parse({
          s0_id: o.s0_id,
          proposal_id: old.proposal_id,
          proposal_sha256: old.proposal_sha,
          state: 'superseded',
          by: null,
          at: at.toISOString(),
        }),
        actor: ONBOARDING_SESSION_SYSTEM,
      });
    }
    drafts.push({
      type: ONBOARDING_SESSION_EVENT.proposal_recorded,
      body: SessionProposalRecordedPayload.parse({
        s0_id: o.s0_id,
        proposal,
        proposal_sha256: sha,
        census_hash: o.census_hash,
        turn_seq: Number(turns.rows[0]?.n ?? 0) + 1,
        recorded_at: at.toISOString(),
      }),
      actor: o.decided ? ONBOARDING_SESSION_SYSTEM : ONBOARDING_SESSION_ACTOR,
    });
    if (o.decided) {
      drafts.push({
        type: ONBOARDING_SESSION_EVENT.proposal_decided,
        body: SessionProposalDecidedPayload.parse({
          s0_id: o.s0_id,
          proposal_id,
          proposal_sha256: sha,
          state: 'edited',
          edited_value: o.proposal.value,
          by: o.decided.by,
          at: at.toISOString(),
        }),
        actor: o.decided.by,
      });
    }
    const w = await j.emitAll(stream, drafts as never);
    if (!w.ok) return w;
    for (const e of w.value.events) await applyConsoleEvent(tx, e);
    return ok({
      proposal_id,
      proposal_sha256: sha,
      superseded: open.rows.map((r) => r.proposal_id),
    });
  });
}

/** A person's answer to a proposal. The proposal must be open and the hash the one they saw. */
export async function recordConsoleDecision(
  d: CoreDeps,
  o: {
    s0_id: string;
    proposal_id: string;
    proposal_sha256: string;
    state: 'accepted' | 'edited' | 'rejected';
    edited_value?: unknown;
    by: string;
  },
): Promise<
  Result<{ kind: string; target: string; value: unknown; census_hash: string | null }, CoreError>
> {
  const at = clockOf(d).now();
  return inCoreTx(d, async (j, tx) => {
    const stream = onboardingSessionStream(o.s0_id);
    await lockKeys(tx, [stream]);
    const q = await tx.query<{
      kind: string;
      target: string;
      body: ConsoleProposal;
      proposal_sha: string;
      state: string;
      census_hash: string | null;
    }>(
      'SELECT kind, target, body, proposal_sha, state, census_hash FROM core.console_proposal WHERE proposal_id = $1 AND s0_id = $2',
      [o.proposal_id, o.s0_id],
    );
    const row = q.rows[0];
    if (!row) return err(coreError('not_found', 'no such proposal'));
    if (row.state !== 'open')
      return err(coreError('conflict', `the proposal is already ${row.state}`));
    if (row.proposal_sha !== o.proposal_sha256) {
      return err(coreError('conflict', 'proposal_changed: it is not what you read'));
    }
    const w = await j.emitAll(stream, [
      {
        type: ONBOARDING_SESSION_EVENT.proposal_decided,
        body: SessionProposalDecidedPayload.parse({
          s0_id: o.s0_id,
          proposal_id: o.proposal_id,
          proposal_sha256: o.proposal_sha256,
          state: o.state,
          ...(o.state === 'edited' ? { edited_value: o.edited_value } : {}),
          by: o.by,
          at: at.toISOString(),
        }),
        actor: o.by,
      },
    ] as never);
    if (!w.ok) return w;
    for (const e of w.value.events) await applyConsoleEvent(tx, e);
    return ok({
      kind: row.kind,
      target: row.target,
      value: o.state === 'edited' ? o.edited_value : row.body.value,
      census_hash: row.census_hash,
    });
  });
}

/** What the person accepted so far, as defaults for the sign-off (the latest answer per kind and target wins). */
export async function draftOf(db: Pick<pg.Pool, 'query'>, s0Id: string): Promise<ConsoleDraft> {
  const q = await db.query<{
    kind: string;
    target: string;
    decided_value: Record<string, unknown> | null;
    census_hash: string | null;
  }>(
    `SELECT kind, target, decided_value, census_hash FROM core.console_proposal
      WHERE s0_id = $1 AND state IN ('accepted', 'edited') AND decided_value IS NOT NULL
      ORDER BY decided_at, global_seq`,
    [s0Id],
  );
  const gaps: Record<string, 'file_issue' | 'track_only' | 'waive'> = {};
  const role_map: Record<string, string[]> = {};
  const fix = new Map<string, string>();
  let tier: ConsoleDraft['tier'];
  let two: boolean | undefined;
  let test: ConsoleDraft['test_command'];
  for (const r of q.rows) {
    const v = r.decided_value ?? {};
    if (r.kind === 'tier') tier = v['tier'] as ConsoleDraft['tier'];
    else if (r.kind === 'gap_disposition') gaps[r.target] = v['disposition'] as never;
    else if (r.kind === 'role_map') role_map[r.target] = v['principals'] as string[];
    else if (r.kind === 'settings') two = v['two_person_enabled'] as boolean;
    else if (r.kind === 'test_command') {
      test = {
        command: String(v['command']),
        ...(typeof v['setup'] === 'string' ? { setup: v['setup'] } : {}),
        census_hash: r.census_hash,
      };
    } else if (r.kind === 'fix_file') fix.set(String(v['path']), r.target);
  }
  return ConsoleDraft.parse({
    ...(tier ? { tier } : {}),
    gaps,
    role_map,
    ...(two === undefined ? {} : { two_person_enabled: two }),
    ...(test ? { test_command: test } : {}),
    fix_files: [...fix.keys()].sort(),
  });
}

/** The command the person attested for THIS census head (the newest accepted one), or `null`. */
export async function declaredTestCommand(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
  censusHash: string,
): Promise<{ command: string; setup?: string } | null> {
  const q = await db.query<{ decided_value: { command: string; setup?: string } }>(
    `SELECT decided_value FROM core.console_proposal
      WHERE s0_id = $1 AND kind = 'test_command' AND state IN ('accepted', 'edited')
        AND decided_value IS NOT NULL AND census_hash = $2
      ORDER BY decided_at DESC, global_seq DESC LIMIT 1`,
    [s0Id, censusHash],
  );
  const v = q.rows[0]?.decided_value;
  return v ? { command: v.command, ...(v.setup ? { setup: v.setup } : {}) } : null;
}

/** The accepted fix files (path and content) for the fix pack, the latest per path. */
export async function acceptedFixFilesOf(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
): Promise<Array<{ fix_id: string; path: string; content: string }>> {
  const q = await db.query<{ target: string; decided_value: { path: string; content: string } }>(
    `SELECT target, decided_value FROM core.console_proposal
      WHERE s0_id = $1 AND kind = 'fix_file' AND state IN ('accepted', 'edited') AND decided_value IS NOT NULL
      ORDER BY decided_at, global_seq`,
    [s0Id],
  );
  const by = new Map<string, { fix_id: string; path: string; content: string }>();
  for (const r of q.rows) by.set(r.decided_value.path, { fix_id: r.target, ...r.decided_value });
  return [...by.values()];
}

// ---------------------------------------------------------------- reads

interface SessionDbRow {
  s0_id: string;
  project_id: string;
  started_by: string;
  state: ConsoleSessionState;
  cause: ConsoleStateCause | null;
  turns: number;
  opened_at: Date;
  updated_at: Date;
}

export async function readSessionRow(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
): Promise<SessionDbRow | null> {
  const q = await db.query<SessionDbRow>('SELECT * FROM core.console_session WHERE s0_id = $1', [
    s0Id,
  ]);
  return q.rows[0] ?? null;
}

/** The sessions started by one person (the console's session list), newest first. */
export async function listSessions(
  db: Pick<pg.Pool, 'query'>,
  o: { started_by?: string; limit?: number } = {},
): Promise<ConsoleSessionRow[]> {
  const q = await db.query<SessionDbRow>(
    `SELECT * FROM core.console_session WHERE ($1::text IS NULL OR started_by = $1)
      ORDER BY updated_at DESC LIMIT $2`,
    [o.started_by ?? null, o.limit ?? 50],
  );
  return q.rows.map((r) =>
    ConsoleSessionRow.parse({
      s0_id: r.s0_id,
      project_id: r.project_id,
      subject: 'onboarding',
      state: r.state,
      cause: r.cause,
      turns: r.turns,
      started_by: r.started_by,
      opened_at: isoOf(r.opened_at),
      updated_at: isoOf(r.updated_at),
    }),
  );
}

/** The turns with their text joined from the payload (an erased text reads as "(erased)"). */
export async function readTurns(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
): Promise<
  Array<{
    seq: number;
    role: SessionTurnRole;
    text: string;
    observed: string | null;
    observed_sha: string | null;
    at: string;
  }>
> {
  const q = await db.query<{
    seq: number;
    role: SessionTurnRole;
    at: Date;
    observed: string | null;
    observed_sha: string | null;
    text: string | null;
  }>(
    `SELECT t.seq, t.role, t.at, t.observed, t.observed_sha, p.text
       FROM core.console_turn t LEFT JOIN core.console_payload p ON p.payload_id = t.payload_id
      WHERE t.s0_id = $1 ORDER BY t.seq`,
    [s0Id],
  );
  return q.rows.map((r) => ({
    seq: r.seq,
    role: r.role,
    text: r.text ?? '(erased)',
    observed: r.observed,
    observed_sha: r.observed_sha,
    at: isoOf(r.at),
  }));
}

export async function sessionView(
  db: Pick<pg.Pool, 'query'>,
  s0Id: string,
  tierFloor: ConsoleSessionView['tier_floor'] = null,
): Promise<ConsoleSessionView | null> {
  const s = await readSessionRow(db, s0Id);
  if (!s) return null;
  const turns = await readTurns(db, s0Id);
  const props = await db.query<{
    body: Record<string, unknown>;
    state: string;
    proposal_sha: string;
    turn_seq: number;
  }>(
    'SELECT body, state, proposal_sha, turn_seq FROM core.console_proposal WHERE s0_id = $1 ORDER BY global_seq',
    [s0Id],
  );
  return ConsoleSessionView.parse({
    s0_id: s0Id,
    project_id: s.project_id,
    started_by: s.started_by,
    state: s.state,
    cause: s.cause,
    turns: turns.map((t) => ({
      seq: t.seq,
      role: t.role,
      text: t.text,
      observed: t.observed,
      at: t.at,
    })),
    proposals: props.rows.map((p) => ({
      ...p.body,
      state: p.state,
      proposal_sha256: p.proposal_sha,
      turn_seq: p.turn_seq,
    })),
    tier_floor: tierFloor,
    draft: await draftOf(db, s0Id),
  });
}
