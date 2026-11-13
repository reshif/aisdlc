import { createPool } from '@aisdlc/db';
import { databaseUrl } from '@aisdlc/service-kit';
import { catchUpReadModels, readModelDigests, rebuildReadModels } from './rebuild-check.js';

// `aisdlc-rebuild-check [--catch-up | --rebuild]` (RC-OPS-1, the restore drill): prints every checked read model of
// the record database as `{read_models: {name: {rows, sha256}}}` on stdout. With `--catch-up` it first folds each one
// forward to the record's head, as the services would on their next read (the reference taken before a backup); with
// `--rebuild` it first drops each one and refolds it from the record alone. What it folded goes to stderr.
// AISDLC_DATABASE_URL: the record database (a file: ref).

const rebuilding = process.argv.includes('--rebuild');
const catchingUp = process.argv.includes('--catch-up');
const pool = createPool(databaseUrl(process.env, 'AISDLC_DATABASE_URL'), 2);
try {
  if (catchingUp) {
    const r = await catchUpReadModels(pool);
    console.error(`caught up ${Object.keys(r).length} projections`);
  }
  if (rebuilding) {
    const r = await rebuildReadModels(pool);
    console.error(`rebuilt ${Object.keys(r.projections).length} projections and ${r.items} items`);
  }
  console.log(JSON.stringify({ read_models: await readModelDigests(pool) }));
} catch (e) {
  console.error(`aisdlc-rebuild-check: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
