import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ControlKindValues,
  HOLD_DESCRIPTIONS,
  SANDBOX_PROFILES,
  SandboxClassValues,
  pdpResource,
  type AdmissionGrant,
  type HealthTile,
  type ControlKind,
  type OpsControl,
  type OpsPreview,
  type PdpResource,
  type Scope,
} from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Guarded } from '../access';
import { ErrorNote, Loading } from '../components/Notice';
import { NotBuilt, Read, ShortHash, itemKey } from '../components/Read';
import { describeError, shortTime } from '../format';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  KeyValue,
  PageHead,
  Pill,
  Stat,
  Stats,
  Table,
  useToast,
  type Column,
  type PillTone,
} from '../ui';
import { IntegrationTiles } from './QualityPages';

// Operate (prototype `capacity`, `sessions`, `controls`, `kill`, `health`): the scheduler's admission
// state (H1–H3, WIP, HUMAN-WAIT), the sandbox-controller's slots and caps, the control plane with its
// preview → nonce → apply, the kill switch's journal as core observed it, and the health tiles. Reads
// are `audit.read` on the fleet; a control is `control.apply` / `control.lift` on its scope.

// ---------------------------------------------------------------- scheduler

const GRANT_COLS: ReadonlyArray<Column<AdmissionGrant>> = [
  {
    key: 'item',
    header: 'Item',
    rowHeader: true,
    render: (g) => <Link to={`/items/${g.item_id}`}>{itemKey(g.item_id)}</Link>,
  },
  {
    key: 'unit',
    header: 'Unit',
    render: (g) => <code>{g.unit_id.split(':')[1] ?? g.unit_id}</code>,
  },
  { key: 'project', header: 'Project', render: (g) => g.project_id },
  { key: 'epoch', header: 'Lease epoch', align: 'right', render: (g) => g.lease_epoch },
  { key: 'since', header: 'Granted', render: (g) => shortTime(g.granted_at) },
];

export function SchedulerPage() {
  const q = useQuery({ queryKey: ['admission'], queryFn: api.admission, refetchInterval: 10_000 });
  return (
    <>
      <PageHead
        eyebrow="Operate"
        title="Scheduler"
        sub="Admission at 6.0: a Unit runs only with an approver slot free (H1), a coding slot free (H2), its envelope reserved (H3) and no other holder of its lease (WIP). People set the limits; core decides admission; the sandbox-controller only places sessions."
        actions={
          <Link to="/sandboxes" className="ui-btn">
            Sandboxes
          </Link>
        }
      />
      <Read q={q} what="the admission state">
        {(v) => (
          <>
            <Stats label="Admission">
              <Stat
                label="Coding slot"
                value={`${v.sessions_in_slot} / ${v.coding_session_cap}`}
                detail="sessions in a slot / the cap (H2)"
                {...(v.sessions_in_slot >= v.coding_session_cap ? { tone: 'warn' as const } : {})}
              />
              <Stat label="Held items" value={v.held.length} detail="H1–H3, WIP, kill, control" />
              <Stat
                label="HUMAN-WAIT"
                value={v.waiting.length}
                detail="slot and lease released, snapshot kept, envelope clock paused"
              />
              <Stat
                label="As of"
                value={shortTime(v.as_of).slice(11)}
                detail={shortTime(v.as_of).slice(0, 10)}
              />
            </Stats>
            <Card title="Held" flush>
              <Table
                caption="Held items"
                captionHidden
                columns={[
                  {
                    key: 'item',
                    header: 'Item',
                    rowHeader: true,
                    render: (h) => <Link to={`/items/${h.item_id}`}>{itemKey(h.item_id)}</Link>,
                  },
                  { key: 'p', header: 'Project', render: (h) => h.project_id },
                  { key: 'at', header: 'Resumes to', render: (h) => h.underlying },
                  {
                    key: 'why',
                    header: 'Why',
                    render: (h) => (
                      <ul className="pg-chips">
                        {h.reasons.map((r) => (
                          <li key={r} title={HOLD_DESCRIPTIONS[r] ?? r}>
                            <Pill tone="warn">{r}</Pill>
                          </li>
                        ))}
                      </ul>
                    ),
                  },
                  {
                    key: 'since',
                    header: 'Since',
                    render: (h) => (h.since ? shortTime(h.since) : '–'),
                  },
                ]}
                rows={v.held}
                rowKey={(h) => h.item_id}
                empty={<EmptyState title="Nothing is held">No item waits on a hold.</EmptyState>}
              />
            </Card>
            <div className="pg-split">
              <Card title="In a slot" flush>
                <Table
                  caption="Active grants"
                  captionHidden
                  columns={GRANT_COLS}
                  rows={v.active}
                  rowKey={(g) => g.grant_id}
                  empty={<p className="muted pg-pad">No Unit holds a slot.</p>}
                />
              </Card>
              <Card title="HUMAN-WAIT" flush>
                <Table
                  caption="Waiting grants"
                  captionHidden
                  columns={[
                    ...GRANT_COLS,
                    {
                      key: 'snap',
                      header: 'Snapshot',
                      render: (g) => (g.snapshot_ref ? <code>{g.snapshot_ref}</code> : '–'),
                    },
                  ]}
                  rows={v.waiting}
                  rowKey={(g) => g.grant_id}
                  empty={<p className="muted pg-pad">No session waits for a person.</p>}
                />
              </Card>
            </div>
          </>
        )}
      </Read>
    </>
  );
}

