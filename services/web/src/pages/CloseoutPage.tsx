import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AuditOutcome,
  pdpResource,
  type AuditOutcome as Outcome,
  type CloseOutGate,
  type CloseOutUnit,
} from '@aisdlc/contracts';
import { useState } from 'react';
import { api } from '../api';
import { Guarded } from '../access';
import { ErrorNote } from '../components/Notice';
import { Read, ShortHash, itemKey } from '../components/Read';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, GateTag, KeyValue, PageHead, Pill, Table, laneText } from '../ui';

// 9.3 the close-out record (M15): what the item went through, as the factory wrote it when the item closed, with
// the escapes reported after the merge (B17) and, for a mode-E merge drawn by 9.5, its audit. The record is
// content-addressed: its id is the sha256 of its canonical JSON. Reading it is `closeout.read` on the item; the
// audit is `audit.record` (never the G4 approver or the requester: the server checks), an escape `item.escape`.

const OUTCOME_TEXT: Readonly<Record<Outcome, string>> = {
  ok: 'The gate held: the merge was right to pass',
  gate_miss: 'A gate miss: this merge should not have passed on evidence alone',
};

const newKey = (): string => `portal-${crypto.randomUUID()}`;

export function CloseoutPage({ id, csrf }: { id: string; csrf: string }) {
  const q = useQuery({ queryKey: ['closeout', id], queryFn: () => api.itemCloseout(id) });
  return (
    <Read q={q} what="the close-out record">
      {(v) => {
        const r = v.record;
        const resource = pdpResource.item(r.project_id, r.item_id, r.lane);
        return (
          <>
            <PageHead
              eyebrow="Close-out · 9.3"
              title={`Close-out of ${itemKey(r.item_id)}`}
              crumbs={[
                { label: r.project_id, to: `/projects/${r.project_id}` },
                { label: `item ${itemKey(r.item_id)}`, to: `/items/${r.item_id}` },
                { label: 'close-out' },
              ]}
              renderLink={(to, label) => <Link to={to}>{label}</Link>}
              sub="What the item went through, written once when it closed: every gate with its ledger decision, the merge, the release, the acceptance, break-glass merges and the rework."
            />
            <Card title="The record">
              <KeyValue
                rows={[
                  ['Record id', <ShortHash key="id" hash={v.closeout_sha256} />],
                  ['Repo', <code key="r">{r.repo}</code>],
                  ['Lane', laneText(r.lane)],
                  ['Catalogue', `${r.catalogue.version}`],
                  [
                    'Merged',
                    r.merged_sha ? <code key="m">{r.merged_sha.slice(0, 12)}</code> : 'not merged',
                  ],
                  [
                    'G4 review',
                    r.g4
                      ? `mode ${r.g4.mode ?? 'unknown'}, decided by ${r.g4.deciders.join(', ') || 'nobody yet'}`
                      : 'no G4',
                  ],
                  [
                    'Release output',
                    r.release_output ? <ShortHash key="ro" hash={r.release_output} /> : 'none',
                  ],
                  [
                    'Acceptance (G6)',
                    r.acceptance.outcome
                      ? `${r.acceptance.outcome} by ${r.acceptance.by ?? 'unknown'}`
                      : 'not decided',
                  ],
                  [
                    'Rework',
                    `${r.rework.total} back-edge(s)${
                      Object.keys(r.rework.by_edge).length > 0
                        ? `: ${Object.entries(r.rework.by_edge)
                            .map(([e, n]) => `${e} ×${n}`)
                            .join(', ')}`
                        : ''
                    }`,
                  ],
                ]}
              />
            </Card>
            <Card title="Gates" flush>
              <Table<CloseOutGate>
                caption="Gates of the item"
                captionHidden
                columns={[
                  {
                    key: 'g',
                    header: 'Gate',
                    rowHeader: true,
                    render: (g) => <GateTag gate={g.gate} />,
                  },
                  {
                    key: 'o',
                    header: 'Outcome',
                    render: (g) =>
                      g.outcome ? (
                        <Pill tone={g.outcome === 'approve' ? 'ok' : 'warn'}>{g.outcome}</Pill>
                      ) : (
                        <Pill tone="mute">pending</Pill>
                      ),
                  },
                  {
                    key: 'l',
                    header: 'Ledger entry',
                    render: (g) => (g.ledger_entry_id ? <code>{g.ledger_entry_id}</code> : '–'),
                  },
                ]}
                rows={r.gates}
                rowKey={(g) => g.gate_instance_id}
              />
            </Card>
            <Card title="Units" flush>
              <Table<CloseOutUnit>
                caption="Units"
                captionHidden
                columns={[
                  {
                    key: 'u',
                    header: 'Unit',
                    rowHeader: true,
                    render: (u) => <code>{u.unit_key}</code>,
                  },
                  { key: 'pr', header: 'PR', render: (u) => `#${u.pr_number}` },
                  {
                    key: 'h',
                    header: 'Head',
                    render: (u) => <code>{u.head_sha.slice(0, 12)}</code>,
                  },
                  {
                    key: 'm',
                    header: 'Merge',
                    render: (u) =>
                      u.merge_commit_sha ? <code>{u.merge_commit_sha.slice(0, 12)}</code> : '–',
                  },
                  {
                    key: 'p',
                    header: 'Evidence Pack',
                    render: (u) =>
                      u.pack_sha256 ? (
                        <ShortHash hash={u.pack_sha256} />
                      ) : (
                        <Pill tone="warn">none</Pill>
                      ),
                  },
                ]}
                rows={r.units}
                rowKey={(u) => u.unit_key}
                empty={<p className="muted pg-pad">No Unit (a human-led item).</p>}
              />
            </Card>
            {r.break_glass.length > 0 ? (
              <Card title="Break-glass merges">
                <ul className="pg-list">
                  {r.break_glass.map((b) => (
                    <li key={`${b.pr_number}:${b.head_sha}`}>
                      <Pill tone="bad">{b.class}</Pill> PR #{b.pr_number} at{' '}
                      <code>{b.head_sha.slice(0, 12)}</code>
                      {b.x4_gate_instance_id ? ' · X4 review opened' : ' · no X4 yet'}
                    </li>
                  ))}
                </ul>
              </Card>
            ) : null}

            <div className="pg-split">
              <Card title="Audit (9.5)" testId="closeout-audit">
                {v.audit === null ? (
                  <p className="muted">
                    This merge was not a mode-E merge, so 9.5 does not sample it.
                  </p>
                ) : !v.audit.sampled ? (
                  <p className="muted">Considered for the sample and not drawn.</p>
                ) : v.audit.outcome ? (
                  <p>
                    Audited by {v.audit.audited_by ?? 'unknown'}:{' '}
                    <b>{OUTCOME_TEXT[v.audit.outcome]}</b>.
                  </p>
                ) : (
                  <>
                    <p>
                      Drawn for the mode-E audit. Read the evidence and the merge, then say whether
                      the gate held. More than 10% misses over at least 20 audits suspends mode E
                      for the project (B19).
                    </p>
                    <Guarded action="audit.record" resource={resource} label="Record the audit">
                      <AuditForm id={r.item_id} csrf={csrf} />
                    </Guarded>
                  </>
                )}
              </Card>
              <Card title="Escapes (B17)" testId="closeout-escapes">
                {v.escapes.length === 0 ? (
                  <EmptyState title="No escape reported">
                    A defect found after the merge is reported here.
                  </EmptyState>
                ) : (
                  <ul className="pg-list" aria-label="Escapes">
                    {v.escapes.map((e) => (
                      <li key={e.key}>
                        <Pill tone="bad">{e.lane}</Pill> {e.reason_code} · by {e.by} ·{' '}
                        {shortTime(e.reported_at)}
                      </li>
                    ))}
                  </ul>
                )}
                <Guarded action="item.escape" resource={resource} mode="hide">
                  <EscapeForm id={r.item_id} csrf={csrf} />
                </Guarded>
              </Card>
            </div>
          </>
        );
      }}
    </Read>
  );
}

