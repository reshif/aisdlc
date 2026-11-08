import { execFile } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { checkpointMessage, type CheckpointCore } from '@aisdlc/contracts';
import { b64urlEncode, manualClock, type ManualClock } from '@aisdlc/kernel';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CHECKPOINT_INTERVAL_MS,
  appendLedgerEntry,
  main,
  runCheckpoint,
  verifyLedger,
  type VerifyFailureCode,
} from '../src/index.js';
import { draft, startStack, tampered, type Stack } from './helpers.js';

const run = promisify(execFile);

let s: Stack;
let clock: ManualClock;
let dir: string;
let notaryKeyFile: string;
let witnessKeyFile: string;

beforeAll(async () => {
  clock = manualClock('2026-11-08T10:00:00.000Z');
  s = await startStack({ clock });
  const deps = { notary: s.checkpointerNotary, witness: s.checkpointerWitness, clock };
  // 6 entries, a checkpoint after the 3rd and one after the 6th.
  for (const n of [1, 2, 3])
    expect((await appendLedgerEntry(s.record.pool, s.deps, draft(n))).ok).toBe(true);
  clock.advance(CHECKPOINT_INTERVAL_MS);
  expect((await runCheckpoint(s.record.pool, deps)).ok).toBe(true);
  for (const n of [4, 5, 6])
    expect((await appendLedgerEntry(s.record.pool, s.deps, draft(n))).ok).toBe(true);
  clock.advance(CHECKPOINT_INTERVAL_MS);
  expect((await runCheckpoint(s.record.pool, deps)).ok).toBe(true);

  dir = mkdtempSync(join(tmpdir(), 'aisdlc-verify-'));
  notaryKeyFile = join(dir, 'notary.jwk');
  witnessKeyFile = join(dir, 'witness.jwk');
  writeFileSync(notaryKeyFile, JSON.stringify(s.keys.notary));
  writeFileSync(witnessKeyFile, JSON.stringify(s.keys.witness));
});
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true });
  await s.stop();
});

async function failsWith(tamper: string[], code: VerifyFailureCode, opts = {}) {
  const r = await tampered(s.record, tamper, (tx) => verifyLedger(tx, s.keys, opts));
  expect(r.ok, `expected ${code}`).toBe(false);
  expect(!r.ok && r.error.code).toBe(code);
  return r.ok ? null : r.error;
}

describe('verifyLedger', () => {
  it('passes on a good ledger', async () => {
    const r = await verifyLedger(s.record.pool, s.keys);
    expect(r.ok && r.value).toEqual({ entries: 6, checkpoints: 2, head_seq: 6, covered_to: 6 });
  });

  it('fails on a tampered row', async () => {
    const f = await failsWith(
      ['UPDATE ledger.ledger_entry SET body = \'{"n": 999}\' WHERE ledger_seq = 2'],
      'entry_hash',
    );
    expect(f?.ledger_seq).toBe(2);
    expect(f?.message).toMatch(/entry 2/);
  });

  it('fails on a broken chain link, a gap and a missing head', async () => {
    const f = await failsWith(
      ["UPDATE ledger.ledger_entry SET prev_hash = repeat('1', 64) WHERE ledger_seq = 4"],
      'chain_break',
    );
    expect(f?.ledger_seq).toBe(4);
    const g = await failsWith(['DELETE FROM ledger.ledger_entry WHERE ledger_seq = 3'], 'gap');
    expect(g?.ledger_seq).toBe(4);
    await failsWith(['DELETE FROM ledger.ledger_entry WHERE ledger_seq = 6'], 'checkpoint_range');
  });

  it('fails on a bad Notary signature, whether swapped, garbled or by another key', async () => {
    const f = await failsWith(
      [
        `UPDATE ledger.ledger_entry SET notary_sig = (SELECT notary_sig FROM ledger.ledger_entry WHERE ledger_seq = 3)
          WHERE ledger_seq = 2`,
      ],
      'notary_signature',
    );
    expect(f?.ledger_seq).toBe(2);
    await failsWith(
      [`UPDATE ledger.ledger_entry SET notary_sig = repeat('A', 86) WHERE ledger_seq = 5`],
      'notary_signature',
    );
    // Verifying with the Witness key as the Notary key: every signature is wrong.
    const r = await verifyLedger(s.record.pool, {
      notary: s.keys.witness,
      witness: s.keys.witness,
    });
    expect(!r.ok && r.error.code).toBe('notary_signature');
    expect(!r.ok && r.error.ledger_seq).toBe(1);
  });

  it('fails on a forged checkpoint: another root, another head, or a signature by another key', async () => {
    const f = await failsWith(
      ["UPDATE ledger.checkpoint SET root_hash = repeat('2', 64) WHERE cp_seq = 1"],
      'checkpoint_root',
    );
    expect(f?.cp_seq).toBe(1);
    await failsWith(
      ["UPDATE ledger.checkpoint SET head_hash = repeat('3', 64) WHERE cp_seq = 2"],
      'checkpoint_head',
    );

    // A checkpoint with correct content but a Witness signature made by a key we do not trust.
    const cpRow = await s.record.pool.query<{
      root_hash: string;
      head_hash: string;
      created_at: Date;
    }>('SELECT root_hash, head_hash, created_at FROM ledger.checkpoint WHERE cp_seq = 2');
    const row = cpRow.rows[0];
    const core: CheckpointCore = {
      cp_seq: 2,
      from_ledger_seq: 1,
      to_ledger_seq: 6,
      root_hash: row?.root_hash as string,
      head_hash: row?.head_hash as string,
      created_at: (row?.created_at as Date).toISOString(),
    };
    const attacker = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
    const forged = b64urlEncode(
      sign('sha256', checkpointMessage(core), { key: attacker, dsaEncoding: 'ieee-p1363' }),
    );
    const sigs = await s.record.pool.query<{ signatures: unknown[] }>(
      'SELECT signatures FROM ledger.checkpoint WHERE cp_seq = 2',
    );
    const replaced = (
      sigs.rows[0]?.signatures as Array<{ signer: string; signature: Record<string, string> }>
    ).map((x) =>
      x.signer === 'witness' ? { ...x, signature: { ...x.signature, value: forged } } : x,
    );
    const g = await failsWith(
      [
        `UPDATE ledger.checkpoint SET signatures = '${JSON.stringify(replaced)}'::jsonb WHERE cp_seq = 2`,
      ],
      'checkpoint_signature',
    );
    expect(g?.message).toMatch(/witness/);
  });

  it('requires the latest checkpoint to cover the head, unless a tail is allowed', async () => {
    await failsWith(['DELETE FROM ledger.checkpoint WHERE cp_seq = 2'], 'head_uncovered');
    const ok = await tampered(s.record, ['DELETE FROM ledger.checkpoint WHERE cp_seq = 2'], (tx) =>
      verifyLedger(tx, s.keys, { allowUncoveredTail: true }),
    );
    expect(ok.ok && ok.value).toMatchObject({ entries: 6, covered_to: 3 });
    const none = await failsWith(['DELETE FROM ledger.checkpoint'], 'head_uncovered');
    expect(none?.message).toMatch(/no checkpoint/);
  });

  it('is happy with an empty ledger', async () => {
    const r = await tampered(
      s.record,
      ['DELETE FROM ledger.checkpoint', 'DELETE FROM ledger.ledger_entry'],
      (tx) => verifyLedger(tx, s.keys),
    );
    expect(r.ok && r.value).toEqual({ entries: 0, checkpoints: 0, head_seq: 0, covered_to: 0 });
  });

  it('works in small batches', async () => {
    const r = await verifyLedger(s.record.pool, s.keys, { batchSize: 2 });
    expect(r.ok && r.value.entries).toBe(6);
  });
});

