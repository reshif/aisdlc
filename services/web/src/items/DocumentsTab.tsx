import {
  DocumentGroupValues,
  type DocumentGateBinding,
  type DocumentVersion,
  type ItemDocument,
  type ItemDocumentsView,
} from '@aisdlc/contracts';
import { useQuery } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { api } from '../api';
import { Read, ShortHash } from '../components/Read';
import { shortTime } from '../format';
import { lineDiff } from '../lib/diff';
import { Link } from '../router';
import { Card, EmptyState, GateTag, Pill, type PillTone } from '../ui';
import { DOCUMENT_GROUP_TEXT } from '../vocab';

// The item page's Documents and Intent tabs (P2-1): every artefact of the item by kind (the intent block, the spec,
// the design documents and their ADR-style decisions, the plan, the constitution report, the evidence), each with its
// versions in order, who wrote each and when, which gate bound which version (the gate's subject hash, decided in the
// ledger) and what changed between two versions of a text. The markdown is the agent's text: shown as text, never as
// HTML, and only from data class D1 (the bff withholds it below; the hashes stay). The documents need view level V2.

const typeText = (t: string): string => t.replace(/_/g, ' ');

const OUTCOME_TONE: Readonly<Record<string, PillTone>> = {
  approve: 'ok',
  reject: 'bad',
  request_changes: 'warn',
};

function GateLine({ g }: { g: DocumentGateBinding }) {
  const decided = g.status === 'decided';
  return (
    <li data-testid="doc-gate" data-gate={g.gate}>
      <GateTag gate={g.gate} />{' '}
      {decided ? (
        <Pill tone={OUTCOME_TONE[g.outcome ?? ''] ?? 'neutral'}>{g.outcome ?? 'decided'}</Pill>
      ) : (
        <Pill tone={g.status === 'pending' ? 'info' : 'mute'}>{g.status}</Pill>
      )}
      {g.approvers.length > 0 ? <> by {g.approvers.join(', ')}</> : null}
      {g.ended_at ? <span className="muted"> · {shortTime(g.ended_at)}</span> : null}
      {g.card_id ? (
        <>
          {' '}
          · <Link to={`/cards/${g.card_id}`}>card</Link>
        </>
      ) : null}
      {g.ledger_entry_id ? (
        <>
          {' '}
          · ledger <code className="ui-mono">{g.ledger_entry_id.slice(0, 8)}</code>
        </>
      ) : null}
    </li>
  );
}

function Author({ v }: { v: DocumentVersion }) {
  const a = v.author;
  if (a.kind === 'agent') {
    return a.agent_id ? (
      <Link to={`/agents/${a.agent_id}`}>agent {a.agent_id}</Link>
    ) : (
      <span>an agent</span>
    );
  }
  return <span>{a.kind === 'person' ? 'a person (B5)' : 'the factory (deterministic)'}</span>;
}

function DiffView({ before, after }: { before: DocumentVersion; after: DocumentVersion }) {
  if (before.markdown === null || after.markdown === null) {
    return <p className="muted">The text is withheld: there is nothing to compare.</p>;
  }
  const lines = lineDiff(before.markdown, after.markdown);
  if (lines === null) return <p className="muted">These versions are too long to compare here.</p>;
  const added = lines.filter((l) => l.op === 'add').length;
  const removed = lines.filter((l) => l.op === 'del').length;
  return (
    <>
      <p className="muted" data-testid="doc-diff-summary">
        Version {before.version} to {after.version}: {added} line{added === 1 ? '' : 's'} added,{' '}
        {removed} removed.
      </p>
      <pre className="ask-text doc-diff" aria-label={`Changes from version ${before.version}`}>
        {lines.map((l, i) => (
          <span key={i} data-op={l.op} className={`doc-diff-${l.op}`}>
            {l.op === 'add' ? '+ ' : l.op === 'del' ? '- ' : '  '}
            {l.text}
          </span>
        ))}
      </pre>
    </>
  );
}

