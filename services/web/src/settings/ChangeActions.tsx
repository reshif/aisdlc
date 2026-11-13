import { label, pdpResource, term, type SettingPreview } from '@aisdlc/contracts';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useId, useState } from 'react';
import { Guarded } from '../access';
import { ApiError, api } from '../api';
import { ErrorNote } from '../components/Notice';
import { Modal, Pill, Term, useToast } from '../ui';
import { applyNow } from './applyNow';
import { fieldWord, valueWord } from './words';

// The one way a factory setting changes (screen map §2.11, "Change flow"): Preview (what it does, in plain words, and
// when it applies), then Propose (a settings change waiting for approval), or, for the factory admin, Apply now with a
// reason (proposed and approved in one step, the reason recorded). The server decides every step; what is shown here
// is a hint.

/** The words for a refusal the person can act on (glossary §18). */
export function changeError(e: unknown): string {
  if (e instanceof ApiError) {
    if (/stale_parent/.test(e.message) || e.code === 'conflict') {
      return 'Someone changed this first. Reload and redo your change.';
    }
    if (/unchanged/.test(e.message)) return 'Nothing changed: your draft is what is in force.';
    if (e.status === 403) return `You can't do this: ${e.message}`;
    return e.message;
  }
  return 'The change could not be made. Nothing was changed.';
}

export function PreviewView({ p }: { p: SettingPreview }) {
  return (
    <section className="st-preview" aria-label="Preview of the change" data-testid="st-preview">
      <p>
        <Pill tone={p.applies === 'now' ? 'warn' : 'info'}>
          <Term family="settingsApplies" value={p.applies} />
        </Pill>{' '}
        {p.applies === 'new_items' && p.items_in_progress > 0
          ? `${p.items_in_progress} item(s) in progress keep the version they started with.`
          : null}
      </p>
      {p.problems.length > 0 ? (
        <div className="notice notice-bad" role="alert" aria-label="Problems with the draft">
          <ul>
            {p.problems.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </div>
      ) : null}
      {p.effects.length > 0 ? (
        <ul className="st-effects" aria-label="What it does">
          {p.effects.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : null}
      {p.changes.length === 0 ? (
        <p className="muted">Nothing changes: the draft is what is in force.</p>
      ) : (
        <table className="ui-tbl st-diff">
          <caption className="ui-sr">What changes</caption>
          <thead>
            <tr>
              <th scope="col">Field</th>
              <th scope="col">Now</th>
              <th scope="col">After the change</th>
            </tr>
          </thead>
          <tbody>
            {p.changes.map((c) => (
              <tr key={c.path}>
                <th scope="row">{c.path.split('.').map(fieldWord).join(' › ')}</th>
                <td>{valueWord(c.before)}</td>
                <td>{valueWord(c.after)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ChangeActions({
  configKey,
  draft,
  parent,
  csrf,
  mayApplyNow,
  blocked,
  onDone,
}: {
  configKey: string;
  draft: unknown;
  parent: string | null;
  csrf: string;
  mayApplyNow: boolean;
  /** Why the change cannot be sent (no change, the form's problems), or null. */
  blocked: string | null;
  onDone?: () => void;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const reasonId = useId();
  const [preview, setPreview] = useState<{ for: string; p: SettingPreview } | null>(null);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState('');
  const draftText = JSON.stringify(draft ?? null);
  const fresh = preview?.for === draftText ? preview.p : null;
  const done = () => {
    void qc.invalidateQueries({ queryKey: ['config'] });
    void qc.invalidateQueries({ queryKey: ['config-key'] });
    void qc.invalidateQueries({ queryKey: ['config-keys'] });
    onDone?.();
  };
  const look = useMutation({
    mutationFn: () => api.previewConfig(configKey, draft, csrf),
    onSuccess: (p) => setPreview({ for: draftText, p }),
  });
  const propose = useMutation({
    mutationFn: () => api.proposeConfig(configKey, { value: draft, parent_rev_hash: parent }, csrf),
    onSuccess: () => {
      toast('Proposed. It waits for approval; nothing changed yet.', 'ok');
      done();
    },
  });
  const apply = useMutation({
    mutationFn: () => applyNow(configKey, draft, parent, reason, csrf),
    onSuccess: (d) => {
      setAsking(false);
      setReason('');
      toast(
        d.published
          ? 'Applied. The change is in force; your reason is in the decision log.'
          : `Approved, but it is not in force yet: ${d.publish_error ?? 'publishing failed'}.`,
        d.published ? 'ok' : 'warn',
      );
      done();
    },
  });
  const fleet = pdpResource.fleet();
  const busy = look.isPending || propose.isPending || apply.isPending;
  const settingsGate = label('gate', 'M1');
  return (
    <div className="st-change">
      {fresh ? <PreviewView p={fresh} /> : null}
      {look.isError ? <ErrorNote error={look.error} /> : null}
      {propose.isError ? (
        <p className="ui-help ui-help-bad" role="alert">
          {changeError(propose.error)}
        </p>
      ) : null}
      {blocked ? <p className="muted">{blocked}</p> : null}
      <div className="st-change-acts">
        <Guarded action="config.propose" resource={fleet} label="Preview the change">
          <button
            type="button"
            className="ui-btn"
            disabled={busy || blocked !== null}
            onClick={() => look.mutate()}
          >
            Preview the change
          </button>
        </Guarded>
        <Guarded action="config.propose" resource={fleet} label="Propose this change">
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            title={term('gate', 'M1').explain}
            disabled={busy || blocked !== null || fresh === null || !fresh.valid}
            onClick={() => propose.mutate()}
          >
            Propose this change
          </button>
        </Guarded>
        {mayApplyNow ? (
          <button
            type="button"
            className="ui-btn"
            disabled={busy || blocked !== null || fresh === null || !fresh.valid}
            onClick={() => setAsking(true)}
          >
            Apply now as factory admin
          </button>
        ) : null}
      </div>
      {fresh === null && blocked === null ? (
        <p className="ui-help">Preview the change to see what it does before you send it.</p>
      ) : null}
      <Modal
        open={asking}
        title="Apply now as factory admin"
        onClose={() => setAsking(false)}
        footer={
          <>
            <button type="button" className="ui-btn" onClick={() => setAsking(false)}>
              Cancel
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={apply.isPending || reason.trim() === ''}
              onClick={() => apply.mutate()}
            >
              Apply now
            </button>
          </>
        }
      >
        <p>
          The change is proposed and its “{settingsGate}” is decided by you at once. Your name and
          reason go into the decision log.
        </p>
        <label className="ui-label" htmlFor={reasonId}>
          Reason (required)
        </label>
        <textarea
          id={reasonId}
          className="ui-input"
          rows={3}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
        {apply.isError ? (
          <p className="ui-help ui-help-bad" role="alert">
            {changeError(apply.error)}
          </p>
        ) : null}
      </Modal>
    </div>
  );
}
