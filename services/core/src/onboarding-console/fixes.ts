import type { OnboardingFixKind } from '@aisdlc/agents';
import { FIX_PATHS, type OnboardingAgentOutput } from '../onboarding-v2/agent.js';

// The fix files a person accepted in the console, merged into the shape the fix pack already renders (the onboarding
// agent's `fixes`). Pure. A console file wins over the batch agent's file at the same path; the factory's own rules
// still apply when the pack is rendered (`acceptedFixFiles`: only the paths of the fix's kind, never an existing file,
// no secret), and the pack still goes through its own X2 before the Push Broker.

/** Which kind of fix writes this path, or `null` when the factory writes no such path. */
export function fixKindOfPath(path: string): OnboardingFixKind | null {
  for (const [kind, paths] of Object.entries(FIX_PATHS) as Array<
    [OnboardingFixKind, readonly string[]]
  >) {
    if (paths.includes(path)) return kind;
  }
  return null;
}

/** Every path a fix file proposal may name. */
export const FIX_FILE_PATHS: readonly string[] = Object.values(FIX_PATHS).flat();

const EMPTY: OnboardingAgentOutput = {
  kind: 'onboarding',
  summary: 'Fixes accepted in the console.',
  learned: [],
  claims: [],
  fixes: [],
  questions: [],
  gap_suggestions: [],
};

/**
 * The agent's proposal (or none) plus the console's accepted files. `null` when there is neither: nothing to show or
 * render.
 */
export function mergeConsoleFixes(
  base: OnboardingAgentOutput | null,
  accepted: ReadonlyArray<{ fix_id: string; path: string; content: string }>,
): OnboardingAgentOutput | null {
  if (accepted.length === 0) return base;
  const mine = new Set(accepted.map((a) => a.path));
  const out = base ?? EMPTY;
  const kept = out.fixes
    .map((f) => ({ ...f, files: f.files.filter((x) => !mine.has(x.path)) }))
    .filter((f) => f.files.length > 0 || f.manual_steps.length > 0);
  const added = accepted.flatMap((a) => {
    const kind = fixKindOfPath(a.path);
    return kind === null
      ? []
      : [
          {
            fix_id: `console-${a.fix_id}`.slice(0, 64),
            fix_kind: kind,
            title: `Add ${a.path}`,
            why: 'Accepted in the onboarding console.',
            files: [{ path: a.path, content: a.content }],
            manual_steps: [],
          },
        ];
  });
  return { ...out, fixes: [...kept, ...added].slice(0, 8) };
}
