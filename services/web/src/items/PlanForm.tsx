import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api, type PortalPlan } from '../api';
import { describeError } from '../format';
import { newKey } from './waiting';

// B5: a person writes the plan. The form is the planner's own four parts as fields (Units with their scope,
// size and dependencies; the order; the tasks of each Unit; the oracles each Unit is verified against). It does
// not check them: the factory runs the SAME checks it runs over an agent's plan (the schema, the dependency
// graph, the sequence, the tasks, the oracle binding) and answers with the findings, field by field, and
// nothing is stored until they all pass. The person never pushes code; G3 decides what they wrote.

const SIZES = ['small', 'medium', 'large'] as const;

interface UnitRow {
  key: string;
  title: string;
  paths: string;
  size: (typeof SIZES)[number];
  depends: string;
  tasks: string;
  oracles: string;
}

const blank = (): UnitRow => ({
  key: '',
  title: '',
  paths: '',
  size: 'small',
  depends: '',
  tasks: '',
  oracles: '',
});

const list = (v: string): string[] =>
  v
    .split(/[\n,]/)
    .map((x) => x.trim())
    .filter((x) => x !== '');

/** The four parts of the plan, in the shapes the planner answers in, from what the person filled in. */
export function planBody(units: readonly UnitRow[], rationale: string, key: string): PortalPlan {
  let n = 0;
  return {
    key,
    split: {
      units: units.map((u) => ({
        unit_key: u.key.trim(),
        title: u.title.trim(),
        paths: list(u.paths),
        size: u.size,
        depends_on: list(u.depends),
      })),
    },
    sequence: { order: units.map((u) => u.key.trim()), rationale: rationale.trim() },
    tasks: {
      units: units.map((u) => ({
        unit_key: u.key.trim(),
        tasks: u.tasks
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l !== '')
          .map((l) => {
            const [description = '', verification = ''] = l.split('|').map((x) => x.trim());
            n += 1;
            return { task_id: `t${n}`, description, verification };
          }),
      })),
    },
    verification: {
      bindings: units.map((u) => ({ unit_key: u.key.trim(), oracle_ids: list(u.oracles) })),
    },
  };
}

export function PlanForm({ id, csrf }: { id: string; csrf: string }) {
  const qc = useQueryClient();
  const [units, setUnits] = useState<UnitRow[]>([blank()]);
  const [rationale, setRationale] = useState('');
  const set = (i: number, patch: Partial<UnitRow>) =>
    setUnits((all) => all.map((u, j) => (j === i ? { ...u, ...patch } : u)));
  const send = useMutation({
    mutationFn: () => api.itemPlan(id, planBody(units, rationale, newKey()), csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['item', id] }),
  });
  const empty = units.some(
    (u) =>
      u.key.trim() === '' ||
      u.title.trim() === '' ||
      list(u.paths).length === 0 ||
      u.tasks.trim() === '' ||
      list(u.oracles).length === 0,
  );

  if (send.isSuccess) {
    return (
      <section aria-label="Write the plan" className="decide">
        <h2>Write the plan</h2>
        <p role="status" data-testid="plan-stored">
          The plan was stored: {send.data.units} Unit{send.data.units === 1 ? '' : 's'}, planned
          against commit <code>{send.data.base_sha.slice(0, 12)}</code>. It now goes to the design
          approvers (G3), who decide it; you do not approve your own plan.
        </p>
      </section>
    );
  }

  return (
    <section aria-label="Write the plan" className="decide">
      <h2>Write the plan</h2>
      <p className="muted">
        The agent&apos;s plan was refused twice, so a person writes it. Fill in the Units in the
        order they are built. The factory checks it exactly as it checks an agent&apos;s plan and
        tells you what to fix; nothing is stored until it passes. You write a plan here, never code.
      </p>
      {units.map((u, i) => (
        <fieldset key={i} className="plain-fieldset" aria-label={`Unit ${i + 1}`}>
          <legend>Unit {i + 1}</legend>
          <div className="field">
            <label htmlFor={`u${i}-key`}>Name (a short lowercase key)</label>
            <input
              id={`u${i}-key`}
              value={u.key}
              onChange={(e) => set(i, { key: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`u${i}-title`}>What it does</label>
            <input
              id={`u${i}-title`}
              value={u.title}
              onChange={(e) => set(i, { title: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`u${i}-paths`}>
              Paths it may touch (a folder ending in / or a file; comma or line separated)
            </label>
            <input
              id={`u${i}-paths`}
              value={u.paths}
              onChange={(e) => set(i, { paths: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`u${i}-size`}>Size</label>
            <select
              id={`u${i}-size`}
              value={u.size}
              onChange={(e) => set(i, { size: e.target.value as UnitRow['size'] })}
            >
              {SIZES.map((x) => (
                <option key={x} value={x}>
                  {x}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor={`u${i}-deps`}>Needs these Units first (names, comma separated)</label>
            <input
              id={`u${i}-deps`}
              value={u.depends}
              onChange={(e) => set(i, { depends: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`u${i}-tasks`}>
              Tasks, one per line: what to do | how it is verified
            </label>
            <textarea
              id={`u${i}-tasks`}
              rows={3}
              value={u.tasks}
              onChange={(e) => set(i, { tasks: e.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor={`u${i}-oracles`}>
              Oracles that verify it (ids from the approved spec, comma separated)
            </label>
            <input
              id={`u${i}-oracles`}
              value={u.oracles}
              onChange={(e) => set(i, { oracles: e.target.value })}
            />
          </div>
          {units.length > 1 ? (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => setUnits((all) => all.filter((_, j) => j !== i))}
            >
              Remove Unit {i + 1}
            </button>
          ) : null}
        </fieldset>
      ))}
      <p>
        <button
          type="button"
          className="btn btn-quiet"
          onClick={() => setUnits((all) => [...all, blank()])}
        >
          Add a Unit
        </button>
      </p>
      <div className="field">
        <label htmlFor="plan-rationale">Why this order</label>
        <input
          id="plan-rationale"
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
        />
      </div>
      {send.isError ? (
        <div className="notice notice-bad" role="alert" data-testid="plan-problem">
          <p>{describeError(send.error)}</p>
          <p className="muted">Nothing was stored. Fix what it says and send the plan again.</p>
        </div>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={send.isPending || empty || rationale.trim() === ''}
          onClick={() => send.mutate()}
        >
          Send the plan for approval
        </button>
      </div>
    </section>
  );
}
