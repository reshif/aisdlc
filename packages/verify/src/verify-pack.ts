#!/usr/bin/env node
// Entrypoint of the bundled CLI (`dist/verify-pack.js`, the `aisdlc-verify-pack` bin): checks a signed Evidence Pack
// offline. Imports only the CLI module, so the bundle carries contracts and the kernel and nothing that does I/O.
import { verifyPackMain } from './pack-cli.js';

process.exitCode = await verifyPackMain(process.argv.slice(2), {
  out: (l) => console.log(l),
  err: (l) => console.error(l),
});
