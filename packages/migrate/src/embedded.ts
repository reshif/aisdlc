import type { MigrationSets } from './plan.js';

/**
 * `null` when running from source (tests, `tsx`): the migrations are then read from the directories
 * `plan.json` names. In the bundle (`npm run build -w @aisdlc/migrate`) scripts/bundle.mjs replaces
 * this whole module by one that holds the SQL text of every one of those directories, so the
 * deployed `dist/aisdlc-migrate.js` needs no other file.
 */
export const embedded: MigrationSets | null = null;
