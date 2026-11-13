import {
  ARTEFACT_SCHEMA_ID,
  ArtefactStoredPayload,
  PLANNING_EVENT,
  ProposalRecordedPayload,
  planningStream,
  type ArtefactType,
  type ArtefactView,
  type StepId,
} from '@aisdlc/contracts';
import {
  canonicalJson,
  err,
  ok,
  sha256Hex,
  taggedError,
  type Result,
  type TaggedError,
} from '@aisdlc/kernel';
import { scanText } from '@aisdlc/secrets-rules';
import type pg from 'pg';
import { coreError, type CoreError } from '../errors.js';
import { clockOf, inCoreTx, lockKeys, type CoreDeps } from '../journal.js';
import { renderArtefact } from './render.js';

// The artefact store and its proposals (PLAN M12; DM §3.5). An artefact is content-addressed: the sha256 of
// the canonical JSON (RFC 8785) of what a step produced, stored in `core.artefact` with an
// `artefact.stored` record event carrying the same hash, in one transaction. The shared secret ruleset
// runs over the content first and a hit REFUSES the write (the hit's rule ids are returned, never its
// value). A read recomputes the hash and checks the record has the event: a body that does not hash to its
// event is not served.

export const ArtefactRefused = taggedError('ArtefactRefused');
export type ArtefactRefused = TaggedError<
  'ArtefactRefused',
  { code: 'secret_in_output'; rules: readonly string[] }
>;

/** Rule ids the shared ruleset hits in `text` (never the matched values). */
export const secretRules = (text: string): string[] => [
  ...new Set(scanText(text).map((m) => m.rule_id)),
];

export interface StoredArtefact {
  readonly sha256: string;
  readonly version: number;
  readonly type: ArtefactType;
  /** The command had already stored it: nothing was written. */
  readonly duplicate: boolean;
}

export interface NewArtefact {
  readonly item_id: string;
  readonly project_id: string;
  readonly type: ArtefactType;
  readonly step: StepId;
  readonly command_key: string;
  readonly run_id: string | null;
  readonly content: unknown;
  /** The proposal this artefact answers, written in the same transaction. */
  readonly proposal?: ProposalRecordedPayload;
}

export const PLANNING_ACTOR = 'system.planning';

interface Row {
  seq: string;
  item_id: string;
  type: string;
  version: number;
  sha256: string;
  project_id: string;
  step: string;
  command_key: string;
  run_id: string | null;
  content: string;
  bytes: number;
  stored_at: Date;
}

/**
 * Stores the content of one step. Idempotent per (item, command, type): a redelivered command gets the
 * artefact it already stored. Refused (nothing written) when the content holds a secret.
 */