// ---------------------------------------------------------------- sandboxes

export function SandboxesPage() {
  const q = useQuery({
    queryKey: ['slots'],
    queryFn: api.slots,
    refetchInterval: 10_000,
    retry: false,
  });
  return (
    <>
      <PageHead
        eyebrow="Operate"
        title="Sandboxes"
        sub="The runner host's slots as the sandbox-controller reports them: two caps (a total and coding sessions), the class ceilings, and the sessions running now. Caps change through Configuration (sandbox.caps, M1-gated)."
        actions={
          <Link to="/config/sandbox.caps" className="ui-btn">
            sandbox.caps
          </Link>
        }
      />
      {q.isPending ? <Loading what="the slots" /> : null}
      {q.isError ? (
        <Card title="Slots">
          <p>
            <Pill tone="mute">unknown</Pill> The sandbox-controller did not answer, so the free
            slots are unknown (admission reads unknown as none free).
          </p>
          <ErrorNote error={q.error} retry={() => void q.refetch()} />
        </Card>
      ) : null}
      {q.data ? (
        <>
          <Stats label="Slots">
            <Stat
              label="Total"
              value={`${q.data.used_total} / ${q.data.caps.total}`}
              detail={`caps from ${q.data.caps_source === 'config' ? 'the published config' : 'the defaults'}`}
            />
            <Stat
              label="Coding (W)"
              value={`${q.data.used['W'] ?? 0} / ${q.data.caps.coding}`}
              detail={`${q.data.free['W'] ?? 0} free`}
            />
            <Stat label="Host" value={q.data.host_id} />
          </Stats>
          <Card title="Sessions" flush>
            <Table
              caption="Sessions"
              captionHidden
              columns={[
                {
                  key: 'id',
                  header: 'Session',
                  rowHeader: true,
                  render: (x) => <code>{x.session_id}</code>,
                },
                { key: 'c', header: 'Class', render: (x) => x.class },
                { key: 'g', header: 'Grant', render: (x) => <code>{x.grant_id}</code> },
                { key: 's', header: 'Started', render: (x) => shortTime(x.started_at) },
              ]}
              rows={q.data.sessions}
              rowKey={(x) => x.session_id}
              empty={<p className="muted pg-pad">No session is running.</p>}
            />
          </Card>
        </>
      ) : null}
      <Card title="Class ceilings" flush>
        <Table
          caption="Sandbox classes"
          captionHidden
          columns={[
            { key: 'c', header: 'Class', rowHeader: true, render: (c) => <b>{c}</b> },
            { key: 'd', header: 'What it is for', render: (c) => SANDBOX_PROFILES[c].description },
            { key: 'n', header: 'Network', render: (c) => SANDBOX_PROFILES[c].network },
            {
              key: 'e',
              header: 'Runs repo code',
              render: (c) => (SANDBOX_PROFILES[c].exec ? 'yes' : 'no'),
            },
            {
              key: 'k',
              header: 'Key',
              render: (c) => (SANDBOX_PROFILES[c].key ? 'per Unit' : 'none'),
            },
            {
              key: 'l',
              header: 'CPU / memory / time',
              render: (c) => {
                const l = SANDBOX_PROFILES[c].limits;
                return `${l.cpus} / ${l.memory_mb} MB / ${l.time_s} s`;
              },
            },
          ]}
          rows={SandboxClassValues}
          rowKey={(c) => c}
        />
      </Card>
      <NotBuilt title="Stopping one session" milestone="M19">
        The portal has no session stop yet (the proposed <code>session.stop</code> action, coverage
        §5 item 6); a kill of the session scope stops it today.
      </NotBuilt>
    </>
  );
}

