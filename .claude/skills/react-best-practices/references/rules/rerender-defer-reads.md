---
title: Defer State Reads to Usage Point
impact: MEDIUM
impactDescription: avoids unnecessary subscriptions
tags: rerender, url, storage, optimization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rerender-defer-reads.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Defer State Reads to Usage Point

Don't subscribe to dynamic state (the URL, storage) if you only read it inside callbacks.

**Incorrect (re-renders on every URL change, reads the value only on click):**

```tsx
function CopyLinkButton({ cardId }: { cardId: string }) {
  const search = useLocationSearch(); // a hook that re-renders on every URL change

  const handleCopy = () => {
    const ref = new URLSearchParams(search).get('ref');
    void copyCardLink(cardId, { ref });
  };

  return (
    <button type="button" onClick={handleCopy}>
      Copy link
    </button>
  );
}
```

**Correct (reads on demand, no subscription):**

```tsx
function CopyLinkButton({ cardId }: { cardId: string }) {
  const handleCopy = () => {
    const ref = new URLSearchParams(window.location.search).get('ref');
    void copyCardLink(cardId, { ref });
  };

  return (
    <button type="button" onClick={handleCopy}>
      Copy link
    </button>
  );
}
```

URL values are untrusted input: validate them before use.
