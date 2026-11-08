import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');

/**
 * Vitest globalSetup: builds the bundles the process-level tests spawn (the three services, the
 * verify-ledger CLI, the demo writer), so `npm test` works from a clean clone with no prior
 * `npm run build`. It always rebuilds, so a test never runs against a stale bundle. Only this
 * project builds them, so nothing races on `dist/`.
 */
export default function setup(): void {
  const bundle = join(root, 'scripts', 'bundle.mjs');
  const targets: Array<[string, string[]]> = [
    ['services/kms-local', ['main']],
    ['services/notary', ['main']],
    ['services/witness', ['main']],
    ['packages/ledger', ['verify-ledger', 'demo-writer']],
  ];
  for (const [dir, entries] of targets) {
    execFileSync(process.execPath, [bundle, ...entries], { cwd: join(root, dir), stdio: 'pipe' });
  }
}
