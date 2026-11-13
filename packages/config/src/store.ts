import {
  CONFIG_EVENT,
  CONFIG_NOTIFY_CHANNEL,
  ConfigRevision,
  FACTORY_SCOPE,
  GATE_EVENT,
  Scope,
  configLineageKey,
  configProjectOf,
  configRevHash,
  configStream,
  configSubjectId,
  scopeFitsLayer,
  type ConfigDoc,
  type ConfigLayerKind,
  type ConfigLineage,
  type JsonObject,
  type PrincipalId,
} from '@aisdlc/contracts';
import {
  lockKey,
  openGate,
  readGateState,
  clockOf,
  type DecisionDeps,
  type Written,
} from '@aisdlc/decisions';
import { err, ok, canonicalJson, type Result } from '@aisdlc/kernel';
import { appendEvents, runProjection, type Executor } from '@aisdlc/record';
import { recordSettingsRelease } from './catalogue.js';
import { configError, type ConfigError } from './errors.js';
import { readLineage } from './lineage.js';
import { enter, inConfigTx } from './tx.js';
import { configProjection } from './projection.js';
import type { ConfigRegistry } from './registry.js';

// Proposing and publishing configuration (PLAN M3.5).
//
//   proposeRevision  validates the document against the registry, records the immutable revision
//                    (`config.proposed`) and opens an M1 gate whose subject_hash is its rev_hash.
//   (humans)         decide the M1 gate through the ordinary prepare / evidence / decide path.
//   configPublish    refuses unless the ledger shows a decided approve of an M1 gate for exactly
//                    that hash; then records `config.published`, which references the M1 decision
//                    entry, and NOTIFYs consumers. A publish writes no ledger entry of its own:
//                    the M1 decision IS the ledgered act.
//
// Lock order is the decision kernel's (see `enterLedger`): the lineage key (a gate-style key), then
// the ledger lock and an import of stranded Notary entries, then record appends.

export interface ConfigDeps extends DecisionDeps {
  readonly registry: ConfigRegistry;
}

const lineageOf = (layer: ConfigLayerKind, scope: ConfigLineage['scope']): ConfigLineage => ({
  layer,
  scope,
});

export interface ProposeInput {
  readonly layer: ConfigLayerKind;
  /** `factory` layer: the fleet scope (default). `project` layer: `{kind:'project', ref}`. */
  readonly scope?: ConfigLineage['scope'];
  /** The FULL document of the layer, not a delta. */
  readonly doc: unknown;
  readonly proposed_by: PrincipalId;
  /** The revision this one replaces. Default: the layer's current head. A different one is refused. */
  readonly parent_rev_hash?: string | null;
  /** When the M1 gate expires; default the decision kernel's TTL. */
  readonly expires_at?: string;
}

export interface ProposeResult {
  readonly rev_hash: string;
  readonly parent_rev_hash: string | null;
  readonly gate_instance_id: string;
  /** Pending M1 gates of this lineage this proposal replaced. */
  readonly superseded: readonly string[];
}

