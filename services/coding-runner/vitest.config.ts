import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'coding-runner',
    include: ['test/**/*.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 240_000,
    // the Docker tests share one daemon, one image and the leftovers assertions: one file at a time
    fileParallelism: false,
  },
});
