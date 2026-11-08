import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'migrate',
    include: ['test/**/*.test.ts'],
    globalSetup: ['../db/src/global-setup.ts', './test/global-setup-bundle.ts'],
    testTimeout: 60_000,
    hookTimeout: 180_000,
  },
});