export async function proposeRevision(
  deps: ConfigDeps,
  input: ProposeInput,
): Promise<Result<Written<ProposeResult>, ConfigError>> {
  const scopeIn = Scope.safeParse(input.scope ?? FACTORY_SCOPE);
  if (!scopeIn.success) return err(configError('invalid_input', scopeIn.error.message));
  const scope = scopeIn.data;
  if (!scopeFitsLayer(input.layer, scope)) {
    return err(
      configError('invalid_input', `${input.layer} layer does not fit scope ${scope.kind}`),
    );
  }
  const lineage = lineageOf(input.layer, scope);
  // portal v2: derived keys (a regenerated policy bundle) are part of the revision the M1 approver decides
  const valid = deps.registry.validate(
    input.layer,
    input.layer === 'factory' ? deps.registry.prepare(input.doc) : input.doc,
  );
  if (!valid.ok) return valid;
  const doc = valid.value;

  // Step 1: record the revision (record only; its own transaction).
  const recorded = await inConfigTx<{ rev_hash: string; parent: string | null }>(
    deps,
    async (tx) => {
      await lockKey(tx, `config:${configLineageKey(lineage)}`);
      const entered = await enter(tx, deps);
      if (!entered.ok) return entered;
      const l = await readLineage(tx, lineage);
      const head = l.head?.rev_hash ?? null;
      const parent = input.parent_rev_hash === undefined ? head : input.parent_rev_hash;
      if (parent !== head) {
        return err(
          configError(
            'stale_parent',
            `parent ${parent ?? 'none'} is not the current revision ${head ?? 'none'}`,
          ),
        );
      }
      if (l.head && canonicalJson(l.head.doc) === canonicalJson(doc)) {
        return err(configError('unchanged', 'the document equals the current revision'));
      }
      const rev_hash = configRevHash({ layer: input.layer, scope, parent_rev_hash: parent, doc });
      const w = await appendEvents(
        tx,
        configStream(lineage),
        await headSeq(tx, configStream(lineage)),
        [
          {
            type: CONFIG_EVENT.proposed,
            actor: input.proposed_by,
            idempotency_key: `config.proposed:${rev_hash}`,
            body: {
              rev_hash,
              layer: input.layer,
              scope,
              parent_rev_hash: parent,
              doc,
              proposed_by: input.proposed_by,
            } as unknown as JsonObject,
          },
        ],
        { clock: clockOf(deps) },
      );
      if (!w.ok) return err(configError('database', JSON.stringify(w.error)));
      return ok({ value: { rev_hash, parent }, pending: entered.value });
    },
  );
  if (!recorded.ok) return recorded;

  // Step 2: the M1 gate. Same subject (the lineage) with a new hash supersedes a pending proposal.
  const { rev_hash, parent } = recorded.value;
  const gate = await openGate(deps, {
    gate_id: 'M1',
    project_id: configProjectOf(lineage) as never,
    subject_kind: 'config',
    subject_id: configSubjectId(lineage),
    subject_hash: rev_hash,
    requester: input.proposed_by,
    facts: {
      layer: input.layer,
      scope,
      parent_rev_hash: parent,
      ...(input.expires_at ? { expires_at: input.expires_at } : {}),
    },
  });
  if (!gate.ok) return err(configError('decision', gate.error.message, gate.error));
  return ok({
    rev_hash,
    parent_rev_hash: parent,
    gate_instance_id: gate.value.gate_instance_id,
    superseded: gate.value.superseded,
    confirmed: recorded.value.confirmed && gate.value.confirmed,
  });
}

// ---------------------------------------------------------------- Publish

export interface PublishInput {
  readonly rev_hash: string;
  readonly published_by?: string;
}

export interface PublishResult {
  readonly rev_hash: string;
  readonly layer: ConfigLayerKind;
  readonly scope: ConfigLineage['scope'];
  readonly gate_instance_id: string;
  /** The M1 decision entry on the ledger that the `config.published` event references. */
  readonly ledger_entry_id: string;
  /** False when the revision was already published: nothing was written. */
  readonly published: boolean;
}

/** The lineage a `rev_hash` was proposed on, from the authoritative record. */
async function proposedLineage(db: Executor, rev_hash: string): Promise<ConfigLineage | null> {
  const q = await db.query<{ body: { layer: ConfigLayerKind; scope: ConfigLineage['scope'] } }>(
    `SELECT body FROM record.record_event
      WHERE type = $1 AND body ->> 'rev_hash' = $2 ORDER BY global_seq LIMIT 1`,
    [CONFIG_EVENT.proposed, rev_hash],
  );
  const b = q.rows[0]?.body;
  return b ? { layer: b.layer, scope: b.scope } : null;
}

/**
 * `config_publish`: makes a proposed revision effective, only if the ledger holds a decided
 * `approve` of an M1 gate for exactly its `rev_hash` (the gate state is folded from the ledger, and
 * a decision on any other hash, or an expired, superseded, withdrawn or rejected gate, does not
 * count). Refuses with `not_decided` otherwise, and with `stale_parent` if the revision is not a
 * child of the current head. Idempotent.
 */
