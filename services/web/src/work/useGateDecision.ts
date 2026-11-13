import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type GateCardPreparedWire, type GateCardWire, type LedgerReceipt } from '../api';
import { explainDecideError, type DecideProblem } from '../lib/decideErrors';
import type { DecisionVerb } from '../ui';

// Deciding a work-item approval: the same three moves as every card, now in one place for every approval.
//   1. PREPARE: a single-use nonce per pending gate, bound to the subject the gate decides; a subject that is not the
//      one this page shows is refused here ("reload"), never decided blind.
//   2. EVIDENCE VIEWED: sent from an effect, so only after the evidence was painted on this page.
//   3. DECIDE: a click on one of the three verbs, with a reason (always for a send-back or a refusal, and for every
//      decision outside the rules), and the step-up proof when the gate wants one.
// The factory admin deciding outside the normal rules sends the reason as the override header on all three moves;
// the bff carries it to core and the decision kernel records it on the decision (docs/specs/deletion.md §8).
// Nothing is decided on its own: no verb is a default, and every refusal means "nothing was decided".

export interface GateDecision {
  readonly prepared: boolean;
  readonly ready: boolean;
  readonly busy: boolean;
  readonly problem: DecideProblem | null;
  readonly receipt: readonly LedgerReceipt[] | null;
  readonly needsProof: boolean;
  readonly proof: string | null;
  readonly note: string | null;
  confirmIdentity: () => void;
  decide: (verb: DecisionVerb, reason: string) => void;
}

export function useGateDecision({
  id,
  csrf,
  card,
  decidable,
  override,
}: {
  id: string;
  csrf: string;
  card: GateCardWire | undefined;
  /** The person may decide (or the factory admin decides outside the rules) and the evidence is on screen. */
  decidable: boolean;
  /**
   * The factory admin decides outside the rules: nothing is prepared ahead; the click prepares, says the evidence
   * was viewed and decides in one go, all three carrying the reason typed in the rail as the override reason.
   */
  override?: boolean;
}): GateDecision {
  const qc = useQueryClient();
  const [prep, setPrep] = useState<GateCardPreparedWire | null>(null);
  const [viewed, setViewed] = useState(false);
  const [renew, setRenew] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<DecideProblem | null>(null);
  const [receipt, setReceipt] = useState<readonly LedgerReceipt[] | null>(null);
  const [proof, setProof] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const subject = card?.subject_hash ?? null;
  const on = decidable && !override && subject !== null && receipt === null;
  const reasonRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    if (!on) return;
    let dead = false;
    setPrep(null);
    setViewed(false);
    setProblem(null);
    api
      .prepareGateCard(id, csrf, reasonRef.current)
      .then((got) => {
        if (dead) return;
        if (got.gates.some((g) => g.subject_hash !== subject)) {
          setProblem({
            kind: 'stale',
            text: 'This approval changed while the page was opening. Reload to see the current version; nothing was decided.',
            reload: true,
          });
          return;
        }
        setPrep(got);
      })
      .catch((e: unknown) => {
        if (!dead) setProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [on, id, csrf, subject, renew]);

  useEffect(() => {
    if (!prep) return;
    let dead = false;
    api
      .gateCardEvidence(
        id,
        prep.gates.map((g) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
        csrf,
        reasonRef.current,
      )
      .then(() => {
        if (!dead) setViewed(true);
      })
      .catch((e: unknown) => {
        if (!dead) setProblem(explainDecideError(e));
      });
    return () => {
      dead = true;
    };
  }, [prep, id, csrf]);

  // back from the identity provider: collect the step-up proof, once
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
        setNote('It is you: decide now.');
      })
      .catch(() => setNote('The confirmation could not be read (it works once). Confirm again.'));
  }, []);

  const needsProof =
    prep?.gates.some((g) => g.step_up.required) ??
    card?.gates.some((g) => g.step_up_required) ??
    false;

  const confirmIdentity = useCallback(() => {
    const bound = prep?.gates.find((g) => g.step_up.required)?.step_up.bound_hash;
    if (!bound) return;
    setBusy(true);
    api
      .stepUpStart({ subject_hash: bound, return_to: window.location.pathname }, csrf)
      .then((got) => {
        if (got.status === 'redirect') {
          window.location.assign(got.authorize_url);
          return;
        }
        setProof(got.proof);
        setNote('It is you: decide now.');
      })
      .catch((e: unknown) => setProblem(explainDecideError(e)))
      .finally(() => setBusy(false));
  }, [prep, csrf]);

  const send = useCallback(
    (p: GateCardPreparedWire, verb: DecisionVerb, reason: string, proofNow: string | null) =>
      api
        .decideGateCard(
          id,
          {
            decision: verb,
            ...(reason === '' ? {} : { reason }),
            votes: p.gates.map((g) => ({
              nonce: g.nonce,
              ...(g.step_up.required && proofNow ? { step_up: { proof: proofNow } } : {}),
            })),
          },
          csrf,
          reasonRef.current,
        )
        .then((got) => {
          setReceipt(got.entries);
          setProof(null);
          void qc.invalidateQueries({ queryKey: ['gate-card', id] });
          void qc.invalidateQueries({ queryKey: ['gate-context', id] });
          void qc.invalidateQueries({ queryKey: ['inbox'] });
          void qc.invalidateQueries({ queryKey: ['item'] });
        }),
    [id, csrf, qc],
  );

  const decide = useCallback(
    (verb: DecisionVerb, reason: string) => {
      if (override) {
        // one go: prepare, evidence viewed (the evidence is on screen), decide, each with the reason as the override
        reasonRef.current = reason;
        setProblem(null);
        setBusy(true);
        void (async () => {
          try {
            const p = await api.prepareGateCard(id, csrf, reason);
            if (p.gates.some((g) => g.subject_hash !== subject)) {
              setProblem({
                kind: 'stale',
                text: 'This approval changed while you read it. Reload to see the current version; nothing was decided.',
                reload: true,
              });
              return;
            }
            await api.gateCardEvidence(
              id,
              p.gates.map((g) => ({ nonce: g.nonce, evidence_hash: g.evidence_hash })),
              csrf,
              reason,
            );
            await send(p, verb, reason, proof);
          } catch (e) {
            setProblem(explainDecideError(e));
          } finally {
            setBusy(false);
          }
        })();
        return;
      }
      if (!prep) return;
      if (needsProof && !proof) {
        setProblem({
          kind: 'step_up',
          text: "Confirm it's you first, then decide. Nothing was decided.",
          reload: false,
        });
        return;
      }
      setProblem(null);
      setBusy(true);
      send(prep, verb, reason, proof)
        .catch((e: unknown) => {
          const ex = explainDecideError(e);
          setProblem(ex);
          if (ex.kind === 'expired') setRenew((n) => n + 1);
          if (ex.kind === 'step_up') setProof(null);
        })
        .finally(() => setBusy(false));
    },
    [override, prep, needsProof, proof, id, csrf, subject, send],
  );

  return {
    prepared: prep !== null,
    ready: override ? !busy && receipt === null : prep !== null && viewed && !busy,
    busy,
    problem,
    receipt,
    needsProof,
    proof,
    note,
    confirmIdentity,
    decide,
  };
}
