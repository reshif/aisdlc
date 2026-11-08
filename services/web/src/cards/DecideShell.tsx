import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  api,
  ApiError,
  type CardDecision,
  type CardDetailWire,
  type LedgerReceipt,
  type PreparedCard,
} from '../api';
import { Badge } from '../components/Badge';
import { validateAgainst } from '../lib/schema';
import { explainDecideError, type DecideProblem } from '../lib/decideErrors';
import { Link } from '../router';
import { Hash } from './shared';

// The decide flow every card shares (PLAN M8.3): prepare (a nonce), tell the factory the evidence
// was shown (once the page has rendered it), decide. Nothing here decides for the person: the only
// way a decision is sent is a click on a button that says what it does, and no button is ever the
// default of a form. The content is checked against the card's own JSON Schema before it is sent
// and again by core, with the same contracts.

export interface DecideShellProps {
  readonly card: CardDetailWire;
  readonly csrf: string;
  /** What the form holds for an approval; `null` while the form cannot say. */
  readonly content: unknown;
  /** Reasons the form is not ready to approve (they are shown, and the button stays off). */
  readonly blocked: readonly string[];
  readonly approveLabel: string;
  /** A card with nothing to reconsider (the security card) takes no send-back or rejection. */
  readonly onlyApprove?: boolean;
  /** Text above the buttons that belongs to the card (a confirmation checkbox, say). */
  readonly children?: ReactNode;
}

const ENTRY_TEXT: Readonly<Record<string, string>> = {
  approve: 'approved',
  reject: 'rejected',
  request_changes: 'sent back',
};

export function Receipt({
  entries,
  project,
}: {
  entries: readonly LedgerReceipt[];
  project: string;
}) {
  return (
    <section className="notice notice-good" aria-label="Ledger receipt" data-testid="receipt">
      <h3>Decision recorded on the ledger</h3>
      <ul className="plain receipt-list">
        {entries.map((e) => (
          <li key={e.entry_hash} data-ledger-seq={e.ledger_seq}>
            <dl className="facts">
              <div>
                <dt>Ledger entry</dt>
                <dd>#{e.ledger_seq}</dd>
              </div>
              <div>
                <dt>Decision</dt>
                <dd>
                  {e.gate_id ? `${e.gate_id}: ` : ''}
                  {e.decision ? (ENTRY_TEXT[e.decision] ?? e.decision) : e.entry_type}
                  {e.sod_waiver ? ' (decided alone: sod_waiver)' : ''}
                </dd>
              </div>
              <div>
                <dt>Entry hash</dt>
                <dd>
                  <Hash value={e.entry_hash} label="entry hash" />
                </dd>
              </div>
            </dl>
            <p>
              <Link to={`/projects/${project}/ledger#entry-${e.ledger_seq}`}>
                Open entry #{e.ledger_seq} in the ledger
              </Link>
            </p>
          </li>
        ))}
      </ul>
      <p>
        <Link to={`/projects/${project}/ledger`}>See all of the project&rsquo;s ledger</Link>
      </p>
    </section>
  );
}

