import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AUDIT_BUCKET,
  AUDIT_LEDGER_ENTRY_TYPE,
  SignedAuditExport,
  checkSignedAuditExport,
  exportedEventHash,
  signedAuditExportBytes,
} from '@aisdlc/contracts';
import { newId, sha256Hex } from '@aisdlc/kernel';
import { main as ledgerCli } from '@aisdlc/ledger';
import { computeEventHash } from '@aisdlc/record';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { auditSnapshot, executeApproved, rebuildAudit, sweepRetention } from '../src/index.js';
import { FROM, TO, call, startWorld, type World } from './fixture.js';

// The audit service end to end (PLAN M19) on a real Postgres, the real Notary and kms-local, a Witness-co-signed
// checkpoint and the service's own least-privilege role: signed exports that verify offline (and do not once tampered
// with), legal holds and erasure under two people, retention from config, the read models rebuilt from the record.

let w: World;
const dir = mkdtempSync(join(tmpdir(), 'audit-test-'));

beforeAll(async () => {
  w = await startWorld();
});
afterAll(async () => {
  await w?.stop();
  rmSync(dir, { recursive: true, force: true });
});

const exportReq = (who: string, scope: object) => ({
  on_behalf_of: who,
  scope,
  from: FROM,
  to: TO,
  reason: 'SOC 2 sample',
});

async function signedBytes(id: string, who = 'audrey'): Promise<Uint8Array> {
  const r = await call(w, 'GET', `/v1/exports/${id}/signed?on_behalf_of=${who}`);
  expect(r.status, JSON.stringify(r.json)).toBe(200);
  const bytes = new Uint8Array(Buffer.from(r.json.bytes_b64, 'base64'));
  expect(sha256Hex(bytes)).toBe(r.json.object_key);
  return bytes;
}

const ledgerTypes = async (): Promise<string[]> =>
  (
    await w.db.pool.query<{ entry_type: string }>(
      'SELECT entry_type FROM ledger.ledger_entry ORDER BY ledger_seq',
    )
  ).rows.map((r) => r.entry_type);

