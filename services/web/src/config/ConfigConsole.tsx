import { pdpResource, type ConfigKeyRevision, type ConfigRevisionState } from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Guarded } from '../access';
import { api } from '../api';
import { ErrorNote, Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { validateAgainst, type JsonSchema } from '../lib/schema';
import { Card, EmptyState, KeyValue, Pill, Table, useToast, type PillTone } from '../ui';
import { SchemaField, diffValues, looksLikeSecretRef } from './SchemaForm';

// The configuration console (the one pattern every config screen uses): for one registered key,
// the effective value and where it came from (its revision and the M1 decision that published it),
// a draft editor generated from the key's JSON Schema, the diff against the effective value,
// "Propose" (an ordinary revision with its M1 gate: config.propose, decided by the PDP on the
// server whatever this page shows), the pending proposals with who must decide, and the history.
// Nothing here publishes; a value changes only when its M1 gate is decided approve.

const STATE_TONE: Readonly<Record<ConfigRevisionState, PillTone>> = {
  proposed: 'warn',
  current: 'ok',
  superseded: 'mute',
  rejected: 'bad',
  rolled_back: 'back',
};

const short = (h: string | null) => (h === null ? '—' : `${h.slice(0, 12)}…`);

/** A value as people read it: JSON, with a secret reference marked as a reference. */
export function ValueView({ value, label }: { value: unknown; label: string }) {
  if (looksLikeSecretRef(value)) {
    return (
      <span>
        <code>{String(value)}</code> <Pill tone="info">secret reference</Pill>
      </span>
    );
  }
  const refs = secretRefPaths(value);
  return (
    <>
      <pre className="code cfg-value" aria-label={label}>
        {JSON.stringify(value, null, 2)}
      </pre>
      {refs.length > 0 ? (
        <p className="hint" data-testid="cfg-secret-refs">
          Secret references (where a secret lives, never the secret):{' '}
          {refs.map((r) => (
            <code key={r}>{r}</code>
          ))}
        </p>
      ) : null}
    </>
  );
}

/** The paths of the strings in a value that are secret references. */
function secretRefPaths(v: unknown, path = ''): string[] {
  if (looksLikeSecretRef(v)) return [path === '' ? '(value)' : path];
  if (Array.isArray(v)) return v.flatMap((x, i) => secretRefPaths(x, `${path}[${i}]`));
  if (typeof v === 'object' && v !== null) {
    return Object.entries(v).flatMap(([k, x]) =>
      secretRefPaths(x, path === '' ? k : `${path}.${k}`),
    );
  }
  return [];
}

export function ConfigConsole({ configKey, csrf }: { configKey: string; csrf: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({
    queryKey: ['config', configKey],
    queryFn: () => api.configKey(configKey),
    refetchInterval: 15_000,
  });
  const [draft, setDraft] = useState<unknown>(undefined);
  const base = q.data?.effective.value;
  const head = q.data?.head_rev_hash ?? null;
  // A new head (a revision published since) resets the draft to the new effective value.
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const loadedFor = q.data ? `${configKey}@${head ?? 'none'}` : null;
  if (q.data && loadedFor !== draftFor) {
    setDraftFor(loadedFor);
    setDraft(structuredClone(q.data.effective.value));
  }

  const propose = useMutation({
    mutationFn: () => api.proposeConfig(configKey, { value: draft, parent_rev_hash: head }, csrf),
    onSuccess: (r) => {
      toast(`Proposed. The M1 gate ${short(r.gate_instance_id)} decides it; nothing changed yet.`);
      void qc.invalidateQueries({ queryKey: ['config', configKey] });
    },
  });

  if (q.isPending) return <Loading what={`the configuration of ${configKey}`} />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const names = v.principal_names;
  const who = (id: string) => names[id] ?? id;
  const schema = v.key.json_schema as JsonSchema;
  const problems = draft === undefined ? [] : validateAgainst(schema, draft);
  const changes = draft === undefined ? [] : diffValues(base, draft);

  return (
    <div className="cfg" data-config-key={configKey}>
      <Card title="Effective value" testId="cfg-effective">
        <ValueView value={v.effective.value} label="Effective value" />
        <KeyValue
          label="Where it comes from"
          rows={[
            [
              'Source',
              v.effective.source === 'default'
                ? 'the registered default (no published revision sets it)'
                : 'a published revision',
            ],
            ['Revision', <code key="r">{short(v.effective.rev_hash)}</code>],
            ['M1 gate', <code key="g">{short(v.effective.gate_instance_id)}</code>],
            [
              'M1 decision (ledger entry)',
              <code key="l">{short(v.effective.ledger_entry_id)}</code>,
            ],
            ['Published', v.effective.published_at ? shortTime(v.effective.published_at) : '—'],
          ]}
        />
      </Card>

      <Card
        title="Draft a change"
        footer={
          <Guarded
            action="config.propose"
            resource={pdpResource.fleet()}
            label="Propose this change"
          >
            <button
              type="button"
              className="ui-btn ui-btn-primary"
              disabled={
                !v.may_propose || changes.length === 0 || problems.length > 0 || propose.isPending
              }
              onClick={() => propose.mutate()}
            >
              Propose this change
            </button>
          </Guarded>
        }
      >
        <p className="muted">
          {v.key.description}. A proposal is a new revision of the factory configuration with an M1
          gate; the value changes only once that gate is decided approve.
        </p>
        {draft === undefined ? null : (
          <form
            aria-label={`Draft of ${configKey}`}
            onSubmit={(e) => {
              e.preventDefault();
            }}
          >
            <SchemaField schema={schema} value={draft} onChange={setDraft} label={configKey} />
          </form>
        )}
        {problems.length > 0 ? (
          <div className="notice notice-bad" role="alert" aria-label="Problems with the draft">
            <ul>
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          </div>
        ) : null}
        <h3>Change against the effective value</h3>
        {changes.length === 0 ? (
          <p className="muted" data-testid="cfg-nochange">
            The draft equals the effective value.
          </p>
        ) : (
          <Table
            caption="Changes in the draft"
            captionHidden
            rows={changes}
            rowKey={(c) => c.path}
            columns={[
              { key: 'p', header: 'Field', rowHeader: true, render: (c) => <code>{c.path}</code> },
              {
                key: 'b',
                header: 'Now',
                render: (c) => (
                  <code>{c.before === undefined ? '(not set)' : JSON.stringify(c.before)}</code>
                ),
              },
              {
                key: 'a',
                header: 'Proposed',
                render: (c) => (
                  <code>{c.after === undefined ? '(not set)' : JSON.stringify(c.after)}</code>
                ),
              },
            ]}
          />
        )}
        {propose.isError ? <ErrorNote error={propose.error} /> : null}
      </Card>

      <Card title="Waiting for a decision" testId="cfg-pending">
        {v.pending.length === 0 ? (
          <p className="muted">No proposal is open.</p>
        ) : (
          <ul className="plain" aria-label="Open proposals">
            {v.pending.map((p) => (
              <li key={p.revision.rev_hash} data-rev={p.revision.rev_hash}>
                <Pill tone="warn">{p.gate_status ?? 'unknown'}</Pill> revision{' '}
                <code>{short(p.revision.rev_hash)}</code> by {who(p.revision.proposed_by)},{' '}
                {shortTime(p.revision.proposed_at)}.{' '}
                {p.revision.changes_key
                  ? 'It changes this key.'
                  : 'It changes another key of the factory configuration, not this one.'}
                <div>
                  M1 gate <code>{short(p.revision.gate_instance_id)}</code>, decided by the
                  factory&rsquo;s <strong>{p.deciders.slot}</strong> slot:{' '}
                  {p.deciders.holders.length === 0
                    ? 'nobody holds it yet, so nobody can decide it.'
                    : p.deciders.holders.map(who).join(', ')}
                </div>
                {p.revision.gate_instance_id ? (
                  <div>
                    <Link to={`/config/revisions/${p.revision.gate_instance_id}`}>
                      Open the revision to decide it
                    </Link>
                  </div>
                ) : null}
                {p.revision.changes_key ? (
                  <ValueView
                    value={p.revision.value}
                    label={`Proposed value ${p.revision.rev_hash}`}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="History" flush>
        <Table<ConfigKeyRevision>
          caption={`Revisions of the factory configuration, newest first`}
          captionHidden
          rows={v.history}
          rowKey={(r) => r.rev_hash}
          empty={<EmptyState title="No revision yet">The key has its default value.</EmptyState>}
          columns={[
            {
              key: 'rev',
              header: 'Revision',
              rowHeader: true,
              render: (r) => <code>{short(r.rev_hash)}</code>,
            },
            {
              key: 'state',
              header: 'State',
              render: (r) => <Pill tone={STATE_TONE[r.state]}>{r.state}</Pill>,
            },
            {
              key: 'by',
              header: 'Proposed',
              render: (r) => `${who(r.proposed_by)}, ${shortTime(r.proposed_at)}`,
            },
            {
              key: 'key',
              header: 'This key',
              render: (r) => (r.changes_key ? 'changed' : 'unchanged'),
            },
            {
              key: 'pub',
              header: 'Published (M1 entry)',
              render: (r) =>
                r.published_at ? (
                  <>
                    {shortTime(r.published_at)} <code>{short(r.ledger_entry_id)}</code>
                  </>
                ) : (
                  '—'
                ),
            },
          ]}
        />
      </Card>
    </div>
  );
}
