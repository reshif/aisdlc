import { randomUUID } from 'node:crypto';
import { catalogueFor } from '@aisdlc/catalogue';
import {
  AUDIT_EVENT,
  CLOSEOUT_EVENT,
  CLOSEOUT_LEDGER_ENTRY_TYPE,
  CLOSEOUT_SCHEMA,
  CloseOutRecord,
  G6_ACCEPTANCE_FACT,
  MODE_E_SUSPENDED_LEDGER_ENTRY_TYPE,
  auditStream,
  closeOutId,
  closeoutStream,
  type CatalogueRef,
} from '@aisdlc/contracts';
import { withTransaction } from '@aisdlc/db';
import { readOpened } from '@aisdlc/decisions';
import { FakeStagePorts } from '@aisdlc/ports';
import { appendEvents } from '@aisdlc/record';
import { limitValue } from '@aisdlc/work';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  closeOutStagePorts,
  drawAuditSamples,
  listAuditSamples,
  listEscapes,
  readCloseOut,
  readItem,
  readItemEvents,
  readModeESuspension,
  rebuildAudits,
  rebuildCloseOut,
  recordAuditResult,
  reportEscape,
  submitRequest,
  type WorkDriverDeps,
} from '../src/index.js';
import { pid, pr, startCoreStack, type CoreStack } from '../src/testing.js';
import {
  GATING_ON,
  approvers,
  decideGate,
  driverOver,
  loadReports,
  runItem,
  seedActivePrr,
} from './work-fixtures.js';

// PLAN M15.4, S9 on the real record, ledger and Notary through the work driver and the decision kernel:
//   9.2 / G6  exactly the requester decides G6 (another holder of the slot is refused), its card binds the acceptance;
//             a rejection is B18 (Done, a NEW linked item)
//   9.3       the close-out record: deterministic, record + ledger, rebuildable, its id the hash of its content
//   9.5       the mode-E audit sample is drawn off the closing chain; a miss is B19 (a NEW item); the pinned catalogue's
//             B19 limits suspend mode E for the project, never below the minimum sample, only above the rate
//   B17       an escape found after the close-out: ET13 recorded, a NEW L0/L1 item

vi.setConfig({ testTimeout: 180_000 });

let s: CoreStack;
beforeAll(async () => {
  s = await startCoreStack();
  await loadReports();
});
afterAll(async () => {
  await s.stop();
});

const ok = <T>(r: { ok: true; value: T } | { ok: false; error: unknown }): T => {
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};
const ledger = () => s.deps.ledger as NonNullable<typeof s.deps.ledger>;

let n = 0;
async function newItem(seeded: { project: string; repo: string }): Promise<string> {
  n += 1;
  const r = ok(
    await submitRequest(s.deps, {
      project_id: pid(seeded.project),
      repo: seeded.repo,
      lane: 'L4',
      requester: pr('alice'),
      channel: 'N1',
      text: `close-out test request ${n}`,
    }),
  );
  return r.item_id as string;
}

const driver = (): WorkDriverDeps => {
  const base = new FakeStagePorts();
  const d = driverOver(s, { ports: base });
  return { ...d, ports: closeOutStagePorts({ ...s.deps, ledger: ledger(), base }) as never };
};

type St = NonNullable<Awaited<ReturnType<typeof readItem>>>['state'];
const g6Open = (st: St) => st.gates.some((g) => g.gate === 'G6' && g.status === 'pending');

/** A project with every gate on; bob holds every slot, alice (the requester) also holds `requesters`. */
async function project() {
  const seeded = await seedActivePrr(s, { level: 'full', gating: GATING_ON });
  approvers(s, seeded.project, ['bob']);
  return seeded;
}

