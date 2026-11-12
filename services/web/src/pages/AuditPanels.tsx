import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AUDIT_ACTION,
  auditScopeText,
  legalHoldScopeText,
  pdpResource,
  type AuditExportView,
  type ErasureView,
  type LegalHoldScope,
  type LegalHoldView,
} from '@aisdlc/contracts';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Guarded } from '../access';
import { Read, ShortHash } from '../components/Read';
import { describeError, shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, KeyValue, Pill, Table, type Column, type PillTone } from '../ui';

// Govern › Audit (PLAN M19; design reference: the prototype's `audit` view): signed exports for auditors, erasure of
// the payloads kept off the hash chain, legal holds and retention, over the audit service through the bff. The
// buttons are hints from the PDP (`Guarded`); every write is decided again by the bff and by the audit service.
// Erasure and holds are guarded by `identity.admin` on the fleet (`AUDIT_ACTION.govern`), the action the server decides
// them under.

const FLEET = pdpResource.fleet();
const GOVERN = AUDIT_ACTION.govern;

const dayStart = (d: string) => `${d}T00:00:00.000Z`;
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
const tomorrow = () => new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

// ---------------------------------------------------------------- exports

function ExportForm({ csrf }: { csrf: string }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<'fleet' | 'project'>('project');
  const [project, setProject] = useState('');
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(tomorrow());
  const [reason, setReason] = useState('');
  const write = useMutation({
    mutationFn: () =>
      api.writeAuditExport(
        {
          scope:
            kind === 'fleet'
              ? { kind: 'fleet' }
              : { kind: 'project', project_id: project as never },
          from: dayStart(from),
          to: dayStart(to),
          reason,
        },
        csrf,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['audit-exports'] }),
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    write.mutate();
  };
  return (
    <form className="pg-form" onSubmit={submit} aria-label="Request an export">
      <label>
        Scope
        <select value={kind} onChange={(e) => setKind(e.target.value as 'fleet' | 'project')}>
          <option value="project">one project</option>
          <option value="fleet">the whole factory</option>
        </select>
      </label>
      {kind === 'project' ? (
        <label>
          Project
          <input value={project} onChange={(e) => setProject(e.target.value)} required />
        </label>
      ) : null}
      <label>
        From (UTC day)
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} required />
      </label>
      <label>
        To, not included
        <input
          type="date"
          value={to}
          max={tomorrow()}
          onChange={(e) => setTo(e.target.value)}
          required
        />
      </label>
      <label>
        Why
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="SOC 2 sample, access review"
          required
        />
      </label>
      <button type="submit" className="ui-btn ui-btn-primary" disabled={write.isPending}>
        Write the export
      </button>
      {write.isError ? <p role="alert">{describeError(write.error)}</p> : null}
      {write.isSuccess ? (
        <p role="status">
          Export written: {write.data.entries} ledger entries and {write.data.events} record events,
          signed, in the write-once store, on the ledger at #{write.data.entry_seq}.
        </p>
      ) : null}
    </form>
  );
}

