import { execFileSync, spawnSync } from 'node:child_process';
import { chownSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const DEFAULT_BIN = '/usr/lib/postgresql/16/bin';

export interface TestCluster {
  /** Admin connection URL (superuser, database `postgres`). */
  url: string;
  stop(): Promise<void>;
}

function pgBin(): string {
  const dir = process.env['PG_BIN'] ?? DEFAULT_BIN;
  if (!existsSync(join(dir, 'initdb'))) {
    throw new Error(`initdb not found in ${dir}; set PG_BIN or DATABASE_URL`);
  }
  return dir;
}

/** Postgres refuses to run as root, so drop to `postgres` (or `nobody`) when we are root. */
function runAs(): string | undefined {
  if (typeof process.getuid !== 'function' || process.getuid() !== 0) return undefined;
  for (const user of ['postgres', 'nobody']) {
    if (spawnSync('id', ['-u', user]).status === 0) return user;
  }
  throw new Error('running as root and no unprivileged user (postgres, nobody) exists');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a throwaway cluster: initdb into a temp dir, unix socket only (no TCP), random port
 * number (it names the socket file), fsync off. `stop()` kills it and removes the directory.
 */
export async function startTestCluster(): Promise<TestCluster> {
  const bin = pgBin();
  const user = runAs();
  const root = mkdtempSync(join(tmpdir(), 'aisdlc-pg-'));
  const data = join(root, 'data');
  const sock = join(root, 'sock');
  const log = join(root, 'postgres.log');
  if (user) {
    const uid = Number(execFileSync('id', ['-u', user]).toString().trim());
    const gid = Number(execFileSync('id', ['-g', user]).toString().trim());
    chownSync(root, uid, gid);
  }
  const run = (cmd: string, args: string[]): void => {
    const [file, fileArgs] = user
      ? ['runuser', ['-u', user, '--', join(bin, cmd), ...args]]
      : [join(bin, cmd), args];
    execFileSync(file as string, fileArgs as string[], {
      stdio: 'pipe',
      env: { ...process.env, LC_ALL: 'C' },
    });
  };

  let started = false;
  const stop = async (): Promise<void> => {
    try {
      if (started) {
        started = false;
        run('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop']);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  };

  try {
    run('initdb', [
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
    execFileSync('mkdir', ['-p', sock]);
    if (user) execFileSync('chown', [user, sock]);
    const port = await freePort();
    const opts = [
      `-c listen_addresses=`,
      `-c unix_socket_directories=${sock}`,
      `-p ${port}`,
      '-c fsync=off',
      '-c synchronous_commit=off',
      '-c full_page_writes=off',
      '-c max_connections=200',
    ].join(' ');
    run('pg_ctl', ['-D', data, '-o', opts, '-l', log, '-w', '-t', '60', 'start']);
    started = true;
    return {
      url: `postgres://postgres@${encodeURIComponent(sock)}:${port}/postgres`,
      stop,
    };
  } catch (e) {
    await stop().catch(() => undefined);
    throw e;
  }
}
