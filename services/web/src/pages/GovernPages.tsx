import { useQuery } from '@tanstack/react-query';
import {
  ACTION_IDS,
  type AuditDecisionRow,
  type CatalogueVersionRow,
  type LedgerAuditEntry,
  type PdpResource,
} from '@aisdlc/contracts';
import { useState } from 'react';
import { api, type Me } from '../api';
import { Loading } from '../components/Notice';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  GateTag,
  KeyValue,
  PageHead,
  Pill,
  Stat,
  Stats,
  Table,
  laneText,
  type Column,
} from '../ui';

// Govern (prototype `ledger`, `audit`, `catalogue`): the signed ledger per project with how each entry
// links to the one before it, the PDP's decision log, and every released catalogue, read-only.

// ---------------------------------------------------------------- ledger

/** Where an entry's `prev_hash` points, judged only from the entries on screen (the full check is offline). */
function chainOf(rows: readonly LedgerAuditEntry[]): Map<number, 'linked' | 'outside' | 'genesis'> {
  const bySeq = new Map(rows.map((r) => [r.ledger_seq, r]));
  return new Map(
    rows.map((r) => {
      if (r.prev_hash === null) return [r.ledger_seq, 'genesis'] as const;
      const before = bySeq.get(r.ledger_seq - 1);
      return [
        r.ledger_seq,
        before && before.entry_hash === r.prev_hash ? 'linked' : 'outside',
      ] as const;
    }),
  );
}

function ProjectLedger({ project }: { project: string }) {
  const q = useQuery({ queryKey: ['ledger', project, null], queryFn: () => api.ledger(project) });
  return (
    <Read q={q} what="the ledger entries">
      {(v) => {
        const chain = chainOf(v.entries);
        const broken = v.entries.filter((e) => {
          const before = v.entries.find((x) => x.ledger_seq === e.ledger_seq - 1);
          return before !== undefined && e.prev_hash !== before.entry_hash;
        });
        const cols: ReadonlyArray<Column<LedgerAuditEntry>> = [
          {
            key: 'seq',
            header: 'Seq',
            rowHeader: true,
            align: 'right',
            render: (e) => e.ledger_seq,
          },
          { key: 'type', header: 'Entry', render: (e) => <code>{e.entry_type}</code> },
          {
            key: 'gate',
            header: 'Gate or step',
            render: (e) => e.gate_id ?? e.step ?? <span className="muted">–</span>,
          },
          { key: 'dec', header: 'Decision', render: (e) => e.decision ?? '–' },
          { key: 'actor', header: 'Actor', render: (e) => e.actor ?? '–' },
          { key: 'at', header: 'Time', render: (e) => shortTime(e.created_at) },
          { key: 'hash', header: 'Entry hash', render: (e) => <ShortHash hash={e.entry_hash} /> },
          {
            key: 'chain',
            header: 'Chain',
            render: (e) => {
              const c = chain.get(e.ledger_seq);
              return c === 'linked' ? (
                <Pill tone="ok">links to #{e.ledger_seq - 1}</Pill>
              ) : c === 'genesis' ? (
                <Pill tone="info">genesis</Pill>
              ) : (
                <Pill tone="mute">previous entry is another project&rsquo;s</Pill>
              );
            },
          },
        ];
        return (
          <>
            <Stats label="This project's ledger">
              <Stat label="Entries" value={v.entries.length} />
              <Stat
                label="Ledger head"
                value={v.head ? `#${v.head.ledger_seq}` : '–'}
                detail={v.head ? `hash ${v.head.entry_hash.slice(0, 12)}` : 'empty ledger'}
              />
              <Stat
                label="Links on screen"
                value={broken.length === 0 ? 'consistent' : `${broken.length} broken`}
                tone={broken.length === 0 ? 'ok' : 'bad'}
                detail="the whole chain and its signatures: verify-ledger, offline"
              />
            </Stats>
            <Card title={`Entries of ${project}`} flush>
              <Table
                caption={`Ledger entries of ${project}`}
                captionHidden
                columns={cols}
                rows={v.entries}
                rowKey={(e) => e.entry_id}
                empty={
                  <EmptyState title="No entries yet">
                    Nothing about this project is on the ledger.
                  </EmptyState>
                }
              />
            </Card>
          </>
        );
      }}
    </Read>
  );
}

