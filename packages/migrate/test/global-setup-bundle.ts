import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');
const scratch = join(import.meta.dirname, '..', '.tmp');

/**
 * Vitest globalSetup: builds what the process-level test runs, so `npm test` works from a clean
 * clone with no prior `npm run build`.
 *   - the aisdlc-migrate bundle, into `.tmp/migrate/` (not `dist/`: nothing else is next to it);
 *   - the identity, bff and codehost bundles, each into `.tmp/<service>/dist` with its own
 *     `migrations/` beside it (the layout a deployment has), into a private directory so that this
 *     build never races those services' own test builds of their `dist/`.
 */
export default function setup(): void {
  rmSync(scratch, { recursive: true, force: true });
  mkdirSync(scratch, { recursive: true });
  const bundle = (cwd: string, ...args: string[]) =>
    execFileSync(process.execPath, [join(root, 'scripts', 'bundle.mjs'), ...args], {
      cwd,
      stdio: 'pipe',
    });
  bundle(
    join(root, 'packages', 'migrate'),
    `--outdir=${join(scratch, 'migrate')}`,
    '--embed-migrations=plan.json',
    'aisdlc-migrate',
  );
  for (const svc of ['identity', 'bff', 'codehost']) {
    bundle(join(root, 'services', svc), `--outdir=${join(scratch, svc, 'dist')}`, 'main');
    // codehost has no database, so no migrations of its own.
    if (existsSync(join(root, 'services', svc, 'migrations'))) {
      cpSync(join(root, 'services', svc, 'migrations'), join(scratch, svc, 'migrations'), {
        recursive: true,
        force: true,
      });
    }
  }
}
