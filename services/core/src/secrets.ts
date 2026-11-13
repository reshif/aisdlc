import { createPrivateKey } from 'node:crypto';
import {
  SECRET_DEFS,
  SECRET_ENTRY,
  SECRET_EVENT,
  SECRET_NAMES,
  SecretDestroyedPayload,
  SecretStoredPayload,
  SecretView,
  secretPath,
  secretStream,
  secretVaultRef,
  type LedgerEntryDraft,
  type PrincipalId,
  type SecretList,
  type SecretName,
  type SecretWriteResult,
} from '@aisdlc/contracts';
import { DEFAULT_POLICY_BUNDLE_VERSION, enterLedger, type DecisionDeps } from '@aisdlc/decisions';
import { err, hashCanonical, newId, ok, type Result } from '@aisdlc/kernel';
import { appendLedgerEntryTx } from '@aisdlc/ledger';
import type { SecretStorePort } from '@aisdlc/ports';
import type pg from 'pg';
import { coreError, type CoreError } from './errors.js';
import { clockOf, inCoreLedgerTx, lockKeys } from './journal.js';

// The write-only secret API (portal v2, N15; gap G1). A factory admin (or anyone the PDP allows `config.propose` on
// the fleet) pastes a value in the portal; the bff forwards it once to `PUT /v1/secrets/:name`; core writes it into
// the secret store (Vault: core's policy may create and update values, read metadata and destroy, and may NOT read a
// value back) and then records `secret.stored` {name, version, by, at} with a ledger entry over exactly that body.
// Never the value, a hash of it or its length: not in the record, the ledger, a log line, an error or a response.
//
// Why core and not the bff: the record and the ledger are written here under the lock order (AGENTS.md), with the
// Notary's signature; the bff holds no ledger writer and should hold no Vault credential. The value passes through
// the bff in memory only.
//
// Order: the store first, the record second. A store write that succeeds and a record write that fails leaves a
// version in Vault the record does not name (the list then shows `updated_by: null` for it, the honest answer);
// the reverse (a record of a value that was never stored) cannot happen.

export interface SecretDeps {
  readonly pool: pg.Pool;
  readonly store: SecretStorePort;
  /** The ledger side (the decision kernel's deps as core wires them). */
  readonly decisions: DecisionDeps;
}

const storeRef = (name: SecretName): string => `${secretPath(name)}#value`;

/** The value's shape for its format; the refusal never quotes the value. */
export function checkSecretValue(name: SecretName, value: string): CoreError | null {
  const f = SECRET_DEFS[name].format;
  if (value.trim() !== value && f !== 'pem_private_key') {
    return coreError('invalid_input', `${name}: the value has leading or trailing white space`);
  }
  if (f === 'pem_private_key') {
    try {
      const k = createPrivateKey(value);
      if (k.asymmetricKeyType !== 'rsa') {
        return coreError('invalid_input', `${name}: not an RSA private key`);
      }
    } catch {
      return coreError('invalid_input', `${name}: not a PEM private key`);
    }
  }
  if (f === 'url') {
    let u: URL;
    try {
      u = new URL(value);
    } catch {
      return coreError('invalid_input', `${name}: not a URL`);
    }
    if (u.protocol !== 'https:') return coreError('invalid_input', `${name}: not an https URL`);
  }
  if (f === 'token' && /\s/.test(value)) {
    return coreError('invalid_input', `${name}: a token holds no white space`);
  }
  return null;
}

/** Who stored the current version of each secret, from the record (the newest `secret.*` event per stream). */
async function lastWriters(
  pool: pg.Pool,
): Promise<Map<string, { by: PrincipalId; version: number } | null>> {
  const q = await pool.query<{ stream: string; type: string; body: unknown }>(
    `SELECT DISTINCT ON (stream) stream, type, body FROM record.record_event
      WHERE starts_with(stream, 'secret:') ORDER BY stream, seq DESC`,
  );
  const out = new Map<string, { by: PrincipalId; version: number } | null>();
  for (const r of q.rows) {
    if (r.type === SECRET_EVENT.stored) {
      const p = SecretStoredPayload.safeParse(r.body);
      if (p.success) out.set(p.data.name, { by: p.data.by, version: p.data.version });
    } else out.set(r.stream.slice('secret:'.length), null);
  }
  return out;
}

