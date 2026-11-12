import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'verify', include: ['test/**/*.test.ts'], testTimeout: 60_000 },
});
