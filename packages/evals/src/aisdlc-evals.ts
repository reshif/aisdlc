#!/usr/bin/env node
import { runCli } from './cli.js';

const code = await runCli(process.argv.slice(2), {
  env: process.env,
  out: (t) => process.stdout.write(t),
  err: (t) => process.stderr.write(t),
});
process.exit(code);
