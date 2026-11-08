import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { name: 'kernel', include: ['test/**/*.test.ts'] } });