// ---------------------------------------------------------------- controls

const SCOPE_KINDS = ['fleet', 'project', 'lane'] as const;
type ControlScopeKind = (typeof SCOPE_KINDS)[number];

const resourceOf = (s: Scope): PdpResource | null => {
  if (s.kind === 'fleet') return pdpResource.fleet();
  if (s.kind === 'project') return s.ref ? pdpResource.project(s.ref) : null;
  if (s.kind === 'lane') {
    const [p, l] = s.ref.split('/');
    return p && l ? pdpResource.lane(p, l) : null;
  }
  return null;
};
const scopeText = (s: Scope): string =>
  s.kind === 'fleet' ? 'the whole factory' : `${s.kind} ${s.ref}`;

const KIND_TEXT: Readonly<Record<ControlKind, string>> = {
  hold: 'Hold: no new agent work in the scope',
  clamp: 'Clamp: limit agent work in flight',
  halt: 'Halt: stop releases (S8, G5)',
  maintenance: 'Maintenance: freeze timers and hold work (MM-2)',
};

function ControlForm({ csrf }: { csrf: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [kind, setKind] = useState<ControlKind>('hold');
  const [scopeKind, setScopeKind] = useState<ControlScopeKind>('project');
  const [ref, setRef] = useState('');
  const [preview, setPreview] = useState<OpsPreview | null>(null);
  const scope: Scope = { kind: scopeKind, ref: scopeKind === 'fleet' ? '*' : ref.trim() } as Scope;
  const resource = resourceOf(scope);
  const doPreview = useMutation({
    mutationFn: () => api.previewControl({ kind, scope }, csrf),
    onSuccess: (p) => setPreview(p),
  });
  const apply = useMutation({
    mutationFn: (p: OpsPreview) =>
      api.applyControl({ kind, scope, preview_id: p.preview_id, nonce: p.nonce }, csrf),
    onSuccess: () => {
      setPreview(null);
      toast('The control is applied and on the ledger.', 'ok');
      void qc.invalidateQueries({ queryKey: ['controls'] });
    },
  });
  const changed = () => setPreview(null);
  return (
    <Card title="Apply a control">
      <form
        className="pg-form"
        onSubmit={(e) => {
          e.preventDefault();
          doPreview.mutate();
        }}
      >
        <label>
          Control{' '}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as ControlKind);
              changed();
            }}
          >
            {ControlKindValues.map((k) => (
              <option key={k} value={k}>
                {KIND_TEXT[k]}
              </option>
            ))}
          </select>
        </label>
        <label>
          Scope{' '}
          <select
            value={scopeKind}
            onChange={(e) => {
              setScopeKind(e.target.value as ControlScopeKind);
              changed();
            }}
          >
            {SCOPE_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
        </label>
        {scopeKind !== 'fleet' ? (
          <label>
            {scopeKind === 'lane' ? 'Project/lane' : 'Project'}{' '}
            <input
              value={ref}
              onChange={(e) => {
                setRef(e.target.value);
                changed();
              }}
              placeholder={scopeKind === 'lane' ? 'payments/L3' : 'payments'}
              required
            />
          </label>
        ) : null}
        {resource ? (
          <Guarded action="control.apply" resource={resource} label="Preview">
            <button type="submit" className="ui-btn" disabled={doPreview.isPending}>
              Preview
            </button>
          </Guarded>
        ) : (
          <button type="submit" className="ui-btn" disabled>
            Preview
          </button>
        )}
      </form>
      {doPreview.isError ? <ErrorNote error={doPreview.error} /> : null}
      {preview ? (
        <section aria-label="Preview" className="pg-preview" data-testid="control-preview">
          <h3>What it would affect</h3>
          <KeyValue
            rows={[
              ['Scope', scopeText(preview.blast_radius.scope)],
              ['Projects', preview.blast_radius.projects.join(', ') || 'none'],
              ['Lanes', preview.blast_radius.lanes.join(', ') || 'all'],
              ['Open items', String(preview.blast_radius.items)],
              ['In a session', String(preview.blast_radius.items_in_flight)],
              ['Overlapping controls', String(preview.blast_radius.overlapping_controls)],
              ['Preview hash', <ShortHash key="h" hash={preview.blast_radius_hash} />],
              ['Valid until', shortTime(preview.expires_at)],
            ]}
          />
          <p className="muted">
            Applying sends this preview&rsquo;s nonce: if anything in the scope changed, the factory
            refuses and you preview again.
          </p>
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            disabled={apply.isPending}
            onClick={() => apply.mutate(preview)}
          >
            Apply {kind}
          </button>
          {apply.isError ? <ErrorNote error={apply.error} /> : null}
        </section>
      ) : null}
    </Card>
  );
}