export function ExportsPanel({ csrf }: { csrf: string }) {
  const q = useQuery({ queryKey: ['audit-exports'], queryFn: api.auditExports });
  const cols: ReadonlyArray<Column<AuditExportView>> = [
    {
      key: 'id',
      header: 'Export',
      rowHeader: true,
      render: (x) => <ShortHash hash={x.export_id} />,
    },
    { key: 'scope', header: 'Scope', render: (x) => auditScopeText(x.scope) },
    {
      key: 'range',
      header: 'Range',
      render: (x) => `${x.from.slice(0, 10)} to ${x.to.slice(0, 10)}`,
    },
    { key: 'by', header: 'Requested by', render: (x) => <code>{x.requested_by}</code> },
    { key: 'n', header: 'Contents', render: (x) => `${x.entries} entries, ${x.events} events` },
    {
      key: 'cp',
      header: 'Anchored to',
      render: (x) =>
        `checkpoint ${x.checkpoint_seq} (1..${x.covered_to})${x.uncovered > 0 ? `, ${x.uncovered} after it` : ''}`,
    },
    { key: 'hash', header: 'Package', render: (x) => <ShortHash hash={x.export_sha256} /> },
    { key: 'seq', header: 'Ledger', render: (x) => `#${x.entry_seq}` },
    {
      key: 'dl',
      header: 'Signed file',
      render: (x) => (
        <a href={api.auditExportHref(x.export_id)} download>
          Download
        </a>
      ),
    },
    { key: 'at', header: 'When', render: (x) => shortTime(x.produced_at) },
  ];
  return (
    <>
      <Read q={q} what="the exports">
        {(v) => (
          <Card
            title="Signed exports"
            flush
            actions={<span className="muted">ledger type audit.export</span>}
          >
            <Table
              caption="Signed exports"
              captionHidden
              columns={cols}
              rows={v.exports}
              rowKey={(x) => x.export_id}
              empty={<EmptyState title="No export yet">Write one below.</EmptyState>}
            />
          </Card>
        )}
      </Read>
      <Card title="Request an export">
        <p className="muted">
          The package holds the scope&rsquo;s ledger entries in full, the hash of every entry up to
          the newest checkpoint (co-signed by the Notary and the Witness) and the record events with
          their hash links. The Notary signs it; it is written once and can never be changed or
          deleted. Check a download offline with{' '}
          <code>
            aisdlc verify-export --file &lt;file&gt; --notary-key &lt;jwk&gt; --witness-key
            &lt;jwk&gt;
          </code>
          .
        </p>
        <Guarded action={AUDIT_ACTION.export} resource={FLEET} label="Write the export">
          <ExportForm csrf={csrf} />
        </Guarded>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- erasure

const ERASURE_TONE: Record<ErasureView['state'], PillTone> = {
  requested: 'gate',
  blocked: 'bad',
  approved: 'warn',
  executed: 'ok',
  rejected: 'mute',
};

function ErasureDecide({ e, csrf }: { e: ErasureView; csrf: string }) {
  const qc = useQueryClient();
  const [matter, setMatter] = useState('');
  const [reason, setReason] = useState('');
  const done = () => void qc.invalidateQueries({ queryKey: ['audit-erasures'] });
  const approve = useMutation({
    mutationFn: () => api.approveErasure(e.erasure_id, { matter_ref: matter, reason }, csrf),
    onSettled: done,
  });
  const reject = useMutation({
    mutationFn: () => api.rejectErasure(e.erasure_id, reason, csrf),
    onSettled: done,
  });
  if (e.state !== 'requested' && e.state !== 'blocked') return null;
  const err = approve.error ?? reject.error;
  return (
    <Guarded action={GOVERN} resource={FLEET} mode="hide">
      <form
        className="pg-inline"
        onSubmit={(ev) => {
          ev.preventDefault();
          approve.mutate();
        }}
      >
        <label>
          <span className="ui-sr">Matter reference for erasure {e.erasure_id}</span>
          <input
            value={matter}
            onChange={(ev) => setMatter(ev.target.value)}
            placeholder="LA-112"
          />
        </label>
        <label>
          <span className="ui-sr">Reason for erasure {e.erasure_id}</span>
          <input
            value={reason}
            onChange={(ev) => setReason(ev.target.value)}
            placeholder="reason"
            required
          />
        </label>
        <button
          type="submit"
          className="ui-btn ui-btn-sm ui-btn-danger"
          disabled={approve.isPending || matter === ''}
        >
          Approve and erase
        </button>
        <button
          type="button"
          className="ui-btn ui-btn-sm"
          disabled={reject.isPending || reason === ''}
          onClick={() => reject.mutate()}
        >
          Reject
        </button>
        {err ? <span role="alert">{describeError(err)}</span> : null}
      </form>
    </Guarded>
  );
}

function ErasureForm({ csrf }: { csrf: string }) {
  const qc = useQueryClient();
  const [principal, setPrincipal] = useState('');
  const [project, setProject] = useState('');
  const [reason, setReason] = useState('');
  const ask = useMutation({
    mutationFn: () =>
      api.requestErasure(
        {
          subject: {
            principal_id: principal as never,
            project_id: project === '' ? null : (project as never),
          },
          reason,
        },
        csrf,
      ),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['audit-erasures'] }),
  });
  return (
    <form
      className="pg-form"
      aria-label="Request an erasure"
      onSubmit={(e) => {
        e.preventDefault();
        ask.mutate();
      }}
    >
      <label>
        Whose payloads (principal id)
        <input value={principal} onChange={(e) => setPrincipal(e.target.value)} required />
      </label>
      <label>
        Only in project (optional)
        <input value={project} onChange={(e) => setProject(e.target.value)} />
      </label>
      <label>
        Why
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="SAR-9"
          required
        />
      </label>
      <button type="submit" className="ui-btn ui-btn-primary" disabled={ask.isPending}>
        Request the erasure
      </button>
      {ask.isError ? <p role="alert">{describeError(ask.error)}</p> : null}
      {ask.isSuccess ? (
        <p role="status">
          Requested: {ask.data.targets.length} payloads found. A second factory admin gives the
          legal approval.
        </p>
      ) : null}
    </form>
  );
}

