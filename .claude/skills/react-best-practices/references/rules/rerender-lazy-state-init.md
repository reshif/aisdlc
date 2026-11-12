---
title: Use Lazy State Initialization
impact: MEDIUM
impactDescription: wasted computation on every render
tags: react, hooks, useState, performance, initialization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rerender-lazy-state-init.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Use Lazy State Initialization

Pass a function to `useState` for expensive initial values. Without the function form, the
initializer runs on every render even though the value is only used once.

**Incorrect (runs on every render):**

```tsx
function FilteredList({ items }: { items: readonly Item[] }) {
  // buildSearchIndex() runs on EVERY render, even after initialization
  const [searchIndex] = useState(buildSearchIndex(items));
  const [query, setQuery] = useState('');

  return <SearchResults index={searchIndex} query={query} onQuery={setQuery} />;
}
```

**Correct (runs only once):**

```tsx
function FilteredList({ items }: { items: readonly Item[] }) {
  // buildSearchIndex() runs ONLY on initial render
  const [searchIndex] = useState(() => buildSearchIndex(items));
  const [query, setQuery] = useState('');

  return <SearchResults index={searchIndex} query={query} onQuery={setQuery} />;
}
```

**Reading stored preferences:** parse to `unknown` and validate; never trust the stored shape, and
never keep a credential, token or session data in web storage (the session is an HttpOnly cookie).

```tsx
type Prefs = { readonly compact: boolean };
const DEFAULT_PREFS: Prefs = { compact: false };

function readPrefs(): Prefs {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem('prefs') ?? 'null');
    return typeof raw === 'object' &&
      raw !== null &&
      'compact' in raw &&
      typeof raw.compact === 'boolean'
      ? { compact: raw.compact }
      : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

function PrefsPanel() {
  const [prefs, setPrefs] = useState(readPrefs); // the function itself, called once
  return <PrefsForm prefs={prefs} onChange={setPrefs} />;
}
```

Use lazy initialization when computing initial values from storage, building data structures
(indexes, maps), reading from the DOM, or performing heavy transformations.

For simple primitives (`useState(0)`), direct references (`useState(props.value)`), or cheap
literals (`useState({})`), the function form is unnecessary.
