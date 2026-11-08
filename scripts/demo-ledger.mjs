#!/usr/bin/env node
// M2 exit demo (PLAN M2.6), plain node, no TypeScript:
//   throwaway Postgres -> kms-local, notary, witness as separate processes from their bundles
//   -> ten ledger entries and one checkpoint round through the real writer (demo-writer bundle)
//   -> `verify-ledger` passes -> one row is tampered (superuser, triggers off) -> it fails.
// Everything it starts is stopped and every temp dir removed, also on failure or Ctrl-C.
// Run it through `npm run demo:ledger` (which builds first). Exit 0 only if both verdicts held.
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  chownSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const BUNDLES = {
  kms: join(root, 'services/kms-local/dist/main.js'),
  notary: join(root, 'services/notary/dist/main.js'),
  witness: join(root, 'services/witness/dist/main.js'),
  writer: join(root, 'packages/ledger/dist/demo-writer.js'),
  verify: join(root, 'packages/ledger/dist/verify-ledger.js'),
};
const PG_BIN = process.env.PG_BIN ?? '/usr/lib/postgresql/16/bin';
const T0 = Date.now();
const step = (msg) => console.log(`\n== [${((Date.now() - T0) / 1000).toFixed(1)}s] ${msg}`);

/** @type {Array<() => Promise<void> | void>} */
const cleanups = [];
const children = new Set();

// ---------------------------------------------------------------------------------- processes

/** Starts a bundle in its own process group. Resolves with the URL it prints when listening. */
function startService(name, bundle, env) {
  return new Promise((resolveStart, reject) => {
    const child = spawn(process.execPath, ['--enable-source-maps', bundle], {
      detached: true, // own process group, so the whole group can be signalled
      env: { PATH: process.env.PATH, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    const svc = {
      name,
      child,
      output: '',
      exited: new Promise((r) => child.once('exit', (code, sig) => r({ code, sig }))),
    };
    let settled = false;
    const timer = setTimeout(() => fail(new Error(`${name} did not start within 20s`)), 20_000);
    const fail = (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`${e.message}\n--- ${name} output ---\n${svc.output}`));
    };
    const onData = (d) => {
      svc.output += d;
      const m = /listening on (http:\/\/\S+)/.exec(svc.output);
      if (m && !settled) {
        settled = true;
        clearTimeout(timer);
        resolveStart({ ...svc, url: m[1] });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (d) => (svc.output += d));
    child.once('exit', (code, sig) =>
      fail(new Error(`${name} exited during start (code ${code}, signal ${sig})`)),
    );
    child.once('error', fail);
    cleanups.push(() => killGroup(svc));
  });
}

async function killGroup(svc) {
  const { child } = svc;
  if (child.exitCode !== null || child.signalCode !== null) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* group already gone */
    }
    return;
  }
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-child.pid, sig);
    } catch {
      return;
    }
    const done = await Promise.race([
      svc.exited.then(() => true),
      new Promise((r) => setTimeout(() => r(false), 3_000)),
    ]);
    if (done) break;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
}

/** SIGTERM and expect a clean exit 0 (the graceful-shutdown contract of every service). */
async function stopGracefully(svc) {
  process.kill(-svc.child.pid, 'SIGTERM');
  const r = await Promise.race([
    svc.exited,
    new Promise((res) => setTimeout(() => res('timeout'), 10_000)),
  ]);
  if (r === 'timeout') throw new Error(`${svc.name} did not stop within 10s of SIGTERM`);
  if (r.code !== 0)
    throw new Error(
      `${svc.name} exited ${r.code} (${r.sig}) after SIGTERM, wanted 0\n${svc.output}`,
    );
  console.log(`   ${svc.name} stopped cleanly (exit 0)`);
}

