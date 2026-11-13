import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '@aisdlc/db';
import { S3ObjectStore } from '@aisdlc/ports';
import { databaseUrl, requiredEnv } from '@aisdlc/service-kit';

// `aisdlc-export-packs --out DIR` (RC-OPS-1, the restore drill): every signed Evidence Pack the record names
// (`core.evidence_pack`, rebuilt from the `evidence:` streams) read back from the object store as stored, into
// `DIR/<object key>.pack`, and `DIR/packs.tsv` (object key, item, head, passing) for `aisdlc-verify-pack`, which
// checks each one offline. It reads, never writes the store. A pack the store cannot give is a line on stderr and
// exit code 1: a restore that lost a pack fails the drill.
//
//   CORE_DATABASE_URL, CORE_OBJECT_STORE_URL, CORE_OBJECT_STORE_ACCESS_KEY_REF, CORE_OBJECT_STORE_SECRET_KEY_REF

const at = process.argv.indexOf('--out');
const out = at >= 0 ? process.argv[at + 1] : undefined;
if (!out) {
  console.error('usage: aisdlc-export-packs --out DIR');
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const pool = createPool(databaseUrl(process.env, 'CORE_DATABASE_URL'), 2);
const store = new S3ObjectStore({
  endpoint: requiredEnv(process.env, 'CORE_OBJECT_STORE_URL'),
  accessKeyRef: requiredEnv(process.env, 'CORE_OBJECT_STORE_ACCESS_KEY_REF'),
  secretKeyRef: requiredEnv(process.env, 'CORE_OBJECT_STORE_SECRET_KEY_REF'),
});
let missing = 0;
try {
  const rows = await pool.query<{
    object_key: string;
    bucket: string;
    item_id: string;
    head_sha: string;
    passing: boolean;
  }>(
    `SELECT object_key, bucket, item_id::text AS item_id, head_sha, passing FROM core.evidence_pack
      ORDER BY event_gseq`,
  );
  const lines: string[] = [];
  const declared = new Set<string>();
  for (const r of rows.rows) {
    if (!declared.has(r.bucket)) {
      const d = await store.declareBucket(r.bucket, 'write_once');
      if (!d.ok) throw new Error(`bucket ${r.bucket}: ${d.error.message}`);
      declared.add(r.bucket);
    }
    const got = await store.get(r.bucket, r.object_key);
    if (!got.ok) {
      console.error(`missing ${r.bucket}/${r.object_key}: ${got.error.code}`);
      missing += 1;
      continue;
    }
    writeFileSync(join(out, `${r.object_key}.pack`), got.value);
    lines.push([r.object_key, r.item_id, r.head_sha, String(r.passing)].join('\t'));
  }
  writeFileSync(join(out, 'packs.tsv'), lines.map((l) => `${l}\n`).join(''));
  console.log(`exported ${lines.length} pack(s), ${missing} missing`);
} catch (e) {
  console.error(`aisdlc-export-packs: ${e instanceof Error ? e.message : String(e)}`);
  missing += 1;
} finally {
  await pool.end();
}
process.exitCode = missing === 0 ? 0 : 1;
