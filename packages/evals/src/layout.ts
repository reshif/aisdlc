// The on-disk layout of an eval store, `asf-eval-store/v1` (PLAN M11.3; DM §5.1):
//
//   manifest.json            the signed manifest (ES256): every other file and its sha256
//   tasks/<case>.json        a case: the INPUT and a `hidden_ref`, never the expected answer
//   hidden/<sha256>.json     the grader a `hidden_ref` names (content-addressed)
//   holdouts/<case>.json     a HOLDOUT case, and holdouts/<sha256>.hidden.json its grader.
//                            Reserved: only `holdout.ts` reads them (D36: the factory's agents never see answers)
//   baselines/<provider>.json  the pass vectors a later run is compared with, per provider

export const MANIFEST_FILE = 'manifest.json';
export const TASKS_DIR = 'tasks';
export const HIDDEN_DIR = 'hidden';
export const HOLDOUTS_DIR = 'holdouts';
export const BASELINES_DIR = 'baselines';
export const STORE_DIRS = [TASKS_DIR, HIDDEN_DIR, HOLDOUTS_DIR, BASELINES_DIR] as const;

export const taskFile = (caseId: string): string => `${TASKS_DIR}/${caseId}.json`;
export const hiddenFile = (hex: string): string => `${HIDDEN_DIR}/${hex}.json`;
export const holdoutFile = (caseId: string): string => `${HOLDOUTS_DIR}/${caseId}.json`;
export const holdoutHiddenFile = (hex: string): string => `${HOLDOUTS_DIR}/${hex}.hidden.json`;
export const baselineFile = (provider: string): string => `${BASELINES_DIR}/${provider}.json`;

/** The cases a path names, by directory: names only, never content. */
export const isHoldoutHidden = (rel: string): boolean =>
  rel.startsWith(`${HOLDOUTS_DIR}/`) && rel.endsWith('.hidden.json');
