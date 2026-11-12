import { STEPS, type EvidencePackView, type GateCheckRunsView } from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { api, signedPackHref } from '../api';
import { Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { GateCheckBody } from '../items/VerifyTab';
import { Link } from '../router';
import { Card, GateTag, KeyValue, PageHead, Pill, Table, laneText } from '../ui';

// The Evidence Pack viewer (PLAN M14.6, prototype `views-m14.js` "pack"): the binding, the five steps by result hash,
// the gates the item raised with their ledger decisions, the signature, the signed bytes to download and the command
// that checks them offline, and gate-check's verdict history on the item's PRs. Ids, hashes, verdicts and counts only:
// the pack holds nothing else.

const short = (s: string, n = 12) => `${s.slice(0, n)}…`;

export function PackPage({ id }: { id: string }) {
  const [pack, setPack] = useState<string | undefined>(undefined);
  const q = useQuery({
    queryKey: ['item-evidence', id, pack ?? 'newest'],
    queryFn: () => api.itemEvidence(id, pack),
  });
  const gc = useQuery({
    queryKey: ['item-gate-check', id],
    queryFn: () => api.itemGateCheck(id),
    staleTime: 15_000,
  });
  if (q.isPending) return <Loading what="the Evidence Pack" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  return (
    <PackBody
      v={q.data}
      gateCheck={
        gc.data ??
        (gc.isError ? { item_id: q.data.item_id, status: 'unknown', verdicts: [] } : null)
      }
      onPick={setPack}
    />
  );
}

export function PackBody({
  v,
  gateCheck,
  onPick,
}: {
  v: EvidencePackView;
  gateCheck: GateCheckRunsView | null;
  onPick?: (pack: string) => void;
}) {
  const [checked, setChecked] = useState(false);
  const crumbs = [
    { label: 'Projects', to: '/' },
    { label: v.project_id, to: `/projects/${v.project_id}` },
    { label: 'Work item', to: `/items/${v.item_id}` },
    { label: 'Evidence Pack' },
  ];
  const renderLink = (to: string, label: string) => <Link to={to}>{label}</Link>;
  const p = v.pack;
  if (p === null) {
    return (
      <>
        <PageHead
          crumbs={crumbs}
          renderLink={renderLink}
          eyebrow="7.6"
          title="No Evidence Pack yet"
          sub="7.6 signs a pack only when the latest result of every step 7.1–7.5 for the Unit head passed and every gate a check raised was approved; a rework or a handoff is signed too, marked not passing."
        />
        <Link className="ui-btn" to={`/items/${v.item_id}`}>
          Back to the item
        </Link>
      </>
    );
  }
  const c = v.contents;
  return (
    <>
      <PageHead
        crumbs={crumbs}
        renderLink={renderLink}
        eyebrow={`aisdlc-evidence-pack/1 · ${v.project_id}`}
        title={`Evidence Pack · Unit ${p.unit_key}`}
        sub="Ids, hashes, verdicts and counts only: no message and no content. Its id is the sha256 of its canonical JSON; the Notary signs it, and the signed bytes live under their sha256 in the write-once bucket."
        actions={
          <>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              onClick={() => setChecked(true)}
              disabled={c === null}
            >
              Verify offline
            </button>
            <a className="ui-btn" href={signedPackHref(v.item_id, p.pack_sha256)} download>
              Download signed pack
            </a>
          </>
        }
      />
      {!p.passing ? (
        <p className="s7-banner s7-banner-gate" role="note">
          This pack is signed but not passing: it records {p.disposition.kind}
          {p.disposition.kind === 'rework' ? ` (${p.disposition.edge})` : ''}
          {p.disposition.kind === 'handoff'
            ? ` (${p.disposition.trigger} at ${p.disposition.step})`
            : ''}
          . gate-check never accepts it.
        </p>
      ) : null}
      {v.contents_problem ? (
        <p className="s7-banner s7-banner-bad" role="alert">
          The signed bytes could not be shown: {v.contents_problem}. The facts below are the
          record&rsquo;s.
        </p>
      ) : null}
      <div className="s7-split">
        <div className="s7-stack">
          <Card title="Binding">
            <KeyValue
              rows={[
                [
                  'Pack id',
                  <code key="id" className="s7-wrap">
                    {p.pack_sha256}
                  </code>,
                ],
                ['Unit', <code key="u">{p.unit_key}</code>],
                ['Head', <code key="h">{p.head_sha}</code>],
                ['Base (bound by G3)', <code key="b">{p.base_sha}</code>],
                ...(c
                  ? ([
                      ['Lane · tier', `${laneText(c.lane)} · ${c.tier}`],
                      ['Gating profile', <code key="g">{short(c.profile_sha256)}</code>],
                      [
                        'Catalogue',
                        <code key="c">{`${c.catalogue_ref.version} · ${short(c.catalogue_ref.hash, 8)}`}</code>,
                      ],
                      [
                        'Push receipt',
                        c.push_receipt ? (
                          <code key="r">{`${c.push_receipt.receipt_id} · patch ${short(c.push_receipt.patch_hash, 10)} · PR #${c.push_receipt.pr_number}`}</code>
                        ) : (
                          'none'
                        ),
                      ],
                      ['Oracle locks', String(c.oracle_locks)],
                    ] as const)
                  : []),
                ['Produced', shortTime(p.produced_at)],
              ]}
            />
          </Card>
          {c ? (
            <Card title="Steps" flush>
              <Table
                caption="Steps of the pack"
                captionHidden
                columns={[
                  {
                    key: 'step',
                    header: 'Step',
                    rowHeader: true,
                    render: (s) => (
                      <>
                        <code>{s.step}</code> {STEPS[s.step].title}
                      </>
                    ),
                  },
                  {
                    key: 'hash',
                    header: 'Result hash',
                    render: (s) =>
                      s.result_sha256 ? <code>{short(s.result_sha256)}</code> : 'none',
                  },
                  {
                    key: 'verdict',
                    header: 'Verdict',
                    render: (s) => (
                      <Pill tone={s.met ? 'ok' : s.verdict === 'passed' ? 'gate' : 'bad'}>
                        {s.verdict ?? 'not run'}
                        {s.met ? '' : ' · unmet'}
                      </Pill>
                    ),
                  },
                  {
                    key: 'failing',
                    header: 'Failing findings',
                    render: (s) =>
                      s.findings.failing === 0 ? (
                        <span className="muted">none</span>
                      ) : (
                        s.findings.items
                          .map((f) => `${f.kind} ${f.path ?? ''}${f.line ? `:${f.line}` : ''}`)
                          .join('; ')
                      ),
                  },
                ]}
                rows={c.steps}
                rowKey={(s) => s.step}
              />
            </Card>
          ) : null}
          {c ? (
            <Card title="Gates the item raised" flush>
              <Table
                caption="Gates the item raised"
                captionHidden
                columns={[
                  {
                    key: 'gate',
                    header: 'Gate',
                    rowHeader: true,
                    render: (g) => <GateTag gate={g.gate} />,
                  },
                  { key: 'station', header: 'Station', render: (g) => <code>{g.station}</code> },
                  {
                    key: 'decision',
                    header: 'Decision',
                    render: (g) => (
                      <Pill
                        tone={
                          g.outcome === 'approve' ? 'ok' : g.status === 'pending' ? 'gate' : 'bad'
                        }
                      >
                        {g.outcome ?? g.status}
                      </Pill>
                    ),
                  },
                  {
                    key: 'ledger',
                    header: 'Ledger',
                    render: (g) => g.decisions.map((x) => `#${x.ledger_seq}`).join(', ') || '-',
                  },
                ]}
                rows={c.gates}
                rowKey={(g) => g.gate_instance_id}
                empty={<p className="muted s7-pad">No gate.</p>}
              />
            </Card>
          ) : null}
        </div>
        <aside className="s7-stack">
          <Card title="Signature">
            <KeyValue
              rows={[
                ['Signed by', 'Notary · evidence scope'],
                ['Key', <code key="k">{p.key_id}</code>],
                ['Message', 'domain-separated, over the pack id'],
                ['Journal', <code key="j">notary.evidence_signature</code>],
                ['Object', <code key="o">{`${p.bucket}/${short(p.object_key, 16)}`}</code>],
                ['Recorded', <code key="r">evidence.pack_signed + ledger entry</code>],
              ]}
            />
            {checked && c ? (
              <ul className="s7-rules" aria-label="Offline check" data-testid="offline-check">
                <li>canonical JSON: ok (the bytes are what the store holds)</li>
                <li>
                  object key = sha256 of the signed bytes: checked when the factory read them back
                </li>
                <li>pack hash matches its id: checked when the factory read them back</li>
                <li>
                  Notary signature ({c.signature.alg}, key {c.signature.key_id}): check it yourself
                  with the command below and the Notary&rsquo;s public key; this page does not vouch
                  for it
                </li>
                <li>
                  head <code>{p.head_sha.slice(0, 7)}</code> and item are the ones this page names
                </li>
              </ul>
            ) : null}
          </Card>
          <Card title="Verify it yourself">
            <p className="muted">
              Anyone with the Notary&rsquo;s public key can check a pack without the factory:
              canonical form, object key, pack hash, signature, head and item.
            </p>
            {v.verify_command ? (
              <pre className="code" data-testid="verify-command">
                {v.verify_command}
              </pre>
            ) : null}
          </Card>
          <Card title="gate-check verdicts">
            {gateCheck === null ? (
              <Loading what="gate-check's verdicts" />
            ) : (
              <>
                <GateCheckBody v={gateCheck} head={p.head_sha} />
                {gateCheck.status === 'ok' && gateCheck.verdicts.length > 1 ? (
                  <ol className="s7-history" aria-label="Verdict history">
                    {gateCheck.verdicts.map((x) => (
                      <li key={x.seq}>
                        <Pill
                          tone={
                            x.outcome === 'success'
                              ? 'ok'
                              : x.outcome === 'failure'
                                ? 'bad'
                                : 'mute'
                          }
                        >
                          {x.outcome}
                        </Pill>{' '}
                        head <code>{x.head_sha.slice(0, 7)}</code> · {x.reason} ·{' '}
                        {shortTime(x.recorded_at)}
                      </li>
                    ))}
                  </ol>
                ) : null}
                <p className="s7-faint">
                  Passes only when the PR head equals the pack&rsquo;s head, the bytes verify
                  offline and G3 is decided approve. gate-check never merges; a person merges on
                  GitHub.
                </p>
              </>
            )}
          </Card>
          {v.packs.length > 1 ? (
            <Card title="Other packs of this item">
              <ul className="plain">
                {v.packs.map((x) => (
                  <li key={x.pack_sha256}>
                    <button
                      type="button"
                      className="ui-btn ui-btn-sm ui-btn-ghost"
                      aria-current={x.pack_sha256 === p.pack_sha256 ? 'true' : undefined}
                      onClick={() => onPick?.(x.pack_sha256)}
                    >
                      {short(x.pack_sha256, 10)} · {x.passing ? 'passing' : x.disposition.kind} ·
                      head {x.head_sha.slice(0, 7)}
                    </button>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </aside>
      </div>
    </>
  );
}
