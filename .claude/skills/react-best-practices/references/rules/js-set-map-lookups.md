---
title: Use Set/Map for O(1) Lookups
impact: LOW-MEDIUM
impactDescription: O(n) to O(1)
tags: javascript, set, map, data-structures, performance
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-set-map-lookups.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Use Set/Map for O(1) Lookups

Convert arrays to Set/Map for repeated membership checks.

**Incorrect (O(n) per check):**

```typescript
const allowedIds: readonly string[] = loadAllowedIds();
const visible = items.filter((item) => allowedIds.includes(item.id));
```

**Correct (O(1) per check):**

```typescript
const allowedIds: ReadonlySet<string> = new Set(loadAllowedIds());
const visible = items.filter((item) => allowedIds.has(item.id));
```

This is a speed rule only: in the portal, what a person may see or do is decided by the server (the
PDP), never by a client-side allow list.
