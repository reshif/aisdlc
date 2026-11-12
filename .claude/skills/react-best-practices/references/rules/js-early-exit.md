---
title: Early Return from Functions
impact: LOW-MEDIUM
impactDescription: avoids unnecessary computation
tags: javascript, functions, optimization, early-return
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-early-exit.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Early Return from Functions

Return early when result is determined to skip unnecessary processing.

**Incorrect (processes all items even after finding answer):**

```typescript
function validateUsers(users: User[]) {
  let hasError = false;
  let errorMessage = '';

  for (const user of users) {
    if (!user.email) {
      hasError = true;
      errorMessage = 'Email required';
    }
    if (!user.name) {
      hasError = true;
      errorMessage = 'Name required';
    }
    // Continues checking all users even after error found
  }

  return hasError ? { valid: false, error: errorMessage } : { valid: true };
}
```

**Correct (returns immediately on first error):**

```typescript
function validateUsers(users: User[]) {
  for (const user of users) {
    if (!user.email) {
      return { valid: false, error: 'Email required' };
    }
    if (!user.name) {
      return { valid: false, error: 'Name required' };
    }
  }

  return { valid: true };
}
```
