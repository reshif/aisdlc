---
title: Hoist Static JSX Elements
impact: MEDIUM
impactDescription: avoids re-creation
tags: rendering, jsx, static, optimization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rendering-hoist-jsx.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Hoist Static JSX Elements

Extract static JSX outside components to avoid re-creation.

**Incorrect (recreates element every render):**

```tsx
function LoadingSkeleton() {
  return <div className="animate-pulse h-20 bg-gray-200" />;
}

function Container() {
  return <div>{loading && <LoadingSkeleton />}</div>;
}
```

**Correct (reuses same element):**

```tsx
const loadingSkeleton = <div className="animate-pulse h-20 bg-gray-200" />;

function Container() {
  return <div>{loading && loadingSkeleton}</div>;
}
```

This is especially helpful for large and static SVG nodes, which can be expensive to recreate on every render.
