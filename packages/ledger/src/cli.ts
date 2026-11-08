#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import type { Jwk } from '@aisdlc/kernel';
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
  --allow-tail    accept entries newer than the latest checkpoint (a live ledger)`;

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