export async function configPublish(
  deps: ConfigDeps,
  input: PublishInput,
): Promise<Result<Written<PublishResult>, ConfigError>> {
  const lineage = await proposedLineage(deps.pool, input.rev_hash);
  if (!lineage) return err(configError('revision_not_found', `no revision ${input.rev_hash}`));
  const subject = configSubjectId(lineage);

  const done = await inConfigTx<PublishResult>(deps, async (tx) => {
    await lockKey(tx, `config:${configLineageKey(lineage)}`);
    // Every M1 instance of this lineage that decides this hash; lock them, then the ledger.
    const gates = await tx.query<{ stream: string }>(
      `SELECT stream FROM record.record_event
        WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2 AND body ->> 'gate_id' = 'M1'
          AND body ->> 'subject_kind' = 'config' AND body ->> 'subject_hash' = $3
        ORDER BY global_seq`,
      [GATE_EVENT.opened, subject, input.rev_hash],
    );
    const ids = gates.rows.map((r) => r.stream.slice('gate:'.length));
    for (const id of [...ids].sort()) await lockKey(tx, `gate:${id}`);
    const entered = await enter(tx, deps);
    if (!entered.ok) return entered;
    const pending = entered.value;

    const l = await readLineage(tx, lineage);
    const rev = l.proposed.get(input.rev_hash);
    if (!rev) return err(configError('revision_not_found', `no revision ${input.rev_hash}`));
    const already = l.published.find((p) => p.rev_hash === input.rev_hash);
    if (already) {
      return ok({
        value: {
          rev_hash: input.rev_hash,
          layer: lineage.layer,
          scope: lineage.scope,
          gate_instance_id: already.gate_instance_id,
          ledger_entry_id: already.ledger_entry_id,
          published: false,
        },
        pending,
      });
    }
    if (rev.parent_rev_hash !== (l.head?.rev_hash ?? null)) {
      return err(
        configError(
          'stale_parent',
          `revision ${input.rev_hash} has parent ${rev.parent_rev_hash ?? 'none'}, the current revision is ${l.head?.rev_hash ?? 'none'}`,
        ),
      );
    }
    // Defence in depth: the document in the record must still hash to the revision.
    if (
      configRevHash({
        layer: rev.layer,
        scope: rev.scope,
        parent_rev_hash: rev.parent_rev_hash,
        doc: rev.doc,
      }) !== input.rev_hash
    ) {
      return err(configError('not_decided', 'stored document does not match rev_hash'));
    }

    const seen: string[] = [];
    for (const id of ids) {
      const state = await readGateState(tx, id);
      if (!state) continue;
      const p = state.open.payload;
      seen.push(`${id}:${state.status}${state.outcome ? `/${state.outcome}` : ''}`);
      if (
        state.status === 'decided' &&
        state.outcome === 'approve' &&
        p.gate_id === 'M1' &&
        p.subject_kind === 'config' &&
        p.subject_hash === input.rev_hash &&
        state.ended_ledger_seq !== null
      ) {
        const deciding = state.decisions.find((d) => d.ledger_seq === state.ended_ledger_seq);
        if (!deciding) continue;
        const body = {
          rev_hash: input.rev_hash,
          layer: lineage.layer,
          scope: lineage.scope,
          parent_rev_hash: rev.parent_rev_hash,
          gate_instance_id: id,
          ledger_entry_id: deciding.entry_id,
          published_by: input.published_by ?? 'system.config',
        };
        const w = await appendEvents(
          tx,
          configStream(lineage),
          await headSeq(tx, configStream(lineage)),
          [
            {
              type: CONFIG_EVENT.published,
              actor: input.published_by ?? 'system.config',
              idempotency_key: `config.published:${input.rev_hash}`,
              body: body as unknown as JsonObject,
            },
          ],
          { clock: clockOf(deps) },
        );
        if (!w.ok) return err(configError('database', JSON.stringify(w.error)));
        // Portal v2: a factory revision that changes a catalogue section makes the next catalogue release, recorded
        // with the publish (one transaction: the settings are never in force without their release).
        if (lineage.layer === 'factory') {
          const rel = await recordSettingsRelease(tx, rev.doc, input.rev_hash, clockOf(deps));
          if (!rel.ok) return rel;
        }
        // Delivered to listeners when this transaction commits, never before.
        await tx.query('SELECT pg_notify($1, $2)', [
          CONFIG_NOTIFY_CHANNEL,
          JSON.stringify({ lineage: configLineageKey(lineage), rev_hash: input.rev_hash }),
        ]);
        return ok({
          value: {
            rev_hash: input.rev_hash,
            layer: lineage.layer,
            scope: lineage.scope,
            gate_instance_id: id,
            ledger_entry_id: deciding.entry_id,
            published: true,
          },
          pending,
        });
      }
    }
    return err(
      configError(
        'not_decided',
        `no decided approve of an M1 gate for ${input.rev_hash} (${seen.join(', ') || 'no gate'})`,
      ),
    );
  });
  return done;
}