export function FleetLedgerPage({ me }: { me: Me }) {
  const fleet = me.actions.fleet.includes('audit.read');
  const projects = useQuery({ queryKey: ['projects'], queryFn: api.projects, enabled: fleet });
  const ids = fleet
    ? (projects.data ?? []).map((p) => p.project.project_id)
    : me.actions.projects.filter((p) => p.actions.includes('audit.read')).map((p) => p.project_id);
  const [pick, setPick] = useState<string | null>(null);
  const project = pick ?? ids[0] ?? null;
  return (
    <>
      <PageHead
        eyebrow="Govern"
        title="Ledger"
        sub="Every decision is an entry on the signed, hash-chained ledger: each entry's hash covers the one before it, so none can change or go without the offline check noticing. You see the projects whose audit views you may read."
      />
      {fleet && projects.isPending ? <Loading what="the projects" /> : null}
      {ids.length === 0 && !(fleet && projects.isPending) ? (
        <EmptyState title="No ledger you may read">
          Ledger reads need audit.read on a project.
        </EmptyState>
      ) : null}
      {ids.length > 0 ? (
        <div className="pg-filters">
          <label>
            Project{' '}
            <select value={project ?? ''} onChange={(e) => setPick(e.target.value)}>
              {ids.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          {project ? (
            <Link to={`/projects/${project}/ledger`}>Open the project&rsquo;s ledger page</Link>
          ) : null}
        </div>
      ) : null}
      {project ? <ProjectLedger key={project} project={project} /> : null}
      <Card title="Verify it yourself">
        <p>
          The portal checks only the links it shows. The whole chain, its checkpoints and the
          Witness signatures are checked offline with <code>verify-ledger</code> (
          <code>dist/verify-ledger.js</code>), which needs nothing from the factory but the public
          keys.
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- audit

const resourceText = (r: PdpResource): string =>
  r.type === 'Fleet'
    ? 'fleet'
    : `${r.type.toLowerCase()} ${r.id}${r.project && r.type !== 'Project' ? ` (${r.project})` : ''}`;

export function AuditPage() {
  const [action, setAction] = useState('');
  const q = useQuery({
    queryKey: ['audit-decisions', action],
    queryFn: () => api.auditDecisions(action || undefined),
  });
  const cols: ReadonlyArray<Column<AuditDecisionRow>> = [
    { key: 'at', header: 'When', rowHeader: true, render: (d) => shortTime(d.at) },
    { key: 'who', header: 'Principal', render: (d) => <code>{d.principal}</code> },
    { key: 'a', header: 'Action', render: (d) => <code>{d.action}</code> },
    { key: 'r', header: 'Resource', render: (d) => resourceText(d.resource) },
    {
      key: 'd',
      header: 'Decision',
      render: (d) => <Pill tone={d.decision === 'allow' ? 'ok' : 'bad'}>{d.decision}</Pill>,
    },
    { key: 'why', header: 'Reasons', render: (d) => d.reasons.join(', ') },
    { key: 'log', header: 'Logged because', render: (d) => d.logged_because },
    { key: 'b', header: 'Bundle', render: (d) => d.bundle_version ?? 'none loaded' },
  ];
  return (
    <>
      <PageHead
        eyebrow="Govern"
        title="Audit"
        sub="The policy decision log: every deny, every allow of an action the catalogue logs, newest first. Capability probes for the portal's buttons are not logged."
      />
      <div className="pg-filters">
        <label>
          Action{' '}
          <select value={action} onChange={(e) => setAction(e.target.value)}>
            <option value="">Every action</option>
            {ACTION_IDS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </label>
      </div>
      <Read q={q} what="the decision log">
        {(v) => (
          <Card title="Decisions" flush>
            <Table
              caption="Policy decisions"
              captionHidden
              columns={cols}
              rows={v.decisions}
              rowKey={(d) => d.decision_id}
              empty={<EmptyState title="No decision logged">Nothing matches.</EmptyState>}
            />
          </Card>
        )}
      </Read>
      <Card title="Not here yet">
        <p className="muted">
          Signed audit exports, pseudonym resolution, erasure and legal hold are the audit services
          of M19 (audit-exporter, audit-backend).
        </p>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- catalogue

function Lanes({ v }: { v: CatalogueVersionRow }) {
  return (
    <Table
      caption={`Lanes of catalogue ${v.ref.version}`}
      captionHidden
      columns={[
        { key: 'l', header: 'Lane', rowHeader: true, render: (l) => laneText(l.lane) },
        { key: 'e', header: 'Enters at', render: (l) => l.enter_at ?? 'human-led' },
        { key: 's', header: 'Stages', render: (l) => l.stages.join(' → ') },
        {
          key: 'g',
          header: 'Gates',
          render: (l) => (
            <ul className="pg-chips">
              {l.gates.map((g) => (
                <li key={`${g.gate}@${g.step}`} title={`${g.presence} at ${g.step}`}>
                  <GateTag gate={g.gate} />
                </li>
              ))}
            </ul>
          ),
        },
      ]}
      rows={v.lanes}
      rowKey={(l) => l.lane}
    />
  );
}

export function CataloguePage() {
  const q = useQuery({ queryKey: ['catalogue'], queryFn: api.catalogue, staleTime: 300_000 });
  const [pick, setPick] = useState<string | null>(null);
  return (
    <>
      <PageHead
        eyebrow="Govern"
        title="Catalogue"
        sub="Lanes, limits and gating as immutable releases. An item pins {version, hash} when it is created and keeps running on exactly that release; a change is a new version, never an edit."
      />
      <Read q={q} what="the catalogue">
        {(v) => {
          const current = v.versions.find((x) => x.current) ?? v.versions.at(-1);
          const shown = v.versions.find((x) => x.ref.version === pick) ?? current;
          return (
            <>
              <Card title="Released versions" flush>
                <Table
                  caption="Catalogue releases"
                  captionHidden
                  columns={[
                    {
                      key: 'v',
                      header: 'Version',
                      rowHeader: true,
                      render: (x) => (
                        <button
                          type="button"
                          className="ui-btn ui-btn-sm"
                          aria-pressed={x.ref.version === shown?.ref.version}
                          onClick={() => setPick(x.ref.version)}
                        >
                          {x.ref.version}
                        </button>
                      ),
                    },
                    {
                      key: 'c',
                      header: 'State',
                      render: (x) =>
                        x.current ? (
                          <Pill tone="ok">new items pin this</Pill>
                        ) : (
                          <Pill tone="mute">pinned only</Pill>
                        ),
                    },
                    { key: 'h', header: 'Hash', render: (x) => <ShortHash hash={x.ref.hash} /> },
                    {
                      key: 'n',
                      header: 'Items pinned',
                      align: 'right',
                      render: (x) => x.pinned_items,
                    },
                  ]}
                  rows={[...v.versions].reverse()}
                  rowKey={(x) => x.ref.version}
                />
              </Card>
              {shown ? (
                <Card title={`Lanes of ${shown.ref.version}`} flush>
                  <KeyValue rows={[['Hash', <code key="h">{shown.ref.hash}</code>]]} />
                  {shown.lanes.length === 0 ? (
                    <p className="muted pg-pad">
                      This release did not verify against its pin, so its lanes are not shown.
                    </p>
                  ) : (
                    <Lanes v={shown} />
                  )}
                </Card>
              ) : null}
            </>
          );
        }}
      </Read>
    </>
  );
}
