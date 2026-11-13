import { SECRET_DEFS, type SecretName, type SecretView } from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { api } from '../api';
import { describeError, shortTime } from '../format';
import { ConfirmDelete, SecretField, useToast } from '../ui';

// Secrets in the portal (screen map §2.12, N15): a write-only field into the secret store (Vault). Only metadata ever
// comes back ("set · last changed 13 Nov"); the typed value is cleared from the page at once, whatever the answer,
// and is never cached, logged or put in the query cache.

export const SECRETS_QUERY = ['secrets'] as const;

export function useSecrets() {
  return useQuery({ queryKey: SECRETS_QUERY, queryFn: api.secrets, retry: false });
}

/** The secret a `vault:<owner>/<name>#value` reference names, if it is one of the factory's. */
export function secretOfRef(ref: string): SecretName | null {
  const m = /^vault:[a-z0-9-]+\/([a-z0-9-]+)#value$/.exec(ref);
  const name = m?.[1];
  return name !== undefined && name in SECRET_DEFS ? (name as SecretName) : null;
}

/** One secret: paste or replace (write-only), and delete. */
export function SecretRow({
  name,
  view,
  csrf,
  storeReachable,
  canDelete = true,
}: {
  name: SecretName;
  view: SecretView | undefined;
  csrf: string;
  storeReachable: boolean;
  canDelete?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [deleting, setDeleting] = useState(false);
  const save = useMutation({
    mutationFn: (value: string) => api.putSecret(name, value, csrf),
    onSuccess: () => {
      toast('Secret saved. It is never shown again.', 'ok');
      void qc.invalidateQueries({ queryKey: SECRETS_QUERY });
    },
  });
  const destroy = useMutation({
    mutationFn: () => api.deleteSecret(name, csrf),
    onSuccess: () => {
      setDeleting(false);
      toast('Secret deleted from the vault, every version.', 'ok');
      void qc.invalidateQueries({ queryKey: SECRETS_QUERY });
    },
  });
  const label = SECRET_DEFS[name].label;
  const isSet = storeReachable && view?.set === true;
  return (
    <div className="st-secret" data-secret={name}>
      <SecretField
        label={label}
        isSet={isSet}
        {...(isSet && view?.updated_at ? { lastChanged: shortTime(view.updated_at) } : {})}
        busy={save.isPending}
        onSave={(v) => save.mutate(v)}
        {...(save.isError
          ? { error: `${describeError(save.error)} Nothing was changed.` }
          : !storeReachable
            ? { error: 'The vault did not answer: whether this is set is unknown.' }
            : {})}
      />
      {canDelete && isSet ? (
        <button
          type="button"
          className="ui-btn ui-btn-sm ui-btn-danger"
          onClick={() => setDeleting(true)}
        >
          Delete secret {label}
        </button>
      ) : null}
      <ConfirmDelete
        open={deleting}
        kind="secret"
        name={name}
        busy={destroy.isPending}
        {...(destroy.isError ? { error: describeError(destroy.error) } : {})}
        consequences={
          <p>
            Every version is destroyed in the vault. Whatever uses it stops working until a new one
            is saved.
          </p>
        }
        onConfirm={() => destroy.mutate()}
        onClose={() => setDeleting(false)}
      />
    </div>
  );
}

/** A set of secrets by name, read once. */
export function SecretRows({ names, csrf }: { names: readonly SecretName[]; csrf: string }) {
  const q = useSecrets();
  if (q.isPending) return <p className="muted">Reading which secrets are saved…</p>;
  if (q.isError) {
    return (
      <p className="muted" role="note">
        The secrets could not be read ({describeError(q.error)}).
      </p>
    );
  }
  return (
    <div className="st-secrets">
      {names.map((n) => (
        <SecretRow
          key={n}
          name={n}
          view={q.data.secrets.find((s) => s.name === n)}
          csrf={csrf}
          storeReachable={q.data.store_reachable}
        />
      ))}
    </div>
  );
}
