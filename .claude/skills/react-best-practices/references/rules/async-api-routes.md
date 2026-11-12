---
title: Prevent Waterfall Chains in Service Handlers
impact: CRITICAL
impactDescription: 2-10× improvement
tags: bff, handlers, waterfalls, parallelization
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/async-api-routes.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Prevent Waterfall Chains in Service Handlers

In a bff or service route handler, start independent reads immediately, even if you don't await
them yet.

**Incorrect (config waits for the session, data waits for both):**

```typescript
app.get('/api/example', async (req) => {
  const session = await sessions.require(req);
  const config = await readConfig();
  const data = await readData(session.principal_id);
  return { data, config };
});
```

**Correct (session and config start immediately):**

```typescript
app.get('/api/example', async (req) => {
  const sessionPromise = sessions.require(req);
  const configPromise = readConfig();
  const session = await sessionPromise;
  const [config, data] = await Promise.all([configPromise, readData(session.principal_id)]);
  return { data, config };
});
```

Limits in this repo:

- Authorisation comes first. Never start a read whose answer depends on who is asking before the
  session and the PDP decision are known, and never return anything if either fails (fail closed).
- Inside a database transaction, statements on one client run in order anyway; do not parallelise
  them. A transaction that writes the record and the ledger follows the lock order in AGENTS.md.
