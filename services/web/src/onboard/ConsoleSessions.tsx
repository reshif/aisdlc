import { useQuery } from '@tanstack/react-query';
import type { ConsoleSessionRow } from '@aisdlc/contracts';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, PageHead, Pill, Table, type Column } from '../ui';
import { onboardApi } from './api';
import { stateWord } from './Console';

// The console's session list (docs/design/onboarding-console.md, mental model; P3): the factory has ONE agent surface,
// the console. A session has a subject (today an onboarding); this page lists the sessions you may see and lets you
// start one on an onboarding that has none. It replaces the one-shot "Ask the factory" page.

const TONE = {
  running: 'agent',
  awaiting_person: 'human',
  paused: 'warn',
  stopped: 'mute',
  done: 'ok',
} as const;

export function ConsoleSessions() {
  const sessions = useQuery({
    queryKey: ['console', 'sessions'],
    queryFn: () => onboardApi.consoleSessions(),
    retry: false,
  });
  const projects = useQuery({ queryKey: ['projects'], queryFn: () => api.projects() });
  const rows = sessions.data?.sessions ?? [];
  const have = new Set(rows.map((r) => r.s0_id));
  const open = (projects.data ?? []).flatMap((p) =>
    p.latest_s0 &&
    !have.has(p.latest_s0.s0_id) &&
    !['done', 'rejected', 'withdrawn', 'superseded'].includes(p.latest_s0.status)
      ? [{ project: p.project.project_id, repo: p.latest_s0.repo, s0: p.latest_s0.s0_id }]
      : [],
  );
  const columns: ReadonlyArray<Column<ConsoleSessionRow>> = [
    {
      key: 'subject',
      header: 'About',
      rowHeader: true,
      render: (r) => <Link to={`/onboard/${r.s0_id}`}>Onboarding of {r.project_id}</Link>,
    },
    {
      key: 'state',
      header: 'State',
      render: (r) => <Pill tone={TONE[r.state]}>{stateWord(r.state)}</Pill>,
    },
    { key: 'turns', header: 'Turns', align: 'right', render: (r) => String(r.turns) },
    { key: 'at', header: 'Last activity', render: (r) => shortTime(r.updated_at) },
  ];
  return (
    <>
      <PageHead
        title="Sessions"
        sub="The console is where you work with the factory’s agent. A session is about one thing, today one onboarding. The agent reads and proposes; you decide."
      />
      <div className="oc-sessions" data-testid="console-sessions">
        {sessions.isPending ? <Loading what="your sessions" /> : null}
        {sessions.isError ? (
          <ErrorNote error={sessions.error} retry={() => void sessions.refetch()} />
        ) : null}
        {sessions.data ? (
          <Table
            caption="Console sessions"
            columns={columns}
            rows={rows}
            rowKey={(r) => r.s0_id}
            empty={
              <EmptyState title="No sessions yet">
                Open an onboarding and start the console there, or start one below.
              </EmptyState>
            }
          />
        ) : null}
        {open.length > 0 ? (
          <Card title="Start a session" testId="console-start-list">
            <ul className="ob-list">
              {open.map((o) => (
                <li key={o.s0}>
                  <span>
                    Onboarding of {o.repo} <span className="ui-help">({o.project})</span>
                  </span>
                  <Link to={`/onboard/${o.s0}`}>Open and start the console</Link>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
      </div>
    </>
  );
}
