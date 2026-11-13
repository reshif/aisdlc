import {
  SettingPreview,
  lookupTerm,
  placementOf,
  type SettingPreview as SettingPreviewT,
} from '@aisdlc/contracts';
import type { ConfigDeps } from '@aisdlc/config';
import { canonicalJson, err, ok, type Result } from '@aisdlc/kernel';
import { coreError, type CoreError } from './errors.js';
import { configKeyView } from './config-console.js';

// The effect of a draft settings change before it is proposed (screen map N8): what changes, in plain sentences
// built from the glossary's words, when it applies, and how many items are in progress (a catalogue change leaves
// them on the process version they pinned). It reads; it writes nothing. The registry checks the whole document
// again when the change is proposed: a preview that says "valid" is a hint, never an approval.

type Change = SettingPreviewT['changes'][number];

const same = (a: unknown, b: unknown) => canonicalJson(a ?? null) === canonicalJson(b ?? null);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The leaves that differ, by dotted path (arrays compared whole). */
export function diffPaths(before: unknown, after: unknown, path = ''): Change[] {
  if (isObj(before) && isObj(after)) {
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
    return keys.flatMap((k) => diffPaths(before[k], after[k], path === '' ? k : `${path}.${k}`));
  }
  return same(before, after) ? [] : [{ path: path === '' ? '(value)' : path, before, after }];
}

const word = (family: Parameters<typeof lookupTerm>[0], v: string) =>
  lookupTerm(family, v)?.label ?? 'an unnamed value';

/** The gates of each lane of a `catalogue.lanes` value. */
function laneGates(v: unknown): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  if (!isObj(v)) return out;
  for (const [lane, def] of Object.entries(v)) {
    const gates = isObj(def) && Array.isArray(def['gates']) ? def['gates'] : [];
    out.set(
      lane,
      new Set(gates.flatMap((g) => (isObj(g) && typeof g['gate'] === 'string' ? [g['gate']] : []))),
    );
  }
  return out;
}

/** Sentences for the keys whose effect can be said better than a diff. */
export function effectSentences(key: string, before: unknown, after: unknown): string[] {
  const out: string[] = [];
  if (key === 'catalogue.lanes') {
    const b = laneGates(before);
    const a = laneGates(after);
    for (const lane of [...new Set([...b.keys(), ...a.keys()])].sort()) {
      const was = b.get(lane) ?? new Set<string>();
      const now = a.get(lane) ?? new Set<string>();
      for (const g of [...now].filter((x) => !was.has(x)).sort()) {
        out.push(`The ${word('lane', lane)} track gets the approval “${word('gate', g)}”.`);
      }
      for (const g of [...was].filter((x) => !now.has(x)).sort()) {
        out.push(
          `The ${word('lane', lane)} track no longer has the approval “${word('gate', g)}”.`,
        );
      }
    }
  }
  if (key === 'gates.policy' && isObj(before) && isObj(after)) {
    const bg = isObj(before['gates']) ? before['gates'] : {};
    const ag = isObj(after['gates']) ? after['gates'] : {};
    for (const g of Object.keys(ag).sort()) {
      const x = bg[g];
      const y = ag[g];
      if (!isObj(y)) continue;
      const name = word('gate', g);
      if (isObj(x) && x['slot'] !== y['slot'] && typeof y['slot'] === 'string') {
        out.push(`“${name}” is decided by ${word('roleSlot', y['slot'])} from now on.`);
      }
      if (isObj(x) && x['step_up'] !== y['step_up']) {
        out.push(
          y['step_up']
            ? `“${name}” asks the decider to confirm it’s them.`
            : `“${name}” no longer asks the decider to confirm it’s them.`,
        );
      }
      if (isObj(x) && x['own_request'] !== y['own_request']) {
        out.push(`“${name}”: who may decide their own request changes.`);
      }
    }
    const bt = new Set(Array.isArray(before['two_person_gates']) ? before['two_person_gates'] : []);
    const at = new Set(Array.isArray(after['two_person_gates']) ? after['two_person_gates'] : []);
    for (const g of [...at]
      .filter((x) => !bt.has(x))
      .map(String)
      .sort()) {
      out.push(
        `“${word('gate', g)}” needs two people where a project has two-person approvals on.`,
      );
    }
    for (const g of [...bt]
      .filter((x) => !at.has(x))
      .map(String)
      .sort()) {
      out.push(`“${word('gate', g)}” no longer needs two people.`);
    }
  }
  if (key === 'sandbox.caps' && isObj(before) && isObj(after)) {
    if (before['coding'] !== after['coding']) {
      out.push(
        `Coding sandboxes at once: ${String(before['coding'])} → ${String(after['coding'])}.`,
      );
    }
    if (before['total'] !== after['total']) {
      out.push(`Sandboxes at once: ${String(before['total'])} → ${String(after['total'])}.`);
    }
  }
  if (key === 'agents.config') {
    const b = isObj(before) ? before : {};
    const a = isObj(after) ? after : {};
    for (const id of [...new Set([...Object.keys(b), ...Object.keys(a)])].sort()) {
      const x = isObj(b[id]) ? b[id] : {};
      const y = isObj(a[id]) ? a[id] : {};
      const name = word('agent', id);
      if ((x['enabled'] ?? true) !== (y['enabled'] ?? true)) {
        out.push(
          y['enabled'] === false
            ? `${name} is turned off: it runs nothing until it is turned on.`
            : `${name} is turned on.`,
        );
      }
      if (!same(x['models'], y['models'])) {
        out.push(
          Array.isArray(y['models'])
            ? `${name} uses ${y['models'].join(', ')}.`
            : `${name} uses its contract’s models again.`,
        );
      }
      for (const [f, what] of [
        ['max_turns', 'most turns'],
        ['run_time_s', 'session time limit'],
        ['test_time_s', 'test run time limit'],
        ['budget', 'budget per run'],
      ] as const) {
        if (!same(x[f], y[f])) out.push(`${name}: the ${what} changes.`);
      }
    }
  }
  return out;
}

export async function previewSetting(
  deps: ConfigDeps,
  key: string,
  value: unknown,
): Promise<Result<SettingPreviewT, CoreError>> {
  const def = deps.registry.get(key);
  if (!def) return err(coreError('not_found', `no config key ${key}`));
  const view = await configKeyView(deps, key);
  if (!view.ok) return view;
  const before = view.value.effective.value;
  const parsed = def.schema.safeParse(value);
  const problems = parsed.success
    ? []
    : parsed.error.issues.map((i) =>
        i.path.length > 0 ? `${i.path.join('.')}: ${i.message}` : i.message,
      );
  const placement = placementOf(key);
  const r = await deps.pool.query<{ n: string }>(
    'SELECT count(*)::text AS n FROM core.work_item WHERE terminal IS NULL',
  );
  const inProgress = Number(r.rows[0]?.n ?? 0);
  const changes = diffPaths(before, value);
  const effects = effectSentences(key, before, value);
  if (changes.length > 0 && placement.applies === 'new_items') {
    effects.push(
      inProgress === 0
        ? 'This makes a new process version; new items use it.'
        : `This makes a new process version for new items; ${inProgress} item(s) in progress keep the version they started with.`,
    );
  }
  return ok(
    SettingPreview.parse({
      key,
      applies: placement.applies,
      valid: parsed.success,
      problems,
      changes,
      effects,
      items_in_progress: inProgress,
    }),
  );
}
