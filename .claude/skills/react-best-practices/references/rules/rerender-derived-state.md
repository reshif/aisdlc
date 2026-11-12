---
title: Subscribe to Derived State
impact: MEDIUM
impactDescription: reduces re-render frequency
tags: rerender, derived-state, media-query, optimization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rerender-derived-state.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Subscribe to Derived State

Subscribe to derived boolean state instead of continuous values to reduce re-render frequency.
(`useWindowWidth` and `useMediaQuery` below are illustrations, not hooks the portal has.)

**Incorrect (re-renders on every pixel change):**

```tsx
function Sidebar() {
  const width = useWindowWidth(); // updates continuously
  const isMobile = width < 768;
  return <nav className={isMobile ? 'mobile' : 'desktop'} />;
}
```

**Correct (re-renders only when the boolean changes):**

```tsx
function Sidebar() {
  const isMobile = useMediaQuery('(max-width: 767px)'); // matchMedia + useSyncExternalStore
  return <nav className={isMobile ? 'mobile' : 'desktop'} />;
}
```

Often plain CSS media queries in `styles.css` remove the need for either hook.
