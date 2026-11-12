---
title: Deduplicate Global Event Listeners
impact: MEDIUM-HIGH
impactDescription: single listener for N components
tags: client, event-listeners, subscription, useSyncExternalStore
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/client-event-listeners.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Deduplicate Global Event Listeners

When many component instances need the same global event, register one listener at module level and
fan out to subscribers, instead of one listener per instance. No library is needed.

**Incorrect (N instances = N listeners):**

```tsx
function useKeyboardShortcut(key: string, callback: () => void) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.metaKey && e.key === key) callback();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [key, callback]);
}
```

**Correct (N instances = 1 listener):**

```tsx
// Module-level registry: one window listener while at least one callback is registered
const keyCallbacks = new Map<string, Set<() => void>>();

const onKeyDown = (e: KeyboardEvent) => {
  if (!e.metaKey) return;
  keyCallbacks.get(e.key)?.forEach((cb) => cb());
};

function register(key: string, cb: () => void): () => void {
  if (keyCallbacks.size === 0) window.addEventListener('keydown', onKeyDown);
  const set = keyCallbacks.get(key) ?? new Set<() => void>();
  set.add(cb);
  keyCallbacks.set(key, set);
  return () => {
    set.delete(cb);
    if (set.size === 0) keyCallbacks.delete(key);
    if (keyCallbacks.size === 0) window.removeEventListener('keydown', onKeyDown);
  };
}

function useKeyboardShortcut(key: string, callback: () => void) {
  useEffect(() => register(key, callback), [key, callback]);
}
```

For a global value that components read (online status, a media query), `useSyncExternalStore`
with a module-level `subscribe` gives the same one-listener behaviour and tear-free reads.

Keyboard shortcuts must not override the browser's or assistive technology's keys, and every
shortcut action must also be reachable through a visible control (see the accessibility-auditor skill).
