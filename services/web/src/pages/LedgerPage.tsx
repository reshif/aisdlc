import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../api';
import { PageError, Loading } from '../components/Notice';
import { Hash } from '../cards/shared';
import { shortTime } from '../format';
import { Link } from '../router';

/** The ledger entries of a project, or of one onboarding record (PLAN M8.4): read-only. */
export function LedgerPage({ project, s0 }: { project: string; s0?: string }) {
  const q = useQuery({
    queryKey: ['ledger', project, s0 ?? null],
    queryFn: () => api.ledger(project, s0),
  });
  // A link from a receipt names one entry (`#entry-7`): bring it into view once the entries are here.
  const loaded = q.data !== undefined;
  useEffect(() => {
    if (!loaded) return;
    const id = window.location.hash.slice(1);
    if (id !== '') document.getElementById(id)?.scrollIntoView?.({ block: 'center' });
  }, [loaded]);
  if (q.isPending) return <Loading what="the ledger entries" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const { entries, head } = q.data;
  return (
    <>
      <p className="crumbs">
        <Link to="/">Projects</Link> / <Link to={`/projects/${project}`}>{project}</Link>
      </p>
      <h1>Ledger of {project}</h1>
      <p>
        Every decision about this project is an entry on the signed, hash-chained ledger. Each
        entry&rsquo;s hash covers the one before it, so none can be changed or removed without the
        offline check noticing.
      </p>
      {s0 ? (
        <p>
          Limited to one onboarding record.{' '}
          <Link to={`/projects/${project}/ledger`}>Show the whole project</Link>
        </p>
      ) : null}
      {entries.length === 0 ? (
        <p className="muted" data-testid="ledger-empty">
          No entries yet.
        </p>
      ) : (
        <div className="scroll">
          <table className="table" aria-label="Ledger entries">
            <thead>
              <tr>
                <th scope="col">Seq</th>
                <th scope="col">Entry</th>
                <th scope="col">Gate or step</th>
                <th scope="col">Decision</th>
                <th scope="col">Actor</th>
                <th scope="col">Alone</th>
                <th scope="col">Time</th>
                <th scope="col">Entry hash</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr
                  key={e.entry_hash}
                  id={`entry-${e.ledger_seq}`}
                  data-seq={e.ledger_seq}
                  data-type={e.entry_type}
                  aria-current={
                    window.location.hash === `#entry-${e.ledger_seq}` ? 'true' : undefined
                  }
                >
                  <th scope="row">{e.ledger_seq}</th>
                  <td>{e.entry_type}</td>
                  <td>{e.gate_id ?? (e.step ? `step ${e.step}` : '')}</td>
                  <td>{e.decision ?? ''}</td>
                  <td>{e.actor ?? ''}</td>
                  <td>{e.sod_waiver ? 'sod_waiver' : ''}</td>
                  <td>{shortTime(e.created_at)}</td>
                  <td>
                    <Hash value={e.entry_hash} label="entry hash" />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <h2>Check it yourself</h2>
      <p>
        The ledger is verified offline, from the database and the public keys, with no help from the
        factory:
      </p>
      <pre className="code">
        aisdlc verify-ledger --db &lt;postgres-url&gt; --notary-key &lt;jwk-file&gt; --witness-key
        &lt;jwk-file&gt;
      </pre>
      <p className="muted">
        {head
          ? `The ledger itself is at entry ${head.ledger_seq} (hash ${head.entry_hash.slice(0, 16)}…). This view lists the entries that concern ${project}.`
          : 'The ledger is empty.'}{' '}
        See the verify-ledger section of the project docs for where the keys are.
      </p>
    </>
  );
}