describe('signed exports (PLAN M19)', () => {
  let exportId = '';

  it('a project export carries exactly the project’s record and ledger, signed, stored write-once, on the ledger', async () => {
    const r = await call(
      w,
      'POST',
      '/v1/exports',
      exportReq('pam', { kind: 'project', project_id: 'acme' }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    exportId = r.json.export_id;
    expect(r.json).toMatchObject({
      bucket: AUDIT_BUCKET,
      entries: 1,
      events: 2,
      uncovered: 0,
      requested_by: 'pam',
    });
    const bytes = await signedBytes(exportId, 'pam');
    const check = await checkSignedAuditExport(bytes, w.keys, { object_key: r.json.object_key });
    expect(check.ok, JSON.stringify(check)).toBe(true);
    if (!check.ok) return;
    const p = check.signed.package;
    expect(p.record.events.map((e) => e.stream)).toEqual([
      `item:${w.items.acme}`,
      `item:${w.items.acme}`,
    ]);
    expect(p.ledger.entries.map((e) => (e.body as { what: string }).what)).toEqual([
      'acme settings',
    ]);
    expect(JSON.stringify(p)).not.toContain('beta settings');
    // the decision is on the ledger, naming the export and its project
    const e = await w.db.pool.query(
      `SELECT actor, subject_hash, body FROM ledger.ledger_entry WHERE entry_type = $1`,
      [AUDIT_LEDGER_ENTRY_TYPE.export],
    );
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0]).toMatchObject({
      actor: 'pam',
      subject_hash: r.json.export_sha256,
      body: { project_id: 'acme', export_id: exportId, object_key: r.json.object_key },
    });
    // write-once: the store refuses to delete it
    const del = await w.objects.delete(AUDIT_BUCKET, r.json.object_key);
    expect(!del.ok && del.error.code).toBe('write_once');
  });

  it('verifies offline with `aisdlc verify-export`, and fails once a byte of it is changed', async () => {
    const bytes = await signedBytes(exportId);
    const nk = join(dir, 'notary.jwk');
    const wk = join(dir, 'witness.jwk');
    writeFileSync(nk, JSON.stringify(w.keys.notary));
    writeFileSync(wk, JSON.stringify(w.keys.witness));
    const good = join(dir, 'export.json');
    writeFileSync(good, bytes);
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l) };
    expect(
      await ledgerCli(
        ['verify-export', '--file', good, '--notary-key', nk, '--witness-key', wk],
        io,
      ),
    ).toBe(0);
    expect(out.join('\n')).toMatch(/export OK/);
    // the same content re-signed by nobody: change one event body, keep everything else
    const s = SignedAuditExport.parse(JSON.parse(new TextDecoder().decode(bytes)));
    const forged = structuredClone(s);
    (forged.package.record.events[0] as { body: Record<string, unknown> }).body['note'] = 'forged';
    const bad = join(dir, 'forged.json');
    writeFileSync(bad, signedAuditExportBytes(forged));
    out.length = 0;
    expect(
      await ledgerCli(
        ['verify-export', '--file', bad, '--notary-key', nk, '--witness-key', wk],
        io,
      ),
    ).toBe(1);
    expect(out.join('\n')).toMatch(/export_hash_mismatch/);
  });

  it('every tampering is caught: an event, an entry, the hash list, the key, the bytes', async () => {
    const bytes = await signedBytes(exportId);
    const s = SignedAuditExport.parse(JSON.parse(new TextDecoder().decode(bytes)));
    // re-sign each forgery's id with the Notary's purpose so only the inner checks can catch it
    const resign = async (f: SignedAuditExport): Promise<Uint8Array> => {
      const { auditExportId } = await import('@aisdlc/contracts');
      f.export_sha256 = auditExportId(f.package);
      const sig = await w.auditNotary.signAuditExport({
        export_sha256: f.export_sha256,
        scope_ref: 'project:acme',
      });
      if (!sig.ok) throw new Error('sign');
      f.signature = sig.value;
      return signedAuditExportBytes(f);
    };
    const event = structuredClone(s);
    (event.package.record.events[1] as { body: Record<string, unknown> }).body['note'] = 'x';
    const r1 = await checkSignedAuditExport(await resign(event), w.keys);
    expect(!r1.ok && r1.code).toBe('event_hash');

    const entry = structuredClone(s);
    (entry.package.ledger.entries[0] as { body: Record<string, unknown> }).body['what'] = 'x';
    const r2 = await checkSignedAuditExport(await resign(entry), w.keys);
    expect(!r2.ok && r2.code).toBe('entry_signature');

    const hashes = structuredClone(s);
    hashes.package.ledger.entry_hashes[0] = 'f'.repeat(64);
    const r3 = await checkSignedAuditExport(await resign(hashes), w.keys);
    expect(!r3.ok && r3.code).toBe('checkpoint_root');

    const swapped = await checkSignedAuditExport(bytes, {
      notary: w.keys.witness,
      witness: w.keys.witness,
    });
    expect(swapped.ok).toBe(false);

    const loose = new TextEncoder().encode(JSON.stringify(s, null, 2));
    const r4 = await checkSignedAuditExport(loose, w.keys);
    expect(!r4.ok && r4.code).toBe('not_canonical');
    const r5 = await checkSignedAuditExport(bytes, w.keys, { object_key: 'a'.repeat(64) });
    expect(!r5.ok && r5.code).toBe('object_key_mismatch');
  });

  it('the exported event hash is the record’s own hash function', async () => {
    const bytes = await signedBytes(exportId);
    const s = SignedAuditExport.parse(JSON.parse(new TextDecoder().decode(bytes)));
    for (const e of s.package.record.events) {
      expect(exportedEventHash(e)).toBe(computeEventHash({ ...e }));
      expect(e.hash).toBe(exportedEventHash(e));
    }
  });

  it('the PDP decides about the person: a viewer is refused, a project admin gets their project only, the auditor the fleet', async () => {
    const viewer = await call(
      w,
      'POST',
      '/v1/exports',
      exportReq('vic', { kind: 'project', project_id: 'acme' }),
    );
    expect(viewer.status).toBe(403);
    const fleetByPam = await call(w, 'POST', '/v1/exports', exportReq('pam', { kind: 'fleet' }));
    expect(fleetByPam.status).toBe(403);
    expect((await call(w, 'GET', `/v1/exports/${exportId}?on_behalf_of=vic`)).status).toBe(403);
    const list = await call(w, 'GET', '/v1/exports?on_behalf_of=pam&project=acme');
    expect(list.status).toBe(200);
    expect(list.json.exports.map((e: { export_id: string }) => e.export_id)).toEqual([exportId]);
    expect((await call(w, 'GET', '/v1/exports?on_behalf_of=pam')).status).toBe(403);
    const fleet = await call(w, 'POST', '/v1/exports', exportReq('audrey', { kind: 'fleet' }));
    expect(fleet.status, JSON.stringify(fleet.json)).toBe(201);
    // the fleet has both projects; the first export's own entry is after the checkpoint (counted, not exported)
    expect(fleet.json).toMatchObject({ entries: 2, uncovered: 1 });
    expect(fleet.json.events).toBeGreaterThanOrEqual(3);
    const readerOnly = await call(
      w,
      'POST',
      '/v1/exports',
      exportReq('audrey', { kind: 'fleet' }),
      'reader-at-audit-'.padEnd(32, 'x'),
    );
    expect(readerOnly.status).toBe(403);
  });

  it('refuses a range that is reversed or too long, and counts the entries after the checkpoint without exporting them', async () => {
    const reversed = await call(w, 'POST', '/v1/exports', {
      ...exportReq('audrey', { kind: 'fleet' }),
      from: TO,
      to: FROM,
    });
    expect(reversed.status).toBe(400);
    const long = await call(w, 'POST', '/v1/exports', {
      ...exportReq('audrey', { kind: 'fleet' }),
      from: '2024-01-01T00:00:00.000Z',
    });
    expect(long.status).toBe(400);
    await w.ownerEntry({ project_id: 'acme', what: 'after the checkpoint' });
    const r = await call(
      w,
      'POST',
      '/v1/exports',
      exportReq('pam', { kind: 'project', project_id: 'acme' }),
    );
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.uncovered).toBeGreaterThanOrEqual(2);
    const s = SignedAuditExport.parse(
      JSON.parse(new TextDecoder().decode(await signedBytes(r.json.export_id))),
    );
    expect(JSON.stringify(s.package.ledger.entries)).not.toContain('after the checkpoint');
    await w.checkpoint();
  });
});

