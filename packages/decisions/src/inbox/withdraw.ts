import { CARD_EVENT, CardWithdrawnPayload, cardStream, type JsonObject } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { appendEvents } from '@aisdlc/record';
import { decisionError, type DecisionError } from '../errors.js';
import { clockOf, inDecisionTx, lockKey, type DecisionDeps, type Written } from '../internal.js';
import { readCardState } from './state.js';

export interface WithdrawCardInput {
  readonly card_id: string;
  readonly reason: string;
  readonly by: string;
}

/**
 * Closes a card that carries no gate and that nobody can decide any more (PLAN M7.3: its S0 record
 * was parked, withdrawn, superseded, or the step went back to the factory). A record event only: no
 * ledger entry, no vote, never an approval. A card with gates is closed by withdrawing its gates
 * (`withdrawGate`); a card already decided or withdrawn is left alone.
 */
export async function withdrawCard(
  deps: DecisionDeps,
  input: WithdrawCardInput,
): Promise<Result<Written<{ withdrawn: boolean }>, DecisionError>> {
  return inDecisionTx<{ withdrawn: boolean }>(deps, async (tx) => {
    await lockKey(tx, `card:${input.card_id}`);
    const state = await readCardState(tx, input.card_id);
    if (!state) return err(decisionError('gate_not_found', `no card ${input.card_id}`));
    if (state.gates.length > 0) {
      return err(decisionError('invalid_input', 'a card with gates is closed with its gates'));
    }
    if (state.status !== 'open') return ok({ value: { withdrawn: false }, pending: [] });
    const head = await tx.query<{ seq: string }>(
      'SELECT coalesce(max(seq), 0)::text AS seq FROM record.record_event WHERE stream = $1',
      [cardStream(input.card_id)],
    );
    const w = await appendEvents(
      tx,
      cardStream(input.card_id),
      Number(head.rows[0]?.seq),
      [
        {
          type: CARD_EVENT.withdrawn,
          actor: input.by,
          idempotency_key: `card.withdrawn:${input.card_id}`,
          body: CardWithdrawnPayload.parse({
            card_id: input.card_id,
            reason: input.reason,
            by: input.by,
          }) as unknown as JsonObject,
        },
      ],
      { clock: clockOf(deps) },
    );
    if (!w.ok) return err(decisionError('conflict', JSON.stringify(w.error)));
    return ok({ value: { withdrawn: true }, pending: [] });
  });
}