function LiftButton({ c, csrf }: { c: OpsControl; csrf: string }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const lift = useMutation({
    mutationFn: () => api.liftControl(c.control_id, reason, csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['controls'] }),
  });
  const res = resourceOf(c.scope);
  if (!res) return null;
  return (
    <Guarded action="control.lift" resource={res} label="Lift" mode="hide">
      <form
        className="pg-inline"
        onSubmit={(e) => {
          e.preventDefault();
          lift.mutate();
        }}
      >
        <label>
          <span className="ui-sr">
            Why lift {c.kind} on {scopeText(c.scope)}
          </span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="reason"
            required
          />
        </label>
        <button type="submit" className="ui-btn ui-btn-sm" disabled={lift.isPending}>
          Lift
        </button>
        {lift.isError ? <span role="alert">{describeError(lift.error)}</span> : null}
      </form>
    </Guarded>
  );
}

export function ControlsPage({ csrf }: { csrf: string }) {
  const q = useQuery({ queryKey: ['controls'], queryFn: api.controls, refetchInterval: 15_000 });
  return (
    <>
      <PageHead
        eyebrow="Operate"
        title="Controls"
        sub="Hold, clamp, halt and maintenance on the fleet, a project or a lane. Every control is previewed first (what it would affect, with a nonce), then applied with that nonce, and both land on the ledger. A fleet control is a factory admin's alone."
        actions={
          <Link to="/kill" className="ui-btn">
            Kill switch
          </Link>
        }
      />
      <ControlForm csrf={csrf} />
      <Read q={q} what="the controls">
        {(v) => (
          <>
            <Card title="Active controls" flush>
              <Table
                caption="Active controls"
                captionHidden
                columns={[
                  { key: 'k', header: 'Control', rowHeader: true, render: (c) => <b>{c.kind}</b> },
                  { key: 's', header: 'Scope', render: (c) => scopeText(c.scope) },
                  { key: 'o', header: 'Origin', render: (c) => c.origin_kind },
                  { key: 'a', header: 'Since', render: (c) => shortTime(c.created_at) },
                  {
                    key: 'e',
                    header: 'Expires',
                    render: (c) => (c.expires_at ? shortTime(c.expires_at) : 'never'),
                  },
                  { key: 'l', header: 'Lift', render: (c) => <LiftButton c={c} csrf={csrf} /> },
                ]}
                rows={v.controls}
                rowKey={(c) => c.control_id}
                empty={
                  <EmptyState title="No control is active">
                    Work runs under the catalogue alone.
                  </EmptyState>
                }
              />
            </Card>
            <Card title="Banners" flush>
              <Table
                caption="Banners"
                captionHidden
                columns={[
                  { key: 'sev', header: 'Severity', rowHeader: true, render: (b) => b.severity },
                  { key: 's', header: 'Scope', render: (b) => scopeText(b.scope) },
                  { key: 't', header: 'Text', render: (b) => b.text },
                  { key: 'e', header: 'Until', render: (b) => shortTime(b.expires_at) },
                ]}
                rows={v.banners}
                rowKey={(b) => b.banner_id}
                empty={<p className="muted pg-pad">No banner is published.</p>}
              />
            </Card>
          </>
        )}
      </Read>
      <NotBuilt title="Step-up on a control" milestone="M9.7 follow-up">
        Core&rsquo;s control routes take the preview&rsquo;s nonce but no step-up proof yet, so the
        portal asks for none. Publishing a banner from the portal is not built either (core has the
        route).
      </NotBuilt>
    </>
  );
}