describe('legal holds and erasure (PLAN M19)', () => {
  const vicPayload = (n: number, project = 'acme', created_at = '2026-11-12T09:00:00.000Z') => ({
    kind: 'conversation_payload' as const,
    payload_id: newId(),
    thread_id: newId(),
    owner: 'vic',
    project_id: project,
    sha256: sha256Hex(`vic ${n}`),
    created_at,
    text: `vic's words ${n}`,
  });

  it('a hold is placed by one factory admin and released only by another, both on the ledger', async () => {
    const byAuditor = await call(w, 'POST', '/v1/holds', {
      on_behalf_of: 'audrey',
      scope: { kind: 'project', project_id: 'acme' },
      matter_ref: 'LA-1',
      reason: 'dispute',
    });
    expect(byAuditor.status).toBe(403);
    const h = await call(w, 'POST', '/v1/holds', {
      on_behalf_of: 'root',
      scope: { kind: 'project', project_id: 'acme' },
      matter_ref: 'LA-1',
      reason: 'dispute',
    });
    expect(h.status, JSON.stringify(h.json)).toBe(201);
    expect(h.json).toMatchObject({ state: 'active', placed_by: 'root' });
    const self = await call(w, 'POST', `/v1/holds/${h.json.hold_id}/release`, {
      on_behalf_of: 'root',
      reason: 'done',
    });
    expect(self.status).toBe(403);
    const other = await call(w, 'POST', `/v1/holds/${h.json.hold_id}/release`, {
      on_behalf_of: 'fran',
      reason: 'done',
    });
    expect(other.status, JSON.stringify(other.json)).toBe(200);
    expect(other.json).toMatchObject({ state: 'released', released_by: 'fran' });
    expect(other.json.release_entry_seq).toBeGreaterThan(other.json.place_entry_seq);
    const again = await call(w, 'POST', `/v1/holds/${h.json.hold_id}/release`, {
      on_behalf_of: 'fran',
      reason: 'x',
    });
    expect(again.status).toBe(409);
    const types = await ledgerTypes();
    expect(types).toContain(AUDIT_LEDGER_ENTRY_TYPE.hold_placed);
    expect(types).toContain(AUDIT_LEDGER_ENTRY_TYPE.hold_released);
  });

  it('erasure: requested by one admin, blocked by a hold, approved by another, the payloads tombstoned, the chain kept', async () => {
    const a = vicPayload(1);
    const b = vicPayload(2);
    const other = { ...vicPayload(3, 'beta'), owner: 'pam' };
    w.payloads.add(a);
    w.payloads.add(b);
    w.payloads.add(other);
    const records = Number(
      (await w.db.pool.query('SELECT count(*) FROM record.record_event')).rows[0].count,
    );

    const req = await call(w, 'POST', '/v1/erasures', {
      on_behalf_of: 'fran',
      subject: { principal_id: 'vic', project_id: 'acme' },
      reason: 'subject access request SAR-9',
    });
    expect(req.status, JSON.stringify(req.json)).toBe(201);
    const id = req.json.erasure_id;
    expect(req.json.targets.map((t: { sha256: string }) => t.sha256).sort()).toEqual(
      [a.sha256, b.sha256].sort(),
    );
    expect(JSON.stringify(req.json)).not.toContain("vic's words");

    // the requester does not approve, nor an auditor
    const own = await call(w, 'POST', `/v1/erasures/${id}/approve`, {
      on_behalf_of: 'fran',
      matter_ref: 'LA-2',
      reason: 'ok',
    });
    expect(own.status).toBe(403);
    const auditor = await call(w, 'POST', `/v1/erasures/${id}/approve`, {
      on_behalf_of: 'audrey',
      matter_ref: 'LA-2',
      reason: 'ok',
    });
    expect(auditor.status).toBe(403);

    // a hold over the subject blocks the approval: recorded, nothing erased, no erasure entry
    const hold = await call(w, 'POST', '/v1/holds', {
      on_behalf_of: 'root',
      scope: { kind: 'principal', principal_id: 'vic' },
      matter_ref: 'LA-3',
      reason: 'litigation',
    });
    expect(hold.status).toBe(201);
    const blocked = await call(w, 'POST', `/v1/erasures/${id}/approve`, {
      on_behalf_of: 'root',
      matter_ref: 'LA-2',
      reason: 'counsel ok',
    });
    expect(blocked.status).toBe(409);
    expect(blocked.json.error.code).toBe('legal_hold');
    const view = await call(w, 'GET', `/v1/erasures/${id}?on_behalf_of=audrey`);
    expect(view.json).toMatchObject({
      state: 'blocked',
      blocked_by: [hold.json.hold_id],
      entry_seq: null,
    });
    expect(w.payloads.rows.get(a.payload_id)?.text).not.toBeNull();
    expect(await ledgerTypes()).not.toContain(AUDIT_LEDGER_ENTRY_TYPE.erasure);

    // the hold released by the other admin, the erasure approved: erased, on the ledger before anything went
    expect(
      (
        await call(w, 'POST', `/v1/holds/${hold.json.hold_id}/release`, {
          on_behalf_of: 'fran',
          reason: 'settled',
        })
      ).status,
    ).toBe(200);
    const ok = await call(w, 'POST', `/v1/erasures/${id}/approve`, {
      on_behalf_of: 'root',
      matter_ref: 'LA-2',
      reason: 'counsel ok',
    });
    expect(ok.status, JSON.stringify(ok.json)).toBe(200);
    expect(ok.json).toMatchObject({ state: 'executed', approved_by: 'root', matter_ref: 'LA-2' });
    expect(ok.json.targets.every((t: { erased: boolean }) => t.erased)).toBe(true);
    expect(w.payloads.rows.get(a.payload_id)).toMatchObject({ text: null, sha256: a.sha256 });
    expect(w.payloads.rows.get(b.payload_id)?.text).toBeNull();
    expect(w.payloads.rows.get(other.payload_id)?.text).not.toBeNull();
    const entry = await w.db.pool.query(
      `SELECT ledger_seq, actor, body FROM ledger.ledger_entry WHERE entry_type = $1`,
      [AUDIT_LEDGER_ENTRY_TYPE.erasure],
    );
    expect(entry.rows).toHaveLength(1);
    expect(entry.rows[0].actor).toBe('root');
    expect(entry.rows[0].body).toMatchObject({
      erasure_id: id,
      basis: 'request',
      approved_by: 'root',
      requested_by: 'fran',
    });
    expect(entry.rows[0].body.targets.map((t: { sha256: string }) => t.sha256).sort()).toEqual(
      [a.sha256, b.sha256].sort(),
    );
    // erasure never removed a record event: the record only grew
    const after = Number(
      (await w.db.pool.query('SELECT count(*) FROM record.record_event')).rows[0].count,
    );
    expect(after).toBeGreaterThan(records);
    // done is done
    const twice = await call(w, 'POST', `/v1/erasures/${id}/approve`, {
      on_behalf_of: 'root',
      matter_ref: 'LA-2',
      reason: 'again',
    });
    expect(twice.status).toBe(409);
  });

  it('an approved erasure waits while core is down and finishes on the next tick; a rejection erases nothing', async () => {
    const p = vicPayload(4, 'gamma');
    w.payloads.add(p);
    const req = await call(w, 'POST', '/v1/erasures', {
      on_behalf_of: 'root',
      subject: { principal_id: 'vic', project_id: 'gamma' },
      reason: 'SAR-10',
    });
    expect(req.status).toBe(201);
    w.payloads.down = true;
    const ok = await call(w, 'POST', `/v1/erasures/${req.json.erasure_id}/approve`, {
      on_behalf_of: 'fran',
      matter_ref: 'LA-4',
      reason: 'ok',
    });
    expect(ok.status).toBe(200);
    expect(ok.json.state).toBe('approved');
    w.payloads.down = false;
    expect(await executeApproved(w.govern())).toBe(1);
    expect(w.payloads.rows.get(p.payload_id)?.text).toBeNull();

    const q = vicPayload(5, 'delta');
    w.payloads.add(q);
    const r2 = await call(w, 'POST', '/v1/erasures', {
      on_behalf_of: 'root',
      subject: { principal_id: 'vic', project_id: 'delta' },
      reason: 'SAR-11',
    });
    const rej = await call(w, 'POST', `/v1/erasures/${r2.json.erasure_id}/reject`, {
      on_behalf_of: 'fran',
      reason: 'not ours',
    });
    expect(rej.status).toBe(200);
    expect(rej.json.state).toBe('rejected');
    expect(w.payloads.rows.get(q.payload_id)?.text).not.toBeNull();
    const none = await call(w, 'POST', '/v1/erasures', {
      on_behalf_of: 'root',
      subject: { principal_id: 'nobody', project_id: null },
      reason: 'SAR-12',
    });
    expect(none.status).toBe(404);
  });

  it('retention: the published class erases only what is older and not held; null erases nothing', async () => {
    const now = Date.parse(w.clock.now().toISOString());
    const old = {
      ...vicPayload(6, 'ret', new Date(now - 40 * 86_400_000).toISOString()),
      owner: 'pam',
    };
    const young = {
      ...vicPayload(7, 'ret', new Date(now - 5 * 86_400_000).toISOString()),
      owner: 'pam',
    };
    const heldOld = {
      ...vicPayload(8, 'held', new Date(now - 40 * 86_400_000).toISOString()),
      owner: 'pam',
    };
    for (const p of [old, young, heldOld]) w.payloads.add(p);
    // the default keeps everything
    const none = await sweepRetention(w.govern(), w.retention);
    expect(none).toEqual({ ok: true, value: { due: 0, held: 0, erasure_id: null } });
    const hold = await call(w, 'POST', '/v1/holds', {
      on_behalf_of: 'root',
      scope: { kind: 'project', project_id: 'held' },
      matter_ref: 'LA-5',
      reason: 'audit',
    });
    expect(hold.status).toBe(201);
    w.retention = {
      config: { classes: { conversation_payload: { days: 30 } } },
      rev_hash: 'r'.repeat(64),
    };
    const s = await sweepRetention(w.govern(), w.retention);
    expect(s.ok && s.value).toMatchObject({ held: 1 });
    expect(w.payloads.rows.get(old.payload_id)?.text).toBeNull();
    expect(w.payloads.rows.get(young.payload_id)?.text).not.toBeNull();
    expect(w.payloads.rows.get(heldOld.payload_id)?.text).not.toBeNull();
    const e = await w.db.pool.query(
      `SELECT actor, body FROM ledger.ledger_entry WHERE entry_type = $1 AND body ->> 'basis' = 'retention'`,
      [AUDIT_LEDGER_ENTRY_TYPE.erasure],
    );
    expect(e.rows).toHaveLength(1);
    expect(e.rows[0]).toMatchObject({
      actor: null,
      body: { approved_by: `config:${'r'.repeat(64)}` },
    });
    const view = await call(w, 'GET', '/v1/retention?on_behalf_of=audrey');
    expect(view.status).toBe(200);
    expect(view.json.config.classes.conversation_payload.days).toBe(30);
    expect(view.json.last_sweeps[0]).toMatchObject({ held: 1 });
    w.retention = { config: { classes: { conversation_payload: { days: null } } }, rev_hash: null };
  });

  it('the read models rebuild from the record to the same rows', async () => {
    const before = await auditSnapshot(w.db.pool);
    expect(await rebuildAudit(w.db.pool)).toBeGreaterThan(5);
    expect(await auditSnapshot(w.db.pool)).toEqual(before);
  });
});

