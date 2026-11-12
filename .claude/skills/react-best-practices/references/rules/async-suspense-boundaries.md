---
title: Strategic Loading Boundaries
impact: HIGH
impactDescription: faster first paint of the page frame
tags: async, suspense, loading-states, layout-shift
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/async-suspense-boundaries.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Strategic Loading Boundaries

The portal is a client-rendered SPA: there are no async components. Instead of one page-level
spinner that waits for every query, let each section own its query and its loading state (or a
`Suspense` boundary around a `React.lazy` component), so the page frame renders at once.

**Incorrect (the whole page waits for the slowest query):**

```tsx
function CardPage({ id }: { id: string }) {
  const card = useCard(id);
  const artefacts = useCardArtefacts(id);
  if (card.isPending || artefacts.isPending) return <Loading />;
  // ...
}
```

**Correct (the frame and the card render; the artefacts section loads on its own):**

```tsx
function CardPage({ id }: { id: string }) {
  const card = useCard(id);
  if (card.isPending) return <Loading />;
  if (card.isError) return <ErrorNote error={card.error} />;
  return (
    <>
      <CardSummary card={card.data} />
      <GateArtefacts id={id} /> {/* its own query, its own loading and error state */}
    </>
  );
}
```

**When NOT to split:**

- Data needed to decide what the page is at all (who may decide, whether the card exists)
- When the person must see everything before acting: a decide control stays disabled until every
  piece of evidence it binds has loaded and is intact. Never let a decision proceed on partial data.
- Small, fast queries where the extra loading state only adds layout shift
