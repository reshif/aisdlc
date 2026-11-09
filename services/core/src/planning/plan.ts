import type { PlannedUnit, UnitSize } from '@aisdlc/contracts';
import { UnitKey } from '@aisdlc/contracts';

// S5's deterministic halves (PLAN M12.4): the checks over what the plan steps propose, the DAG order and the
// budget envelope of 5.5. All pure: the same plan gives the same findings, order and envelope, with no model
// and no I/O. A finding refuses the agent's answer (it is asked again, B3), it never edits it.

export interface PlanFinding {
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Obj[] => (Array.isArray(v) ? v.filter(isObj) : []);
const f = (code: string, path: string, message: string): PlanFinding => ({ code, path, message });
const keyOf = (u: Obj): string => (typeof u['unit_key'] === 'string' ? u['unit_key'] : '');

// ---------------------------------------------------------------- 5.1 the DAG

/** A path in a Unit's scope: relative to the repo, no `..`, no glob that would escape it. */
const scopePath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.trim() === p &&
  p.length > 0 &&
  !p.startsWith('/') &&
  !p.includes('\\') &&
  !p.includes('\0') &&
  !p.split('/').includes('..') &&
  !p.includes('**');

/** The Units in DAG order (a Unit after everything it depends on; ties by key), or `null` when there is a cycle. */
export function dagOrder(
  units: ReadonlyArray<{ unit_key: string; depends_on: readonly string[] }>,
): string[] | null {
  const keys = new Set(units.map((u) => u.unit_key));
  const left = new Map(
    units.map((u) => [u.unit_key, new Set(u.depends_on.filter((d) => keys.has(d)))] as const),
  );
  const out: string[] = [];
  while (left.size > 0) {
    const ready = [...left]
      .filter(([, deps]) => deps.size === 0)
      .map(([k]) => k)
      .sort();
    const next = ready[0];
    if (next === undefined) return null;
    out.push(next);
    left.delete(next);
    for (const deps of left.values()) deps.delete(next);
  }
  return out;
}

/**
 * 5.1: the Units are a DAG with ids: each id a slug and used once, each Unit has a scope of paths inside the
 * repo, every `depends_on` names a Unit of the plan (and not itself), and the graph has no cycle.
 */
export function validateUnitSplit(out: unknown): PlanFinding[] {
  const units = list(isObj(out) ? out['units'] : undefined);
  const findings: PlanFinding[] = [];
  const seen = new Set<string>();
  units.forEach((u, i) => {
    const at = `units[${i}]`;
    const key = keyOf(u);
    if (!UnitKey.safeParse(key).success) {
      findings.push(
        f('bad_unit_key', `${at}.unit_key`, 'a unit id is a lowercase slug (a-z, 0-9, . _ -)'),
      );
    } else if (seen.has(key)) {
      findings.push(f('duplicate_unit', `${at}.unit_key`, 'two Units have one id'));
    }
    seen.add(key);
    const paths = Array.isArray(u['paths']) ? u['paths'] : [];
    if (paths.length === 0) findings.push(f('empty_scope', `${at}.paths`, 'a Unit has no scope'));
    paths.forEach((p, j) => {
      if (!scopePath(p)) {
        findings.push(
          f(
            'bad_path',
            `${at}.paths[${j}]`,
            'a scope path is inside the repository, with no .. or **',
          ),
        );
      }
    });
  });
  units.forEach((u, i) => {
    const key = keyOf(u);
    (Array.isArray(u['depends_on']) ? (u['depends_on'] as unknown[]) : []).forEach((d, j) => {
      const at = `units[${i}].depends_on[${j}]`;
      if (d === key) findings.push(f('self_dependency', at, 'a Unit depends on itself'));
      else if (typeof d !== 'string' || !seen.has(d)) {
        findings.push(
          f('dangling_dependency', at, 'a Unit depends on one that is not in the plan'),
        );
      }
    });
  });
  if (findings.length === 0) {
    const order = dagOrder(
      units.map((u) => ({
        unit_key: keyOf(u),
        depends_on: Array.isArray(u['depends_on']) ? (u['depends_on'] as string[]) : [],
      })),
    );
    if (order === null) {
      findings.push(f('dependency_cycle', 'units', 'the Units depend on each other in a cycle'));
    }
  }
  return findings;
}

/** The Units of a stored 5.1 artefact, with the structure the later steps need. */
export interface SplitUnit {
  readonly unit_key: string;
  readonly title: string;
  readonly paths: readonly string[];
  readonly size: UnitSize;
  readonly depends_on: readonly string[];
}
export const splitUnits = (split: unknown): SplitUnit[] =>
  list(isObj(split) ? split['units'] : undefined).map((u) => ({
    unit_key: keyOf(u),
    title: typeof u['title'] === 'string' ? u['title'] : '',
    paths: Array.isArray(u['paths']) ? (u['paths'] as string[]) : [],
    size: (u['size'] as UnitSize) ?? 'medium',
    depends_on: Array.isArray(u['depends_on']) ? (u['depends_on'] as string[]) : [],
  }));

// ---------------------------------------------------------------- 5.2 to 5.4, 5.6

/** 5.2: every Unit once, in an order that has each Unit after everything it depends on. */
export function validateSequence(out: unknown, split: unknown): PlanFinding[] {
  const units = splitUnits(split);
  const keys = new Set(units.map((u) => u.unit_key));
  const order = isObj(out) && Array.isArray(out['order']) ? (out['order'] as unknown[]) : [];
  const findings: PlanFinding[] = [];
  const at = new Map<string, number>();
  order.forEach((k, i) => {
    if (typeof k !== 'string' || !keys.has(k)) {
      findings.push(
        f('unknown_unit', `order[${i}]`, 'the sequence names a Unit that is not in the plan'),
      );
    } else if (at.has(k))
      findings.push(f('duplicate_unit', `order[${i}]`, 'a Unit is sequenced twice'));
    else at.set(k, i);
  });
  for (const u of units) {
    if (!at.has(u.unit_key))
      findings.push(f('missing_unit', 'order', 'a Unit of the plan is not sequenced'));
  }
  if (findings.length === 0) {
    for (const u of units) {
      for (const d of u.depends_on) {
        if ((at.get(d) ?? 0) > (at.get(u.unit_key) ?? 0)) {
          findings.push(
            f('before_dependency', 'order', 'a Unit is sequenced before something it depends on'),
          );
        }
      }
    }
  }
  return findings;
}

/** 5.3: every Unit of the plan has a task plan, once, and its task ids are distinct. */
export function validateTasks(out: unknown, split: unknown): PlanFinding[] {
  const keys = new Set(splitUnits(split).map((u) => u.unit_key));
  const findings: PlanFinding[] = [];
  const seen = new Set<string>();
  list(isObj(out) ? out['units'] : undefined).forEach((u, i) => {
    const k = keyOf(u);
    const at = `units[${i}]`;
    if (!keys.has(k))
      findings.push(
        f('unknown_unit', `${at}.unit_key`, 'a task plan for a Unit that is not in the plan'),
      );
    else if (seen.has(k))
      findings.push(f('duplicate_unit', `${at}.unit_key`, 'a Unit has two task plans'));
    seen.add(k);
    const ids = new Set<string>();
    list(u['tasks']).forEach((t, j) => {
      const id = typeof t['task_id'] === 'string' ? t['task_id'] : '';
      if (ids.has(id))
        findings.push(
          f('duplicate_task', `${at}.tasks[${j}].task_id`, 'two tasks of a Unit have one id'),
        );
      ids.add(id);
    });
  });
  for (const k of keys) {
    if (!seen.has(k))
      findings.push(f('missing_unit', 'units', 'a Unit of the plan has no task plan'));
  }
  return findings;
}

/**
 * 5.4: each Unit is bound to oracle specs of G2 (every id real), every Unit is bound, and every oracle spec
 * is some Unit's: an oracle nobody verifies would be one the build never runs.
 */
export function validateVerification(
  out: unknown,
  split: unknown,
  oracles: unknown,
): PlanFinding[] {
  const keys = new Set(splitUnits(split).map((u) => u.unit_key));
  const known = new Set(
    list(isObj(oracles) ? oracles['oracles'] : undefined).flatMap((o) =>
      typeof o['oracle_id'] === 'string' ? [o['oracle_id']] : [],
    ),
  );
  const findings: PlanFinding[] = [];
  const bound = new Set<string>();
  const used = new Set<string>();
  list(isObj(out) ? out['bindings'] : undefined).forEach((b, i) => {
    const k = keyOf(b);
    const at = `bindings[${i}]`;
    if (!keys.has(k))
      findings.push(
        f('unknown_unit', `${at}.unit_key`, 'a binding for a Unit that is not in the plan'),
      );
    else if (bound.has(k))
      findings.push(f('duplicate_unit', `${at}.unit_key`, 'a Unit is bound twice'));
    bound.add(k);
    (Array.isArray(b['oracle_ids']) ? (b['oracle_ids'] as unknown[]) : []).forEach((o, j) => {
      if (typeof o !== 'string' || !known.has(o)) {
        findings.push(
          f(
            'unknown_oracle',
            `${at}.oracle_ids[${j}]`,
            'a binding names an oracle spec G2 did not approve',
          ),
        );
      } else used.add(o);
    });
  });
  for (const k of keys) {
    if (!bound.has(k))
      findings.push(f('unbound_unit', 'bindings', 'a Unit is verified by no oracle spec'));
  }
  for (const o of known) {
    if (!used.has(o))
      findings.push(f('unbound_oracle', 'bindings', 'an oracle spec is bound to no Unit'));
  }
  return findings;
}

/** 5.6: the capacity input names only Units of the plan, once each. */
export function validateCapacity(out: unknown, split: unknown): PlanFinding[] {
  const keys = new Set(splitUnits(split).map((u) => u.unit_key));
  const findings: PlanFinding[] = [];
  const seen = new Set<string>();
  list(isObj(out) ? out['review_minutes'] : undefined).forEach((r, i) => {
    const k = keyOf(r);
    if (!keys.has(k))
      findings.push(
        f(
          'unknown_unit',
          `review_minutes[${i}].unit_key`,
          'a review estimate for a Unit not in the plan',
        ),
      );
    else if (seen.has(k))
      findings.push(
        f('duplicate_unit', `review_minutes[${i}].unit_key`, 'a Unit is estimated twice'),
      );
    seen.add(k);
  });
  return findings;
}

/**
 * The most Units the factory runs at once. M13.2: "concurrency cap of one coding session"; the plan's own
 * proposal is bounded by it, so a plan cannot ask for parallelism the sandbox will not give.
 */
export const CODING_SESSION_CAP = 1;

/** The capacity artefact: the agent's proposal and what the factory will use of it. */
export function boundCapacity(out: Obj, split: unknown): Obj {
  const n = splitUnits(split).length;
  const proposed = typeof out['max_parallel_units'] === 'number' ? out['max_parallel_units'] : 1;
  return {
    kind: 'capacity_input',
    proposed_parallel_units: proposed,
    max_parallel_units: Math.max(1, Math.min(proposed, n, CODING_SESSION_CAP)),
    bounded_by: { units: n, coding_sessions: CODING_SESSION_CAP },
    review_minutes: out['review_minutes'] ?? [],
    rationale: out['rationale'] ?? '',
    assumptions: out['assumptions'] ?? [],
  };
}

// ---------------------------------------------------------------- 5.5 the budget envelope

/**
 * How much of the coding contract's budget a Unit of each size may spend. The contract (A4/`coder`: tokens and
 * cost per Unit) is the factory's number; these are the shares of it. The flow gives no lane default
 * ("the flow names a profile envelope and gives none"), so a lane default, when the catalogue has one,
 * only CAPS the plan.
 */
export const SIZE_SHARE: Readonly<Record<UnitSize, number>> = {
  small: 0.25,
  medium: 0.5,
  large: 1,
};

export interface EnvelopeInput {
  readonly lane: string;
  /** The catalogue's lane profile default (`default_envelope.budget_cents`); `null` when the lane has none. */
  readonly lane_default_budget_cents: number | null;
  /** The coding agent contract's budget for one Unit. */
  readonly coder_budget: { readonly max_tokens: number; readonly max_cost_micro_usd: number };
  readonly units: ReadonlyArray<{ unit_key: string; size: UnitSize }>;
  readonly base_sha: string;
}

/** 5.5, deterministic: what each Unit may spend, from the lane's profile default and the sizes of the Units. */
export function budgetEnvelope(i: EnvelopeInput): {
  content: Obj;
  envelopes: Map<string, { max_tokens: number; max_cost_micro_usd: number }>;
} {
  const raw = i.units.map((u) => ({
    unit_key: u.unit_key,
    size: u.size,
    max_tokens: Math.max(1, Math.ceil(i.coder_budget.max_tokens * SIZE_SHARE[u.size])),
    max_cost_micro_usd: Math.max(
      1,
      Math.ceil(i.coder_budget.max_cost_micro_usd * SIZE_SHARE[u.size]),
    ),
  }));
  const sum = (k: 'max_tokens' | 'max_cost_micro_usd') => raw.reduce((a, u) => a + u[k], 0);
  const cap = i.lane_default_budget_cents === null ? null : i.lane_default_budget_cents * 10_000;
  const capped = cap !== null && sum('max_cost_micro_usd') > cap;
  const scale = capped && cap !== null ? cap / sum('max_cost_micro_usd') : 1;
  const units = raw.map((u) => ({
    ...u,
    max_tokens: Math.max(1, Math.floor(u.max_tokens * scale)),
    max_cost_micro_usd: Math.max(1, Math.floor(u.max_cost_micro_usd * scale)),
  }));
  const content: Obj = {
    kind: 'budget_envelope',
    base_sha: i.base_sha,
    basis: {
      lane: i.lane,
      lane_default_budget_cents: i.lane_default_budget_cents,
      coder_contract: i.coder_budget,
      size_share: SIZE_SHARE,
    },
    capped,
    units,
    total: {
      max_tokens: units.reduce((a, u) => a + u.max_tokens, 0),
      max_cost_micro_usd: units.reduce((a, u) => a + u.max_cost_micro_usd, 0),
    },
  };
  return {
    content,
    envelopes: new Map(
      units.map((u) => [
        u.unit_key,
        { max_tokens: u.max_tokens, max_cost_micro_usd: u.max_cost_micro_usd },
      ]),
    ),
  };
}

/** The Units of the plan in DAG order with their scope and envelope (what enters the `unit` read model). */
export function plannedUnits(
  split: unknown,
  envelopes: ReadonlyMap<string, { max_tokens: number; max_cost_micro_usd: number }>,
): PlannedUnit[] {
  const units = splitUnits(split);
  const order = dagOrder(units) ?? units.map((u) => u.unit_key);
  return order.flatMap((key, position) => {
    const u = units.find((x) => x.unit_key === key);
    const envelope = envelopes.get(key);
    return u && envelope
      ? [
          {
            unit_key: u.unit_key,
            title: u.title,
            paths: [...u.paths],
            size: u.size,
            depends_on: [...u.depends_on],
            position,
            envelope,
          },
        ]
      : [];
  });
}
