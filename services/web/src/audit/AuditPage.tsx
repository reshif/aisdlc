import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import {
  ACTION_IDS,
  label,
  lookupTerm,
  term,
  type AuditDecisionRow,
  type FleetLedgerEntry,
  type FleetLedgerFilter,
  type LedgerAuditEntry,
  type PdpResource,
} from '@aisdlc/contracts';
import { useEffect, useId, useState } from 'react';
import { adminApi, errorText } from '../admin';
import { api, type Me } from '../api';
import { Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import {
  Card,
  CodeChip,
  EmptyState,
  ErrorState,
  PageHeader,
  Pill,
  Table,
  Tabs,
  WireTerm,
  type Column,
} from '../ui';
import { ErasurePanel, ExportsPanel, HoldsPanel, RetentionPanel } from './AuditPanels';

// Decision log & audit (screen map §2.16): the signed record of every decision for auditors and admins. Tabs:
// Decision log (the fleet's ledger, newest first, with the factory admin's overrides and their reasons and the
// deletions; N25), Access decisions (the policy's sampled decisions), Exports, Legal holds, Deletions (object
// deletions in the log, and personal-data erasure requests), Retention. A project's own readers (audit.read on a
// project only) get the decision log of their projects. Codes show here as small chips: this is an audit screen.

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

const TABS = [
  { id: 'log', label: label('screen', 'decision_log') },
  { id: 'access', label: label('screen', 'access_decisions') },
  { id: 'exports', label: 'Exports' },
  { id: 'holds', label: 'Legal holds' },
  { id: 'deletions', label: label('concept', 'deletion') + 's' },
  { id: 'retention', label: 'Retention' },
] as const;
type TabId = (typeof TABS)[number]['id'];

const tabOf = (): TabId => {
  const t = new URLSearchParams(window.location.search).get('tab');
  return (TABS.find((x) => x.id === t)?.id ?? 'log') as TabId;
};

/** What an entry is, in words (the entry type follows as a chip). */
export function entryWords(type: string): string {
  if (type === 'decision' || type === 'gate.decision') return 'Approval decided';
  if (type === 'card.step_decision') return 'Onboarding step decided';
  if (type === 'config_publish') return 'Settings change in force';
  if (type.startsWith('access.')) return 'Access changed';
  if (type === 'admin.override') return label('concept', 'override');
  if (type === 'deletion.performed') return label('concept', 'deletion');
  if (type === 'redacted') return label('concept', 'redacted');
  if (type === 'evidence.pack_signed') return 'Evidence signed';
  if (type === 'push.receipt') return 'Branch pushed';
  if (type === 'kill.event') return 'Emergency stop';
  if (type === 'ops.action') return 'Operations action';
  if (type === 'closeout.recorded') return 'Final record kept';
  if (type === 'secret.stored') return 'Secret stored';
  if (type.startsWith('prr.')) return 'Readiness changed';
  return 'Recorded';
}

const KIND_WORDS: Readonly<Record<string, string>> = {
  project: label('concept', 'project'),
  repo: label('concept', 'repo'),
  item: label('concept', 'work_item'),
  person: label('concept', 'person'),
  team: label('concept', 'team'),
  binding: label('concept', 'role_assignment'),
};

function useNames(enabled: boolean): (id: string | null) => string {
  const q = useQuery({ queryKey: ['people'], queryFn: adminApi.people, enabled, retry: false });
  const m = new Map((q.data?.people ?? []).map((p) => [p.principal_id as string, p.display_name]));
  return (id) =>
    id === null
      ? '—'
      : id.startsWith('deleted.')
        ? label('concept', 'deleted_person')
        : (m.get(id) ?? id);
}

function LogTable({
  rows,
  caption,
  name,
}: {
  rows: readonly FleetLedgerEntry[];
  caption: string;
  name: (id: string | null) => string;
}) {
  const cols: ReadonlyArray<Column<FleetLedgerEntry>> = [
    {
      key: 'seq',
      header: '#',
      align: 'right',
      rowHeader: true,
      render: (e) => e.ledger_seq.toLocaleString('en'),
    },
    {
      key: 'at',
      header: 'When',
      render: (e) => (
        <time dateTime={e.created_at}>
          {new Date(e.created_at).toISOString().replace('T', ' ').slice(0, 19)} UTC
        </time>
      ),
    },
    { key: 'who', header: 'Who', render: (e) => name(e.actor) },
    {
      key: 'what',
      header: 'What',
      render: (e) => (
        <>
          {entryWords(e.entry_type)} <CodeChip code={e.entry_type} />
          {e.gate_id ? (
            <div>
              <WireTerm family="gate" value={e.gate_id} showCode audience="audit" />
              {e.decision ? (
                <>
                  {' · '}
                  <WireTerm family="decision" value={e.decision} />
                </>
              ) : null}
            </div>
          ) : e.decision ? (
            <div>
              <WireTerm family="decision" value={e.decision} />
            </div>
          ) : null}
          {e.deletion ? (
            <div className="adm-muted">
              {KIND_WORDS[e.deletion.kind] ?? 'Object'} deleted; {e.deletion.redacted}{' '}
              {e.deletion.redacted === 1 ? 'entry' : 'entries'} now hash only
            </div>
          ) : null}
        </>
      ),
    },
    {
      key: 'sub',
      header: 'Subject',
      render: (e) =>
        e.entry_type === 'redacted' ? (
          <span className="adm-muted">{term('concept', 'redacted').explain}</span>
        ) : e.subject_id ? (
          <span className="ui-mono">{e.subject_id}</span>
        ) : (
          '—'
        ),
    },
    {
      key: 'why',
      header: 'Override',
      render: (e) =>
        e.override_reason || e.deletion?.override ? (
          <>
            <Pill tone="warn">{label('concept', 'override')}</Pill>
            {e.override_reason ? <div>“{e.override_reason}”</div> : null}
          </>
        ) : null,
    },
    {
      key: 'hash',
      header: 'Hash',
      render: (e) => (
        <span className="adm-hash" title={e.entry_hash}>
          {e.entry_hash.slice(0, 12)}
        </span>
      ),
    },
  ];
  return (
    <Table
      caption={caption}
      captionHidden
      columns={cols}
      rows={rows}
      rowKey={(e) => e.entry_id}
      empty={<EmptyState title="Nothing here yet">No entry matches.</EmptyState>}
    />
  );
}

const FILTERS: ReadonlyArray<{ id: FleetLedgerFilter; label: string }> = [
  { id: 'all', label: 'Everything' },
  { id: 'decisions', label: 'Decisions' },
  { id: 'overrides', label: label('concept', 'override') + 's' },
  { id: 'access', label: 'Access changes' },
  { id: 'deletions', label: label('concept', 'deletion') + 's' },
];

function FleetLog({ me, filter: fixed }: { me: Me; filter?: FleetLedgerFilter }) {
  const [filter, setFilter] = useState<FleetLedgerFilter>(fixed ?? 'all');
  const name = useNames(me.actions.fleet.includes('audit.read'));
  const q = useInfiniteQuery({
    queryKey: ['fleet-ledger', filter],
    queryFn: ({ pageParam }) => adminApi.ledger(filter, pageParam),
    initialPageParam: null as number | null,
    getNextPageParam: (last) => last.next_before,
  });
  const rows = q.data?.pages.flatMap((p) => p.entries) ?? [];
  const head = q.data?.pages[0]?.head ?? null;
  return (
    <>
      {fixed ? null : (
        <div className="adm-filters" role="group" aria-label="Show">
          {FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className="ui-btn ui-btn-sm"
              aria-pressed={filter === f.id}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
        </div>
      )}
      {head ? (
        <p className="ui-help" style={{ margin: '0 0 10px' }}>
          The log has {head.ledger_seq.toLocaleString('en')} entries; newest hash{' '}
          <span className="adm-hash">{head.entry_hash.slice(0, 12)}</span>. Every entry is signed
          and linked to the one before; the whole chain is verified offline with the factory’s
          public keys.
        </p>
      ) : null}
      {q.isPending ? (
        <Loading what="the decision log" />
      ) : q.isError ? (
        <p className="adm-note" role="alert">
          {errorText(q.error)}
        </p>
      ) : (
        <Card flush>
          <LogTable rows={rows} caption="Decision log" name={name} />
          {q.hasNextPage ? (
            <div style={{ padding: '12px 16px' }}>
              <button
                type="button"
                className="ui-btn"
                disabled={q.isFetchingNextPage}
                onClick={() => void q.fetchNextPage()}
              >
                Show older entries
              </button>
            </div>
          ) : null}
        </Card>
      )}
    </>
  );
}

const asFleet = (e: LedgerAuditEntry): FleetLedgerEntry => ({
  ...e,
  override_reason: null,
  deletion: null,
});

/** A project reader's log: the entries of the projects where they may read the audit trail. */
function ProjectLog({ me }: { me: Me }) {
  const id = useId();
  const ids = me.actions.projects
    .filter((p) => p.actions.includes('audit.read'))
    .map((p) => p.project_id);
  const [pick, setPick] = useState('');
  const project = pick || ids[0] || '';
  const q = useQuery({
    queryKey: ['ledger', project, null],
    queryFn: () => api.ledger(project),
    enabled: project !== '',
  });
  const name = useNames(false);
  if (ids.length === 0) {
    return (
      <EmptyState title="No decision log you may read">
        Reading it needs a role that reads a project’s audit trail.
      </EmptyState>
    );
  }
  return (
    <>
      <div className="adm-tools">
        <label htmlFor={id}>
          <span className="ui-label">{label('concept', 'project')}</span>
          <select
            id={id}
            className="ui-select"
            value={project}
            onChange={(e) => setPick(e.target.value)}
          >
            {ids.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.isPending ? (
        <Loading what="the decision log" />
      ) : q.isError ? (
        <p className="adm-note" role="alert">
          {errorText(q.error)}
        </p>
      ) : (
        <Card flush>
          <LogTable
            rows={[...q.data.entries].reverse().map(asFleet)}
            caption={`Decision log of ${project}`}
            name={name}
          />
        </Card>
      )}
    </>
  );
}

const resourceWords = (r: PdpResource): string =>
  r.type === 'Fleet'
    ? label('concept', 'role_scope_fleet')
    : r.type === 'Project'
      ? `${label('concept', 'project')} ${r.id}`
      : `${r.type} ${r.id}${r.project ? ` (${r.project})` : ''}`;

const BECAUSE: Readonly<Record<AuditDecisionRow['logged_because'], string>> = {
  deny: 'A refusal',
  action: 'Always logged',
  override: label('concept', 'override'),
  sampled: 'Sampled',
};

function AccessDecisions({ me }: { me: Me }) {
  const id = useId();
  const [action, setAction] = useState('');
  const name = useNames(true);
  const q = useQuery({
    queryKey: ['audit-decisions', action],
    queryFn: () => api.auditDecisions(action || undefined),
  });
  void me;
  const cols: ReadonlyArray<Column<AuditDecisionRow>> = [
    { key: 'at', header: 'When', rowHeader: true, render: (d) => shortTime(d.at) },
    { key: 'who', header: 'Who', render: (d) => name(d.principal) },
    {
      key: 'a',
      header: 'Asked to',
      render: (d) => (
        <>
          <WireTerm family="action" value={d.action} showCode audience="audit" />
        </>
      ),
    },
    { key: 'r', header: 'On', render: (d) => resourceWords(d.resource) },
    {
      key: 'd',
      header: 'Answer',
      render: (d) => (
        <Pill tone={d.decision === 'allow' ? 'ok' : 'bad'}>
          {d.decision === 'allow' ? 'Allowed' : 'Refused'}
        </Pill>
      ),
    },
    { key: 'b', header: 'Logged as', render: (d) => BECAUSE[d.logged_because] },
  ];
  return (
    <>
      <p className="ui-help" style={{ margin: '0 0 10px' }}>
        Every refusal, every allow of an action that is always logged, every factory admin override,
        and a sample of the rest, newest first.
      </p>
      <div className="adm-tools">
        <label htmlFor={id}>
          <span className="ui-label">Action</span>
          <select
            id={id}
            className="ui-select"
            value={action}
            onChange={(e) => setAction(e.target.value)}
          >
            <option value="">Every action</option>
            {ACTION_IDS.map((a) => (
              <option key={a} value={a}>
                {lookupTerm('action', a)?.label ?? a}
              </option>
            ))}
          </select>
        </label>
      </div>
      {q.isPending ? (
        <Loading what="the access decisions" />
      ) : q.isError ? (
        <p className="adm-note" role="alert">
          {errorText(q.error)}
        </p>
      ) : (
        <Card flush>
          <Table
            caption="Access decisions"
            captionHidden
            columns={cols}
            rows={q.data.decisions}
            rowKey={(d) => d.decision_id}
            empty={<EmptyState title="No decision logged">Nothing matches.</EmptyState>}
          />
        </Card>
      )}
    </>
  );
}

export function AuditPage({ me }: { me: Me }) {
  const fleet = me.actions.fleet.includes('audit.read');
  const [tab, setTab] = useState<TabId>(tabOf);
  useEffect(() => {
    const url = new URL(window.location.href);
    url.searchParams.set('tab', tab);
    window.history.replaceState(null, '', `${url.pathname}${url.search}`);
  }, [tab]);
  const project = me.actions.projects.some((p) => p.actions.includes('audit.read'));
  if (!fleet && !project) {
    return (
      <ErrorState
        status={403}
        reason="Reading the decision log needs a role that reads the audit trail."
        action={<Link to="/me/access">See my access</Link>}
      />
    );
  }
  return (
    <>
      <PageHeader
        title={label('screen', 'audit_log')}
        meta="The signed record of every decision: who, what, when and why. Nothing in it can change."
        renderLink={renderLink}
      />
      {fleet ? (
        <Tabs
          label={label('screen', 'audit_log')}
          tabs={TABS}
          selected={tab}
          onSelect={(t) => setTab(t as TabId)}
        >
          {tab === 'log' ? (
            <FleetLog me={me} />
          ) : tab === 'access' ? (
            <AccessDecisions me={me} />
          ) : tab === 'exports' ? (
            <ExportsPanel csrf={me.csrf_token} />
          ) : tab === 'holds' ? (
            <HoldsPanel csrf={me.csrf_token} />
          ) : tab === 'deletions' ? (
            <div className="adm-stack">
              <p className="ui-help" style={{ margin: 0 }}>
                Deleting removes an object and all its data for good. The log keeps a deletion entry
                (who, when, why, by hash; no name) and each deleted entry as its hash only, so the
                chain still verifies.
              </p>
              <FleetLog me={me} filter="deletions" />
              <ErasurePanel csrf={me.csrf_token} />
            </div>
          ) : (
            <RetentionPanel />
          )}
        </Tabs>
      ) : (
        <ProjectLog me={me} />
      )}
    </>
  );
}
