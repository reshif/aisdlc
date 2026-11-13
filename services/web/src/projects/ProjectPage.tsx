import { useQuery } from '@tanstack/react-query';
import { label, lookupTerm, type ProjectDetail, type ProjectPrrView } from '@aisdlc/contracts';
import { useState } from 'react';
import { api, type Me } from '../api';
import { describeError } from '../format';
import { AskForWorkButton } from '../items/AskForWorkButton';
import { BreakersPanel } from '../pages/BreakersPanel';
import { AreaLevels } from '../pages/AreaLevels';
import { ProjectSettingsPanel } from '../pages/ProjectSettingsPage';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  ErrorState,
  KeyValue,
  PageHeader,
  Pill,
  Scorecard,
  Stat,
  Stats,
  Table,
  Tabs,
  type ScoreItem,
} from '../ui';
import { Lifecycle } from './Lifecycle';
import { TrackApprovals } from './TrackApprovals';
import '../onboard/onboard.css';

// The project page (screen-map §2.9, skeleton screen 4): one header and eight tabs. What onboarding set is what the
// page shows everywhere: the readiness scorecard signed at onboarding, the tracks it opened, the approvals each track
// has and who decides them (read from the same settings in force the work engine reads), and the repo's life: edit
// its settings (M1 propose), run onboarding again, raise the level, delete.

export const PROJECT_TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'work', label: 'Work board' },
  { id: 'floor', label: 'Floor' },
  { id: 'readiness', label: 'Readiness scorecard' },
  { id: 'people', label: 'People & approvals' },
  { id: 'drift', label: 'Changes since onboarding' },
  { id: 'settings', label: 'Settings' },
  { id: 'audit', label: 'Audit' },
] as const;
type TabId = (typeof PROJECT_TABS)[number]['id'];

const tabFromUrl = (): TabId => {
  try {
    const t = new URLSearchParams(window.location.search).get('tab');
    return (PROJECT_TABS.find((x) => x.id === t)?.id ?? 'overview') as TabId;
  } catch {
    return 'overview';
  }
};

export function ProjectPage({ id, me }: { id: string; me: Me }) {
  const q = useQuery({
    queryKey: ['project', id],
    queryFn: () => api.project(id),
    refetchInterval: 10_000,
  });
  const prr = useQuery({ queryKey: ['prr', id], queryFn: () => api.prr(id), retry: false });
  const [tab, setTab] = useState<TabId>(tabFromUrl);
  if (q.isPending) return <p className="ui-help">Reading the project…</p>;
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    if (status === 403)
      return <ErrorState status={403} action={<Link to="/projects">Projects</Link>} />;
    if (status === 404)
      return <ErrorState status={404} action={<Link to="/projects">Projects</Link>} />;
    return (
      <p className="ui-help ui-help-bad" role="alert">
        {describeError(q.error)}
      </p>
    );
  }
  const d = q.data;
  const p = d.project;
  const repo = d.repos[0]?.repo_ref;
  const governing = prr.data?.repos.find((r) => r.governing)?.governing ?? null;
  return (
    <>
      <PageHeader
        title={p.name}
        crumbs={[{ label: 'Projects', to: '/projects' }, { label: p.name }]}
        renderLink={(to, l) => <Link to={to}>{l}</Link>}
        icon={p.name.slice(0, 2).toUpperCase()}
        meta={`${repo ?? 'No repo yet'} · ${p.tier ? label('tier', p.tier) : 'Risk not signed yet'}`}
        status={
          <>
            <Pill tone="info">{p.level ? label('level', p.level) : 'Not onboarded'}</Pill>
            {governing ? (
              <Pill tone="ok">Readiness {governing.record.composite} of 4</Pill>
            ) : (
              <Pill tone="mute">Not signed off yet</Pill>
            )}
          </>
        }
        actions={<AskForWorkButton project={p.project_id} />}
      />
      <Tabs
        label="Project"
        tabs={PROJECT_TABS}
        selected={tab}
        onSelect={(t) => {
          setTab(t as TabId);
          try {
            window.history.replaceState(null, '', `/projects/${encodeURIComponent(id)}?tab=${t}`);
          } catch {
            /* the address bar is a convenience */
          }
        }}
      >
        {tab === 'overview' ? <Overview d={d} prr={prr.data ?? null} /> : null}
        {tab === 'work' ? <Work project={p.project_id} /> : null}
        {tab === 'floor' ? (
          <Card title="This project's floor">
            <p>
              <Link to={`/floor?project=${encodeURIComponent(p.project_id)}`}>Open the floor</Link>
            </p>
            <BreakersPanel project={p.project_id} csrf={me.csrf_token} />
          </Card>
        ) : null}
        {tab === 'readiness' ? <Readiness d={d} prr={prr.data ?? null} /> : null}
        {tab === 'people' ? <TrackApprovals project={p.project_id} /> : null}
        {tab === 'drift' ? <Drift project={p.project_id} /> : null}
        {tab === 'settings' ? (
          <div className="ob-main">
            <TrackApprovals project={p.project_id} />
            <Card title="Change a setting">
              <ProjectSettingsPanel id={p.project_id} csrf={me.csrf_token} />
            </Card>
            <Lifecycle d={d} me={me} />
          </div>
        ) : null}
        {tab === 'audit' ? (
          <Card title="This project's record">
            <ul className="ob-list">
              <li>
                <Link to={`/projects/${p.project_id}/ledger`}>Decision log of this project</Link>
              </li>
              <li>
                <Link to={`/projects/${p.project_id}/issues`}>Gaps filed as GitHub issues</Link>
              </li>
              <li>
                <Link to={`/projects/${p.project_id}/knowledge`}>
                  What agents know about the repo
                </Link>
              </li>
              <li>
                <Link to={`/projects/${p.project_id}/learn`}>Suggestions from finished work</Link>
              </li>
            </ul>
          </Card>
        ) : null}
      </Tabs>
    </>
  );
}

