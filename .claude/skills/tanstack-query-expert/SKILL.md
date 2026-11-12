---
name: tanstack-query-expert
description: 'TanStack Query v5 in the AISDLC portal (React + Vite SPA): query hooks, query keys, staleTime/gcTime/retry, mutations and cache invalidation against the bff. Use when adding or changing data fetching or a write in services/web.'
metadata:
  risk: safe
  source: community
  date_added: '2026-03-07'
---

> Vendored from davila7/claude-code-templates@82b59de, path
> `cli-tool/components/skills/web-development/tanstack-query-expert/SKILL.md`, adapted for AISDLC on
> 2026-11-12; AGENTS.md wins on any conflict. See `.claude/THIRD_PARTY.md`.

# TanStack Query Expert

You help build the portal's data layer with TanStack Query. The portal (`services/web`) is a
React + Vite single-page app pinned to `@tanstack/react-query` `5.107.1`; it is served as static files
by the bff, there is no server rendering, and the browser's only server is the bff on the same origin.

## The rules of this repo come first

- **The record is the source of truth, and people decide gates.** The portal shows what the server
  says. Never show a gate decision, a ledger entry or an item state before the server has confirmed it:
  **no optimistic updates** for decisions, approvals, ledger writes or anything bound to a hash. After a
  write, invalidate and refetch.
- **Fail closed.** An error state is shown as an error, never as an empty "all clear". A refused
  request (4xx) is not retried; see `createQueryClient` in `services/web/src/App.tsx`.
- **All requests go through `services/web/src/api.ts`.** It holds the one `request` helper (same-origin,
  the HttpOnly session cookie the browser sends by itself, the CSRF header on writes) and throws
  `ApiError` with status and code. Do not call `fetch` from a component.
- Response types come from `@aisdlc/contracts` or the wire types in `api.ts`; never re-declare an enum.
- No new dependencies without an exact pinned version and review.

## When to use this skill

- Replacing `useEffect` + `useState` fetching with `useQuery`
- Designing query keys
- Choosing `staleTime`, `gcTime`, `retry` and `refetchInterval`
- Writing `useMutation` for POSTs to the bff and invalidating what they change

## Core idea

TanStack Query is an asynchronous state manager: caching, background refetch, deduplication of the
same request across components, and loading/error states. Do not fetch in `useEffect` in this app.

## Query patterns

### The custom hook pattern

Wrap `useQuery` in a hook so the key, the fetcher and the types live together:

```typescript
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';

export function useCard(cardId: string) {
  return useQuery({
    queryKey: ['card', cardId],
    queryFn: () => api.card(cardId), // api.ts throws ApiError on a non-2xx answer
    enabled: cardId !== '',
  });
}
```

The fetcher must throw on failure (as `api.ts` does) so TanStack Query sees an error, and must
return a typed value, not `any`: give `request<T>` the wire type.

### Query keys

Keys are arrays; order matters. The portal uses a short resource name first (`['me']`, `['inbox']`,
`['card', id]`, `['card-artefacts', id]`, `['s0']`). Keep to that, and when a resource grows several
views, a small key factory prevents typos:

```typescript
export const cardKeys = {
  all: ['card'] as const,
  detail: (id: string) => ['card', id] as const,
  artefacts: (id: string) => ['card-artefacts', id] as const,
};
```

Invalidate by prefix (`{ queryKey: ['card'] }`) when a write may touch several entries.

## Mutations and cache invalidation

```typescript
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, type DecideInput } from '../api';

export function useDecideCard(cardId: string, csrf: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: DecideInput) => api.decideCard(cardId, input, csrf),
    // After the server has answered, refetch what the decision changed. Never pre-write it.
    onSettled: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['card', cardId] }),
        qc.invalidateQueries({ queryKey: ['inbox'] }),
      ]);
    },
  });
}
```

Show `isPending` on the control that submitted, disable resubmission while pending, and render the
mutation's error with the shared notice components (`components/Notice.tsx`).

### Optimistic updates

Only for state that is local, cosmetic and not part of the record (for example a collapsed panel
persisted through an API, if one ever exists). Never for decisions, gates, ledger entries, items or
anything the server signs or hashes. When used, type the cache entry instead of `any`:

```typescript
type Prefs = { readonly collapsed: readonly string[] };

onMutate: async (next: Prefs) => {
  await qc.cancelQueries({ queryKey: ['prefs'] });
  const previous = qc.getQueryData<Prefs>(['prefs']);
  qc.setQueryData<Prefs>(['prefs'], next);
  return { previous };
},
onError: (_err, _next, context) => {
  if (context?.previous !== undefined) qc.setQueryData(['prefs'], context.previous);
},
onSettled: () => qc.invalidateQueries({ queryKey: ['prefs'] }),
```

## The client

The one `QueryClient` is made by `createQueryClient()` in `App.tsx` (retry only for network or server
failures and at most twice, `refetchOnWindowFocus: true`, a short `staleTime`) and given to
`QueryClientProvider` in `App`; tests pass their own client to `App`. Change defaults there, not per
component, unless one query really differs (for example `refetchInterval` on `['me']`).

## Best practices

- Do: wrap `useQuery`/`useMutation` in hooks; components call `useCard(id)`, not `useQuery` with an
  inline fetcher.
- Do: prefer `invalidateQueries` over `setQueryData`; the server's answer is the one to show.
- Do: keep `staleTime` short for anything a person decides on; a stale card is worse than a refetch.
- Do: derive values during render from `data`; never copy query data into `useState` through an effect.
- Don't: retry 4xx answers; a refusal does not change by asking again.
- Don't: treat `data === undefined` as "nothing to do"; check `isError` and `isPending` first.

## Troubleshooting

**Problem:** A request repeats in the network tab.
**Solution:** A `queryFn` that throws is retried by the client's `retry` rule; a key that changes every
render (a new object each time) refetches each render. Build keys from primitives; set `retry: false`
in a test client while debugging.

**Problem:** `staleTime` vs `gcTime` (formerly `cacheTime`).
**Solution:** `staleTime` decides when a background refetch happens; `gcTime` how long an unused entry
stays in memory after its last observer unmounts.