function AuditForm({ id, csrf }: { id: string; csrf: string }) {
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState<Outcome>('ok');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.itemAudit(id, { outcome, reason_code: reason.trim() }, csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['closeout', id] }),
  });
  return (
    <form
      className="pg-form"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <fieldset className="s7-choice">
        <legend>Did the gate hold?</legend>
        {AuditOutcome.options.map((o) => (
          <label key={o}>
            <input
              type="radio"
              name="outcome"
              value={o}
              checked={outcome === o}
              onChange={() => setOutcome(o)}
            />
            {OUTCOME_TEXT[o]}
          </label>
        ))}
      </fieldset>
      <label>
        Reason code
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="evidence_complete"
          required
          maxLength={64}
        />
      </label>
      <button type="submit" className="ui-btn ui-btn-primary" disabled={m.isPending}>
        Record the audit
      </button>
      {m.data ? (
        <p role="status">
          Recorded: {m.data.missed} miss(es) in {m.data.sampled} audit(s)
          {m.data.suspended ? '; mode E is now suspended for the project (B19).' : '.'}
        </p>
      ) : null}
      {m.isError ? <ErrorNote error={m.error} /> : null}
    </form>
  );
}

function EscapeForm({ id, csrf }: { id: string; csrf: string }) {
  const qc = useQueryClient();
  const [lane, setLane] = useState<'L0' | 'L1'>('L1');
  const [reason, setReason] = useState('');
  const m = useMutation({
    mutationFn: () => api.itemEscape(id, { lane, reason_code: reason.trim(), key: newKey() }, csrf),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['closeout', id] }),
  });
  return (
    <form
      className="pg-form pg-preview"
      onSubmit={(e) => {
        e.preventDefault();
        m.mutate();
      }}
    >
      <label>
        Fix it as
        <select value={lane} onChange={(e) => setLane(e.target.value as 'L0' | 'L1')}>
          <option value="L0">{laneText('L0')}</option>
          <option value="L1">{laneText('L1')}</option>
        </select>
      </label>
      <label>
        Reason code
        <input
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="defect_in_prod"
          required
          maxLength={64}
        />
      </label>
      <button type="submit" className="ui-btn" disabled={m.isPending}>
        Report an escape
      </button>
      {m.isSuccess ? (
        <p role="status">The escape is recorded and a linked item is opened (B17).</p>
      ) : null}
      {m.isError ? <ErrorNote error={m.error} /> : null}
    </form>
  );
}
