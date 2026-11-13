import { api, type FactoryRevisionDecision } from '../api';

// "Apply now" (screen map §2.11, the factory admin): the change is proposed as every change is, then its settings
// approval is decided at once by the factory admin with a reason (the override, docs/specs/deletion.md §8). Core's
// decision kernel checks that the person is a factory admin and records the reason with the decision; nothing here
// skips the record. A refusal at any step leaves what was done on the record (a proposal stays waiting).

export async function applyNow(
  key: string,
  value: unknown,
  parent: string | null,
  reason: string,
  csrf: string,
): Promise<FactoryRevisionDecision & { gate: string }> {
  const proposed = await api.proposeConfig(key, { value, parent_rev_hash: parent }, csrf);
  const gate = proposed.gate_instance_id;
  const prep = await api.prepareFactoryRevision(gate, csrf, reason);
  await api.factoryRevisionEvidence(
    gate,
    { nonce: prep.nonce, evidence_hash: prep.evidence_hash },
    csrf,
    reason,
  );
  const d = await api.decideFactoryRevision(
    gate,
    { nonce: prep.nonce, decision: 'approve' },
    csrf,
    reason,
  );
  return { ...d, gate };
}
