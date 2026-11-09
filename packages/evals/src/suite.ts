import type { EvalCase, EvalGrader, EvalSuite } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { storeError, type EvalStoreError } from './errors.js';
import { holdoutCasesOf, loadHoldoutGrader, withHoldouts } from './holdout.js';
import type { EvalStore } from './store.js';

// What the eval tool loads to run a suite: the cases and a function that hands the grader of a case
// to the GRADER (after the agent answered). Holdout cases come in only with `includeHoldout`.

export interface RunnableSuite {
  readonly suite: EvalSuite;
  readonly cases: readonly EvalCase[];
  /** Loaded lazily, per case, so a grader is not in memory while the agent is being called. */
  readonly graderOf: (c: EvalCase) => Result<EvalGrader, EvalStoreError>;
}

export function loadSuite(
  store: EvalStore,
  suiteId: string,
  opts: { includeHoldout?: boolean } = {},
): Result<RunnableSuite, EvalStoreError> {
  const all = store.suites();
  if (!all.ok) return all;
  const merged = withHoldouts(store, all.value);
  if (!merged.ok) return merged;
  const suite = merged.value.find((s) => s.suite_id === suiteId);
  if (!suite) return err(storeError('not_found', `no suite ${suiteId}`));
  const cases: EvalCase[] = [];
  for (const id of suite.case_ids) {
    const c = store.loadCase(id);
    if (!c.ok) return c;
    if (c.value.kind === 'holdout') {
      return err(
        storeError('invalid', `tasks/${id}.json is a holdout: holdouts live in holdouts/`),
      );
    }
    cases.push(c.value);
  }
  if (opts.includeHoldout === true) {
    const h = holdoutCasesOf(store, suiteId);
    if (!h.ok) return h;
    cases.push(...h.value);
  }
  if (cases.length === 0)
    return err(storeError('not_found', `suite ${suiteId} has no cases to run`));
  return ok({
    suite,
    cases,
    graderOf: (c) => {
      const h = c.kind === 'holdout' ? loadHoldoutGrader(store, c) : store.loadHidden(c.hidden_ref);
      return h.ok ? ok(h.value.grader) : h;
    },
  });
}