describe('9.2 G6: the requester accepts, and only the requester', () => {
  it('another holder of the slot is refused; the requester approves; 9.3 records the close-out', async () => {
    const seeded = await project();
    const itemId = await newItem(seeded);
    const d = driver();
    const at = await runItem(s, d, itemId, { stop: g6Open });
    const g6 = at?.state.gates.find((g) => g.gate === 'G6' && g.status === 'pending');
    expect(g6, JSON.stringify(at?.state.waiting)).toBeDefined();
    const opened = await readOpened(s.record.pool, g6?.gate_instance_id as string);
    expect(opened?.payload).toMatchObject({ deciders: ['alice'] });
    expect((opened?.payload.facts as Record<string, unknown>)[G6_ACCEPTANCE_FACT]).toMatchObject({
      requester: 'alice',
    });

    // bob holds `requesters` too, but G6 is the requester's own acceptance
    const bob = await decideGate(s, g6?.gate_instance_id as string, 'bob', 'approve');
    expect(bob.ok).toBe(false);
    ok(await decideGate(s, g6?.gate_instance_id as string, 'alice', 'approve'));

    const done = await runItem(s, d, itemId);
    expect(done?.state.terminal).toBe('Done');

    // 9.3: one close-out record, in the record and the ledger, its id the hash of its content
    const row = await readCloseOut(s.record.pool, itemId);
    expect(row).not.toBeNull();
    const rec = row?.record as CloseOutRecord;
    expect(rec).toMatchObject({
      schema: CLOSEOUT_SCHEMA,
      item_id: itemId,
      requester: 'alice',
      acceptance: { outcome: 'approve', by: 'alice' },
      break_glass: [],
    });
    expect(closeOutId(rec)).toBe(row?.closeout_sha256);
    expect(rec.gates.map((g) => g.gate)).toEqual(expect.arrayContaining(['G4', 'G5', 'G6']));
    expect(rec.gates.filter((g) => g.outcome === 'approve').every((g) => g.ledger_entry_id)).toBe(
      true,
    );
    // no review was wired: G4's mode is unknown, which is never sampled as mode E
    expect(rec.g4?.mode).toBeNull();
    expect(rec.g4?.deciders).toEqual(['bob']);
    const entries = await s.record.pool.query<{ subject_hash: string; subject_id: string }>(
      'SELECT subject_hash, subject_id FROM ledger.ledger_entry WHERE entry_type = $1 AND subject_id = $2',
      [CLOSEOUT_LEDGER_ENTRY_TYPE, itemId],
    );
    expect(entries.rows).toEqual([{ subject_hash: row?.closeout_sha256, subject_id: itemId }]);
    const out = (await readItemEvents(s.record.pool, itemId)).filter(
      (e) => e.type === 'item.stage_completed' && (e.payload as { step?: string }).step === '9.3',
    );
    expect(out.map((e) => (e.payload as { output_hash: string }).output_hash)).toEqual([
      row?.closeout_sha256,
    ]);

    // rebuildable from the events alone, the same row
    await s.record.pool.query('DELETE FROM core.closeout WHERE item_id = $1', [itemId]);
    expect(await rebuildCloseOut(s.deps, itemId)).toBe(1);
    expect(await readCloseOut(s.record.pool, itemId)).toEqual(row);
    // deterministic: the record built again from the same record and ledger is the same record
    const again = await import('../src/index.js').then((m) =>
      m.buildCloseOut(s.record.pool, done?.state as St),
    );
    expect(closeOutId(again)).toBe(row?.closeout_sha256);
  });

  it('B18: the requester rejects: the item is Done with a NEW linked item, and no close-out', async () => {
    const seeded = await project();
    const itemId = await newItem(seeded);
    const d = driver();
    await runItem(s, d, itemId, { stop: g6Open });
    const done = await runItem(s, d, itemId, {
      decide: (g) => (g === 'G6' ? 'reject' : 'approve'),
    });
    expect(done?.state.terminal).toBe('Done');
    expect(done?.state.rework.by_edge['B18']).toBe(1);
    expect(done?.state.spawns.map((x) => [x.edge, x.kind])).toEqual([['B18', 'rejected_rework']]);
    expect(await readCloseOut(s.record.pool, itemId)).toBeNull();
  });
});

