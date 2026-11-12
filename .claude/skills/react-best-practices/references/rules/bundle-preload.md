---
title: Preload Based on User Intent
impact: CRITICAL
impactDescription: reduces perceived latency
tags: bundle, preload, user-intent, hover
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/bundle-preload.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Preload Based on User Intent

Preload heavy chunks before they're needed to reduce perceived latency.

**Example (preload on hover/focus):**

```tsx
const loadViewer = () => import('./diff-viewer');

function ViewerButton({ onClick }: { onClick: () => void }) {
  const preload = () => {
    void loadViewer();
  };

  return (
    <button type="button" onMouseEnter={preload} onFocus={preload} onClick={onClick}>
      Open the diff
    </button>
  );
}
```

Build the lazy component from the same function
(`lazy(() => loadViewer().then((m) => ({ default: m.DiffViewer })))`) so the preload and the render
share one module request. Preload on `onFocus` as well as hover, so keyboard users get the same benefit.