export interface PublishDecidedReport {
  readonly published: readonly string[];
  /** Proposed revisions that are not publishable yet (gate pending) or ever (rejected), and why. */
  readonly skipped: ReadonlyArray<{ rev_hash: string; reason: string }>;
}

/**
 * What the worker runs: publishes every proposed revision whose M1 gate has a decided approve and
 * that is not yet published. Never decides anything; refusals are reported, not raised.
 */
export async function publishDecided(
  deps: ConfigDeps,
): Promise<Result<PublishDecidedReport, ConfigError>> {
  const caught = await runProjection(deps.pool, configProjection);
  if (!caught.ok) return err(configError('database', JSON.stringify(caught.error)));
  const q = await deps.pool.query<{ rev_hash: string }>(
    `SELECT r.rev_hash FROM config.config_revision r
      LEFT JOIN config.config_published p USING (rev_hash)
      WHERE p.rev_hash IS NULL ORDER BY r.global_seq`,
  );
  const published: string[] = [];
  const skipped: Array<{ rev_hash: string; reason: string }> = [];
  for (const { rev_hash } of q.rows) {
    const r = await configPublish(deps, { rev_hash });
    if (r.ok) {
      if (r.value.published) published.push(rev_hash);
    } else skipped.push({ rev_hash, reason: r.error.code });
  }
  return ok({ published, skipped });
}

// ---------------------------------------------------------------- Read: revisions with their state

/**
 * The revisions of a lineage as `ConfigRevision` rows, oldest first, with their derived state:
 * `current` and `superseded` for the published ones, `proposed` while the M1 gate is pending (or
 * decided but not yet published), `rejected` once every gate for the hash ended without an approval.
 */
export async function listRevisions(
  deps: ConfigDeps,
  lineage: ConfigLineage,
): Promise<ConfigRevision[]> {
  const l = await readLineage(deps.pool, lineage);
  const subject = configSubjectId(lineage);
  const out: ConfigRevision[] = [];
  const publishedAt = new Map<string, string>();
  const pubs = await deps.pool.query<{ body: { rev_hash: string }; occurred_at: Date }>(
    `SELECT body, occurred_at FROM record.record_event WHERE stream = $1 AND type = $2`,
    [configStream(lineage), CONFIG_EVENT.published],
  );
  for (const r of pubs.rows) publishedAt.set(r.body.rev_hash, r.occurred_at.toISOString());
  for (const rev of l.proposed.values()) {
    const pub = l.published.find((p) => p.rev_hash === rev.rev_hash);
    let state: ConfigRevision['state'];
    let gate: string | null;
    if (pub) {
      state = l.head?.rev_hash === rev.rev_hash ? 'current' : 'superseded';
      gate = pub.gate_instance_id;
    } else {
      const g = await deps.pool.query<{ stream: string }>(
        `SELECT stream FROM record.record_event
          WHERE type = $1 AND seq = 1 AND body ->> 'subject_id' = $2 AND body ->> 'gate_id' = 'M1'
            AND body ->> 'subject_hash' = $3 ORDER BY global_seq`,
        [GATE_EVENT.opened, subject, rev.rev_hash],
      );
      const states = [];
      for (const r of g.rows) {
        const s = await readGateState(deps.pool, r.stream.slice('gate:'.length));
        if (s) states.push(s);
      }
      gate = states.at(-1)?.open.gate_instance_id ?? null;
      const live = states.some(
        (s) => s.status === 'pending' || (s.status === 'decided' && s.outcome === 'approve'),
      );
      state = states.length === 0 || live ? 'proposed' : 'rejected';
    }
    out.push(
      ConfigRevision.parse({
        rev_hash: rev.rev_hash,
        layer: rev.layer,
        scope: rev.scope,
        previous_rev_hash: rev.parent_rev_hash,
        state,
        gate_instance_id: gate,
        ledger_entry_id: pub?.ledger_entry_id ?? null,
        content: rev.doc,
        proposed_by: rev.proposed_by,
        proposed_at: rev.proposed_at,
        published_at: pub ? (publishedAt.get(rev.rev_hash) ?? null) : null,
      }),
    );
  }
  return out;
}

// ---------------------------------------------------------------- helpers

async function headSeq(tx: Executor, stream: string): Promise<number> {
  const q = await tx.query<{ seq: string }>(
    'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
    [stream],
  );
  return Number(q.rows[0]?.seq ?? 0);
}

export type { ConfigDoc };
