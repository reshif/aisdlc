---
title: Lazy-Load Heavy Components
impact: CRITICAL
impactDescription: directly affects TTI and LCP
tags: bundle, dynamic-import, code-splitting, react-lazy
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/bundle-dynamic-imports.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Lazy-Load Heavy Components

Use `React.lazy` with `Suspense` to load large components that are not needed on first render
(for example a page only some roles open, or a large viewer).

**Incorrect (the viewer bundles with the main chunk):**

```tsx
import { DiffViewer } from './diff-viewer';

function ArtefactPanel({ text }: { text: string }) {
  return <DiffViewer value={text} />;
}
```

**Correct (the viewer loads on demand):**

```tsx
import { lazy, Suspense } from 'react';

const DiffViewer = lazy(() => import('./diff-viewer').then((m) => ({ default: m.DiffViewer })));

function ArtefactPanel({ text }: { text: string }) {
  return (
    <Suspense fallback={<Loading />}>
      <DiffViewer value={text} />
    </Suspense>
  );
}
```

Give the boundary an error state too (an error boundary around it), so a chunk that fails to load
shows an error and never an empty panel.