describe('B17: an escape found after the merge', () => {
  it('needs a close-out; then ET13 is recorded and a NEW L0/L1 item is asked for, once per key', async () => {
    const seeded = await project();
    const itemId = await newItem(seeded);
    const d = driver();
    const before = await reportEscape(s.deps, {
      item_id: itemId,
      by: 'carol',
      lane: 'L0',
      reason_code: 'prod_incident',
      key: `inc-${itemId}`,
    });
    expect(before.ok).toBe(false);
    const done = await runItem(s, d, itemId, {
      decide: () => 'approve',
    });
    expect(done?.state.terminal).toBe('Done');
    const r = { item_id: itemId, by: 'carol', lane: 'L1' as const, reason_code: 'prod_incident' };
    expect(ok(await reportEscape(s.deps, { ...r, key: `inc-${itemId}` }))).toEqual({
      duplicate: false,
    });
    expect(ok(await reportEscape(s.deps, { ...r, key: `inc-${itemId}` }))).toEqual({
      duplicate: true,
    });
    await runItem(s, d, itemId);
    const st = (await readItem(s.record.pool, itemId))?.state as St;
    expect(st.spawns.map((x) => [x.edge, x.kind, x.lane])).toEqual([['B17', 'escape', 'L1']]);
    expect((await listEscapes(s.record.pool, itemId)).map((e) => [e.trigger, e.by])).toEqual([
      ['ET13', 'carol'],
    ]);
  });
});

// ---------------------------------------------------------------- 9.5 and B19

/** A mode-E close-out record for an item, as 9.3 writes it (here written directly: 9.3 has its own test above). */
async function modeECloseOut(itemId: string, project: string, repo: string, cat: CatalogueRef) {
  const record = CloseOutRecord.parse({
    schema: CLOSEOUT_SCHEMA,
    item_id: itemId,
    project_id: project,
    repo,
    lane: 'L3',
    requester: 'alice',
    catalogue: cat,
    gates: [],
    merged_sha: null,
    units: [],
    g4: { gate_instance_id: randomUUID(), mode: 'E', deciders: ['bob'] },
    release_output: null,
    acceptance: { outcome: null, by: null },
    break_glass: [],
    rework: { total: 0, by_edge: {} },
  });
  const sha = closeOutId(record);
  const w = await withTransaction(s.record.pool, (tx) =>
    appendEvents(
      tx,
      closeoutStream(itemId),
      0,
      [
        {
          type: CLOSEOUT_EVENT.recorded,
          body: {
            command_key: `cmd-${itemId}`,
            closeout_sha256: sha,
            record,
            recorded_at: s.clock.now().toISOString(),
          } as never,
          actor: 'system.closeout',
        },
      ],
      { clock: s.clock },
    ),
  );
  if (!w.ok) throw new Error(JSON.stringify(w.error));
  await rebuildCloseOut(s.deps, itemId);
}

const auditDeps = () => ({ ...s.deps, ledger: ledger(), decisions: s.config });

async function auditProject(items: number) {
  const seeded = await project();
  s.elig.setHolders(pid(seeded.project), 'g4', [pr('bob'), pr('carol')]);
  const ids: string[] = [];
  for (let i = 0; i < items; i++) ids.push(await newItem(seeded));
  const cat = (await readItem(s.record.pool, ids[0] as string))?.state
    .catalogue_ref as CatalogueRef;
  for (const id of ids) await modeECloseOut(id, seeded.project, seeded.repo, cat);
  return { ...seeded, ids, cat };
}

