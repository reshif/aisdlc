import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'knowledge',
    include: ['test/**/*.test.ts'],
    globalSetup: ['../../packages/db/src/global-setup.ts', './test/global-setup-bundle.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
