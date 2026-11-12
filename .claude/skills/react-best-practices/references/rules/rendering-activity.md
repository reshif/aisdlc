---
title: Use Activity Component for Show/Hide
impact: MEDIUM
impactDescription: preserves state/DOM
tags: rendering, activity, visibility, state-preservation
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/rendering-activity.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Use Activity Component for Show/Hide

Use React's `<Activity>` to preserve state/DOM for expensive components that frequently toggle visibility.

**Usage:**

```tsx
import { Activity } from 'react';

function Dropdown({ isOpen }: Props) {
  return (
    <Activity mode={isOpen ? 'visible' : 'hidden'}>
      <ExpensiveMenu />
    </Activity>
  );
}
```

Avoids expensive re-renders and state loss.

`<Activity>` is stable from React 19.2 (the portal pins 19.3.1). Hidden content keeps its state but its
effects are cleaned up; content that must not stay in the DOM when hidden (for example a decide
control a person may no longer use) should be unmounted instead.
