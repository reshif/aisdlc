import { label, term } from '@aisdlc/contracts';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Modal } from './overlay';

// A write-only secret field and the type-the-name delete confirmation (portal-v2-intent: "Secrets entered in the
// portal into a write-only field ... never shown again after saving"; "Delete means delete").

/**
 * A secret is pasted once and never shown again. The field has no `value` prop on purpose: what the server knows
 * reaches the screen only as "set · last changed …". The text typed is kept only until Save, and cleared at once
 * whatever the save answers, so it is not left in the page.
 */
export function SecretField({
  label: name,
  isSet,
  lastChanged,
  onSave,
  busy = false,
  error,
  help,
}: {
  label: string;
  /** Whether a secret is stored. */
  isSet: boolean;
  /** When it last changed, formatted ("2 h ago", "13 Nov 2026"). */
  lastChanged?: string;
  onSave: (secret: string) => void;
  busy?: boolean;
  /** What went wrong, in words ("The vault did not answer. Nothing was changed. Try again."). */
  error?: string;
  help?: ReactNode;
}) {
  const [editing, setEditing] = useState(!isSet);
  const [draft, setDraft] = useState('');
  const id = useId();
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const v = draft;
    setDraft('');
    if (v === '') return;
    onSave(v);
    setEditing(false);
  };
  const saved = term('concept', 'secret_saved');
  return (
    <div className="ui-secret">
      <div className="ui-label" id={`${id}-l`}>
        {name}
      </div>
      {isSet ? (
        <p className="ui-secret-state" title={saved.explain}>
          <span className="ui-secret-dot" aria-hidden="true" />
          Set{lastChanged ? ` · last changed ${lastChanged}` : ''}
        </p>
      ) : (
        <p className="ui-secret-state ui-secret-none">Not set</p>
      )}
      {editing ? (
        <form className="ui-secret-form" onSubmit={submit} aria-labelledby={`${id}-l`}>
          <label htmlFor={id} className="ui-sr">
            {label('concept', 'secret_field')}: {name}
          </label>
          <input
            id={id}
            className="ui-input"
            type="password"
            autoComplete="new-password"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            placeholder={label('concept', 'secret_field')}
            value={draft}
            aria-describedby={`${id}-h`}
            {...(error ? { 'aria-invalid': true } : {})}
            onChange={(e) => setDraft(e.target.value)}
          />
          <p id={`${id}-h`} className={error ? 'ui-help ui-help-bad' : 'ui-help'}>
            {error ?? help ?? term('concept', 'secret_field').explain}
          </p>
          <div className="ui-secret-acts">
            <button type="submit" className="ui-btn ui-btn-primary" disabled={busy || draft === ''}>
              Save secret
            </button>
            {isSet ? (
              <button
                type="button"
                className="ui-btn"
                onClick={() => {
                  setDraft('');
                  setEditing(false);
                }}
              >
                Cancel
              </button>
            ) : null}
          </div>
        </form>
      ) : (
        <div className="ui-secret-acts">
          <button
            type="button"
            className="ui-btn"
            title={term('concept', 'rotate').explain}
            onClick={() => setEditing(true)}
          >
            {label('concept', 'rotate')}
          </button>
          {error ? (
            <p className="ui-help ui-help-bad" role="alert">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

/**
 * "Delete project payments-api": the button says what it destroys and is red, and the confirmation asks for the
 * name typed exactly (glossary §1). What deleting removes is said before, never after.
 */
export function ConfirmDelete({
  open,
  kind,
  name,
  consequences,
  busy = false,
  error,
  onConfirm,
  onClose,
}: {
  open: boolean;
  /** "project", "repo", "integration". */
  kind: string;
  name: string;
  /** What is removed, in words. */
  consequences?: ReactNode;
  busy?: boolean;
  error?: string;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const id = useId();
  const what = `${label('concept', 'delete')} ${kind} ${name}`;
  const ok = typed === name;
  return (
    <Modal
      open={open}
      title={`${what}?`}
      onClose={() => {
        setTyped('');
        onClose();
      }}
      footer={
        <>
          <button
            type="button"
            className="ui-btn"
            onClick={() => {
              setTyped('');
              onClose();
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="ui-btn ui-btn-danger"
            disabled={!ok || busy}
            onClick={() => {
              if (ok) onConfirm();
            }}
          >
            {what}
          </button>
        </>
      }
    >
      <div className="ui-delete">
        <p>{term('concept', 'delete').explain}</p>
        {consequences ? <div className="ui-delete-what">{consequences}</div> : null}
        <label htmlFor={id} className="ui-label">
          Type <strong className="ui-mono">{name}</strong> to confirm
        </label>
        <input
          id={id}
          className="ui-input"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
        {error ? (
          <p className="ui-help ui-help-bad" role="alert">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