describe('9.5 the mode-E audit sample, asynchronous, and B19', () => {
  it('a close-out is not sampled on the chain; the loop draws it once; only an eligible auditor records', async () => {
    const p = await auditProject(1);
    const id = p.ids[0] as string;
    expect(await listAuditSamples(s.record.pool, p.project)).toEqual([]);
    expect(ok(await drawAuditSamples({ ...s.deps, sampleOneIn: 1 }))).toMatchObject({
      sampled: 1,
    });
    expect(ok(await drawAuditSamples({ ...s.deps, sampleOneIn: 1 })).considered).toBe(0);
    const [row] = await listAuditSamples(s.record.pool, p.project);
    expect(row).toMatchObject({ item_id: id, sampled: true, outcome: null, g4_deciders: ['bob'] });

    const as = (by: string) =>
      recordAuditResult(auditDeps(), { item_id: id, by, outcome: 'ok', reason_code: 'reviewed' });
    // the G4 approver, the requester and someone without the g4 slot are refused, nothing written
    for (const by of ['bob', 'alice', 'dave']) expect((await as(by)).ok, by).toBe(false);
    expect(ok(await as('carol'))).toEqual({ sampled: 1, missed: 0, suspended: false });
    expect((await as('carol')).ok).toBe(false);

    // the audit tables are a fold of the stream
    const before = await listAuditSamples(s.record.pool, p.project);
    await rebuildAudits(s.deps, p.project);
    expect(await listAuditSamples(s.record.pool, p.project)).toEqual(before);
  });

  it('B19 trips at the pinned catalogue limits: never under the minimum sample; a miss asks for a NEW item', async () => {
    const cat0 = await auditProject(1);
    const c = catalogueFor(cat0.cat);
    if (!c.ok) throw new Error('catalogue');
    const min = limitValue(c.value, 'B19', 'min_sample') as number;
    const rate = limitValue(c.value, 'B19', 'miss_rate') as number;
    // misses that are over the rate already before the minimum sample is reached
    const misses = Math.floor((rate * min) / 100) + 1;
    expect(misses / (min - 1)).toBeGreaterThan(rate / 100);
    const p = await auditProject(min);
    ok(await drawAuditSamples({ ...s.deps, sampleOneIn: 1 }));
    for (const [i, id] of p.ids.entries()) {
      const r = ok(
        await recordAuditResult(auditDeps(), {
          item_id: id,
          by: 'carol',
          outcome: i < misses ? 'gate_miss' : 'ok',
          reason_code: 'reviewed',
        }),
      );
      // under the minimum sample nothing is suspended, whatever the rate
      expect(r.suspended, `audit ${i + 1}`).toBe(i + 1 >= min);
      expect(r.sampled).toBe(i + 1);
    }
    const sus = await readModeESuspension(s.record.pool, p.project);
    expect(sus).toMatchObject({
      project_id: p.project,
      sampled: min,
      missed: misses,
      limits: { miss_rate: rate, min_sample: min },
    });
    const entries = await s.record.pool.query<{ body: { project_id: string } }>(
      'SELECT body FROM ledger.ledger_entry WHERE entry_type = $1',
      [MODE_E_SUSPENDED_LEDGER_ENTRY_TYPE],
    );
    expect(entries.rows.filter((r) => r.body.project_id === p.project)).toHaveLength(1);
    const ev = await s.record.pool.query(
      'SELECT 1 FROM record.record_event WHERE stream = $1 AND type = $2',
      [auditStream(p.project), AUDIT_EVENT.mode_e_suspended],
    );
    expect(ev.rows).toHaveLength(1);
    // a miss is B19 on the audited item: a NEW linked item
    const missed = (await readItem(s.record.pool, p.ids[0] as string))?.state as St;
    expect(missed.rework.by_edge['B19']).toBe(1);
    // rebuilt from the stream, the suspension is still there
    await rebuildAudits(s.deps, p.project);
    expect(await readModeESuspension(s.record.pool, p.project)).toEqual(sus);
  });

  it('exactly the rate at the minimum sample does not suspend (the rule is "more than")', async () => {
    const p0 = await auditProject(1);
    const c = catalogueFor(p0.cat);
    if (!c.ok) throw new Error('catalogue');
    const min = limitValue(c.value, 'B19', 'min_sample') as number;
    const rate = limitValue(c.value, 'B19', 'miss_rate') as number;
    const misses = Math.floor((rate * min) / 100);
    expect((misses / min) * 100).toBeLessThanOrEqual(rate);
    const p = await auditProject(min);
    ok(await drawAuditSamples({ ...s.deps, sampleOneIn: 1 }));
    for (const [i, id] of p.ids.entries()) {
      ok(
        await recordAuditResult(auditDeps(), {
          item_id: id,
          by: 'carol',
          outcome: i < misses ? 'gate_miss' : 'ok',
          reason_code: 'reviewed',
        }),
      );
    }
    expect(await readModeESuspension(s.record.pool, p.project)).toBeNull();
  });
});
