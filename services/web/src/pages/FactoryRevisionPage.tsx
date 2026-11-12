import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { ErrorNote } from '../components/Notice';
import { Read, ShortHash } from '../components/Read';
import { Link } from '../router';
import { Card, KeyValue, PageHead, Pill } from '../ui';

// The factory M1 (M15.5): a factory-layer configuration revision as something to decide, the decide half of the
// configuration console. The policy (`factory.m1_policy`) names the role and how many approvals it takes; the
// proposer never decides their own. Reading is `audit.read` or `config.decide` on the fleet; deciding is
// `config.decide`, the same three steps as every decision: prepare (a nonce bound to what is shown), the evidence
// viewed, then the vote. Core checks the deciders, the quorum and the evidence again.

const json = (v: unknown): string => (v === undefined ? '(not set)' : JSON.stringify(v, null, 2));

export function FactoryRevisionPage({
  gate,
  csrf,
  me,
}: {
  gate: string;
  csrf: string;
  me: string;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['factory-revision', gate],
    queryFn: () => api.factoryRevision(gate),
  });
  const [prep, setPrep] = useState<{ nonce: string; evidence_hash: string } | null>(null);
  const read = useMutation({
    mutationFn: async () => {
      const p = await api.prepareFactoryRevision(gate, csrf);
      await api.factoryRevisionEvidence(
        gate,
        { nonce: p.nonce, evidence_hash: p.evidence_hash },
        csrf,
      );
      return p;
    },
    onSuccess: (p) => setPrep(p),
  });
  const decide = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => {
      if (!prep) throw new Error('read the changes first');
      return api.decideFactoryRevision(gate, { nonce: prep.nonce, decision }, csrf);
    },
    onSuccess: () => {
      setPrep(null);
      void qc.invalidateQueries({ queryKey: ['factory-revision', gate] });
      void qc.invalidateQueries({ queryKey: ['config-key'] });
    },
  });
  return (
    <Read q={q} what="the revision">
      {(v) => (
        <>
          <PageHead
            eyebrow="Govern · factory M1"
            title="A factory configuration revision"
            crumbs={[{ label: 'Configuration', to: '/config' }, { label: 'revision' }]}
            renderLink={(to, label) => <Link to={to}>{label}</Link>}
            sub="Every key the revision changes, before and after. A factory admin other than the proposer approves; how many approvals it takes is itself configuration."
          />
          <Card title="Decision">
            <KeyValue
              rows={[
                ['Revision', <ShortHash key="r" hash={v.rev_hash} />],
                ['Proposed by', v.proposed_by],
                [
                  'State',
                  <Pill
                    key="s"
                    tone={v.status === 'pending' ? 'warn' : v.outcome === 'approve' ? 'ok' : 'mute'}
                  >
                    {v.status === 'pending' ? 'waiting for a decision' : (v.outcome ?? v.status)}
                    {v.published ? ' · published' : ''}
                  </Pill>,
                ],
                ['Decided by', `${v.policy.role}, ${v.quorum} approval(s), never the proposer`],
                [
                  'May decide now',
                  v.deciders.length === 0 ? 'nobody holds the role' : v.deciders.join(', '),
                ],
                ['Evidence', <ShortHash key="e" hash={v.evidence_hash} />],
              ]}
            />
          </Card>
          <Card title={`What it changes (${v.changes.length})`} testId="frev-changes">
            {v.changes.map((c) => (
              <section key={c.key} aria-label={`Change of ${c.key}`} className="pg-preview">
                <h3>
                  <Link to={`/config/${c.key}`}>
                    <code>{c.key}</code>
                  </Link>
                </h3>
                <div className="pg-split">
                  <div>
                    <div className="ui-eyebrow">Before</div>
                    <pre className="ui-mono pg-pre">{json(c.before)}</pre>
                  </div>
                  <div>
                    <div className="ui-eyebrow">After</div>
                    <pre className="ui-mono pg-pre">{json(c.after)}</pre>
                  </div>
                </div>
              </section>
            ))}
          </Card>
          {v.may_decide ? (
            <Card title="Your decision" testId="frev-decide">
              {prep === null ? (
                <>
                  <p>
                    Read the changes above, then say so: the decision is bound to exactly what you
                    read.
                  </p>
                  <button
                    type="button"
                    className="ui-btn"
                    disabled={read.isPending}
                    onClick={() => read.mutate()}
                  >
                    I have read the changes
                  </button>
                </>
              ) : (
                <div className="pg-inline">
                  <button
                    type="button"
                    className="ui-btn ui-btn-primary"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate('approve')}
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    className="ui-btn"
                    disabled={decide.isPending}
                    onClick={() => decide.mutate('reject')}
                  >
                    Reject
                  </button>
                </div>
              )}
              {read.isError ? <ErrorNote error={read.error} /> : null}
              {decide.isError ? <ErrorNote error={decide.error} /> : null}
              {decide.isSuccess ? <p role="status">Your decision is on the ledger.</p> : null}
            </Card>
          ) : (
            <Card title="Your decision">
              <p className="muted" data-testid="frev-why-not">
                {v.status !== 'pending'
                  ? 'This revision has been decided.'
                  : v.proposed_by === me
                    ? 'You proposed it, so you do not decide it.'
                    : `You may read it but not decide it: the ${v.policy.role} holders above decide it.`}
              </p>
            </Card>
          )}
        </>
      )}
    </Read>
  );
}
