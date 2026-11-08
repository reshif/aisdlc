import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'bff',
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../packages/db/src/global-setup.ts', './test/global-setup-bundle.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
