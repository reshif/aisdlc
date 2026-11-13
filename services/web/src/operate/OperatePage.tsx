import { label, type ActionId } from '@aisdlc/contracts';
import type { Me } from '../api';
import { Link } from '../router';
import { reasonText } from '../access';
import {
  ControlsPage,
  HealthPage,
  KillPage,
  SandboxesPage,
  SchedulerPage,
} from '../pages/OperatePages';
import { BudgetsPage, CostPage } from '../pages/SpendPages';
import { ErrorState, PageHeader } from '../ui';
import '../settings/settings.css';

// Operate (screen map §2.15): run the factory from one page with tabs, each a page of its own (`/operate/<tab>`):
// Emergency stop, Pauses and notices, Queue and capacity, Sandboxes, Health, Spend. A tab is listed only when the
// person may read it; the old addresses (`/kill`, `/controls`, ...) open the same tabs.

export const OPERATE_TABS = ['stop', 'pauses', 'queue', 'sandboxes', 'health', 'spend'] as const;
export type OperateTab = (typeof OPERATE_TABS)[number];

const SCREEN: Readonly<
  Record<OperateTab, 'emergency_stop' | 'controls' | 'scheduler' | 'sandboxes' | 'health' | 'spend'>
> = {
  stop: 'emergency_stop',
  pauses: 'controls',
  queue: 'scheduler',
  sandboxes: 'sandboxes',
  health: 'health',
  spend: 'spend',
};

/** What a tab needs on the fleet: `ops.read`, and Spend's cost reports `quality.read` too. */
const NEEDS: Readonly<Record<OperateTab, readonly ActionId[]>> = {
  stop: ['ops.read'],
  pauses: ['ops.read'],
  queue: ['ops.read'],
  sandboxes: ['ops.read'],
  health: ['ops.read'],
  spend: ['ops.read', 'quality.read'],
};

export const mayOpen = (me: Me, t: OperateTab) =>
  NEEDS[t].some((a) => me.actions.fleet.includes(a));

export function OperatePage({ tab, me }: { tab: string | null; me: Me }) {
  const open = OPERATE_TABS.filter((t) => mayOpen(me, t));
  const current = (OPERATE_TABS as readonly string[]).includes(tab ?? '')
    ? (tab as OperateTab)
    : (open[0] ?? 'stop');
  const csrf = me.csrf_token;
  const title = label('screen', 'operate');
  return (
    <>
      <PageHeader
        title={title}
        crumbs={[{ label: title, to: '/operate' }, { label: label('screen', SCREEN[current]) }]}
        renderLink={(to, text) => <Link to={to}>{text}</Link>}
      />
      <nav className="st-tabs" aria-label={`${title} tabs`}>
        <ul>
          {open.map((t) => (
            <li key={t}>
              <Link
                to={`/operate/${t}`}
                {...(t === current ? { 'aria-current': 'page' as const } : {})}
              >
                {label('screen', SCREEN[t])}
              </Link>
            </li>
          ))}
        </ul>
      </nav>
      {!mayOpen(me, current) ? (
        <ErrorState
          status={403}
          reason={reasonText(NEEDS[current][0] ?? 'ops.read', ['no_policy_permits'])}
          action={<Link to="/me/access">See my access</Link>}
        />
      ) : current === 'stop' ? (
        <KillPage csrf={csrf} />
      ) : current === 'pauses' ? (
        <ControlsPage csrf={csrf} />
      ) : current === 'queue' ? (
        <SchedulerPage />
      ) : current === 'sandboxes' ? (
        <SandboxesPage />
      ) : current === 'health' ? (
        <HealthPage />
      ) : (
        <>
          {me.actions.fleet.includes('ops.read') ? <BudgetsPage /> : null}
          {me.actions.fleet.includes('quality.read') ? <CostPage /> : null}
        </>
      )}
    </>
  );
}