describe('least privilege (PLAN M19)', () => {
  it('the audit role writes only its own streams and its four entry types, and reads no core table', async () => {
    const p = w.rolePool;
    // a well-formed next entry (it would extend the chain), of a type the audit service does not write
    const head = await p.query<{ s: string; h: string }>(
      'SELECT ledger_seq::text AS s, entry_hash AS h FROM ledger.ledger_entry ORDER BY ledger_entry.ledger_seq DESC LIMIT 1',
    );
    const next = Number(head.rows[0]?.s) + 1;
    const insert = (type: string) =>
      p.query(
        `INSERT INTO ledger.ledger_entry (ledger_seq, entry_id, entry_type, sod_waiver, policy_bundle_version,
           body, prev_hash, entry_hash, notary_key_id, notary_alg, notary_sig, created_at)
         VALUES ($1, gen_random_uuid(), $2, false, 'x', '{}', $3, repeat('a', 64), 'k', 'ES256', 'a',
           date_trunc('milliseconds', now()))`,
        [next, type, head.rows[0]?.h],
      );
    await expect(insert('config_publish')).rejects.toThrow(/row-level security/);
    await expect(insert('decision')).rejects.toThrow();
    await expect(
      p.query(`INSERT INTO record.record_event (stream, seq, global_seq, event_id, type, body, actor, occurred_at,
        prev_hash, hash) VALUES ('item:x', 1, 999999, gen_random_uuid(), 'x.y', '{}', 'a',
        date_trunc('milliseconds', now()), repeat('0', 64), repeat('a', 64))`),
    ).rejects.toThrow(/row-level security|permission/);
    await expect(p.query('UPDATE record.record_event SET actor = actor')).rejects.toThrow();
    await expect(p.query('DELETE FROM audit.export')).rejects.toThrow(/permission/);
    await expect(p.query('SELECT 1 FROM core.conversation_payload LIMIT 1')).rejects.toThrow(
      /permission/,
    );
    await expect(p.query('CREATE TABLE audit.x (a int)')).rejects.toThrow(/permission/);
    // what it may do, it can: read every stream for an export
    const n = await p.query('SELECT count(*) FROM record.record_event');
    expect(Number(n.rows[0].count)).toBeGreaterThan(0);
  });

  it('every ledger entry still verifies after all of the above', async () => {
    const { verifyLedger } = await import('@aisdlc/ledger');
    await w.checkpoint();
    const r = await verifyLedger(w.db.pool, w.keys);
    expect(r.ok, JSON.stringify(r)).toBe(true);
  });
});
