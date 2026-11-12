#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { checkSignedAuditExport } from '@aisdlc/contracts';
import { sha256Hex, type Jwk } from '@aisdlc/kernel';
import pg from 'pg';
import { verifyLedger } from './verify.js';

export interface CliIo {
  out(line: string): void;
  err(line: string): void;
}

const USAGE = `usage: aisdlc verify-ledger --db <postgres-url> --notary-key <jwk-file> --witness-key <jwk-file> [--allow-tail]

Verifies the ledger offline, read-only: chain links, entry hashes, every Notary signature, every
checkpoint's Merkle root and both signatures, and that the latest checkpoint covers the head.
Exit code 0: verified. 1: verification failed (first failure printed). 2: bad usage, bad input
or the database could not be read.
  --db            connection URL (or env AISDLC_LEDGER_DB_URL); the session is read-only
  --notary-key    public JWK of the Notary key
  --witness-key   public JWK of the Witness key
  --allow-tail    accept entries newer than the latest checkpoint (a live ledger)

usage: aisdlc verify-export --file <signed-export.json> --notary-key <jwk-file> --witness-key <jwk-file> [--object-key <sha256>]

Verifies a signed audit export (PLAN M19) offline, from the file alone: canonical bytes, the export id
and its Notary signature, the checkpoint's Merkle root over every entry hash and both its signatures,
each exported ledger entry's hash, signature and place in the chain, each record event's hash and link.
  --file          the signed export as downloaded (its sha256 is its object key)
  --object-key    the object key it was stored under, checked against the bytes`;

class UsageError extends Error {}

function readPublicJwk(path: string, what: string): Jwk {
  let jwk: Record<string, unknown>;
  try {
    jwk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new UsageError(
      `cannot read ${what} ${path}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (
    jwk['kty'] !== 'EC' ||
    jwk['crv'] !== 'P-256' ||
    typeof jwk['x'] !== 'string' ||
    typeof jwk['y'] !== 'string'
  ) {
    throw new UsageError(`${what} ${path} is not a P-256 EC public JWK`);
  }
  if ('d' in jwk)
    throw new UsageError(`${what} ${path} contains a private key; give the public JWK only`);
  return jwk as Jwk;
}

/** Runs the CLI and returns the exit code. */
export async function main(
  argv: readonly string[],
  io: CliIo,
  env: Record<string, string | undefined> = process.env,
): Promise<number> {
  try {
    const [cmd, ...rest] = argv;
    if (cmd === undefined || cmd === '--help' || cmd === '-h') {
      io.out(USAGE);
      return cmd === undefined ? 2 : 0;
    }
    if (cmd === 'verify-export') return await verifyExport(rest, io);
    if (cmd !== 'verify-ledger') throw new UsageError(`unknown command ${cmd}`);
    const { values } = parseArgs({
      args: [...rest],
      options: {
        db: { type: 'string' },
        'notary-key': { type: 'string' },
        'witness-key': { type: 'string' },
        'allow-tail': { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
      strict: true,
    });
    if (values.help) {
      io.out(USAGE);
      return 0;
    }
    const url = values.db ?? env['AISDLC_LEDGER_DB_URL'];
    if (!url) throw new UsageError('--db is required');
    if (!values['notary-key'] || !values['witness-key']) {
      throw new UsageError('--notary-key and --witness-key are required');
    }
    const keys = {
      notary: readPublicJwk(values['notary-key'], 'notary key'),
      witness: readPublicJwk(values['witness-key'], 'witness key'),
    };

    // Read-only twice over: the session default and the transaction.
    const pool = new pg.Pool({
      connectionString: url,
      max: 1,
      options: '-c default_transaction_read_only=on',
    });
    try {
      const client = await pool.connect();
      try {
        await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
        const r = await verifyLedger(client, keys, {
          allowUncoveredTail: values['allow-tail'] === true,
        });
        await client.query('ROLLBACK');
        if (!r.ok) {
          io.err(`verify-ledger FAILED [${r.error.code}]: ${r.error.message}`);
          return 1;
        }
        io.out(
          r.value.entries === 0
            ? 'ledger OK: empty'
            : `ledger OK: ${r.value.entries} entries, chain intact, every Notary signature valid`,
        );
        io.out(
          `checkpoints OK: ${r.value.checkpoints}, Merkle roots and both signatures valid, latest covers entry ${r.value.covered_to}${
            r.value.covered_to === r.value.head_seq ? ' (the head)' : ` of ${r.value.head_seq}`
          }`,
        );
        return 0;
      } finally {
        client.release();
      }
    } finally {
      await pool.end();
    }
  } catch (e) {
    if (e instanceof UsageError || (e instanceof TypeError && 'code' in e)) {
      io.err(`aisdlc: ${e.message}\n${USAGE}`);
      return 2;
    }
    io.err(`verify-ledger could not run: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }
}

async function verifyExport(rest: readonly string[], io: CliIo): Promise<number> {
  const { values } = parseArgs({
    args: [...rest],
    options: {
      file: { type: 'string' },
      'notary-key': { type: 'string' },
      'witness-key': { type: 'string' },
      'object-key': { type: 'string' },
    },
    strict: true,
  });
  if (!values.file) throw new UsageError('--file is required');
  if (!values['notary-key'] || !values['witness-key']) {
    throw new UsageError('--notary-key and --witness-key are required');
  }
  const keys = {
    notary: readPublicJwk(values['notary-key'], 'notary key'),
    witness: readPublicJwk(values['witness-key'], 'witness key'),
  };
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(readFileSync(values.file));
  } catch (e) {
    throw new UsageError(
      `cannot read ${values.file}: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  const r = await checkSignedAuditExport(
    bytes,
    keys,
    values['object-key'] ? { object_key: values['object-key'] } : {},
  );
  if (!r.ok) {
    io.err(`verify-export FAILED [${r.code}]: ${r.message}`);
    return 1;
  }
  const p = r.signed.package;
  io.out(
    `export OK: ${r.signed.export_sha256} (object key ${sha256Hex(bytes)}), signed by ${r.signed.signature.key_id}`,
  );
  io.out(
    `scope ${p.scope.kind === 'fleet' ? 'fleet' : `project ${p.scope.project_id}`}, ${p.from} to ${p.to}: ${r.entries} ledger entries and ${r.events} record events, every hash, link and signature valid`,
  );
  io.out(
    `checkpoint ${p.ledger.checkpoint.cp_seq} OK: covers entries 1..${r.covered_to}, Merkle root and both signatures valid${
      p.ledger.uncovered > 0
        ? `; ${p.ledger.uncovered} entries of the range are after it and not in this export`
        : ''
    }`,
  );
  return 0;
}