/** Names and metadata only. A store that does not answer is said so; nothing is then shown as set. */
export async function listSecrets(d: SecretDeps): Promise<Result<SecretList, CoreError>> {
  const writers = await lastWriters(d.pool);
  let reachable = true;
  const secrets: SecretView[] = [];
  for (const name of SECRET_NAMES) {
    const def = SECRET_DEFS[name];
    const m = reachable ? await d.store.meta(storeRef(name)) : null;
    if (m && !m.ok) reachable = false;
    const meta = m?.ok ? m.value : null;
    const w = writers.get(name) ?? null;
    secrets.push(
      SecretView.parse({
        name,
        owner: def.owner,
        label: def.label,
        format: def.format,
        ref: secretVaultRef(name),
        set: meta?.set ?? false,
        version: meta?.version ?? null,
        updated_at: meta?.updated_at ? new Date(meta.updated_at).toISOString() : null,
        // the record names the writer only of the version the store holds now
        updated_by: w && meta?.version === w.version ? w.by : null,
      }),
    );
  }
  return ok({ store_reachable: reachable, secrets });
}

/** Stores a new version and records who did it. The value goes to the store and nowhere else. */
export async function putSecret(
  d: SecretDeps,
  name: SecretName,
  value: string,
  by: PrincipalId,
): Promise<Result<SecretWriteResult, CoreError>> {
  const bad = checkSecretValue(name, value);
  if (bad) return err(bad);
  const w = await d.store.put(storeRef(name), value);
  if (!w.ok) {
    const code = w.error.code === 'invalid_value' ? 'invalid_input' : 'unavailable';
    return err(coreError(code, `the secret store refused ${name}: ${w.error.code}`));
  }
  const clock = clockOf(d.decisions);
  const body = SecretStoredPayload.parse({
    name,
    version: w.value.version,
    by,
    at: clock.now().toISOString(),
  });
  const rec = await record(d, name, SECRET_EVENT.stored, SECRET_ENTRY.stored, body, by);
  if (!rec.ok) return rec;
  return ok({ name, version: body.version, updated_at: body.at });
}

/** Destroys every version in the store and records who did it. Idempotent. */
export async function destroySecret(
  d: SecretDeps,
  name: SecretName,
  by: PrincipalId,
): Promise<Result<SecretWriteResult, CoreError>> {
  const r = await d.store.delete(storeRef(name));
  if (!r.ok)
    return err(coreError('unavailable', `the secret store refused ${name}: ${r.error.code}`));
  const clock = clockOf(d.decisions);
  const body = SecretDestroyedPayload.parse({ name, by, at: clock.now().toISOString() });
  const rec = await record(d, name, SECRET_EVENT.destroyed, SECRET_ENTRY.destroyed, body, by);
  if (!rec.ok) return rec;
  return ok({ name, version: null, updated_at: body.at });
}

/** The record event and its ledger entry, in one transaction under the lock order (ledger lock first). */
async function record(
  d: SecretDeps,
  name: SecretName,
  type: string,
  entryType: string,
  body: SecretStoredPayload | SecretDestroyedPayload,
  by: PrincipalId,
): Promise<Result<void, CoreError>> {
  const clock = clockOf(d.decisions);
  return inCoreLedgerTx({ pool: d.pool, clock, ledger: d.decisions.ledger }, async (j, tx) => {
    await lockKeys(tx, [`secret:${name}`]);
    const entered = await enterLedger(tx, d.decisions);
    if (!entered.ok) return err(coreError('unavailable', entered.error.message));
    const pending = [...entered.value];
    const e = await j.emit(secretStream(name), type, body, by);
    if (!e.ok) return e;
    const draft: LedgerEntryDraft = {
      entry_id: newId<'LedgerEntry'>() as never,
      entry_type: entryType,
      gate_instance_id: null,
      gate_id: null,
      subject_kind: null,
      subject_id: null,
      // over the metadata the record holds (name, version, who, when): never over the value
      subject_hash: hashCanonical(body) as never,
      decision: null,
      actor: by,
      sod_waiver: false,
      policy_bundle_version: DEFAULT_POLICY_BUNDLE_VERSION,
      body: { kind: type.replace('.', '_'), ...body } as never,
      created_at: body.at as never,
    };
    const le = await appendLedgerEntryTx(tx, d.decisions.ledger, draft);
    if (!le.ok) return err(coreError('unavailable', le.error.message));
    pending.push(...le.value.pending);
    return ok({ value: undefined, pending });
  });
}