// ---------------------------------------------------------------- kill switch

export function KillPage() {
  const q = useQuery({ queryKey: ['kills'], queryFn: api.kills, refetchInterval: 10_000 });
  return (
    <>
      <PageHead
        eyebrow="Operate · AR9"
        title="Kill switch"
        sub="The kill switch is its own service with its own key and database; it never calls core. Core pulls its signed journal, verifies every entry against the pinned key and records it, and that is what this page shows. An unreachable kill switch counts as a kill."
        actions={
          <Link to="/controls" className="ui-btn">
            Controls
          </Link>
        }
      />
      <Read q={q} what="the kill journal">
        {(v) => (
          <>
            <Stats label="Kill switch">
              <Stat
                label="Journal entries observed"
                value={v.observed_head}
                detail="verified, recorded, ledgered"
              />
              <Stat
                label="Kills requested"
                value={v.journal.filter((e) => e.kind === 'kill.requested').length}
                detail="in the entries shown"
              />
              <Stat
                label="Awaiting a signature"
                value={v.journal.filter((e) => !e.signed).length}
                detail="written while the KMS was away"
                {...(v.journal.some((e) => !e.signed) ? { tone: 'warn' as const } : {})}
              />
            </Stats>
            <Card title="Signed journal" flush>
              <Table
                caption="Kill switch journal"
                captionHidden
                columns={[
                  {
                    key: 'seq',
                    header: 'Seq',
                    rowHeader: true,
                    align: 'right',
                    render: (e) => e.ks_seq,
                  },
                  { key: 'k', header: 'Entry', render: (e) => e.kind },
                  { key: 's', header: 'Subject', render: (e) => <code>{e.subject}</code> },
                  { key: 'a', header: 'By', render: (e) => e.actor ?? 'the kill switch' },
                  {
                    key: 'sig',
                    header: 'Signature',
                    render: (e) =>
                      e.signed ? <Pill tone="ok">signed</Pill> : <Pill tone="warn">pending</Pill>,
                  },
                  {
                    key: 'h',
                    header: 'Entry hash',
                    render: (e) => <ShortHash hash={e.entry_hash} />,
                  },
                  { key: 'at', header: 'When', render: (e) => shortTime(e.at) },
                ]}
                rows={v.journal}
                rowKey={(e) => String(e.ks_seq)}
                empty={
                  <EmptyState title="No kill yet">
                    The journal core has observed is empty.
                  </EmptyState>
                }
              />
            </Card>
          </>
        )}
      </Read>
      <NotBuilt title="Request or release a kill from the portal" milestone="M9.7 follow-up">
        The bff has no route to the kill switch (AR9 keeps it apart; only core-worker and an
        operator reach it), so a kill is requested and released with the operator&rsquo;s client
        today. The portal button with its step-up and the two-person release waits for that route.
      </NotBuilt>
    </>
  );
}

