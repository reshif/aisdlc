---
name: react-best-practices
description: React performance guide for the AISDLC portal (React 19 + Vite SPA, TanStack Query) with rules for eliminating waterfalls, reducing bundle size and avoiding needless re-renders. Use when optimizing, reviewing or refactoring components in services/web.
license: MIT
metadata:
  version: 1.0.0
  author: Vercel Engineering
  tags: [React, Vite, Performance, Optimization, Best Practices, Bundle Size, Rendering]
  dependencies: []
---

> Vendored from davila7/claude-code-templates@82b59de, path
> `cli-tool/components/skills/web-development/react-best-practices/SKILL.md`, adapted for AISDLC on
> 2026-11-12; AGENTS.md wins on any conflict. See `.claude/THIRD_PARTY.md`.

# React Best Practices - Performance Optimization

Performance guide for React applications, organized by impact level, adapted to this repo's portal
(`services/web`): a client-rendered React 19.3 + Vite SPA, built to static files the bff serves under
a strict content security policy (`script-src 'self'`, `style-src 'self'`, no inline script or style),
with TanStack Query as its data layer. There is no Next.js, no server rendering and no React Server
Components here; those parts of the upstream guide are not vendored.

## Ground rules (AGENTS.md wins)

- Correctness and fail-closed behaviour come before speed. Never trade a refetch for stale data on
  something a person decides, and never show a state the server has not confirmed.
- No new dependency (icon library, cache library, data-fetching library, analytics) without an exact
  pinned version and review. No telemetry or third-party scripts in the portal.
- TypeScript strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); no `any`.
- Run `npm run check` before committing; measure with `npm run build -w @aisdlc/web`.

## When to use this skill

- Optimizing portal performance or reviewing a change for it
- Refactoring components with performance in mind
- Debugging slow rendering or loading
- Reducing bundle size
- Removing request waterfalls (in the browser or in a bff handler)

**Key areas covered:**

- **Eliminating Waterfalls** (CRITICAL): prevent sequential async operations
- **Bundle Size Optimization** (CRITICAL): reduce the initial JavaScript payload
- **Client-Side Data Fetching** (MEDIUM-HIGH): deduplicate with TanStack Query
- **Re-render Optimization** (MEDIUM): minimize unnecessary re-renders
- **Rendering Performance** (MEDIUM): optimize browser rendering
- **JavaScript Performance** (LOW-MEDIUM): micro-optimizations for hot paths
- **Advanced Patterns** (LOW): specialized techniques for edge cases

## Quick reference

### Critical priorities

1. **Defer await until needed** - move awaits into the branches that use them
2. **Use Promise.all()** - parallelize independent async operations
3. **Avoid costly barrel imports** - import large libraries from their per-module entry points
4. **Lazy-load heavy components** - `React.lazy` + `Suspense`
5. **Strategic loading boundaries** - let sections load independently

### Common patterns

**Parallel data fetching:**

```typescript
const [user, posts, comments] = await Promise.all([fetchUser(), fetchPosts(), fetchComments()]);
```

**Lazy components:**

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

## Using the guidelines

- `references/rules/*.md`: one file per rule (the single source), grouped by the prefixes in
  `references/rules/_sections.md`; `_template.md` is the shape of a new rule.
- `references/react-performance-guidelines.md`: all rules in one document, compiled from the rule files.

Each rule has incorrect/correct code, its impact, and when to apply it.

## Categories overview

### 1. Eliminating Waterfalls (CRITICAL)

- Defer await until needed
- Dependency-based parallelization (plain promises)
- Prevent waterfall chains in service handlers (bff and core: authorisation first)
- Promise.all() for independent operations
- Strategic loading boundaries

### 2. Bundle Size Optimization (CRITICAL)

- Avoid costly barrel file imports
- Conditional module loading
- Lazy-load heavy components
- Preload based on user intent

### 3. Client-Side Data Fetching (MEDIUM-HIGH)

- Deduplicate global event listeners
- Use TanStack Query for automatic deduplication (see the tanstack-query-expert skill)

### 4. Re-render Optimization (MEDIUM)

- Defer state reads to usage point
- Extract to memoized components
- Narrow effect dependencies
- Subscribe to derived state
- Use lazy state initialization
- Use transitions for non-urgent updates

### 5. Rendering Performance (MEDIUM)

- Animate SVG wrapper instead of SVG element
- CSS content-visibility for long lists
- Hoist static JSX elements
- Optimize SVG precision
- Use Activity component for show/hide
- Use explicit conditional rendering

### 6. JavaScript Performance (LOW-MEDIUM)

- Batch DOM CSS changes
- Build index maps for repeated lookups
- Cache property access in loops
- Cache repeated function calls
- Cache storage API calls
- Combine multiple array iterations
- Early length check for array comparisons
- Early return from functions
- Hoist RegExp creation
- Use loop for min/max instead of sort
- Use Set/Map for O(1) lookups
- Use toSorted() instead of sort()

### 7. Advanced Patterns (LOW)

- Store event handlers in refs
- useLatest for stable callback refs

## Implementation approach

1. **Profile first**: React DevTools Profiler and the browser's performance panel
2. **Focus on critical paths**: waterfalls and bundle size first
3. **Measure impact**: compare the build output and the metrics below before and after
4. **Apply incrementally**: don't optimize prematurely
5. **Test thoroughly**: the web tests (`npx vitest run --project web`) and `npm run e2e:compose` for
   the end-to-end flow

## Key metrics to track

- **Largest Contentful Paint (LCP)**: when main content is visible
- **Interaction to Next Paint (INP)**: responsiveness to interactions
- **Cumulative Layout Shift (CLS)**: visual stability
- **Bundle size**: initial JavaScript payload (Vite's build report)
- **Request count and order**: the network panel; look for waterfalls

## Common pitfalls to avoid

Don't:

- Import large libraries through their barrel entry
- Block parallel operations with sequential awaits
- Re-render entire trees when only part needs updating
- Load anything from another origin (the CSP forbids it, and the portal has no telemetry)
- Mutate arrays with `.sort()` instead of `.toSorted()`
- Create RegExp or heavy objects inside render

Do:

- Use `Promise.all()` for independent operations
- Memoize expensive components after profiling
- Lazy-load non-critical code
- Use immutable array methods
- Hoist static objects outside components

## Resources

- [React Documentation](https://react.dev)
- [TanStack Query v5](https://tanstack.com/query/v5)
- [Vite](https://vite.dev)
- [Vercel: package import cost](https://vercel.com/blog/how-we-optimized-package-imports-in-next-js)
- [Vercel: dashboard performance](https://vercel.com/blog/how-we-made-the-vercel-dashboard-twice-as-fast)

## Version history

**v0.1.0** (January 2026)

- Initial release from Vercel Engineering
- Vendored and adapted for AISDLC on 2026-11-12 (see `.claude/THIRD_PARTY.md`)