export function DocumentCard({ doc }: { doc: ItemDocument }) {
  const ids = { show: useId(), against: useId() };
  const newest = doc.versions.at(-1) as DocumentVersion;
  const [shown, setShown] = useState(newest.version);
  const [against, setAgainst] = useState<number | null>(null);
  const v = doc.versions.find((x) => x.version === shown) ?? newest;
  const base = against === null ? null : (doc.versions.find((x) => x.version === against) ?? null);
  return (
    <Card title={typeText(doc.type)} testId={`doc-${doc.type}`}>
      <div className="ui-tbl-wrap">
        <table className="ui-tbl doc-versions">
          <caption className="ui-sr">Versions of {typeText(doc.type)}</caption>
          <thead>
            <tr>
              <th scope="col">Version</th>
              <th scope="col">Stored</th>
              <th scope="col">By</th>
              <th scope="col">Hash</th>
              <th scope="col">Bound by</th>
            </tr>
          </thead>
          <tbody>
            {doc.versions.map((x) => (
              <tr key={x.version} data-testid="doc-version">
                <th scope="row">
                  v{x.version} <span className="muted">({x.step})</span>
                </th>
                <td>{shortTime(x.stored_at)}</td>
                <td>
                  <Author v={x} />
                </td>
                <td>
                  <ShortHash hash={x.sha256} />
                </td>
                <td>
                  {x.gates.length === 0 ? (
                    <span className="muted">no gate</span>
                  ) : (
                    <ul className="plain">
                      {x.gates.map((g) => (
                        <GateLine key={g.gate_instance_id} g={g} />
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor={ids.show}>Show version</label>
          <select id={ids.show} value={shown} onChange={(e) => setShown(Number(e.target.value))}>
            {doc.versions.map((x) => (
              <option key={x.version} value={x.version}>
                v{x.version}
              </option>
            ))}
          </select>
        </div>
        {doc.versions.length > 1 ? (
          <div className="field">
            <label htmlFor={ids.against}>Compare with</label>
            <select
              id={ids.against}
              value={against ?? ''}
              onChange={(e) => setAgainst(e.target.value === '' ? null : Number(e.target.value))}
            >
              <option value="">no comparison</option>
              {doc.versions
                .filter((x) => x.version !== v.version)
                .map((x) => (
                  <option key={x.version} value={x.version}>
                    v{x.version}
                  </option>
                ))}
            </select>
          </div>
        ) : null}
      </div>
      {base !== null ? (
        <DiffView
          before={base.version < v.version ? base : v}
          after={base.version < v.version ? v : base}
        />
      ) : v.markdown === null ? (
        <p className="muted" data-testid="doc-withheld">
          The text is content of the work: it needs data class D1 on this project. The hash above
          names exactly what was stored. <Link to="/me/access">See my access</Link>
        </p>
      ) : (
        <pre className="ask-text" aria-label={`${typeText(doc.type)} version ${v.version}`}>
          {v.markdown}
        </pre>
      )}
    </Card>
  );
}

function EvidencePacks({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['item-evidence', id], queryFn: () => api.itemEvidence(id) });
  if (q.isPending) return <p className="muted">Reading the Evidence Packs…</p>;
  if (q.isError) return <p className="muted">The Evidence Packs could not be read: unknown.</p>;
  if (q.data.packs.length === 0) return <p className="muted">No Evidence Pack is signed yet.</p>;
  return (
    <ul className="plain" aria-label="Evidence Packs" data-testid="doc-evidence">
      {q.data.packs.map((p) => (
        <li key={p.pack_sha256}>
          <Pill tone={p.passing ? 'ok' : 'bad'}>{p.passing ? 'passed' : 'not passed'}</Pill> Unit{' '}
          <code>{p.unit_key}</code> at head <ShortHash hash={p.head_sha} />, signed{' '}
          {shortTime(p.produced_at)}
        </li>
      ))}
      <li>
        <Link to={`/items/${id}/evidence`}>Open the Evidence Pack viewer</Link>
      </li>
    </ul>
  );
}

export function DocumentsTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['item-documents', id], queryFn: () => api.itemDocuments(id) });
  return (
    <Read q={q} what="the documents">
      {(v) => <DocumentsBody id={id} v={v} />}
    </Read>
  );
}

function DocumentsBody({ id, v }: { id: string; v: ItemDocumentsView }) {
  return (
    <div data-testid="documents-tab">
      {v.not_intact > 0 ? (
        <p className="notice notice-bad" role="alert">
          {v.not_intact} stored document{v.not_intact === 1 ? ' does' : 's do'} not hash to the
          record: not shown.
        </p>
      ) : null}
      {v.documents.length === 0 ? (
        <EmptyState title="No documents yet">
          The steps of this item have stored nothing yet.
        </EmptyState>
      ) : null}
      {DocumentGroupValues.map((g) => {
        const docs = v.documents.filter((d) => d.group === g);
        if (g !== 'evidence' && docs.length === 0) return null;
        return (
          <section key={g} aria-label={DOCUMENT_GROUP_TEXT[g].title} data-testid={`docs-${g}`}>
            <h2>{DOCUMENT_GROUP_TEXT[g].title}</h2>
            <p className="muted">{DOCUMENT_GROUP_TEXT[g].blurb}</p>
            {docs.map((d) => (
              <DocumentCard key={d.type} doc={d} />
            ))}
            {g === 'evidence' ? <EvidencePacks id={id} /> : null}
          </section>
        );
      })}
    </div>
  );
}

/** The Intent tab: the intent block G0/G1 decide (and what the classifier said), from the same documents read. */
export function IntentTab({ id }: { id: string }) {
  const q = useQuery({ queryKey: ['item-documents', id], queryFn: () => api.itemDocuments(id) });
  return (
    <Read q={q} what="the intent">
      {(v) => {
        const intent = v.documents.find((d) => d.type === 'intent_block');
        const cls = v.documents.find((d) => d.type === 'classification');
        if (!intent && !cls) {
          return (
            <EmptyState title="No intent block yet">
              Step 1.5 writes it; G0 and G1 decide it.
            </EmptyState>
          );
        }
        const approved = intent?.versions.filter((x) =>
          x.gates.some((g) => g.status === 'decided' && g.outcome === 'approve'),
        );
        return (
          <div data-testid="intent-tab">
            <p data-testid="intent-status">
              {approved && approved.length > 0
                ? `The intent block version ${(approved.at(-1) as DocumentVersion).version} was approved (${(
                    approved.at(-1) as DocumentVersion
                  ).gates
                    .filter((g) => g.outcome === 'approve')
                    .map((g) => g.gate)
                    .join(', ')}).`
                : 'No gate has approved an intent block yet.'}
            </p>
            {intent ? <DocumentCard doc={intent} /> : null}
            {cls ? <DocumentCard doc={cls} /> : null}
          </div>
        );
      }}
    </Read>
  );
}
