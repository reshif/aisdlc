---
title: Cache Repeated Function Calls
impact: MEDIUM-HIGH
impactDescription: avoid redundant computation
tags: javascript, cache, memoization, performance
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/js-cache-function-results.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Cache Repeated Function Calls

Use a module-level Map to cache the results of a pure function that is called repeatedly with the
same inputs during render.

**Incorrect (redundant computation):**

```tsx
function ProjectList({ projects }: { projects: readonly Project[] }) {
  return (
    <div>
      {projects.map((project) => {
        // slugify() called 100+ times for the same project names
        const slug = slugify(project.name);
        return <ProjectCard key={project.id} slug={slug} />;
      })}
    </div>
  );
}
```

**Correct (cached results):**

```tsx
// Module-level cache
const slugifyCache = new Map<string, string>();

function cachedSlugify(text: string): string {
  const hit = slugifyCache.get(text);
  if (hit !== undefined) return hit;
  const result = slugify(text);
  slugifyCache.set(text, result);
  return result;
}

function ProjectList({ projects }: { projects: readonly Project[] }) {
  return (
    <div>
      {projects.map((project) => (
        // Computed only once per unique project name
        <ProjectCard key={project.id} slug={cachedSlugify(project.name)} />
      ))}
    </div>
  );
}
```

Use a Map (not a hook) so it works everywhere: utilities, event handlers, not just components.

Only cache pure functions of their arguments. Never cache who the person is or what they may do:
that comes from `GET /api/me` and the PDP through TanStack Query, which revalidates it; a module-level
cache of it would outlive a logout or a role change. A cache that can grow without bound (keys from
user input) needs a size limit.

Reference: [How we made the Vercel Dashboard twice as fast](https://vercel.com/blog/how-we-made-the-vercel-dashboard-twice-as-fast)
