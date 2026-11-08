import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');

/**
 * Vitest globalSetup: builds the core-worker bundle (`dist/main.js`) the process-level test spawns, so
 * `npm test` works from a clean clone with no prior `npm run build`. It always rebuilds, so the
 * test never runs a stale bundle.
 */
export default function setup(): void {
  execFileSync(process.execPath, [join(root, 'scripts', 'bundle.mjs'), 'main'], {
    cwd: join(root, 'services', 'core-worker'),
    stdio: 'pipe',
  });
}