export function DecideShell(p: DecideShellProps) {
  const { card, csrf } = p;
  const qc = useQueryClient();
  const id = card.summary.card_id;
  const enabled = card.may_decide && card.summary.status === 'open' && card.summary.actionable;
  const [prep, setPrep] = useState<PreparedCard | null>(null);
  const [evidence, setEvidence] = useState(false);
  const [renew, setRenew] = useState(0);
  const [prepProblem, setPrepProblem] = useState<DecideProblem | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const [stepNote, setStepNote] = useState<string | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<DecideProblem | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [receipt, setReceipt] = useState<CardDecision | null>(null);
  const [applyNote, setApplyNote] = useState<string | null>(null);

  // 1. prepare: a nonce for this person and this evidence.
  useEffect(() => {
    if (!enabled || receipt) return;
    let dead = false;
    setPrep(null);
    setEvidence(false);
    setPrepProblem(null);
    api
      .prepareCard(id, csrf)
      .then((got) => {
        if (dead) return;
        if (got.evidence_hash !== card.evidence_hash) {
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
  }, [enabled, id, csrf, card.evidence_hash, renew, receipt]);

  // 2. evidence viewed: sent from an effect, so after the page has rendered what it covers.
  useEffect(() => {
    if (!prep) return;
    let dead = false;
    api
      .cardEvidence(id, { nonce: prep.nonce, evidence_hash: prep.evidence_hash }, csrf)
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

  // 3. back from the identity provider: collect the proof of the step-up, once.
  const collected = useRef(false);
  useEffect(() => {
    if (collected.current) return;
    const attempt = new URLSearchParams(window.location.search).get('step_up');
    if (!attempt) return;
    collected.current = true;
    window.history.replaceState(null, '', window.location.pathname);
    api
      .stepUpCollect(attempt)
      .then((got) => {
        setProof(got.proof);
        setStepNote('Your identity is confirmed. Choose what you decide below.');
      })
      .catch(() =>
        setStepNote(
          'The identity confirmation could not be collected (it can be used once). Confirm again.',
        ),
      );
  }, []);

  const needsProof = prep?.step_up?.required === true;

  const confirmIdentity = useCallback(async () => {
    if (!prep?.step_up) return;
    setBusy(true);
    try {
      const got = await api.stepUpStart(
        { subject_hash: prep.step_up.bound_hash, return_to: window.location.pathname },
        csrf,
      );
      if (got.status === 'redirect') {
        window.location.assign(got.authorize_url);
        return;
      }
      setProof(got.proof);
      setStepNote('Your identity is confirmed. Choose what you decide below.');
    } catch (e) {
      setProblem(explainDecideError(e));
    } finally {
      setBusy(false);
    }
  }, [prep, csrf]);

  async function send(decision: 'approve' | 'request_changes' | 'reject') {
    if (!prep) return;
    setProblem(null);
    setIssues([]);
    if (decision === 'approve') {
      if (p.blocked.length > 0) {
        setIssues([...p.blocked]);
        return;
      }
      const schemaIssues = validateAgainst(card.decision_schema, p.content);
      if (schemaIssues.length > 0) {
        setIssues(schemaIssues);
        return;
      }
    } else if (reason.trim() === '') {
      setIssues(['Say why, in a sentence, so the person who asked knows.']);
      return;
    }
    if (needsProof && !proof) {
      setProblem(explainDecideError(new ApiError(422, 'refused', 'step_up_required')));
      return;
    }
    setBusy(true);
    try {
      const got = await api.decideCard(
        id,
        {
          nonce: prep.nonce,
          decision,
          ...(decision === 'approve' ? { content: p.content } : {}),
          ...(decision !== 'approve' || reason.trim() !== '' ? { reason: reason.trim() } : {}),
          ...(needsProof && proof ? { step_up: { proof } } : {}),
        },
        csrf,
      );
      setReceipt(got);
      setApplyNote(
        got.applied === 'pending'
          ? 'The decision is on the ledger. Its effect on the onboarding record is still being applied and will follow by itself.'
          : null,
      );
      setProof(null);
      void qc.invalidateQueries({ queryKey: ['card', id] });
      void qc.invalidateQueries({ queryKey: ['s0'] });
      void qc.invalidateQueries({ queryKey: ['inbox'] });
    } catch (e) {
      const ex = explainDecideError(e);
      setProblem(ex);
      if (ex.kind === 'expired') {
        setRenew((n) => n + 1);
      }
      if (ex.kind === 'step_up') setProof(null);
      if (ex.reload) void qc.invalidateQueries({ queryKey: ['card', id] });
    } finally {
      setBusy(false);
    }
  }

  if (receipt) {
    return (
      <section aria-label="Decision" className="decide">
        <Receipt entries={receipt.decision.entries} project={card.summary.project_id} />
        {applyNote ? <p className="notice notice-attention">{applyNote}</p> : null}
      </section>
    );
  }

  const sendBackLeft = card.send_backs.limit - card.send_backs.used;
  const canSendBack = card.decisions_allowed.includes('request_changes') && sendBackLeft > 0;

  if (!enabled) {
    return (
      <section aria-label="Decision" className="decide">
        <h2>Decision</h2>
        <p className="muted" data-testid="not-decidable">
          {card.summary.status !== 'open'
            ? `This card is ${card.summary.status.replace('_', ' ')}; nothing more is decided on it.`
            : !card.summary.actionable
              ? 'The onboarding is not waiting at this card right now, so it cannot be decided.'
              : 'You may look at this card but not decide it. The people who hold its role are named above.'}
        </p>
      </section>
    );
  }

  const ready = prep !== null && evidence && !busy;
  const proofMissing = needsProof && !proof;

  return (
    <section aria-label="Decision" className="decide">
      <h2>Decision</h2>
      {prepProblem ? (
        <div className="notice notice-bad" role="alert">
          <p>{prepProblem.text}</p>
          {prepProblem.reload ? (
            <button
              type="button"
              className="btn btn-quiet"
              onClick={() => void qc.invalidateQueries({ queryKey: ['card', id] })}
            >
              Reload the card
            </button>
          ) : null}
        </div>
      ) : !ready && !busy ? (
        <p role="status" className="muted">
          Getting the decision form ready…
        </p>
      ) : null}

      {p.children}

      {needsProof ? (
        <div className="stepup">
          <h3>Confirm your identity</h3>
          <p>
            Signing this record needs you to sign in again at your identity provider, for this
            record only
            {prep?.step_up ? (
              <>
                {' '}
                (bound to <Hash value={prep.step_up.bound_hash} label="record hash" />)
              </>
            ) : null}
            . You come back to this page and then choose what you decide.
          </p>
          {proof ? (
            <p role="status" className="notice notice-good" data-testid="stepup-ready">
              {stepNote ?? 'Your identity is confirmed.'}
            </p>
          ) : (
            <>
              {stepNote ? (
                <p role="status" className="notice notice-attention">
                  {stepNote}
                </p>
              ) : null}
              <button
                type="button"
                className="btn"
                onClick={() => void confirmIdentity()}
                disabled={!prep || busy}
              >
                Confirm my identity
              </button>
            </>
          )}
        </div>
      ) : null}

      {problem ? (
        <div className="notice notice-bad" role="alert" data-testid="decide-problem">
          <p>{problem.text}</p>
          {problem.reload ? (
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
      ) : null}
      {issues.length > 0 ? (
        <div className="notice notice-bad" role="alert" data-testid="decide-issues">
          <p>This cannot be sent yet:</p>
          <ul>
            {issues.map((i) => (
              <li key={i}>{i}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.blocked.length > 0 ? (
        <div className="notice notice-attention" data-testid="blocked">
          <p>Before you can approve:</p>
          <ul>
            {p.blocked.map((b) => (
              <li key={b}>{b}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <div className="actions">
        <button
          type="button"
          className="btn"
          disabled={!ready || proofMissing || p.blocked.length > 0}
          onClick={() => void send('approve')}
        >
          {p.approveLabel}
        </button>
      </div>
      {proofMissing ? (
        <p className="muted">Confirm your identity first; the buttons stay off until you have.</p>
      ) : null}

      {p.onlyApprove ? null : (
        <fieldset className="other-decisions">
          <legend>If this is not right</legend>
          <div className="field">
            <label htmlFor="decide-reason">Reason (for a send-back or a rejection)</label>
            <textarea
              id="decide-reason"
              rows={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="btn btn-quiet"
              disabled={!ready || proofMissing || !canSendBack}
              onClick={() => void send('request_changes')}
            >
              Send back for changes
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={!ready || proofMissing}
              onClick={() => void send('reject')}
            >
              Reject the onboarding
            </button>
          </div>
          <p className="muted" data-testid="sendback-note">
            {canSendBack
              ? `Send-backs used: ${card.send_backs.used} of ${card.send_backs.limit}. A send-back returns this step to the factory once.`
              : `Send-backs used: ${card.send_backs.used} of ${card.send_backs.limit}. No send-back is left for this step, so the only way to stop is to reject: that ends the onboarding at this step (it can be restored or withdrawn later).`}
          </p>
        </fieldset>
      )}
      <p className="muted">
        <Badge tone="neutral">never automatic</Badge> Nothing is decided until you press one of
        these buttons.
      </p>
    </section>
  );
}