export function ErasurePanel({ csrf }: { csrf: string }) {
  const q = useQuery({ queryKey: ['audit-erasures'], queryFn: api.erasures });
  const cols: ReadonlyArray<Column<ErasureView>> = [
    {
      key: 'id',
      header: 'Request',
      rowHeader: true,
      render: (x) => <ShortHash hash={x.erasure_id} />,
    },
    {
      key: 'subject',
      header: 'Subject',
      render: (x) =>
        x.subject === null ? (
          <span className="muted">retention</span>
        ) : (
          <>
            <code>{x.subject.principal_id}</code>
            {x.subject.project_id ? ` in ${x.subject.project_id}` : ''}
          </>
        ),
    },
    { key: 'by', header: 'Requested by', render: (x) => <code>{x.requested_by}</code> },
    {
      key: 'legal',
      header: 'Legal approval',
      render: (x) =>
        x.approved_by ? (
          <>
            <code>{x.approved_by}</code>
            {x.matter_ref ? ` under ${x.matter_ref}` : ''}
          </>
        ) : (
          <span className="muted">none yet</span>
        ),
    },
    {
      key: 'n',
      header: 'Payloads',
      render: (x) => `${x.targets.filter((t) => t.erased).length} of ${x.targets.length} erased`,
    },
    {
      key: 'seq',
      header: 'Ledger',
      render: (x) => (x.entry_seq === null ? '—' : `#${x.entry_seq}`),
    },
    {
      key: 'state',
      header: 'State',
      render: (x) => (
        <>
          <Pill tone={ERASURE_TONE[x.state]}>{x.state}</Pill>
          {x.state === 'blocked' ? <span className="muted"> legal hold</span> : null}
        </>
      ),
    },
    { key: 'act', header: 'Decide', render: (x) => <ErasureDecide e={x} csrf={csrf} /> },
  ];
  return (
    <>
      <Read q={q} what="the erasure requests">
        {(v) => (
          <Card
            title="Erasure requests"
            flush
            actions={<span className="muted">ledger type erasure.execute</span>}
          >
            <Table
              caption="Erasure requests"
              captionHidden
              columns={cols}
              rows={v.erasures}
              rowKey={(x) => x.erasure_id}
              empty={<EmptyState title="No erasure request">Nothing has been asked.</EmptyState>}
            />
          </Card>
        )}
      </Read>
      <Card title="Request an erasure">
        <p className="muted">
          Erasure removes only the payloads kept off the hash chain (what a person typed to the
          assistant and its answers): their text goes, their hash stays, so the record and the
          ledger still verify. A record event or a ledger entry is never erased. A second factory
          admin approves under a matter reference; the approval is the <code>erasure.execute</code>{' '}
          ledger entry, written before anything is erased. A legal hold over the person, their
          project or the factory refuses it.
        </p>
        <Guarded action={GOVERN} resource={FLEET} label="Request the erasure">
          <ErasureForm csrf={csrf} />
        </Guarded>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- legal holds

function ReleaseHold({ h, csrf }: { h: LegalHoldView; csrf: string }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const release = useMutation({
    mutationFn: () => api.releaseHold(h.hold_id, reason, csrf),
    onSettled: () => void qc.invalidateQueries({ queryKey: ['audit-holds'] }),
  });
  if (h.state !== 'active') return null;
  return (
    <Guarded action={GOVERN} resource={FLEET} mode="hide">
      <form
        className="pg-inline"
        onSubmit={(e) => {
          e.preventDefault();
          release.mutate();
        }}
      >
        <label>
          <span className="ui-sr">Why release hold {h.matter_ref}</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="reason"
            required
          />
        </label>
        <button type="submit" className="ui-btn ui-btn-sm" disabled={release.isPending}>
          Release
        </button>
        {release.isError ? <span role="alert">{describeError(release.error)}</span> : null}
      </form>
    </Guarded>
  );
}

function HoldForm({ csrf }: { csrf: string }) {
  const qc = useQueryClient();
  const [kind, setKind] = useState<LegalHoldScope['kind']>('principal');
  const [ref, setRef] = useState('');
  const [matter, setMatter] = useState('');
  const [reason, setReason] = useState('');
  const scope = (): LegalHoldScope =>
    kind === 'fleet'
      ? { kind: 'fleet' }
      : kind === 'project'
        ? { kind: 'project', project_id: ref as never }
        : { kind: 'principal', principal_id: ref as never };
  const place = useMutation({
    mutationFn: () => api.placeHold({ scope: scope(), matter_ref: matter, reason }, csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['audit-holds'] }),
  });
  return (
    <form
      className="pg-form"
      aria-label="Place a legal hold"
      onSubmit={(e) => {
        e.preventDefault();
        place.mutate();
      }}
    >
      <label>
        Over
        <select value={kind} onChange={(e) => setKind(e.target.value as LegalHoldScope['kind'])}>
          <option value="principal">a person</option>
          <option value="project">a project</option>
          <option value="fleet">the whole factory</option>
        </select>
      </label>
      {kind === 'fleet' ? null : (
        <label>
          {kind === 'project' ? 'Project' : 'Principal id'}
          <input value={ref} onChange={(e) => setRef(e.target.value)} required />
        </label>
      )}
      <label>
        Matter reference
        <input
          value={matter}
          onChange={(e) => setMatter(e.target.value)}
          placeholder="LA-115"
          required
        />
      </label>
      <label>
        Why
        <input value={reason} onChange={(e) => setReason(e.target.value)} required />
      </label>
      <button type="submit" className="ui-btn ui-btn-primary" disabled={place.isPending}>
        Place the hold
      </button>
      {place.isError ? <p role="alert">{describeError(place.error)}</p> : null}
    </form>
  );
}

export function HoldsPanel({ csrf }: { csrf: string }) {
  const q = useQuery({ queryKey: ['audit-holds'], queryFn: api.legalHolds });
  const cols: ReadonlyArray<Column<LegalHoldView>> = [
    { key: 'm', header: 'Matter', rowHeader: true, render: (x) => <code>{x.matter_ref}</code> },
    { key: 's', header: 'Scope', render: (x) => legalHoldScopeText(x.scope) },
    { key: 'r', header: 'Why', render: (x) => x.reason },
    { key: 'by', header: 'Placed by', render: (x) => <code>{x.placed_by}</code> },
    { key: 'at', header: 'Since', render: (x) => shortTime(x.placed_at) },
    {
      key: 'st',
      header: 'State',
      render: (x) => (
        <>
          <Pill tone={x.state === 'active' ? 'warn' : 'mute'}>{x.state}</Pill>
          {x.released_by ? (
            <span className="muted">
              {' '}
              by <code>{x.released_by}</code>
            </span>
          ) : null}
        </>
      ),
    },
    {
      key: 'l',
      header: 'Ledger',
      render: (x) =>
        `#${x.place_entry_seq}${x.release_entry_seq ? `, #${x.release_entry_seq}` : ''}`,
    },
    { key: 'act', header: 'Release', render: (x) => <ReleaseHold h={x} csrf={csrf} /> },
  ];
  return (
    <>
      <Read q={q} what="the legal holds">
        {(v) => (
          <Card title="Legal holds" flush>
            <Table
              caption="Legal holds"
              captionHidden
              columns={cols}
              rows={v.holds}
              rowKey={(x) => x.hold_id}
              empty={<EmptyState title="No legal hold">Nothing is held.</EmptyState>}
            />
          </Card>
        )}
      </Read>
      <Card title="Place a legal hold">
        <p className="muted">
          While a hold is active no payload it covers is erased, by a request or by retention.
          Releasing it needs a second factory admin: the person who placed a hold does not release
          it.
        </p>
        <Guarded action={GOVERN} resource={FLEET} label="Place the hold">
          <HoldForm csrf={csrf} />
        </Guarded>
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- retention

export function RetentionPanel() {
  const q = useQuery({ queryKey: ['audit-retention'], queryFn: api.retention });
  return (
    <Read q={q} what="the retention classes">
      {(v) => {
        const days = v.config.classes.conversation_payload.days;
        return (
          <>
            <Card title="Retention classes">
              <KeyValue
                rows={[
                  [
                    'conversation_payload',
                    days === null
                      ? 'kept until an erasure request (no class set)'
                      : `${days} days, then erased by the sweep`,
                  ],
                  [
                    'ledger, record, signed exports',
                    'kept for ever: never swept (exports are under Object Lock)',
                  ],
                  [
                    'From revision',
                    v.rev_hash === null ? (
                      'the default (nothing published)'
                    ) : (
                      <ShortHash key="r" hash={v.rev_hash} />
                    ),
                  ],
                ]}
              />
              <p className="muted">
                The classes are configuration (<code>audit.retention</code>): a change is a factory
                revision with its M1 gate.{' '}
                <Link to="/config/audit.retention">Change them in Configuration</Link>. A legal hold
                always wins over a class.
              </p>
            </Card>
            <Card title="Last sweeps" flush>
              <Table
                caption="Retention sweeps"
                captionHidden
                columns={[
                  { key: 'at', header: 'When', rowHeader: true, render: (x) => shortTime(x.at) },
                  { key: 'c', header: 'Class', render: (x) => <code>{x.class}</code> },
                  { key: 'd', header: 'Older than', render: (x) => `${x.days} days` },
                  { key: 'n', header: 'Erased', render: (x) => String(x.due) },
                  { key: 'h', header: 'Kept under a hold', render: (x) => String(x.held) },
                ]}
                rows={v.last_sweeps}
                rowKey={(x) => x.at}
                empty={<EmptyState title="No sweep yet">Nothing was due.</EmptyState>}
              />
            </Card>
          </>
        );
      }}
    </Read>
  );
}
