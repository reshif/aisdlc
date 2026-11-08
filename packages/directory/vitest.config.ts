import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'directory',
    include: ['test/**/*.test.ts'],
    globalSetup: ['../db/src/global-setup.ts'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
