import { availableParallelism } from 'node:os';
import { defineConfig } from 'vitest/config';

// Most test time is a test waiting on Postgres or on a child process (a third to a half of a core
// test file's wall time is idle), so more workers than CPUs keeps the CPUs busy: on 4 CPUs, 6 workers
// ran the core project about 20% faster than Vitest's default (CPUs - 1). Every test database is
// unique (`createTestDatabase`), so files never share one. The Docker projects (sandbox-driver,
// coding-runner) keep `fileParallelism: false` in their own configs: one file at a time there.
// `--maxWorkers` on the command line still wins.
const workers = Math.max(1, Math.ceil(availableParallelism() * 1.5));

export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*'],
    maxWorkers: workers,
  },
});
