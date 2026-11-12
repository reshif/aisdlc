---
title: Avoid Costly Barrel File Imports
impact: CRITICAL
impactDescription: 200-800ms import cost, slow builds
tags: bundle, imports, tree-shaking, barrel-files, performance
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/bundle-barrel-imports.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Avoid Costly Barrel File Imports

**Barrel files** are entry points that re-export many modules (an `index.js` that does
`export * from './module'`). Large icon and component libraries can have thousands of re-exports;
importing one name can cost hundreds of milliseconds in development and slow builds.

In this repo:

- The portal has no icon or component library today. Adding one is a new dependency: exact pin and
  review first, and then import from its per-module entry points where it offers them.
- The workspace packages export TypeScript source through `src/index.ts` (AGENTS.md). Keep importing
  them by package name (`import { TierValues } from '@aisdlc/contracts'`); do not deep-import
  another package's internal files. `@aisdlc/contracts` is `"sideEffects": false`, so Vite drops what
  the portal does not use. Import types with `import type` (lint enforces it).
- Inside `services/web`, import components from their own files (as the code already does), not
  through a local `index.ts` that re-exports a folder.

**Incorrect (a hypothetical icon library through its barrel):**

```tsx
import { Check, X, Menu } from 'some-icon-library';
// loads every icon module the library re-exports
```

**Correct (only what you need, when the library supports it):**

```tsx
import Check from 'some-icon-library/icons/check';
import X from 'some-icon-library/icons/x';
```

Check the size effect with `npm run build -w @aisdlc/web` before and after.

Reference: [How we optimized package imports in Next.js](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
(background on the cost; its Next.js config option does not apply here)
