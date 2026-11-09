import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'killswitch',
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../packages/db/src/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
