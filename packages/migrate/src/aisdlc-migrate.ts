#!/usr/bin/env node
import { runMigrateCli } from './cli.js';

process.exitCode = await runMigrateCli(process.argv.slice(2), process.env, {
  log: (l) => console.log(l),
  error: (l) => console.error(l),
});
