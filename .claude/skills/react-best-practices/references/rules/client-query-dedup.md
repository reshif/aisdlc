---
title: Use TanStack Query for Automatic Deduplication
impact: MEDIUM-HIGH
impactDescription: automatic deduplication
tags: client, tanstack-query, deduplication, data-fetching
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/client-swr-dedup.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Use TanStack Query for Automatic Deduplication

The portal's data layer is TanStack Query (`@tanstack/react-query`, pinned). It deduplicates the
same query across component instances, caches it and revalidates it. Do not add a second fetching
library.

**Incorrect (no deduplication, each instance fetches, no error state):**

```tsx
function InboxCount() {
  const [inbox, setInbox] = useState<PortalInbox | null>(null);
  useEffect(() => {
    void api.inbox().then(setInbox);
  }, []);
  // ...
}
```

**Correct (every instance shares one request and one cache entry):**

```tsx
function InboxCount() {
  const inbox = useQuery({ queryKey: ['inbox'], queryFn: api.inbox });
  // render inbox.isPending / inbox.isError / inbox.data
}
```

**For mutations:** `useMutation`, then invalidate the keys the write changed. See the
tanstack-query-expert skill for the repo's patterns (no optimistic updates for decisions).
