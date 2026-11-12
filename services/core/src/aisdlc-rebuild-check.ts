import { createPool } from '@aisdlc/db';
import { databaseUrl } from '@aisdlc/service-kit';
import { readModelDigests, rebuildReadModels } from './rebuild-check.js';

// `aisdlc-rebuild-check [--rebuild]` (RC-OPS-1, the restore drill): prints every checked read model of the record
// database as `{read_models: {name: {rows, sha256}}}` on stdout. With `--rebuild` it first drops each one and refolds
// it from the record alone (what it folded goes to stderr). AISDLC_DATABASE_URL: the record database (a file: ref).

const rebuilding = process.argv.includes('--rebuild');
const pool = createPool(databaseUrl(process.env, 'AISDLC_DATABASE_URL'), 2);
try {
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
