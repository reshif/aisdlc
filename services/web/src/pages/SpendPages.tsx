import { useQuery } from '@tanstack/react-query';
import type { BudgetRow, CostDay, MergedItemCost } from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Read, itemKey } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, PageHead, Pill, Stat, Stats, Table, type Column } from '../ui';

// P2-8 (docs/design/portal-review.md §12): Operate › Budgets and Govern › Cost, from the gateway's metered
// `gateway.model_call` events (core sums the record; the gateway adds its live limits and reservations). Reads only:
// `ops.read` for budgets, `quality.read` for cost, both on the fleet, decided by the bff and by core.

/** Micro-USD as dollars: cents for amounts above a dollar, four places below. */
export function usd(micro: number): string {
  const d = micro / 1_000_000;
  return d >= 1 ? `$${d.toFixed(2)}` : `$${d.toFixed(4)}`;
}

const tokens = (n: number) => n.toLocaleString('en-GB');

/** What share of `max` is used and held, as words (the bar is only a picture of it). */
function burn(used: number, reserved: number, max: number): string {
  const pct = (n: number) => `${Math.min(999, Math.round((n / max) * 100))}%`;
  return reserved > 0 ? `${pct(used)} used, ${pct(reserved)} held` : `${pct(used)} used`;
}

function BudgetState({ g }: { g: BudgetRow }) {
  if (g.exhausted_at) {
    return (
      <Pill tone="bad">
        exhausted ({g.exhausted_limit ?? 'limit'}) {shortTime(g.exhausted_at)}
      </Pill>
    );
  }
  if (g.live === null) return <Pill tone="mute">limits unknown</Pill>;
  if (g.live.reserved_tokens > 0) return <Pill tone="info">calls in flight</Pill>;
  return <Pill tone="ok">open</Pill>;
}

const BUDGET_COLS: ReadonlyArray<Column<BudgetRow>> = [
  {
    key: 'g',
    header: 'Budget group',
    rowHeader: true,
    render: (g) => <code>{g.budget_group}</code>,
  },
  { key: 'p', header: 'Project', render: (g) => g.project_ids.join(', ') || '—' },
  { key: 's', header: 'State', render: (g) => <BudgetState g={g} /> },
  {
    key: 't',
    header: 'Tokens used',
    align: 'right',
    render: (g) =>
      g.live
        ? `${tokens(g.used_tokens)} of ${tokens(g.live.max_tokens)} (${burn(g.live.used_tokens, g.live.reserved_tokens, g.live.max_tokens)})`
        : tokens(g.used_tokens),
  },
  {
    key: 'c',
    header: 'Cost',
    align: 'right',
    render: (g) =>
      g.live
        ? `${usd(g.used_cost_micro_usd)} of ${usd(g.live.max_cost_micro_usd)}`
        : usd(g.used_cost_micro_usd),
  },
  {
    key: 'r',
    header: 'Reserved',
    align: 'right',
    render: (g) =>
      g.live ? `${tokens(g.live.reserved_tokens)} · ${usd(g.live.reserved_cost_micro_usd)}` : '?',
  },
  {
    key: 'n',
    header: 'Calls',
    align: 'right',
    render: (g) => (g.refused > 0 ? `${g.calls} (+${g.refused} refused)` : String(g.calls)),
  },
  {
    key: 'l',
    header: 'Last call',
    render: (g) => (g.last_call_at ? shortTime(g.last_call_at) : 'none yet'),
  },
];

export function BudgetsPage() {
  const q = useQuery({ queryKey: ['budgets'], queryFn: api.budgets, refetchInterval: 30_000 });
  return (
    <>
      <PageHead
        eyebrow="Operate"
        title="Budgets"
        sub="Every budget group of the model gateway: what settled calls spent, what calls in flight hold, and whether its hard stop was hit (ET1 hands the item to a person). Limits and holds are the gateway's own; when it does not answer they are unknown, never zero."
        actions={
          <Link to="/cost" className="ui-btn">
            Cost reports
          </Link>
        }
      />
      <Read q={q} what="the budget groups">
        {(v) => {
          const spent = v.groups.reduce((n, g) => n + g.used_cost_micro_usd, 0);
          const exhausted = v.groups.filter((g) => g.exhausted_at !== null).length;
          const held = v.groups.reduce((n, g) => n + (g.live?.reserved_tokens ?? 0), 0);
          return (
            <>
              <Stats label="Budget totals">
                <Stat label="Groups" value={v.groups.length} />
                <Stat label="Spent" value={usd(spent)} detail="settled calls, all groups" />
                <Stat
                  label="Exhausted"
                  value={exhausted}
                  {...(exhausted > 0 ? { tone: 'bad' as const } : {})}
                  detail="ET1 raised"
                />
                <Stat
                  label="Held now"
                  value={v.gateway ? tokens(held) : '?'}
                  detail={
                    v.gateway ? 'tokens reserved by calls in flight' : 'the gateway is not asked'
                  }
                />
              </Stats>
              <Card title="Budget groups" flush>
                <Table
                  caption="Budget groups"
                  captionHidden
                  columns={BUDGET_COLS}
                  rows={v.groups}
                  rowKey={(g) => g.budget_group}
                  empty={
                    <EmptyState title="No budget group yet">
                      A group appears when the work engine mints a key on it.
                    </EmptyState>
                  }
                />
              </Card>
              <p className="muted">As of {shortTime(v.as_of)}.</p>
            </>
          );
        }}
      </Read>
    </>
  );
}

