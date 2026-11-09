import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { api, type GateArtefactsWire, type GateCardPreparedWire, type LedgerReceipt } from '../api';
import { Badge } from '../components/Badge';
import { Callout, ErrorNote, Loading } from '../components/Notice';
import { explainDecideError, type DecideProblem } from '../lib/decideErrors';
import { Receipt } from './DecideShell';

// Deciding a work-item gate card in the portal (Gap B): G0 and G1, G1f, G2, G3d, G3 with G3s, E1, E2. The same
// three moves as every card: PREPARE (a single-use nonce per pending gate, bound to the subject the gate
// decides), EVIDENCE VIEWED (sent only after the artefacts the subject binds have been rendered on this page,
// intact, and the prepared subject is the very one on screen), DECIDE (approve, reject or request changes,
// the last two with a reason). Nothing is ever sent on its own: a decision is a click on a button that says
// what it does, no button is a default, and a card the person may not decide shows no button at all.
// The artefact text is the agent's own and is only ever rendered as text (React escapes it; there is no
// `dangerouslySetInnerHTML` here, and the page's content-security policy allows no inline script).

type Decision = 'approve' | 'request_changes' | 'reject';

export function GateDecide({
  id,
  csrf,
  artefacts,
}: {
  id: string;
  csrf: string;
  /** What the page rendered above: the evidence the person looked at. */
  artefacts: GateArtefactsWire;
}) {
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['gate-card', id],
    queryFn: () => api.gateCard(id),
    refetchOnWindowFocus: false,
    staleTime: 0,
  });
  const [prep, setPrep] = useState<GateCardPreparedWire | null>(null);
  const [evidence, setEvidence] = useState(false);
  const [renew, setRenew] = useState(0);
  const [prepProblem, setPrepProblem] = useState<DecideProblem | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<DecideProblem | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<readonly LedgerReceipt[] | null>(null);

  const card = q.data;
  const evidenceOk = artefacts.intact && artefacts.artefacts.length > 0;
  const decidable = card?.may_decide === true && evidenceOk && receipt === null;

  // 1. prepare: one nonce per pending gate, for this person
  useEffect(() => {
    if (!decidable) return;
    let dead = false;
    setPrep(null);
    setEvidence(false);
    setPrepProblem(null);
    api
      .prepareGateCard(id, csrf)
      .then((got) => {
        if (dead) return;
        // what the nonces are bound to must be what this page rendered: a card that changed is not decided blind
        if (got.gates.some((g) => g.subject_hash !== artefacts.subject_hash)) {
          setPrepProblem({
            kind: 'stale',
            text: 'The card changed while this page was opening. Reload the page to see the current version.',
            reload: true,
          });
          return;
        }
        setPrep(got);
      })
      .catch((e: unknown) => {
        if (!dead) setPrepProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [decidable, id, csrf, artefacts.subject_hash, renew]);

  // 2. evidence viewed: from an effect, so after the artefacts above were rendered
  useEffect(() => {
    if (!prep) return;
    let dead = false;
    api
      .gateCardEvidence(
        id,
        prep.gates.map((g) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
        csrf,
      )
      .then(() => {
        if (!dead) setEvidence(true);
      })
      .catch((e: unknown) => {
        if (!dead) setPrepProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [prep, id, csrf]);

  if (q.isPending) return <Loading what="the decision form" />;
  if (q.isError) return <ErrorNote error={q.error} retry={() => void q.refetch()} />;
  const c = q.data;

  async function send(decision: Decision) {
    if (!prep) return;
    setProblem(null);
    setIssues([]);
    if (decision !== 'approve' && reason.trim() === '') {
      setIssues(['Say why, in a sentence, so the person who asked knows.']);
      return;
    }
    setBusy(true);
    try {
      const got = await api.decideGateCard(
        id,
        {
          decision,
          ...(reason.trim() === '' ? {} : { reason: reason.trim() }),
          votes: prep.gates.map((g) => ({ nonce: g.nonce })),
        },
        csrf,
      );
      setReceipt(got.entries);
      void qc.invalidateQueries({ queryKey: ['gate-card', id] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (e) {
      const ex = explainDecideError(e);
      setProblem(ex);
      if (ex.kind === 'expired') setRenew((n) => n + 1);
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return (
      <section aria-label="Decision" className="decide">
        <Receipt entries={receipt} project={c.project_id} />
      </section>
    );
  }

  const open = c.status === 'open' && c.gates.some((g) => g.status === 'pending');
  const why = !open
    ? `This card is ${c.status.replace('_', ' ')}; nothing more is decided on it.${c.decision_reason ? ` The reason given: ${c.decision_reason}` : ''}`
    : c.gates.some((g) => g.step_up_required)
      ? 'This decision needs you to confirm your identity again, which the portal does not do for this kind of card yet. It cannot be decided here.'
      : !evidenceOk
        ? 'This card binds no evidence the portal can show (or it is not intact), so it cannot be decided here.'
        : !c.may_decide
          ? 'You may look at this card but not decide it. The people who hold its role are named below.'
          : null;

  if (why !== null) {
    return (
      <section aria-label="Decision" className="decide">
        <h2>Decision</h2>
        <p className="muted" data-testid="not-decidable">
          {why}
        </p>
        <p className="muted">
          Decided by the people who hold {c.deciders.slots.join(', ')}:{' '}
          {c.deciders.holders.map((h) => c.principal_names[h] ?? h).join(', ') || 'nobody yet'}.
        </p>
      </section>
    );
  }

  const ready = prep !== null && evidence && !busy;
  return (
    <section aria-label="Decision" className="decide">
      <h2>Decision</h2>
      <p className="muted">
        You decide {c.gates.map((g) => g.gate).join(' and ')} together, on the artefacts above
        (subject <code>{c.subject_hash.slice(0, 16)}</code>).
        {c.proposed_lane ? ` Proposed lane: ${c.proposed_lane}.` : ''}
        {c.base_sha ? ` Planned against commit ${c.base_sha.slice(0, 12)}.` : ''}
      </p>
      {c.injection_suspected ? (
        <Callout title="The request text looks like it is trying to instruct the factory">
          <p>It is shown as data and was not obeyed. Read it with that in mind.</p>
        </Callout>
      ) : null}
      {prepProblem ? (
        <div className="notice notice-bad" role="alert">
          <p>{prepProblem.text}</p>
          {prepProblem.reload ? (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => {
                window.location.reload();
              }}
            >
              Reload the page
            </button>
          ) : null}
        </div>
      ) : !ready && !busy ? (
        <p role="status" className="muted">
          Getting the decision form ready…
        </p>
      ) : null}
      {problem ? (
        <div className="notice notice-bad" role="alert" data-testid="decide-problem">
          <p>{problem.text}</p>
        </div>
      ) : null}
      {issues.length > 0 ? (
        <div className="notice notice-bad" role="alert" data-testid="decide-issues">
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!ready}
          onClick={() => void send('approve')}
        >
          Approve
        </button>
      </div>
      <fieldset className="other-decisions">
        <legend>If this is not right</legend>
        <div className="field">
          <label htmlFor="gate-reason">Reason (needed to reject or ask for changes)</label>
          <textarea
            id="gate-reason"
            rows={3}
            maxLength={1000}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
        </div>
        <div className="actions">
          <button
            type="button"
            className="btn btn-quiet"
            disabled={!ready}
            onClick={() => void send('request_changes')}
          >
            Ask for changes
          </button>
          <button
            type="button"
            className="btn btn-danger"
            disabled={!ready}
            onClick={() => void send('reject')}
          >
            Reject
          </button>
        </div>
      </fieldset>
      <p className="muted">
        <Badge tone="neutral">never automatic</Badge> Nothing is decided until you press one of
        these buttons.
      </p>
    </section>
  );
}
