---
title: Dependency-Based Parallelization
impact: CRITICAL
impactDescription: 2-10× improvement
tags: async, parallelization, dependencies, promises
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/async-dependencies.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Dependency-Based Parallelization

For operations with partial dependencies, start every task as early as its inputs allow. Plain
promises are enough; no helper library is needed (and none may be added without an exact pin and
review).

**Incorrect (profile waits for config unnecessarily):**

```typescript
const [user, config] = await Promise.all([fetchUser(), fetchConfig()]);
const profile = await fetchProfile(user.id);
```

**Correct (config and profile run in parallel):**

```typescript
const userPromise = fetchUser();
const configPromise = fetchConfig();
const profilePromise = userPromise.then((user) => fetchProfile(user.id));

const [user, config, profile] = await Promise.all([userPromise, configPromise, profilePromise]);
```

Every promise is awaited by the `Promise.all`, so a rejection is never left unhandled.
