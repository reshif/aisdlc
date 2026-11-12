---
title: Conditional Module Loading
impact: CRITICAL
impactDescription: loads large data only when needed
tags: bundle, conditional-loading, lazy-loading
---

> Vendored from davila7/claude-code-templates@82b59de, path `cli-tool/components/skills/web-development/react-best-practices/references/rules/bundle-conditional.md`,
> adapted for AISDLC on 2026-11-12; AGENTS.md wins on any conflict.

## Conditional Module Loading

Load large data or modules only when a feature is activated.

**Example (lazy-load animation frames):**

```tsx
function AnimationPlayer({ enabled }: { enabled: boolean }) {
  const [frames, setFrames] = useState<Frame[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!enabled || frames !== null) return;
    let live = true;
    import('./animation-frames.js')
      .then((mod) => {
        if (live) setFrames(mod.frames);
      })
      .catch(() => {
        if (live) setFailed(true);
      });
    return () => {
      live = false;
    };
  }, [enabled, frames]);

  if (failed) return <ErrorNote error={new Error('could not load the animation')} />;
  if (!frames) return <Loading />;
  return <Canvas frames={frames} />;
}
```

Vite emits `import()` targets as separate chunks from the same origin, which the portal's content
security policy (`script-src 'self'`) allows. Never load a chunk from another origin.
