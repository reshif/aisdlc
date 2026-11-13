import { term } from '@aisdlc/contracts';
import { useCallback, useId, useRef, useState, type ReactNode } from 'react';
import { ApiError } from '../api';
import { Modal } from '../ui';

// The factory admin's override in the portal (docs/specs/deletion.md §8, screen map intro: "the factory admin sees a
// Decide as factory admin or Apply as factory admin button that asks for a reason and records it"). One dialog asks
// for the reason; the act is then sent with it in `x-aisdlc-override-reason`, and the service that decides records
// who, what and why in the decision log. Recording never blocks the act; a blank reason is never sent.
//
//   const ov = useOverride();
//   await ov.withReason('Answer as factory admin', (reason) => api.act(..., reason));   // asks first
//   await ov.ifNeeded('Remove the role', (reason) => api.act(..., reason));             // asks only on a 403
//                                                                                       // override_reason_required
//   return <>{...}{ov.dialog}</>;

/** The error code a service answers when only the factory admin's override permits the act and no reason came. */
export const OVERRIDE_NEEDED = 'override_reason_required';

/** The person cancelled the reason dialog: nothing was sent. */
export class OverrideCancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'OverrideCancelled';
  }
}

export const isOverrideNeeded = (e: unknown): boolean =>
  e instanceof ApiError && e.status === 403 && e.code === OVERRIDE_NEEDED;

interface Ask {
  readonly title: string;
  readonly resolve: (reason: string | null) => void;
}

export function useOverride(): {
  /** Asks for the reason, then runs the act with it. */
  withReason<T>(title: string, act: (reason: string) => Promise<T>): Promise<T>;
  /** Runs the act; if the service says only the override permits it, asks for the reason and runs it again. */
  ifNeeded<T>(title: string, act: (reason: string | undefined) => Promise<T>): Promise<T>;
  readonly dialog: ReactNode;
} {
  const [ask, setAsk] = useState<Ask | null>(null);
  const reasonOf = useCallback(
    (title: string) =>
      new Promise<string | null>((resolve) => {
        setAsk({
          title,
          resolve: (r) => {
            setAsk(null);
            resolve(r);
          },
        });
      }),
    [],
  );
  const withReason = useCallback(
    async <T,>(title: string, act: (reason: string) => Promise<T>): Promise<T> => {
      const r = await reasonOf(title);
      if (r === null) throw new OverrideCancelled();
      return act(r);
    },
    [reasonOf],
  );
  const ifNeeded = useCallback(
    async <T,>(title: string, act: (reason: string | undefined) => Promise<T>): Promise<T> => {
      try {
        return await act(undefined);
      } catch (e) {
        if (!isOverrideNeeded(e)) throw e;
        const r = await reasonOf(title);
        if (r === null) throw new OverrideCancelled();
        return act(r);
      }
    },
    [reasonOf],
  );
  return {
    withReason,
    ifNeeded,
    dialog: ask ? <OverrideDialog title={ask.title} onDone={(r) => ask.resolve(r)} /> : null,
  };
}

/** "Why are you doing this as factory admin?": the reason, required, kept in the decision log with the act. */
export function OverrideDialog({
  title,
  onDone,
}: {
  title: string;
  onDone: (reason: string | null) => void;
}) {
  const [text, setText] = useState('');
  const id = useId();
  const sent = useRef(false);
  const ov = term('concept', 'override');
  const ok = text.trim().length > 0;
  const send = () => {
    if (!ok || sent.current) return;
    sent.current = true;
    onDone(text.trim());
  };
  return (
    <Modal
      open
      title={title}
      onClose={() => onDone(null)}
      footer={
        <>
          <button type="button" className="ui-btn" onClick={() => onDone(null)}>
            Cancel
          </button>
          <button type="button" className="ui-btn ui-btn-primary" disabled={!ok} onClick={send}>
            {title}
          </button>
        </>
      }
    >
      <div className="adm-override">
        <p>
          <strong>{ov.label}.</strong> {ov.explain} Normal rules (who decides, two people, your own
          request) do not stop you; the record shows you acted alone.
        </p>
        <label htmlFor={id} className="ui-label">
          {term('concept', 'override_reason').label}
        </label>
        <textarea
          id={id}
          className="ui-input"
          value={text}
          maxLength={2000}
          required
          aria-describedby={`${id}-h`}
          onChange={(e) => setText(e.target.value)}
        />
        <p id={`${id}-h`} className="ui-help">
          {term('concept', 'override_reason').explain}
        </p>
      </div>
    </Modal>
  );
}

/** The words an error shows: the server's reason; a cancelled override shows nothing. */
export function errorText(e: unknown): string | null {
  if (e instanceof OverrideCancelled) return null;
  if (e instanceof ApiError) {
    if (e.status === 403) return `Refused: ${e.message}. Nothing was changed.`;
    if (e.status === 0) return 'The factory could not be reached. Nothing was changed. Try again.';
    return `${e.message} Nothing was changed.`;
  }
  return e instanceof Error ? e.message : 'Something went wrong. Nothing was changed.';
}
