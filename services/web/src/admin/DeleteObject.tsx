import { useMutation, useQuery } from '@tanstack/react-query';
import {
  label,
  term,
  type DeletionKind,
  type DeletionPreview,
  type DeletionResult,
} from '@aisdlc/contracts';
import { useId, useState } from 'react';
import { ApiError } from '../api';
import { Modal } from '../ui';
import { adminApi } from './api';
import { errorText, useOverride } from './override';

// The one delete experience for every object (screen map §3 "Delete flow"; docs/specs/deletion.md): a red button
// that names what it destroys; a dialog that first shows what blocks it (a legal hold), then exactly what goes,
// counted, and what stays (the decision log's hashes); the name typed back and a reason; then the done state. The
// server decides (`<kind>.delete`, the factory admin always) and records who, what (by hash), when and why.
//
//   <DeleteObject kind="team" id="payments" name="Payments" csrf={csrf} onDeleted={() => navigate('/teams')} />
//
// The Projects squad uses it for projects and repos: `kind="project" | "repo"`, `id` the project id or `owner/name`.

const KIND_WORD: Readonly<Record<DeletionKind, string>> = {
  project: label('concept', 'project').toLowerCase(),
  repo: label('concept', 'repo').toLowerCase(),
  item: label('concept', 'work_item').toLowerCase(),
  person: label('concept', 'person').toLowerCase(),
  team: label('concept', 'team').toLowerCase(),
  binding: label('concept', 'role_assignment').toLowerCase(),
};

/** The button's words: "Delete team Payments"; a role assignment is "Remove role". */
export function deleteLabel(kind: DeletionKind, name: string): string {
  return kind === 'binding'
    ? 'Remove role'
    : `${label('concept', 'delete')} ${KIND_WORD[kind]} ${name}`;
}

const n = (x: number, one: string, many: string) =>
  `${x.toLocaleString('en')} ${x === 1 ? one : many}`;

/** What goes and what stays, in words, from the preview's counts. */
export function previewLines(p: DeletionPreview): { goes: string[]; stays: string } {
  const c = p.counts;
  const goes = [
    n(c.record_events_removed + c.record_events_redacted, 'history event', 'history events'),
    n(c.read_model_rows, 'stored row', 'stored rows'),
    ...(c.objects > 0
      ? [n(c.objects, 'stored file (evidence or export)', 'stored files (evidence and exports)')]
      : []),
  ];
  const stays =
    c.ledger_entries_redacted > 0
      ? `The decision log keeps ${n(c.ledger_entries_redacted, 'hash', 'hashes')} so the chain still verifies; nothing else can be read or restored.`
      : 'Nothing about it is in the decision log; nothing can be read or restored afterwards.';
  return { goes, stays };
}

function previewError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'unavailable' && /deletion_unavailable/.test(e.message)) {
    return 'Deleting is not set up in this factory yet (no deletion login is configured). Nothing was changed.';
  }
  return errorText(e) ?? 'The preview could not be loaded.';
}