export async function storeArtefact(
  d: CoreDeps,
  a: NewArtefact,
): Promise<Result<StoredArtefact, CoreError | ArtefactRefused>> {
  let text: string;
  try {
    text = canonicalJson(a.content);
  } catch {
    return err(coreError('invalid_input', 'the artefact is not JSON'));
  }
  const rules = secretRules(text);
  if (rules.length > 0) return err(ArtefactRefused({ code: 'secret_in_output', rules }));
  const sha256 = sha256Hex(text);
  const bytes = Buffer.byteLength(text);
  const now = clockOf(d).now();
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [`planning:${a.item_id}`]);
    const have = await tx.query<{ version: number; sha256: string }>(
      'SELECT version, sha256 FROM core.artefact WHERE item_id = $1 AND command_key = $2 AND type = $3',
      [a.item_id, a.command_key, a.type],
    );
    const had = have.rows[0];
    if (had) {
      return ok<StoredArtefact>({
        sha256: had.sha256,
        version: had.version,
        type: a.type,
        duplicate: true,
      });
    }
    const top = await tx.query<{ v: number | null }>(
      'SELECT max(version) AS v FROM core.artefact WHERE item_id = $1 AND type = $2',
      [a.item_id, a.type],
    );
    const version = (top.rows[0]?.v ?? 0) + 1;
    await tx.query(
      `INSERT INTO core.artefact
         (item_id, type, version, sha256, project_id, step, command_key, run_id, content, bytes, stored_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [
        a.item_id,
        a.type,
        version,
        sha256,
        a.project_id,
        a.step,
        a.command_key,
        a.run_id,
        text,
        bytes,
        now,
      ],
    );
    const events = [
      {
        type: PLANNING_EVENT.artefact_stored,
        body: ArtefactStoredPayload.parse({
          schema: ARTEFACT_SCHEMA_ID,
          item_id: a.item_id,
          project_id: a.project_id,
          type: a.type,
          version,
          sha256,
          bytes,
          step: a.step,
          command_key: a.command_key,
          run_id: a.run_id,
        }) as unknown as Record<string, unknown>,
        actor: PLANNING_ACTOR,
        idempotency_key: `artefact.stored:${a.command_key}:${a.type}`,
      },
      ...(a.proposal
        ? [
            {
              type: PLANNING_EVENT.proposal_recorded,
              body: ProposalRecordedPayload.parse({
                ...a.proposal,
                artefact_sha256: sha256,
              }) as unknown as Record<string, unknown>,
              actor: PLANNING_ACTOR,
              idempotency_key: `proposal.recorded:${a.command_key}:${a.proposal.attempt}`,
            },
          ]
        : []),
    ];
    const e = await j.emitAll(planningStream(a.item_id), events);
    if (!e.ok) return e;
    return ok<StoredArtefact>({ sha256, version, type: a.type, duplicate: false });
  });
  return w;
}

/** A proposal the factory refused (invalid output, a secret): a hash and the reasons, never the text. */
export async function recordProposal(
  d: CoreDeps,
  p: ProposalRecordedPayload,
): Promise<Result<void, CoreError>> {
  const w = await inCoreTx(d, async (j, tx) => {
    await lockKeys(tx, [`planning:${p.item_id}`]);
    const e = await j.emitAll(planningStream(p.item_id), [
      {
        type: PLANNING_EVENT.proposal_recorded,
        body: ProposalRecordedPayload.parse(p) as unknown as Record<string, unknown>,
        actor: PLANNING_ACTOR,
        idempotency_key: `proposal.recorded:${p.command_key}:${p.attempt}`,
      },
    ]);
    return e.ok ? ok(undefined) : e;
  });
  return w;
}

export interface LoadedArtefact {
  readonly row: {
    readonly item_id: string;
    readonly type: ArtefactType;
    readonly version: number;
    readonly sha256: string;
    readonly step: StepId;
    readonly stored_at: string;
    readonly command_key: string;
    /** The agent run that proposed it; `null` for a deterministic step or a person's plan (B5). */
    readonly run_id: string | null;
    readonly bytes: number;
    /** Orders every artefact of the table in the order it was stored. */
    readonly seq: number;
  };
  readonly content: unknown;
  readonly markdown: string;
}

/** Hash and event check: `null` for a body whose bytes do not hash to its hash, or whose event is missing. */
async function verified(pool: pg.Pool, r: Row): Promise<LoadedArtefact | null> {
  if (sha256Hex(r.content) !== r.sha256) return null;
  const ev = await pool.query(
    `SELECT 1 FROM record.record_event
      WHERE stream = $1 AND type = $2 AND body ->> 'sha256' = $3 AND body ->> 'type' = $4
        AND (body ->> 'version')::int = $5`,
    [planningStream(r.item_id), PLANNING_EVENT.artefact_stored, r.sha256, r.type, r.version],
  );
  if (ev.rows.length === 0) return null;
  let content: unknown;
  try {
    content = JSON.parse(r.content);
  } catch {
    return null;
  }
  return {
    row: {
      item_id: r.item_id,
      type: r.type as ArtefactType,
      version: r.version,
      sha256: r.sha256,
      step: r.step as StepId,
      stored_at: r.stored_at.toISOString(),
      command_key: r.command_key,
      run_id: r.run_id,
      bytes: r.bytes,
      seq: Number(r.seq),
    },
    content,
    markdown: renderArtefact(r.type as ArtefactType, content),
  };
}

/** The newest version of a type for an item, verified; `null` when there is none (or it is not intact). */
export async function latestArtefact(
  pool: pg.Pool,
  itemId: string,
  type: ArtefactType,
): Promise<LoadedArtefact | null> {
  const q = await pool.query<Row>(
    'SELECT * FROM core.artefact WHERE item_id = $1 AND type = $2 ORDER BY version DESC LIMIT 1',
    [itemId, type],
  );
  const r = q.rows[0];
  return r ? verified(pool, r) : null;
}

/** An artefact by its hash (the newest row with it), verified. */
export async function artefactByHash(
  pool: pg.Pool,
  itemId: string,
  sha256: string,
): Promise<LoadedArtefact | null> {
  const q = await pool.query<Row>(
    'SELECT * FROM core.artefact WHERE item_id = $1 AND sha256 = $2 ORDER BY version DESC LIMIT 1',
    [itemId, sha256],
  );
  const r = q.rows[0];
  return r ? verified(pool, r) : null;
}

/** The artefact a command stored, verified (a redelivery answers from it). */
export async function artefactOfCommand(
  pool: pg.Pool,
  itemId: string,
  commandKey: string,
  type: ArtefactType,
): Promise<LoadedArtefact | null> {
  const q = await pool.query<Row>(
    'SELECT * FROM core.artefact WHERE item_id = $1 AND command_key = $2 AND type = $3',
    [itemId, commandKey, type],
  );
  const r = q.rows[0];
  return r ? verified(pool, r) : null;
}

/**
 * Every artefact of an item in the order it was stored, verified (P2-1's Documents tab), and how many stored rows are
 * not intact (their bytes do not hash to their hash, or their event is missing): those are never served.
 */
export async function loadItemArtefacts(
  pool: pg.Pool,
  itemId: string,
): Promise<{ artefacts: LoadedArtefact[]; not_intact: number }> {
  const q = await pool.query<Row>('SELECT * FROM core.artefact WHERE item_id = $1 ORDER BY seq', [
    itemId,
  ]);
  const artefacts: LoadedArtefact[] = [];
  let notIntact = 0;
  for (const r of q.rows) {
    const v = await verified(pool, r);
    if (v) artefacts.push(v);
    else notIntact += 1;
  }
  return { artefacts, not_intact: notIntact };
}

/** Every artefact of an item, oldest first, with its rendering (the portal and the audit read this). */
export async function listArtefacts(pool: pg.Pool, itemId: string): Promise<ArtefactView[]> {
  const q = await pool.query<Row>(
    'SELECT * FROM core.artefact WHERE item_id = $1 ORDER BY stored_at, type, version',
    [itemId],
  );
  const out: ArtefactView[] = [];
  for (const r of q.rows) {
    const v = await verified(pool, r);
    if (v) {
      out.push({
        item_id: v.row.item_id as ArtefactView['item_id'],
        step: v.row.step,
        type: v.row.type,
        version: v.row.version,
        sha256: v.row.sha256 as ArtefactView['sha256'],
        stored_at: v.row.stored_at,
        markdown: v.markdown,
      });
    }
  }
  return out;
}