/** Runs a bundle to completion. Never throws on a non-zero exit. */
function runBundle(bundle, args, env) {
  const r = spawnSync(process.execPath, ['--enable-source-maps', bundle, ...args], {
    env: { PATH: process.env.PATH, ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return { code: r.status ?? -1, out: r.stdout ?? '', err: r.stderr ?? '' };
}

// ------------------------------------------------------------------------------- the database

const asUser = () => {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return undefined;
  for (const user of ['postgres', 'nobody'])
    if (spawnSync('id', ['-u', user]).status === 0) return user;
  throw new Error('running as root and no unprivileged user (postgres, nobody) exists');
};

/** A throwaway cluster: unix socket only, fsync off, in a temp dir. Returns the admin URL. */
async function startPostgres() {
  if (!existsSync(join(PG_BIN, 'initdb')))
    throw new Error(`initdb not found in ${PG_BIN}; set PG_BIN`);
  const user = asUser();
  const dir = mkdtempSync(join(tmpdir(), 'aisdlc-demo-pg-'));
  const data = join(dir, 'data');
  const sock = join(dir, 'sock');
  let started = false;
  cleanups.push(() => {
    try {
      if (started) pgRun(user, 'pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
  mkdirSync(sock);
  if (user) {
    const id = (flag) => Number(execFileSync('id', [flag, user]).toString().trim());
    chownSync(dir, id('-u'), id('-g'));
    chownSync(sock, id('-u'), id('-g'));
  }
  pgRun(user, 'initdb', [
    '-D',
    data,
    '-A',
    'trust',
    '-U',
    'postgres',
    '-E',
    'UTF8',
    '--no-sync',
    '--locale=C',
  ]);
  const port = 20_000 + Math.floor(Math.random() * 20_000); // names the socket file only (no TCP)
  const opts = [
    `-c listen_addresses=`,
    `-c unix_socket_directories=${sock}`,
    `-p ${port}`,
    '-c fsync=off',
    '-c synchronous_commit=off',
    '-c full_page_writes=off',
    '-c max_connections=100',
  ].join(' ');
  pgRun(user, 'pg_ctl', [
    '-D',
    data,
    '-o',
    opts,
    '-l',
    join(dir, 'postgres.log'),
    '-w',
    '-t',
    '60',
    'start',
  ]);
  started = true;
  return `postgres://postgres@${encodeURIComponent(sock)}:${port}/postgres`;
}

function pgRun(user, cmd, args) {
  const [file, fargs] = user
    ? ['runuser', ['-u', user, '--', join(PG_BIN, cmd), ...args]]
    : [join(PG_BIN, cmd), args];
  execFileSync(file, fargs, { stdio: 'pipe', env: { ...process.env, LC_ALL: 'C' } });
}

async function dropDatabase(admin, db) {
  const p = new pg.Pool({ connectionString: admin, max: 1 });
  try {
    await p.query(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`);
  } finally {
    await p.end();
  }
}

const dbUrl = (admin, name) => admin.slice(0, admin.lastIndexOf('/') + 1) + name;

// ----------------------------------------------------------------------------------- the demo

async function demo() {
  for (const [k, p] of Object.entries(BUNDLES)) {
    if (!existsSync(p)) throw new Error(`${k} bundle missing (${p}); run \`npm run build\` first`);
  }
  const work = mkdtempSync(join(tmpdir(), 'aisdlc-demo-'));
  cleanups.push(() => rmSync(work, { recursive: true, force: true }));

  // A throwaway cluster, unless DATABASE_URL names a server (CI): then three uniquely named
  // databases are created on it and dropped afterwards.
  step(
    process.env.DATABASE_URL
      ? 'using the Postgres server in DATABASE_URL'
      : 'starting a throwaway Postgres cluster',
  );
  const admin = process.env.DATABASE_URL ?? (await startPostgres());
  const suffix = `${Date.now().toString(36)}_${randomBytes(3).toString('hex')}`;
  const urls = {};
  const adminPool = new pg.Pool({ connectionString: admin, max: 1 });
  try {
    for (const name of ['record', 'notary', 'witness']) {
      const db = `aisdlc_demo_${name}_${suffix}`;
      await adminPool.query(`CREATE DATABASE ${db}`);
      urls[name] = dbUrl(admin, db);
      if (process.env.DATABASE_URL) cleanups.push(() => dropDatabase(admin, db));
    }
  } finally {
    await adminPool.end();
  }
  console.log('   databases: record, notary, witness');
  // Database URLs may carry a password, so services get `env:NAME` references, not the URL.
  const dbRef = (name) => ({
    ref: `env:DEMO_DB_${name.toUpperCase()}`,
    env: { [`DEMO_DB_${name.toUpperCase()}`]: urls[name] },
  });

  // Service tokens live in 0600 files; configuration carries only `file:` references.
  const tokenRef = (name) => {
    const path = join(work, `${name}.token`);
    writeFileSync(path, `${randomBytes(24).toString('hex')}\n`, { mode: 0o600 });
    chmodSync(path, 0o600);
    return `file:${path}`;
  };
  const ref = Object.fromEntries(
    ['kms-notary', 'kms-witness', 'notary-core', 'notary-checkpointer', 'witness-checkpointer'].map(
      (n) => [n, tokenRef(n)],
    ),
  );
  const base = { FACTORY_ENV: 'local' };

  step('starting kms-local, notary and witness (separate processes)');
  const keyDir = join(work, 'keys');
  const kms = await startService('kms-local', BUNDLES.kms, {
    ...base,
    KMS_DIR: keyDir,
    KMS_PORT: '0',
    KMS_CALLERS: JSON.stringify({
      notary: { token_ref: ref['kms-notary'] },
      witness: { token_ref: ref['kms-witness'] },
    }),
  });
  console.log(`   kms-local  ${kms.url}`);
  const notary = await startService('notary', BUNDLES.notary, {
    ...base,
    NOTARY_PORT: '0',
    ...dbRef('notary').env,
    NOTARY_DATABASE_URL: dbRef('notary').ref,
    NOTARY_CALLERS: JSON.stringify({
      core: { token_ref: ref['notary-core'], scopes: ['ledger', 'read'] },
      checkpointer: { token_ref: ref['notary-checkpointer'], scopes: ['checkpoint', 'read'] },
    }),
    KMS_URL: kms.url,
    KMS_TOKEN_REF: ref['kms-notary'],
  });
  console.log(`   notary     ${notary.url}`);
  const witness = await startService('witness', BUNDLES.witness, {
    ...base,
    WITNESS_PORT: '0',
    ...dbRef('witness').env,
    WITNESS_DATABASE_URL: dbRef('witness').ref,
    WITNESS_CALLERS: JSON.stringify({ checkpointer: { token_ref: ref['witness-checkpointer'] } }),
    KMS_URL: kms.url,
    KMS_TOKEN_REF: ref['kms-witness'],
  });
  console.log(`   witness    ${witness.url}`);

  step('writing 10 ledger entries and running one checkpoint round');
  const w = runBundle(BUNDLES.writer, [], {
    ...base,
    ...dbRef('record').env,
    LEDGER_DB_URL: dbRef('record').ref,
    DEMO_ENTRIES: '10',
    NOTARY_URL: notary.url,
    NOTARY_CORE_TOKEN_REF: ref['notary-core'],
    NOTARY_CHECKPOINTER_TOKEN_REF: ref['notary-checkpointer'],
    WITNESS_URL: witness.url,
    WITNESS_CHECKPOINTER_TOKEN_REF: ref['witness-checkpointer'],
    KMS_URL: kms.url,
    KMS_TOKEN_REF: ref['kms-witness'],
  });
  if (w.code !== 0) throw new Error(`demo-writer failed (exit ${w.code})\n${w.out}${w.err}`);
  console.log(`   ${w.out.trim()}`);

  step('fetching the two public keys from kms-local');
  const keyFiles = {};
  for (const [who, id] of [
    ['notary', 'dev:notary'],
    ['witness', 'dev:witness'],
  ]) {
    const token = readFileSync(ref['kms-witness'].slice(5), 'utf8').trim();
    const res = await fetch(`${kms.url}/v1/keys/${encodeURIComponent(id)}/public`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`public key ${id}: HTTP ${res.status}`);
    const jwk = await res.json();
    keyFiles[who] = join(work, `${who}.jwk.json`);
    writeFileSync(keyFiles[who], JSON.stringify(jwk));
    console.log(`   ${id}: ${jwk.kty} ${jwk.crv} x=${String(jwk.x).slice(0, 12)}...`);
  }

  const verify = () =>
    runBundle(
      BUNDLES.verify,
      ['--notary-key', keyFiles.notary, '--witness-key', keyFiles.witness],
      {
        AISDLC_LEDGER_DB_URL: urls.record,
      },
    );

  step('verify-ledger on the untouched ledger (expect exit 0)');
  const good = verify();
  console.log(`   exit ${good.code}\n${indent(good.out)}${indent(good.err)}`);
  if (
    good.code !== 0 ||
    !/ledger OK: 10 entries/.test(good.out) ||
    !/checkpoints OK: 1,/.test(good.out)
  ) {
    throw new Error('verify-ledger did not pass on the good ledger');
  }

  step('tampering with entry 5 as superuser with triggers disabled');
  const su = new pg.Client({ connectionString: urls.record });
  await su.connect();
  try {
    await su.query('SET session_replication_role = replica');
    const u = await su.query(
      `UPDATE ledger.ledger_entry SET body = '{"n": 999}' WHERE ledger_seq = 5`,
    );
    if (u.rowCount !== 1) throw new Error('tamper changed no row');
  } finally {
    await su.end();
  }

  step('verify-ledger on the tampered ledger (expect exit 1)');
  const bad = verify();
  console.log(`   exit ${bad.code}\n${indent(bad.out)}${indent(bad.err)}`);
  if (bad.code !== 1 || !/verify-ledger FAILED \[entry_hash\]: entry 5/.test(bad.err)) {
    throw new Error('verify-ledger did not detect the tampered row');
  }

  step('stopping the services with SIGTERM');
  for (const svc of [witness, notary, kms]) await stopGracefully(svc);

  step(`demo OK: ledger verified, tamper detected (${((Date.now() - T0) / 1000).toFixed(1)}s)`);
}

const indent = (s) => (s.trim() === '' ? '' : `${s.trimEnd().replace(/^/gm, '   | ')}\n`);

let cleanedUp;
/** Runs every cleanup once, newest first; later calls wait for the same run. */
function cleanup() {
  cleanedUp ??= (async () => {
    for (const fn of cleanups.splice(0).reverse()) {
      try {
        await fn();
      } catch (e) {
        console.error(`cleanup: ${e instanceof Error ? e.message : e}`);
      }
    }
  })();
  return cleanedUp;
}

let interrupted = false;
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    interrupted = true;
    console.error(`\n${sig}: cleaning up`);
    void cleanup().then(() => process.exit(130));
  });
}

let code = 0;
try {
  await demo();
} catch (e) {
  // An interrupt kills the children, which makes `demo()` reject; that is not a demo failure.
  if (!interrupted) {
    console.error(`\ndemo FAILED: ${e instanceof Error ? e.message : e}`);
    code = 1;
  }
} finally {
  await cleanup();
}
process.exit(interrupted ? 130 : code);
