---
title: Optimize SVG Precision
impact: MEDIUM
impactDescription: reduces file size
tags: rendering, svg, optimization, svgo
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rendering-svg-precision.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Optimize SVG Precision

Reduce SVG coordinate precision to decrease file size. The optimal precision depends on the
viewBox size, but in general reducing precision should be considered.

**Incorrect (excessive precision):**

```svg
<path d="M 10.293847 20.847362 L 30.938472 40.192837" />
```

**Correct (1 decimal place):**

```svg
<path d="M 10.3 20.8 L 30.9 40.2" />
```

**Automate with SVGO** (not a dependency of this repo; run the pinned version on demand and commit
only the optimised file):

```bash
npx svgo@4.1.0 --precision=1 --multipass icon.svg
```