describe('aisdlc verify-ledger', () => {
  const lines = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
  };
  const args = (db = s.record.url) => [
    'verify-ledger',
    '--db',
    db,
    '--notary-key',
    notaryKeyFile,
    '--witness-key',
    witnessKeyFile,
  ];

  it('exits 0 and says what it checked on a good ledger', async () => {
    const o = lines();
    expect(await main(args(), o.io)).toBe(0);
    expect(o.out.join('\n')).toMatch(/6 entries.*chain intact/);
    expect(o.out.join('\n')).toMatch(/checkpoints OK: 2.*latest covers entry 6 \(the head\)/);
    expect(o.err).toEqual([]);
  });

  it('takes the database URL from the environment', async () => {
    const o = lines();
    const code = await main(args().slice(0, 1).concat(args().slice(3)), o.io, {
      AISDLC_LEDGER_DB_URL: s.record.url,
    });
    expect(code).toBe(0);
  });

  it('exits 2 with usage for a bad command line or unusable keys', async () => {
    for (const argv of [
      [],
      ['nope'],
      ['verify-ledger'],
      ['verify-ledger', '--db', s.record.url],
      ['verify-ledger', '--bogus'],
      [...args(), '--notary-key', join(dir, 'missing.jwk')],
    ]) {
      const o = lines();
      expect(await main(argv, o.io), JSON.stringify(argv)).toBe(2);
    }
    const priv = join(dir, 'private.jwk');
    writeFileSync(priv, JSON.stringify({ ...s.keys.notary, d: 'secret' }));
    const o = lines();
    expect(
      await main(
        [
          'verify-ledger',
          '--db',
          s.record.url,
          '--notary-key',
          priv,
          '--witness-key',
          witnessKeyFile,
        ],
        o.io,
      ),
    ).toBe(2);
    expect(o.err.join('\n')).toMatch(/private key/);
    const down = lines();
    expect(await main(args('postgres://nobody@127.0.0.1:1/none'), down.io)).toBe(2);
    expect(down.err.join('\n')).toMatch(/could not run/);
  });

  it('runs as a real process: exit 0 on a good ledger, exit 1 with a clear message on a tampered one', async () => {
    // The bundle `npm run build` produces (the globalSetup builds it), run with plain node.
    const cli = join(import.meta.dirname, '..', 'dist', 'verify-ledger.js');
    const node = (extra: string[]) =>
      run(process.execPath, [cli, ...extra], {
        env: { ...process.env, NODE_NO_WARNINGS: '1' },
      }).then(
        (r) => ({ code: 0, out: r.stdout, err: r.stderr }),
        (e: { code: number; stdout: string; stderr: string }) => ({
          code: e.code,
          out: e.stdout,
          err: e.stderr,
        }),
      );

    const good = await node(args());
    expect(good.code).toBe(0);
    expect(good.out).toMatch(/ledger OK: 6 entries/);

    // Commit a tamper (owner rights, triggers off) and verify again; this is the last test here.
    const c = await s.record.pool.connect();
    try {
      await c.query('SET session_replication_role = replica');
      await c.query('UPDATE ledger.ledger_entry SET body = \'{"n": 999}\' WHERE ledger_seq = 5');
      await c.query('RESET session_replication_role');
    } finally {
      c.release();
    }
    const bad = await node(args());
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/verify-ledger FAILED \[entry_hash\]: entry 5/);
    expect(bad.out).toBe('');
  });
});
