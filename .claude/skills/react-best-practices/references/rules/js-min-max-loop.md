---
title: Use Loop for Min/Max Instead of Sort
impact: LOW
impactDescription: O(n) instead of O(n log n)
tags: javascript, arrays, performance, sorting, algorithms
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-min-max-loop.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Use Loop for Min/Max Instead of Sort

Finding the smallest or largest element only requires a single pass through the array. Sorting is
wasteful and slower.

**Incorrect (O(n log n) - sort to find latest):**

```typescript
interface Project {
  id: string;
  name: string;
  updatedAt: number;
}

function getLatestProject(projects: readonly Project[]) {
  const sorted = projects.toSorted((a, b) => b.updatedAt - a.updatedAt);
  return sorted[0];
}
```

Sorts the entire array just to find the maximum value.

**Correct (O(n) - single loop, strict-safe):**

With `noUncheckedIndexedAccess`, `projects[0]` is `Project | undefined`; iterate with `for...of`
instead of indexing, and return `null` for an empty array.

```typescript
function getLatestProject(projects: readonly Project[]): Project | null {
  let latest: Project | null = null;
  for (const p of projects) {
    if (latest === null || p.updatedAt > latest.updatedAt) latest = p;
  }
  return latest;
}

function getOldestAndNewest(projects: readonly Project[]): {
  oldest: Project | null;
  newest: Project | null;
} {
  let oldest: Project | null = null;
  let newest: Project | null = null;
  for (const p of projects) {
    if (oldest === null || p.updatedAt < oldest.updatedAt) oldest = p;
    if (newest === null || p.updatedAt > newest.updatedAt) newest = p;
  }
  return { oldest, newest };
}
```

Single pass through the array, no copying, no sorting.

**Alternative (Math.min/Math.max for small arrays):**

```typescript
const numbers = [5, 2, 8, 1, 9];
const min = Math.min(...numbers);
const max = Math.max(...numbers);
```

This works for small arrays but can fail for very large ones (argument count limits); use the loop
for reliability. Note `Math.min()` of an empty array is `Infinity`.
