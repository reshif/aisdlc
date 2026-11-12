---
title: Hoist RegExp Creation
impact: LOW-MEDIUM
impactDescription: avoids recreation
tags: javascript, regexp, optimization, memoization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-hoist-regexp.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Hoist RegExp Creation

Don't create a RegExp inside render. Hoist a constant pattern to module scope, or memoize one built
from input with `useMemo()`.

**Incorrect (new RegExp every render, and the query is used unescaped):**

```tsx
function Highlighter({ text, query }: { text: string; query: string }) {
  const regex = new RegExp(`(${query})`, 'gi');
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} text={part} />
      ))}
    </>
  );
}
```

**Correct (hoist constants, memoize and escape input-built patterns):**

```tsx
const SHA256_HEX = /^[0-9a-f]{64}$/;

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function Highlighter({ text, query }: { text: string; query: string }) {
  const regex = useMemo(() => new RegExp(`(${escapeRegExp(query)})`, 'gi'), [query]);
  const parts = text.split(regex);
  return (
    <>
      {parts.map((part, i) => (
        <Part key={i} text={part} />
      ))}
    </>
  );
}
```

Escaping matters beyond speed: an unescaped query is an injected pattern (and can be a slow one).

**Warning:** a global regex (`/g`) has mutable `lastIndex` state:

```typescript
const regex = /foo/g;
regex.test('foo'); // true, lastIndex = 3
regex.test('foo'); // false, lastIndex = 0
```
