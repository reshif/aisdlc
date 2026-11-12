import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Hash } from './shared';

// The step-up of one decision, for pages that decide a gate outside the card shell (a settings revision's M1,
// a factory revision): where the gate needs one (G5, M4, and every gate that needs two people: RC-SEC-4) the
// person signs in again at the identity provider for exactly the gate's bound hash, comes back to this page,
// and the proof is sent with the vote. Core checks it; this only collects it.

export interface StepUpState {
  readonly proof: string | null;
  readonly note: string | null;
  readonly busy: boolean;
  readonly error: unknown;
  confirm(): Promise<void>;
  clear(): void;
}

/** `boundHash`: the gate's `step_up.bound_hash` from prepare; null while not known or not needed. */
export function useStepUp(boundHash: string | null, csrf: string): StepUpState {
  const [proof, setProof] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);

  // back from the identity provider: collect the proof, once
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
        setNote('Your identity is confirmed. Choose what you decide below.');
      })
      .catch(() =>
        setNote(
          'The identity confirmation could not be collected (it can be used once). Confirm again.',
        ),
      );
  }, []);

  const confirm = useCallback(async () => {
    if (!boundHash) return;
    setBusy(true);
    setError(null);
    try {
      const got = await api.stepUpStart(
        { subject_hash: boundHash, return_to: window.location.pathname },
        csrf,
      );
      if (got.status === 'redirect') {
        window.location.assign(got.authorize_url);
        return;
      }
      setProof(got.proof);
      setNote('Your identity is confirmed. Choose what you decide below.');
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  }, [boundHash, csrf]);

  const clear = useCallback(() => setProof(null), []);
  return { proof, note, busy, error, confirm, clear };
}

/** The "confirm your identity" box; render it only where the gate needs a step-up. */
export function StepUpBox({ s, boundHash }: { s: StepUpState; boundHash: string | null }) {
  return (
    <div className="stepup" data-testid="stepup">
      <h3>Confirm your identity</h3>
      <p>
        This decision needs you to sign in again at your identity provider, for this decision only
        {boundHash ? (
          <>
            {' '}
            (bound to <Hash value={boundHash} label="subject hash" />)
          </>
        ) : null}
        . You come back to this page and then choose what you decide.
      </p>
      {s.proof ? (
        <p role="status" className="notice notice-good" data-testid="stepup-ready">
          {s.note ?? 'Your identity is confirmed.'}
        </p>
      ) : (
        <>
          {s.note ? (
            <p role="status" className="notice notice-attention">
              {s.note}
            </p>
          ) : null}
          <button
            type="button"
            className="btn"
            onClick={() => void s.confirm()}
            disabled={!boundHash || s.busy}
          >
            Confirm my identity
          </button>
        </>
      )}
    </div>
  );
}
