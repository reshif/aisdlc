import { useQuery } from '@tanstack/react-query';
import { label, term, type PortalInboxItem } from '@aisdlc/contracts';
import { useId, useMemo, useState } from 'react';
import { api, type Me } from '../api';
import { DegradedBanners } from '../components/Degraded';
import { Link } from '../router';
import { CodeChip, EmptyState, PageHeader, Pill, Tabs, type TabDef } from '../ui';
import {
  dueText,
  fullTime,
  inboxHref,
  inboxVerb,
  inboxWhat,
  itemNo,
  listText,
  showsCodes,
  wire,
} from './words';
import './work.css';

// The inbox (screen-map §2.2): every decision waiting on me, then what others decide in the projects I can see, and
// for the fleet readers the whole factory. Filters by project, approval and overdue. Each card says why it is mine,
// when it is due, and flags in red an approval nobody can decide. Nothing is decided here: each card opens Decide,
// where the PDP and the decision kernel are asked again.

type Scope = 'mine' | 'others' | 'factory';

/** Overdue first, then the oldest due time; one with no time last (the order J/K walks on Decide too). */
export function inboxOrder(rows: readonly PortalInboxItem[]): PortalInboxItem[] {
  return [...rows].sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    const x = a.sla_due_at ?? a.opened_at;
    const y = b.sla_due_at ?? b.opened_at;
    return x.localeCompare(y);
  });
}

export function InboxScreen({ me }: { me: Me }) {
  const q = useQuery({ queryKey: ['inbox'], queryFn: () => api.inbox(), refetchInterval: 15_000 });
  const fleetReader = showsCodes(me.actions.fleet);
  const initial = new URLSearchParams(window.location.search).get('scope');
  const [scope, setScope] = useState<Scope>(
    initial === 'factory' && fleetReader ? 'factory' : initial === 'others' ? 'others' : 'mine',
  );
  const [project, setProject] = useState('');
  const [gate, setGate] = useState('');
  const [overdue, setOverdue] = useState(false);
  const ids = { project: useId(), gate: useId(), overdue: useId() };

  const all = useMemo(
    () => (q.data ? { mine: q.data.decide, others: q.data.view } : null),
    [q.data],
  );
  const base =
    all === null
      ? []
      : scope === 'mine'
        ? all.mine
        : scope === 'others'
          ? all.others
          : [...all.mine, ...all.others];
  const rows = inboxOrder(
    base.filter(
      (i) =>
        (project === '' || i.project_id === project) &&
        (gate === '' || inboxWhat(i) === gate) &&
        (!overdue || i.overdue),
    ),
  );
  const projects = [...new Set(base.map((i) => i.project_id))].sort();
  const kinds = [...new Set(base.map((i) => inboxWhat(i)))].sort();
  const tabs: TabDef[] = [
    { id: 'mine', label: 'Waiting on me', ...(all ? { count: all.mine.length } : {}) },
    { id: 'others', label: 'Others decide', ...(all ? { count: all.others.length } : {}) },
    ...(fleetReader ? [{ id: 'factory', label: 'Whole factory' }] : []),
  ];

  return (
    <div className="wk-page">
      <PageHeader title={label('screen', 'inbox')} meta={term('screen', 'inbox').explain} />
      {all ? (
        <DegradedBanners
          projects={[...all.mine, ...all.others].map((i) => i.project_id)}
          readModels={['work_item']}
        />
      ) : null}
      {q.isPending ? <p className="wk-muted">Loading your inbox…</p> : null}
      {q.isError ? (
        <div role="alert" className="ui-card" data-testid="inbox-error">
          <div className="ui-card-bd">
            <p>The inbox could not load. Your approvals are safe; nothing expires approved.</p>
            <button type="button" className="ui-btn ui-btn-sm" onClick={() => void q.refetch()}>
              Try again
            </button>
          </div>
        </div>
      ) : null}
      {all ? (
        <Tabs label="Inbox" tabs={tabs} selected={scope} onSelect={(s) => setScope(s as Scope)}>
          <div className="wk-filters" role="group" aria-label="Filters">
            <div className="wk-field">
              <label htmlFor={ids.project} className="ui-label">
                Project
              </label>
              <select
                id={ids.project}
                className="ui-input ui-select"
                value={project}
                onChange={(e) => setProject(e.target.value)}
              >
                <option value="">All projects</option>
                {projects.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </div>
            <div className="wk-field">
              <label htmlFor={ids.gate} className="ui-label">
                Approval
              </label>
              <select
                id={ids.gate}
                className="ui-input ui-select"
                value={gate}
                onChange={(e) => setGate(e.target.value)}
              >
                <option value="">Every approval</option>
                {kinds.map((k) => (
                  <option key={k} value={k}>
                    {k}
                  </option>
                ))}
              </select>
            </div>
            <div className="wk-row">
              <input
                id={ids.overdue}
                type="checkbox"
                checked={overdue}
                onChange={(e) => setOverdue(e.target.checked)}
              />
              <label htmlFor={ids.overdue}>Overdue only</label>
            </div>
          </div>
          {rows.length === 0 ? (
            <EmptyState title={scope === 'mine' ? 'Nothing is waiting on you' : 'Nothing here'}>
              {scope === 'mine'
                ? 'Approvals, onboarding sign-offs and access requests for your roles appear here first.'
                : 'Nothing else is open in the projects you can see.'}
            </EmptyState>
          ) : (
            <ul
              className="wk-cards"
              aria-label={scope === 'mine' ? 'Waiting on me' : 'Open approvals'}
              data-testid="inbox-list"
            >
              {rows.map((i) => (
                <InboxCard key={`${i.kind}:${i.id}`} i={i} codes={fleetReader} />
              ))}
            </ul>
          )}
        </Tabs>
      ) : null}
    </div>
  );
}

function InboxCard({ i, codes }: { i: PortalInboxItem; codes: boolean }) {
  const why = i.may_decide
    ? label('inboxReason', i.escalated ? 'escalated_backup' : 'eligible')
    : i.deciders.length > 0
      ? `${listText(i.deciders.map((d) => d.display_name))} ${i.deciders.length === 1 ? 'decides' : 'decide'}`
      : null;
  return (
    <li className="wk-icard" data-overdue={i.overdue} data-kind={i.kind}>
      <div className="wk-icard-hd">
        <Link to={inboxHref(i)}>
          {inboxVerb(i)}: {inboxWhat(i)}
        </Link>
        {codes && i.gate ? <CodeChip code={i.gate} /> : null}
        {i.overdue ? <Pill tone="bad">Overdue</Pill> : null}
        {i.feasibility !== 'feasible' ? (
          <Pill tone="bad">{wire('feasibility', i.feasibility)}</Pill>
        ) : null}
      </div>
      <div className="wk-icard-meta">
        {i.item_id ? (
          <span>
            <Link to={`/items/${encodeURIComponent(i.item_id)}`}>Item {itemNo(i.item_id)}</Link>
          </span>
        ) : null}
        <span>{i.project_id}</span>
        <span {...(i.sla_due_at ? { title: fullTime(i.sla_due_at) } : {})}>
          {dueText(i.sla_due_at, i.overdue)}
        </span>
        {why ? <span>{why}</span> : null}
      </div>
      {i.feasibility !== 'feasible' ? (
        <p className="wk-bad">
          {i.feasibility === 'infeasible'
            ? 'Nobody holds the role that decides this. A project admin can give someone the role.'
            : 'Who can decide this is unknown: treated as nobody.'}
          {i.feasibility_reason ? ` ${i.feasibility_reason}` : ''}
        </p>
      ) : null}
    </li>
  );
}
