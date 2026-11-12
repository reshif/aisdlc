import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  GATES,
  ProjectToggleGroupValues,
  ROLE_CATALOGUE,
  RoleSlotValues,
  type RoleSlot,
} from '@aisdlc/contracts';
import { useEffect, useState } from 'react';
import { api, type PreparedRevision, type RevisionDecision } from '../api';
import { Badge } from '../components/Badge';
import { PageError, Loading } from '../components/Notice';
import { Hash, nameOf, Section, DecidersLine } from '../cards/shared';
import { StepUpBox, useStepUp } from '../cards/StepUp';
import { explainDecideError, type DecideProblem } from '../lib/decideErrors';
import { Link } from '../router';

const slotDescription = (slot: RoleSlot): string =>
  ROLE_CATALOGUE.find((r) => r.slot === slot)?.description ?? slot;

/**
 * The settings revision card 4 proposed (the M1 gate): "settings revision pending". Until it is
 * decided and published the role map is not in force and card 5 cannot open. For a first onboarding
 * the person who asked for it decides it as the provisional admin; afterwards the role map's admins do.
 * The same decide flow as a card: prepare, evidence viewed, decide; an approval is published at once.
 */
export function RevisionPage({ gate, csrf }: { gate: string; csrf: string }) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['revision', gate],
    queryFn: () => api.revision(gate),
    refetchInterval: (s) => (s.state.data?.status === 'pending' ? 5000 : false),
  });
  const rev = q.data;
  const enabled = rev?.may_decide === true && rev.status === 'pending';
  const [prep, setPrep] = useState<PreparedRevision | null>(null);
  const [seen, setSeen] = useState(false);
  const [renew, setRenew] = useState(0);
  const [problem, setProblem] = useState<DecideProblem | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RevisionDecision | null>(null);
  const needsProof = prep?.step_up?.required === true;
  const stepUp = useStepUp(needsProof ? (prep?.step_up?.bound_hash ?? null) : null, csrf);

  useEffect(() => {
    if (!enabled || result) return;
    let dead = false;
    setPrep(null);
    setSeen(false);
    api
      .prepareRevision(gate, csrf)
      .then((p) => {
        if (dead) return;
        if (rev && p.evidence_hash !== rev.evidence_hash) {
          setProblem({
            kind: 'stale',
            text: 'The revision changed while this page was opening. Reload the page.',
            reload: true,
          });
          return;
        }
        setPrep(p);
      })
      .catch((e: unknown) => {
        if (!dead) setProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [enabled, gate, csrf, rev?.evidence_hash, renew, result]);

  useEffect(() => {
    if (!prep) return;
    let dead = false;
    api
      .revisionEvidence(gate, { nonce: prep.nonce, evidence_hash: prep.evidence_hash }, csrf)
      .then(() => {
        if (!dead) setSeen(true);
      })
      .catch((e: unknown) => {
        if (!dead) setProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [prep, gate, csrf]);

  if (q.isPending) return <Loading what="the settings revision" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const r = q.data;
  const names = r.principal_names;

  async function decide(decision: 'approve' | 'reject') {
    if (!prep) return;
    setBusy(true);
    setProblem(null);
    try {
      setResult(
        await api.decideRevision(
          gate,
          {
            nonce: prep.nonce,
            decision,
            ...(needsProof && stepUp.proof ? { step_up: { proof: stepUp.proof } } : {}),
          },
          csrf,
        ),
      );
      stepUp.clear();
      void qc.invalidateQueries({ queryKey: ['revision', gate] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
      void qc.invalidateQueries({ queryKey: ['s0'] });
    } catch (e) {
      const ex = explainDecideError(e);
      setProblem(ex);
      if (ex.kind === 'expired') setRenew((n) => n + 1);
      if (ex.kind === 'step_up') stepUp.clear();
    } finally {
      setBusy(false);
    }
  }

  async function publish() {
    setBusy(true);
    setProblem(null);
    try {
      await api.publishRevision(gate, csrf);
      setResult((x) => (x ? { ...x, published: true, publish_error: null } : x));
      void qc.invalidateQueries({ queryKey: ['revision', gate] });
    } catch (e) {
      setProblem(explainDecideError(e));
    } finally {
      setBusy(false);
    }
  }

  const state = r.published
    ? { tone: 'good' as const, text: 'Published: this role map is in force.' }
    : r.status === 'pending'
      ? { tone: 'attention' as const, text: 'Waiting for a decision' }
      : r.status === 'decided' && r.outcome === 'approve'
        ? { tone: 'attention' as const, text: 'Approved, not published yet' }
        : { tone: 'bad' as const, text: `Not in force (${r.outcome ?? r.status})` };

  return (
    <>
      <p className="crumbs">
        <Link to="/inbox">Inbox</Link>
        {r.s0_id ? (
          <>
            {' '}
            / <Link to={`/s0/${r.s0_id}`}>Onboarding record</Link>
          </>
        ) : null}
      </p>
      <h1>Settings revision pending</h1>
      <p className="status-line">
        <Badge tone={state.tone}>{state.text}</Badge>
      </p>
      <p>
        Card 4 proposed these settings for{' '}
        <Link to={`/projects/${r.project_id}`}>{r.project_id}</Link>. They take effect only when the
        people who hold the admin role approve them. Until then the role map below is not in force
        and the last card of the onboarding cannot open.
      </p>
      <DecidersLine who={r.deciders} names={names} what="this revision" />
      <p className="muted">
        Revision <Hash value={r.rev_hash} label="revision hash" /> proposed by{' '}
        {nameOf(names, r.proposed_by)}.
      </p>

      <Section title="Who can do what" id="rev-roles">
        <table className="table" aria-label="Role map">
          <thead>
            <tr>
              <th scope="col">Slot</th>
              <th scope="col">People</th>
            </tr>
          </thead>
          <tbody>
            {RoleSlotValues.map((s) => {
              const v = r.settings.role_map[s];
              return (
                <tr key={s} data-slot={s}>
                  <th scope="row">
                    {s} <span className="muted">{slotDescription(s)}</span>
                  </th>
                  <td>
                    {v.kind === 'codeowners'
                      ? 'the code owners on GitHub'
                      : v.principals.length === 0
                        ? 'nobody'
                        : v.principals.join(', ')}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>
      <Section title="Rules" id="rev-rules">
        <p>
          Two-person rule: {r.settings.two_person.enabled ? 'on' : 'off'}
          {r.settings.two_person.locked_on ? ' (locked on)' : ''}. Gates on:{' '}
          {ProjectToggleGroupValues.filter((g) => r.settings.gating_profile.gates[g] === 'on')
            .map((g) =>
              Object.values(GATES)
                .filter((x) => x.projectToggle === g)
                .map((x) => x.title)
                .join(', '),
            )
            .join('; ') || 'none'}
          . Kill delegations:{' '}
          {r.settings.kill_delegations.filter((d) => d.revoked_at === null).length}.
        </p>
      </Section>

      <section aria-label="Decision" className="decide">
        <h2>Decision</h2>
        {result ? (
          <div className="notice notice-good" role="status" data-testid="receipt">
            <h3>Decision recorded on the ledger</h3>
            <p>
              Ledger entry #{result.entry.ledger_seq}: {result.entry.decision} (entry hash{' '}
              <Hash value={result.entry.entry_hash} label="entry hash" />)
              {result.published
                ? '. The revision is published and the role map is in force.'
                : result.outcome === 'approve'
                  ? '. The revision is not published yet.'
                  : '.'}
            </p>
            {result.outcome === 'approve' && !result.published ? (
              <>
                {result.publish_error ? <p>{result.publish_error}</p> : null}
                <button
                  type="button"
                  className="btn"
                  onClick={() => void publish()}
                  disabled={busy}
                >
                  Publish the approved revision
                </button>
              </>
            ) : null}
            <p>
              <Link to={`/projects/${r.project_id}/ledger`}>
                See it in the project&rsquo;s ledger
              </Link>
            </p>
          </div>
        ) : !enabled ? (
          <p className="muted" data-testid="not-decidable">
            {r.status !== 'pending'
              ? 'This revision has been decided.'
              : 'You may look at this revision but not decide it. The people who hold the admin role decide it.'}
            {r.status === 'decided' &&
            r.outcome === 'approve' &&
            !r.published &&
            r.may_decide === false
              ? ' It is approved and will be published.'
              : ''}
          </p>
        ) : (
          <>
            {problem ? (
              <div className="notice notice-bad" role="alert" data-testid="decide-problem">
                <p>{problem.text}</p>
              </div>
            ) : !seen ? (
              <p role="status" className="muted">
                Getting the decision form ready…
              </p>
            ) : null}
            {needsProof ? (
              <StepUpBox s={stepUp} boundHash={prep?.step_up?.bound_hash ?? null} />
            ) : null}
            {stepUp.error ? (
              <div className="notice notice-bad" role="alert">
                <p>{explainDecideError(stepUp.error).text}</p>
              </div>
            ) : null}
            <div className="actions">
              <button
                type="button"
                className="btn"
                disabled={!seen || busy || (needsProof && !stepUp.proof)}
                onClick={() => void decide('approve')}
              >
                Approve and publish these settings
              </button>
              <button
                type="button"
                className="btn btn-danger"
                disabled={!seen || busy || (needsProof && !stepUp.proof)}
                onClick={() => void decide('reject')}
              >
                Reject these settings
              </button>
            </div>
            <p className="muted">Nothing is decided until you press one of these buttons.</p>
          </>
        )}
      </section>
    </>
  );
}
