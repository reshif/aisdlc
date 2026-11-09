import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { name: 'tripwires', include: ['test/**/*.test.ts'], testTimeout: 60_000 },
});