export function DeleteObject({
  kind,
  id,
  name,
  csrf,
  onDeleted,
  small,
}: {
  kind: DeletionKind;
  /** What the server deletes by. */
  id: string;
  /** What the person types back (shown in bold); often the same as `id`. */
  name: string;
  csrf: string;
  onDeleted?: (r: DeletionResult) => void;
  small?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const what = deleteLabel(kind, name);
  return (
    <>
      <button
        type="button"
        className={`ui-btn ui-btn-danger${small ? ' ui-btn-sm' : ''}`}
        onClick={() => setOpen(true)}
        {...(kind === 'binding' ? { 'aria-label': `${what}: ${name}` } : {})}
      >
        {what}
      </button>
      {open ? (
        <DeleteDialog
          kind={kind}
          id={id}
          name={name}
          csrf={csrf}
          onClose={() => setOpen(false)}
          {...(onDeleted ? { onDeleted } : {})}
        />
      ) : null}
    </>
  );
}

export function DeleteDialog({
  kind,
  id,
  name,
  csrf,
  onClose,
  onDeleted,
}: {
  kind: DeletionKind;
  id: string;
  name: string;
  csrf: string;
  onClose: () => void;
  onDeleted?: (r: DeletionResult) => void;
}) {
  const fid = useId();
  const [typed, setTyped] = useState('');
  const [why, setWhy] = useState('');
  const ov = useOverride();
  const what = deleteLabel(kind, name);
  const preview = useQuery({
    queryKey: ['deletion-preview', kind, id],
    queryFn: () => adminApi.previewDelete(kind, id, csrf),
    retry: false,
    staleTime: 0,
  });
  const del = useMutation({
    mutationFn: () =>
      ov.ifNeeded(`${what} as factory admin`, (reason) =>
        adminApi.remove(kind, id, why.trim(), csrf, reason),
      ),
  });
  const blocked = (preview.data?.blockers.length ?? 0) > 0;
  const ok = typed === name && why.trim() !== '' && preview.isSuccess && !blocked;
  const done = del.data;
  if (ov.dialog) return <>{ov.dialog}</>;
  return (
    <Modal
      open
      title={done ? 'Deleted' : `${what}?`}
      onClose={() => {
        if (done) onDeleted?.(done);
        onClose();
      }}
      footer={
        done ? (
          <button
            type="button"
            className="ui-btn ui-btn-primary"
            onClick={() => {
              onDeleted?.(done);
              onClose();
            }}
          >
            Done
          </button>
        ) : (
          <>
            <button type="button" className="ui-btn" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="ui-btn ui-btn-danger"
              disabled={!ok || del.isPending}
              onClick={() => {
                if (ok) del.mutate();
              }}
            >
              {what}
            </button>
          </>
        )
      }
    >
      {done ? (
        <div className="ui-delete" role="status">
          <p>
            Deleted. {name} is gone from the factory and answers &ldquo;not found&rdquo; everywhere.
          </p>
          <p className="muted">
            {done.counts.ledger_entries_redacted > 0
              ? `${n(done.counts.ledger_entries_redacted, 'decision log entry now shows', 'decision log entries now show')} as hashes only.`
              : 'The decision log had nothing about it.'}{' '}
            The deletion itself is in the decision log: who, when and why, with no name.
          </p>
          {done.objects_purged ? null : (
            <p className="muted">
              Some stored files could not be removed yet; the factory retries them.
            </p>
          )}
        </div>
      ) : (
        <div className="ui-delete">
          <p>{term('concept', 'delete').explain}</p>
          {preview.isPending ? <p aria-busy="true">Working out what goes…</p> : null}
          {preview.isError ? (
            <p className="ui-help ui-help-bad" role="alert">
              {previewError(preview.error)}
            </p>
          ) : null}
          {preview.data ? (
            <>
              {preview.data.blockers.map((b) => (
                <p key={b.kind} className="ui-help ui-help-bad" role="alert">
                  {b.kind === 'legal_hold'
                    ? `A legal hold covers this, so it cannot be deleted: ${b.message}`
                    : b.message}
                </p>
              ))}
              <div className="ui-delete-what">
                <p className="adm-sub">What goes</p>
                <ul aria-label="What goes">
                  {previewLines(preview.data).goes.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
                <p className="adm-sub">What stays</p>
                <p>{previewLines(preview.data).stays}</p>
              </div>
            </>
          ) : null}
          <label htmlFor={`${fid}-n`} className="ui-label">
            Type <strong className="ui-mono">{name}</strong> to confirm
          </label>
          <input
            id={`${fid}-n`}
            className="ui-input"
            type="text"
            autoComplete="off"
            spellCheck={false}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <label htmlFor={`${fid}-r`} className="ui-label adm-gap">
            Why
          </label>
          <textarea
            id={`${fid}-r`}
            className="ui-input"
            value={why}
            maxLength={2000}
            aria-describedby={`${fid}-rh`}
            onChange={(e) => setWhy(e.target.value)}
          />
          <p id={`${fid}-rh`} className="ui-help">
            Kept with the deletion. Do not name what you delete: the name is removed with it.
          </p>
          {del.isError && errorText(del.error) ? (
            <p className="ui-help ui-help-bad" role="alert">
              {errorText(del.error)}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
