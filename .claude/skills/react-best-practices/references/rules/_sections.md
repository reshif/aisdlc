> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/_sections.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

# Sections

This file defines all sections, their ordering, impact levels, and descriptions.
The section ID (in parentheses) is the filename prefix used to group rules.

The upstream section "Server-Side Performance (server)" is not vendored: its four rules are about
React Server Components and Next.js request caching, which this repo does not use (the portal is a
client-rendered React + Vite SPA served by the bff).

---

## 1. Eliminating Waterfalls (async)

**Impact:** CRITICAL
**Description:** Waterfalls are the #1 performance killer. Each sequential await adds full network latency. Eliminating them yields the largest gains.

## 2. Bundle Size Optimization (bundle)

**Impact:** CRITICAL
**Description:** Reducing initial bundle size improves Time to Interactive and Largest Contentful Paint.

## 3. Client-Side Data Fetching (client)

**Impact:** MEDIUM-HIGH
**Description:** Automatic deduplication and efficient data fetching patterns reduce redundant network requests.

## 4. Re-render Optimization (rerender)

**Impact:** MEDIUM
**Description:** Reducing unnecessary re-renders minimizes wasted computation and improves UI responsiveness.

## 5. Rendering Performance (rendering)

**Impact:** MEDIUM
**Description:** Optimizing the rendering process reduces the work the browser needs to do.

## 6. JavaScript Performance (js)

**Impact:** LOW-MEDIUM
**Description:** Micro-optimizations for hot paths can add up to meaningful improvements.

## 7. Advanced Patterns (advanced)

**Impact:** LOW
**Description:** Advanced patterns for specific cases that require careful implementation.
