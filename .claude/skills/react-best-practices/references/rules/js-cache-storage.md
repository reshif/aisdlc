---
title: Cache Storage API Calls
impact: LOW-MEDIUM
impactDescription: reduces expensive I/O
tags: javascript, localStorage, storage, caching, performance
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-cache-storage.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Cache Storage API Calls

`localStorage` and `sessionStorage` are synchronous. When a hot path reads the same key repeatedly,
cache reads in memory.

**Incorrect (reads storage on every call):**

```typescript
function getDensity() {
  return localStorage.getItem('density') ?? 'comfortable';
}
// Called 10 times = 10 storage reads
```

**Correct (Map cache):**

```typescript
const storageCache = new Map<string, string | null>();

function getLocalStorage(key: string): string | null {
  if (!storageCache.has(key)) storageCache.set(key, localStorage.getItem(key));
  return storageCache.get(key) ?? null;
}

function setLocalStorage(key: string, value: string) {
  localStorage.setItem(key, value);
  storageCache.set(key, value); // keep cache in sync
}
```

Use a Map (not a hook) so it works everywhere: utilities, event handlers, not just components.

**Important:** if storage can change externally (another tab), invalidate the cache:

```typescript
window.addEventListener('storage', (e) => {
  if (e.key) storageCache.delete(e.key);
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') storageCache.clear();
});
```

In this repo web storage holds per-browser conveniences only (a layout preference). Never store a
credential, token, CSRF value, session data or anything the server decides; the session is an
HttpOnly cookie that script cannot and must not read.
