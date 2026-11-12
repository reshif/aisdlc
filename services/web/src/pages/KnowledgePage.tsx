import type {
  KnowledgeAreaView,
  KnowledgeGoldenView,
  KnowledgeRepoView,
  KnowledgeSeedView,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { api } from '../api';
import { Hash } from '../cards/shared';
import { PageError, Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, KeyValue, PageHead, Pill, Stat, Stats, Table, type Column } from '../ui';
import { levelTitle } from '../vocab';

// The Knowledge screen outside card 3 (PLAN M17): the repo index, the system map, the code graph, the living-spec
// seeds and the golden-task candidates of each repository, as the record holds them. The server decides who sees it
// (`project.view` and view level V2) and cuts it to the person's data class: below D1 the paths and seed text are
// withheld and only areas and counts remain. Seeds and golden tasks reach agents as data, never as instructions.

const list = (xs: readonly string[]): string => (xs.length === 0 ? 'none' : xs.join(', '));

const areaColumns: ReadonlyArray<Column<KnowledgeAreaView>> = [
  { key: 'area', header: 'Area', rowHeader: true, render: (a) => <code>{a.area}</code> },
  {
    key: 'level',
    header: 'Level',
    render: (a) =>
      a.level === null ? <span className="muted">no record</span> : levelTitle(a.level),
  },
  { key: 'files', header: 'Files', align: 'right', render: (a) => a.files },
  { key: 'tests', header: 'Tests', align: 'right', render: (a) => a.test_files },
  { key: 'lang', header: 'Languages', render: (a) => list(a.languages) },
  { key: 'dep', header: 'Depends on', render: (a) => list(a.depends_on) },
  { key: 'used', header: 'Used by', render: (a) => list(a.used_by) },
];

const seedColumns: ReadonlyArray<Column<KnowledgeSeedView>> = [
  { key: 'area', header: 'Area', rowHeader: true, render: (s) => <code>{s.area}</code> },
  {
    key: 'status',
    header: 'Status',
    render: (s) => (
      <Pill tone={s.status === 'intended' ? 'ok' : 'mute'}>
        {s.status}
        {s.verdict === 'correct' ? ' (corrected)' : ''}
      </Pill>
    ),
  },
  {
    key: 'path',
    header: 'Path',
    render: (s) =>
      s.path === null ? <span className="muted">withheld</span> : <code>{s.path}</code>,
  },
  {
    key: 'text',
    header: 'Text',
    render: (s) =>
      s.text === null ? (
        <span className="muted">withheld at your data class</span>
      ) : (
        <pre className="pg-pre">{s.text}</pre>
      ),
  },
];

const goldenColumns: ReadonlyArray<Column<KnowledgeGoldenView>> = [
  { key: 'area', header: 'Area', rowHeader: true, render: (g) => <code>{g.area}</code> },
  {
    key: 'test',
    header: 'Test',
    render: (g) =>
      g.test === null ? <span className="muted">withheld</span> : <code>{g.test}</code>,
  },
  { key: 'subjects', header: 'Subject code', render: (g) => list(g.subjects) },
  {
    key: 'verdict',
    header: 'Card 3',
    render: (g) =>
      g.verdict === null ? (
        <span className="muted">not decided</span>
      ) : (
        <Pill tone={g.verdict === 'accept' ? 'ok' : 'mute'}>{g.verdict}</Pill>
      ),
  },
];

function Repo({ r }: { r: KnowledgeRepoView }) {
  if (r.baseline === null) {
    return (
      <Card title={r.repo}>
        <EmptyState title="No Full baseline yet">
          The system map, code graph and seeds come from a Full onboarding (card 3), which a
          repository reaches only as a level-up after Light.
        </EmptyState>
      </Card>
    );
  }
  const b = r.baseline;
  return (
    <section aria-label={r.repo}>
      <h2>{r.repo}</h2>
      <Card title="Baseline">
        <KeyValue
          rows={[
            ['Commit', <code key="c">{b.baseline_sha.slice(0, 12)}</code>],
            ['Baseline hash', <Hash key="h" value={b.baseline_hash} label="baseline hash" />],
            ['Recorded', shortTime(b.recorded_at)],
            ['Card 3', b.decided ? 'decided' : 'not decided yet'],
            [
              'Onboarding',
              r.s0_id ? (
                <Link key="s" to={`/s0/${r.s0_id}`}>
                  open
                </Link>
              ) : (
                'none'
              ),
            ],
          ]}
        />
      </Card>
      {r.index ? (
        <Card title="Repo index">
          <Stats label={`Repo index of ${r.repo}`}>
            <Stat label="Files indexed" value={r.index.files} />
            <Stat
              label="Never indexed"
              value={r.index.not_indexed}
              detail="a secret, too big or binary"
            />
            <Stat label="Left out of the harvest" value={r.index.excluded_count} />
          </Stats>
          {r.index.excluded.length > 0 ? (
            <ul className="plain" aria-label={`Excluded paths of ${r.repo}`}>
              {r.index.excluded.map((e) => (
                <li key={e.path}>
                  <code>{e.path}</code>{' '}
                  <span className="muted">{e.reason.replaceAll('_', ' ')}</span>
                </li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}
      <Card title="System map" flush>
        <Table
          caption={`Areas of ${r.repo}`}
          columns={areaColumns}
          rows={r.areas}
          rowKey={(a) => a.area}
          empty="No area."
        />
      </Card>
      {r.code_graph ? (
        <Card title="Code graph">
          <Stats label={`Code graph of ${r.repo}`}>
            <Stat label="Files" value={r.code_graph.files} />
            <Stat label="Imports" value={r.code_graph.edges} />
            <Stat label="External imports" value={r.code_graph.external_imports} />
            <Stat
              label="Whole"
              value={r.code_graph.truncated ? 'no' : 'yes'}
              tone={r.code_graph.truncated ? 'warn' : 'ok'}
            />
          </Stats>
          {r.code_graph.area_edges.length > 0 ? (
            <ul className="plain" aria-label={`Area imports of ${r.repo}`}>
              {r.code_graph.area_edges.map((e) => (
                <li key={`${e.from}>${e.to}`}>
                  <code>{e.from}</code> imports <code>{e.to}</code>{' '}
                  <span className="muted">({e.imports})</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">No import crosses an area.</p>
          )}
        </Card>
      ) : null}
      <Card title="Living-spec seeds" flush>
        <Table
          caption={`Seeds of ${r.repo}`}
          columns={seedColumns}
          rows={r.seeds}
          rowKey={(s) => s.seed_id}
          empty="No seed."
        />
      </Card>
      <Card title="Golden-task candidates" flush>
        <Table
          caption={`Golden tasks of ${r.repo}`}
          columns={goldenColumns}
          rows={r.golden}
          rowKey={(g) => g.candidate_id}
          empty="No candidate."
        />
      </Card>
    </section>
  );
}

export function KnowledgePage({ project }: { project: string }) {
  const q = useQuery({ queryKey: ['knowledge', project], queryFn: () => api.knowledge(project) });
  return (
    <>
      <PageHead
        title={`Knowledge of ${project}`}
        crumbs={[
          { label: 'Projects', to: '/' },
          { label: project, to: `/projects/${project}` },
          { label: 'Knowledge' },
        ]}
        sub="What the factory knows about the code, as the record holds it. Seeds and golden tasks reach agents as data, never as instructions."
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
      />
      {q.isPending ? (
        <Loading what="the knowledge" />
      ) : q.isError ? (
        <PageError error={q.error} retry={() => void q.refetch()} />
      ) : (
        <>
          {q.data.data_class === 'D0' ? (
            <p className="notice notice-attention">
              Shown at data class D0: paths and seed text are withheld, areas and counts remain.
            </p>
          ) : null}
          {q.data.repos.length === 0 ? (
            <p className="muted">This project has no repository yet.</p>
          ) : null}
          {q.data.repos.map((r) => (
            <Repo key={r.repo} r={r} />
          ))}
        </>
      )}
    </>
  );
}
