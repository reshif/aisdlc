import { EvalCase, EvalHidden, type EvalSuite } from '@aisdlc/contracts';
import { err, ok, type Result } from '@aisdlc/kernel';
import { storeError, type EvalStoreError } from './errors.js';
import { HOLDOUTS_DIR, holdoutFile, holdoutHiddenFile } from './layout.js';
import { checkHiddenRef, type EvalStore } from './store.js';

// HOLDOUT ISOLATION (DM §5.1, D36: the factory's own agents must never see answers). This is the ONE
// module that reads `holdouts/`. It is imported by `suite.ts` (the eval tool's loader, behind an
// explicit `includeHoldout`) and by nothing an agent's context, key, port or prompt is built from;
// a test walks the import graph and greps the sources to keep it so. A holdout case's grader is read
// only through `loadHoldoutGrader`, after the agent has answered, by the grader.

/** Case ids under `holdouts/`: names are in the manifest, but the case files are what carry the suite. */
function holdoutIds(store: EvalStore): string[] {
  const pre = `${HOLDOUTS_DIR}/`;
  return Object.keys(store.manifest.files)
    .filter((f) => f.startsWith(pre) && f.endsWith('.json') && !f.endsWith('.hidden.json'))
    .map((f) => f.slice(pre.length, -'.json'.length))
    .sort();
}

export function loadHoldoutCase(
  store: EvalStore,
  caseId: string,
): Result<EvalCase, EvalStoreError> {
  const c = store.read(holdoutFile(caseId), EvalCase);
  if (!c.ok) return c;
  if (c.value.kind !== 'holdout' || c.value.case_id !== caseId) {
    return err(storeError('invalid', `holdouts/${caseId}.json is not a holdout case`));
  }
  return c;
}

export function loadHoldoutGrader(
  store: EvalStore,
  c: EvalCase,
): Result<EvalHidden, EvalStoreError> {
  if (c.kind !== 'holdout') return err(storeError('invalid', 'not a holdout case'));
  const hex = c.hidden_ref.slice('sha256:'.length);
  const h = store.read(holdoutHiddenFile(hex), EvalHidden);
  return h.ok ? checkHiddenRef(hex, h.value) : h;
}

/** The holdout cases of one suite. */
export function holdoutCasesOf(
  store: EvalStore,
  suiteId: string,
): Result<EvalCase[], EvalStoreError> {
  const out: EvalCase[] = [];
  for (const id of holdoutIds(store)) {
    const c = loadHoldoutCase(store, id);
    if (!c.ok) return c;
    if (c.value.suite_id === suiteId) out.push(c.value);
  }
  return ok(out);
}

/** The suites with their holdout case ids filled in (a suite that has holdouts is never `local_prod_loadable`). */
export function withHoldouts(
  store: EvalStore,
  suites: readonly EvalSuite[],
): Result<EvalSuite[], EvalStoreError> {
  const bySuite = new Map<string, EvalSuite>(suites.map((s) => [s.suite_id, { ...s }]));
  for (const id of holdoutIds(store)) {
    const c = loadHoldoutCase(store, id);
    if (!c.ok) return c;
    const v = c.value;
    const s: EvalSuite = bySuite.get(v.suite_id) ?? {
      suite_id: v.suite_id,
      agent_id: v.agent_id,
      profile: v.profile,
      project_tag: v.project_tag,
      case_ids: [],
      holdout_case_ids: [],
      store_id: store.store_id,
      manifest_digest: store.manifest_digest,
      local_prod_loadable: true,
    };
    if (s.agent_id !== v.agent_id || s.profile !== v.profile || s.project_tag !== v.project_tag) {
      return err(storeError('invalid', `suite ${v.suite_id} mixes agents, profiles or tags`));
    }
    s.holdout_case_ids = [...s.holdout_case_ids, v.case_id].sort();
    s.local_prod_loadable = false;
    bySuite.set(v.suite_id, s);
  }
  return ok([...bySuite.values()].sort((a, b) => a.suite_id.localeCompare(b.suite_id)));
}
