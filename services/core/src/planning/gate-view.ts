import {
  GateArtefactRef,
  GateArtefactsView,
  type GateArtefactsView as View,
} from '@aisdlc/contracts';
import { readCardOpened, readOpened } from '@aisdlc/decisions';
import { err, ok, type Result } from '@aisdlc/kernel';
import type pg from 'pg';
import { z } from 'zod';
import { coreError, type CoreError } from '../errors.js';
import { artefactByHash } from './store.js';

// What the portal's card page shows for a gate that decides artefacts (G1f, G2): the artefacts the gate's
// subject hash binds, each as markdown WITH its hash. The list is in the card's own facts (the engine put
// it there when it opened the gates); every body is read back through the store, which recomputes its hash
// and checks the record has its event. An artefact that is missing or not intact is shown as such and the
// view says it is not intact: a person is never shown text that is not the text the hash names.

const Facts = z.looseObject({ artefacts: z.array(GateArtefactRef).optional() });

export async function gateArtefactsView(
  pool: pg.Pool,
  cardId: string,
): Promise<Result<View, CoreError>> {
  const opened = await readCardOpened(pool, cardId);
  if (!opened || opened.open.subject_kind !== 'item') {
    return err(coreError('not_found', `${cardId} is not a work item card`));
  }
  const gates = [];
  for (const t of opened.open.targets) {
    if (t.target !== 'gate') continue;
    const g = await readOpened(pool, t.gate_instance_id);
    if (g) gates.push(g.payload);
  }
  const gate = gates[0];
  let refs: GateArtefactRef[] = [];
  for (const g of gates) {
    const facts = Facts.safeParse(g.facts);
    if (facts.success && (facts.data.artefacts ?? []).length > 0) {
      refs = facts.data.artefacts ?? [];
      break;
    }
  }
  if (refs.length === 0 || !gate)
    return err(coreError('not_found', 'this card binds no artefacts'));
  const artefacts: View['artefacts'] = [];
  for (const r of refs) {
    const a = await artefactByHash(pool, opened.open.subject_id, r.sha256);
    artefacts.push({
      step: r.step,
      type: r.type,
      sha256: r.sha256,
      version: a?.row.version ?? null,
      markdown: a?.markdown ?? null,
      intact: a !== null,
    });
  }
  return ok(
    GateArtefactsView.parse({
      card_id: cardId,
      project_id: opened.open.project_id,
      item_id: opened.open.subject_id,
      gates: gates.map((g) => g.gate_id),
      subject_hash: gate.subject_hash,
      intact: artefacts.every((a) => a.intact),
      artefacts,
    }),
  );
}
