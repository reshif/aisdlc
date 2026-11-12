---
title: CSS content-visibility for Long Lists
impact: MEDIUM
impactDescription: 10× faster initial render
tags: rendering, css, content-visibility, long-lists
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rendering-content-visibility.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## CSS content-visibility for Long Lists

Apply `content-visibility: auto` to defer off-screen rendering (for example a long ledger page).

**CSS (in `styles.css`; the content security policy allows only same-origin stylesheets):**

```css
.ledger-row {
  content-visibility: auto;
  contain-intrinsic-size: auto 80px;
}
```

**Example:**

```tsx
function LedgerList({ rows }: { rows: readonly Row[] }) {
  return (
    <ol className="ledger-list">
      {rows.map((row) => (
        <li key={row.id} className="ledger-row">
          <LedgerEntry row={row} />
        </li>
      ))}
    </ol>
  );
}
```

For 1000 rows, the browser skips layout and paint for the off-screen ones. Content stays in the DOM,
so find-in-page and screen readers still reach it.