function Overview({ d, prr }: { d: ProjectDetail; prr: ProjectPrrView | null }) {
  const latest = d.s0[0];
  const governing = prr?.repos.find((r) => r.governing)?.governing ?? null;
  return (
    <div className="ob-main">
      <Stats label="This project">
        <Stat
          label="Level"
          value={d.project.level ? label('level', d.project.level) : 'None yet'}
        />
        <Stat label="Risk" value={d.project.tier ? label('tier', d.project.tier) : 'Not signed'} />
        <Stat
          label="Readiness"
          value={governing ? `${governing.record.composite} of 4` : 'Not signed'}
          tone={governing ? 'ok' : 'warn'}
        />
        <Stat
          label="Tracks open"
          value={governing ? governing.record.autonomy.lanes_eligible.length : 0}
        />
      </Stats>
      <Card title="Onboarding">
        {latest ? (
          <KeyValue
            rows={[
              [
                'State',
                <Link key="s" to={`/onboard/${latest.record.s0_id}`}>
                  {lookupTerm('onboarding', latest.record.status)?.label ?? 'Unknown'}
                </Link>,
              ],
              ['Level asked for', label('level', latest.record.requested_level)],
            ]}
          />
        ) : (
          <EmptyState title="Not onboarded">
            <Link to="/onboard">Onboard a repo</Link> to start.
          </EmptyState>
        )}
      </Card>
      {governing ? (
        <Card title="Tracks agents may use">
          <ul className="ob-list">
            {governing.record.autonomy.lanes_eligible.map((l) => (
              <li key={l}>{lookupTerm('lane', l)?.label ?? 'Unknown'}</li>
            ))}
          </ul>
        </Card>
      ) : null}
    </div>
  );
}

function Work({ project }: { project: string }) {
  const q = useQuery({ queryKey: ['items', project], queryFn: () => api.items(project) });
  if (q.isPending) return <p className="ui-help">Reading the work…</p>;
  if (q.isError) return <p className="ui-help ui-help-bad">{describeError(q.error)}</p>;
  return (
    <Table
      caption="Work on this project"
      captionHidden
      rowKey={(r) => r.item_id}
      rows={q.data.items}
      empty={<EmptyState title="No work yet">Ask for work to start.</EmptyState>}
      columns={[
        {
          key: 'item',
          header: 'Item',
          rowHeader: true,
          render: (r) => <Link to={`/items/${r.item_id}`}>{r.item_id.slice(0, 8)}</Link>,
        },
        {
          key: 'lane',
          header: 'Track',
          render: (r) => lookupTerm('lane', r.lane ?? r.proposed_lane)?.label ?? 'Unknown',
        },
        {
          key: 'phase',
          header: 'Where',
          render: (r) => lookupTerm('phase', r.phase)?.label ?? 'Unknown',
        },
      ]}
    />
  );
}

function criterionLabel(id: string): string {
  return (
    lookupTerm('lightFloor', id)?.label ?? lookupTerm('readiness', id)?.label ?? 'A requirement'
  );
}

function Readiness({ d, prr }: { d: ProjectDetail; prr: ProjectPrrView | null }) {
  if (!prr) return <p className="ui-help">The readiness scorecard could not be read.</p>;
  const repos = prr.repos.filter((r) => r.governing);
  if (repos.length === 0) {
    return (
      <EmptyState title="No readiness scorecard yet">
        It is signed at the end of onboarding.{' '}
        {d.s0[0] ? <Link to={`/onboard/${d.s0[0].record.s0_id}`}>Open the onboarding</Link> : null}
      </EmptyState>
    );
  }
  return (
    <div className="ob-main">
      {repos.map((r) => {
        const rec = r.governing!.record;
        const items: ScoreItem[] = rec.pillars.flatMap((p) =>
          p.criteria.map((c) => ({
            id: `${p.pillar}:${c.id}`,
            label: `${lookupTerm('pillar', p.pillar)?.label ?? 'Pillar'}: ${criterionLabel(c.id)}`,
            state:
              c.met === true
                ? ('met' as const)
                : c.met === false
                  ? ('not_met' as const)
                  : ('unknown' as const),
          })),
        );
        return (
          <div key={r.repo} className="ob-main">
            <Scorecard
              title={`Readiness scorecard of ${r.repo}`}
              items={items}
              summary={`Readiness ${rec.composite} of 4 · ${lookupTerm('readiness', r.governing!.effective_status)?.label ?? 'Unknown'} · expires ${rec.fresh_until.slice(0, 10)}`}
              footer={
                <Link to={`/projects/${d.project.project_id}/readiness`}>
                  The full scorecard and its history
                </Link>
              }
            />
            <Card title="Level by folder">
              <AreaLevels record={rec} repo={r.repo} />
            </Card>
          </div>
        );
      })}
    </div>
  );
}

function Drift({ project }: { project: string }) {
  const q = useQuery({
    queryKey: ['drift', project],
    queryFn: () => api.drift(project),
    retry: false,
  });
  return (
    <Card title="Changes on GitHub since onboarding">
      {q.isPending ? <p className="ui-help">Reading…</p> : null}
      {q.isError ? <p className="ui-help">{describeError(q.error)}</p> : null}
      {q.data ? (
        <p>
          {q.data.repos.length} repo(s) watched.{' '}
          <Link to={`/projects/${project}/drift`}>See each change and what it means</Link>
        </p>
      ) : null}
    </Card>
  );
}