// ---------------------------------------------------------------- health

const TILE_TONE: Readonly<Record<HealthTile['state'], PillTone>> = {
  ok: 'ok',
  degraded: 'warn',
  down: 'bad',
  unknown: 'mute',
};

/** What a tile's reading says, in words: a stale or missing reading is said, never shown as healthy. */
function readingOf(t: HealthTile): string {
  if (t.stale) return 'reading older than two minutes';
  if (t.as_of === null) return 'nothing has read it';
  const sli =
    t.sli_value !== null && t.domain === 'service' ? ` · ${Math.round(t.sli_value)} ms` : '';
  return `as of ${shortTime(t.as_of)}${sli}`;
}

export function HealthTiles({ tiles, label }: { tiles: readonly HealthTile[]; label: string }) {
  if (tiles.length === 0) return <p className="muted">Nothing to show.</p>;
  return (
    <ul className="pg-tiles" aria-label={label}>
      {tiles.map((t) => (
        <li key={t.tile_id} className="ui-card pg-tile" data-state={t.state}>
          <div className="pg-tile-hd">
            <b>{t.label}</b>
            <Pill tone={TILE_TONE[t.state]}>{t.state}</Pill>
          </div>
          <div className="muted">
            {readingOf(t)}
            {t.detail_code && t.detail_code !== 'ok' ? ` · ${t.detail_code}` : ''}
          </div>
        </li>
      ))}
    </ul>
  );
}

export function HealthPage() {
  const q = useQuery({
    queryKey: ['integrations'],
    queryFn: api.integrations,
    refetchInterval: 30_000,
  });
  const h = useQuery({
    queryKey: ['health'],
    queryFn: api.health,
    refetchInterval: 30_000,
  });
  return (
    <>
      <PageHead
        eyebrow="Operate"
        title="Health"
        sub="How the factory's services, loops and integrations are doing, in one shared shape: a reading older than two minutes reads unknown, never ok."
      />
      <Read q={h} what="the service and loop tiles">
        {(v) => (
          <>
            <Stats label="Health summary">
              <Stat label="Overall" value={v.overall} />
              <Stat label="Ok" value={v.counts.ok} />
              <Stat label="Degraded" value={v.counts.degraded} />
              <Stat label="Down" value={v.counts.down} />
              <Stat label="Unknown" value={v.counts.unknown} />
            </Stats>
            {v.overall !== 'ok' ? (
              <p className="muted" role="note">
                Unknown is not healthy: a service nobody has read, or whose reading is older than
                two minutes, is shown as unknown.
              </p>
            ) : null}
            <Card title="Services">
              <HealthTiles tiles={v.tiles.filter((t) => t.domain === 'service')} label="Services" />
            </Card>
            <Card title="Loops">
              <HealthTiles tiles={v.tiles.filter((t) => t.domain === 'loop')} label="Loops" />
            </Card>
          </>
        )}
      </Read>
      <Read q={q} what="the health tiles">
        {(v) => (
          <Card title="Integrations" actions={<Link to="/integrations">Integrations</Link>}>
            <IntegrationTiles tiles={v.health.tiles} />
          </Card>
        )}
      </Read>
    </>
  );
}