const DAY_COLS: ReadonlyArray<Column<CostDay>> = [
  { key: 'd', header: 'Day (UTC)', rowHeader: true, render: (r) => r.day },
  { key: 'p', header: 'Project', render: (r) => r.project_id },
  { key: 'n', header: 'Calls', align: 'right', render: (r) => r.calls },
  {
    key: 't',
    header: 'Tokens in / out',
    align: 'right',
    render: (r) => `${tokens(r.tokens_in)} / ${tokens(r.tokens_out)}`,
  },
  { key: 'c', header: 'Cost', align: 'right', render: (r) => usd(r.cost_micro_usd) },
];

const MERGED_COLS: ReadonlyArray<Column<MergedItemCost>> = [
  {
    key: 'i',
    header: 'Item',
    rowHeader: true,
    render: (m) => <Link to={`/items/${m.item_id}`}>{itemKey(m.item_id)}</Link>,
  },
  { key: 'p', header: 'Project', render: (m) => m.project_id },
  { key: 'l', header: 'Lane', render: (m) => m.lane ?? '—' },
  { key: 'm', header: 'Merged', render: (m) => shortTime(m.merged_at) },
  { key: 'n', header: 'Calls', align: 'right', render: (m) => m.calls },
  { key: 't', header: 'Tokens', align: 'right', render: (m) => tokens(m.tokens) },
  { key: 'c', header: 'Cost', align: 'right', render: (m) => usd(m.cost_micro_usd) },
];

const RANGES = [7, 30, 90] as const;

export function CostPage() {
  const [days, setDays] = useState<number>(30);
  const q = useQuery({ queryKey: ['cost', days], queryFn: () => api.cost(days) });
  return (
    <>
      <PageHead
        eyebrow="Govern"
        title="Cost"
        sub="What the model gateway metered: spend per day and project, by outcome, and what each merged item cost over every call made for it. Amounts are the gateway's prices (config gateway.models); refused calls cost nothing."
        actions={
          <Link to="/budgets" className="ui-btn">
            Budgets
          </Link>
        }
      />
      <div className="pg-inline" role="group" aria-label="Range">
        {RANGES.map((d) => (
          <button
            key={d}
            type="button"
            className="ui-btn ui-btn-sm"
            aria-pressed={days === d}
            onClick={() => setDays(d)}
          >
            {d} days
          </button>
        ))}
      </div>
      <Read q={q} what="the cost">
        {(v) => {
          const total = v.by_day.reduce((n, r) => n + r.cost_micro_usd, 0);
          const projects = new Map<string, number>();
          for (const r of v.by_day) {
            projects.set(r.project_id, (projects.get(r.project_id) ?? 0) + r.cost_micro_usd);
          }
          const merged = v.merged_items.reduce((n, m) => n + m.cost_micro_usd, 0);
          const perItem = v.merged_items.length ? merged / v.merged_items.length : null;
          return (
            <>
              <Stats label="Cost totals">
                <Stat label="Spent" value={usd(total)} detail={`since ${v.since.slice(0, 10)}`} />
                <Stat label="Projects" value={projects.size} />
                <Stat label="Merged items" value={v.merged_items.length} />
                <Stat
                  label="Per merged item"
                  value={perItem === null ? '—' : usd(Math.round(perItem))}
                  detail="mean, every call for the item"
                />
              </Stats>
              <Card title="Per project" flush>
                <Table
                  caption="Spend per project"
                  captionHidden
                  columns={[
                    { key: 'p', header: 'Project', rowHeader: true, render: ([p]) => p },
                    { key: 'c', header: 'Cost', align: 'right', render: ([, c]) => usd(c) },
                    {
                      key: 's',
                      header: 'Share',
                      align: 'right',
                      render: ([, c]) => (total > 0 ? `${Math.round((c / total) * 100)}%` : '—'),
                    },
                  ]}
                  rows={[...projects].sort((a, b) => b[1] - a[1])}
                  rowKey={([p]) => p}
                  empty={<p className="muted pg-pad">No call was metered in this range.</p>}
                />
              </Card>
              <Card title="Spend over time" flush>
                <Table
                  caption="Spend per day and project"
                  captionHidden
                  columns={DAY_COLS}
                  rows={v.by_day}
                  rowKey={(r) => `${r.day}/${r.project_id}`}
                  empty={<p className="muted pg-pad">No call was metered in this range.</p>}
                />
              </Card>
              <Card title="By outcome" flush>
                <Table
                  caption="Calls by outcome"
                  captionHidden
                  columns={[
                    { key: 'o', header: 'Outcome', rowHeader: true, render: (r) => r.outcome },
                    { key: 'n', header: 'Calls', align: 'right', render: (r) => r.calls },
                    {
                      key: 'c',
                      header: 'Cost',
                      align: 'right',
                      render: (r) => usd(r.cost_micro_usd),
                    },
                  ]}
                  rows={v.by_outcome}
                  rowKey={(r) => r.outcome}
                  empty={<p className="muted pg-pad">No call was metered in this range.</p>}
                />
              </Card>
              <Card title="Cost per merged item" flush>
                <Table
                  caption="Cost per merged item"
                  captionHidden
                  columns={MERGED_COLS}
                  rows={v.merged_items}
                  rowKey={(m) => m.item_id}
                  empty={<p className="muted pg-pad">No item merged in this range.</p>}
                />
              </Card>
            </>
          );
        }}
      </Read>
    </>
  );
}
