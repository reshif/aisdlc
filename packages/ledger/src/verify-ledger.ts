#!/usr/bin/env node
// Entrypoint of the bundled CLI (`dist/verify-ledger.js`, the `aisdlc` bin). Accepts both
// `aisdlc verify-ledger --db ...` and `node dist/verify-ledger.js --db ...`.
import { main } from './cli.js';

const args = process.argv.slice(2);
process.exitCode = await main(args[0] === 'verify-ledger' ? args : ['verify-ledger', ...args], {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
