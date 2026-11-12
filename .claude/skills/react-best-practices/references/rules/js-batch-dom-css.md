---
title: Batch DOM CSS Changes
impact: MEDIUM
impactDescription: reduces reflows/repaints
tags: javascript, dom, css, performance, reflow
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-batch-dom-css.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Batch DOM CSS Changes

Avoid changing styles one property at a time. Group multiple CSS changes together via classes or `cssText` to minimize browser reflows.

**Incorrect (multiple reflows):**

```typescript
function updateElementStyles(element: HTMLElement) {
  // Each line triggers a reflow
  element.style.width = '100px';
  element.style.height = '200px';
  element.style.backgroundColor = 'blue';
  element.style.border = '1px solid black';
}
```

**Correct (add class - single reflow):**

```typescript
// styles.css
.highlighted-box {
  width: 100px;
  height: 200px;
  background-color: blue;
  border: 1px solid black;
}

// JavaScript
function updateElementStyles(element: HTMLElement) {
  element.classList.add('highlighted-box')
}
```

**Correct (change cssText - single reflow):**

```typescript
function updateElementStyles(element: HTMLElement) {
  element.style.cssText = `
    width: 100px;
    height: 200px;
    background-color: blue;
    border: 1px solid black;
  `;
}
```

**React example:**

```tsx
// Incorrect: changing styles one by one
function Box({ isHighlighted }: { isHighlighted: boolean }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (ref.current && isHighlighted) {
      ref.current.style.width = '100px';
      ref.current.style.height = '200px';
      ref.current.style.backgroundColor = 'blue';
    }
  }, [isHighlighted]);

  return <div ref={ref}>Content</div>;
}

// Correct: toggle class
function Box({ isHighlighted }: { isHighlighted: boolean }) {
  return <div className={isHighlighted ? 'highlighted-box' : ''}>Content</div>;
}
```

Prefer CSS classes (in `styles.css`) over inline styles. Classes are cached by the browser and
provide better separation of concerns, and the portal's content security policy (`style-src 'self'`)
blocks `style` attributes in served HTML and injected `<style>` elements; setting `element.style` from
script still works, but a class is the default.
