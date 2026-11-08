import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..', '..', '..');

/**
 * Vitest globalSetup: builds the bff bundle (`dist/main.js`) the process-level test spawns, so
 * `npm test` works from a clean clone with no prior `npm run build`. It always rebuilds, so the
 * test never runs a stale bundle.
 */
export default function setup(): void {
  execFileSync(process.execPath, [join(root, 'scripts', 'bundle.mjs'), 'main', 'dev-oidc'], {
    cwd: join(root, 'services', 'bff'),
    stdio: 'pipe',
  });
}
