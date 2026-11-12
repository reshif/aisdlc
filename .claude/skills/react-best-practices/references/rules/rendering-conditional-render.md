---
title: Use Explicit Conditional Rendering
impact: MEDIUM
impactDescription: prevents rendering 0 or NaN
tags: rendering, conditional, jsx, falsy-values
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rendering-conditional-render.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Use Explicit Conditional Rendering

Use explicit ternary operators (`? :`) instead of `&&` for conditional rendering when the condition can be `0`, `NaN`, or other falsy values that render.

**Incorrect (renders "0" when count is 0):**

```tsx
function Badge({ count }: { count: number }) {
  return <div>{count && <span className="badge">{count}</span>}</div>;
}

// When count = 0, renders: <div>0</div>
// When count = 5, renders: <div><span class="badge">5</span></div>
```

**Correct (renders nothing when count is 0):**

```tsx
function Badge({ count }: { count: number }) {
  return <div>{count > 0 ? <span className="badge">{count}</span> : null}</div>;
}

// When count = 0, renders: <div></div>
// When count = 5, renders: <div><span class="badge">5</span></div>
```
