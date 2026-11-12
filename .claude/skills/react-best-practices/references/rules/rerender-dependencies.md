---
title: Narrow Effect Dependencies
impact: MEDIUM
impactDescription: minimizes effect re-runs
tags: rerender, useEffect, dependencies, optimization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rerender-dependencies.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Narrow Effect Dependencies

Specify primitive dependencies instead of objects to minimize effect re-runs.

**Incorrect (re-runs on any user field change):**

```tsx
useEffect(() => {
  console.log(user.id);
}, [user]);
```

**Correct (re-runs only when id changes):**

```tsx
useEffect(() => {
  console.log(user.id);
}, [user.id]);
```

**For derived state, compute outside effect:**

```tsx
// Incorrect: runs on width=767, 766, 765...
useEffect(() => {
  if (width < 768) {
    enableMobileMode();
  }
}, [width]);

// Correct: runs only on boolean transition
const isMobile = width < 768;
useEffect(() => {
  if (isMobile) {
    enableMobileMode();
  }
}, [isMobile]);
```
