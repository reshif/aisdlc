// Test-only: lets plain `node` run the TypeScript sources (NodeNext `.js` specifiers, workspace
// packages that export `src/index.ts`) so a test can spawn the real CLI process.
import { register } from 'node:module';

register('./ts-resolve.mjs', import.meta.url);
