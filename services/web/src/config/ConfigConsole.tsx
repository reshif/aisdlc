import {
  label,
  lookupTerm,
  pdpResource,
  type ConfigKeyRevision,
  type ConfigRevisionState,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type ComponentType } from 'react';
import { Guarded } from '../access';
import { api, type ConfigKeyWire } from '../api';
import { Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { validateAgainst, type JsonSchema } from '../lib/schema';
import { ChangeActions, changeError } from '../settings/ChangeActions';
import { fieldWord, valueWord } from '../settings/words';
import { Card, EmptyState, KeyValue, Pill, Table, WireTerm, useToast, type PillTone } from '../ui';
import { SchemaField, diffValues, looksLikeSecretRef } from './SchemaForm';

// The configuration console (the one pattern every settings screen uses): for one registered key, the value in
// force and where it came from (the change and the approval that put it in force), a draft generated from the key's
// JSON Schema, the change against the value in force, Preview / Propose / Apply now (factory layer), the changes
// waiting for approval with who decides them, and the history. Nothing here publishes on its own: a value changes
// only once its settings approval is decided approve (by its deciders, or by the factory admin with a reason).

const STATE_TONE: Readonly<Record<ConfigRevisionState, PillTone>> = {
  proposed: 'warn',
  current: 'ok',
  superseded: 'mute',
  rejected: 'bad',
  rolled_back: 'back',
};

const short = (h: string | null) => (h === null ? '—' : `${h.slice(0, 12)}…`);
const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The paths of the strings in a value that are secret references. */
function secretRefPaths(v: unknown, path = ''): string[] {
  if (looksLikeSecretRef(v)) return [path === '' ? '(value)' : path];
  if (Array.isArray(v)) return v.flatMap((x, i) => secretRefPaths(x, `${path}[${i}]`));
  if (isObj(v)) {
    return Object.entries(v).flatMap(([k, x]) =>
      secretRefPaths(x, path === '' ? k : `${path}.${k}`),
    );
  }
  return [];
}

/**
 * A value as people read it: its top-level fields in plain words, and the full value folded (JSON) for those who
 * want it. A secret reference is marked as a reference: where a secret lives, never the secret.
 */
export function ValueView({ value, label: name }: { value: unknown; label: string }) {
  if (looksLikeSecretRef(value)) {
    return (
      <span>
        <code>{String(value)}</code> <Pill tone="info">secret reference</Pill>
      </span>
    );
  }
  const refs = secretRefPaths(value);
  const rows = isObj(value)
    ? Object.entries(value).map(([k, v]) => [fieldWord(k), valueWord(v)] as [string, string])
    : [['Value', valueWord(value)] as [string, string]];
  return (
    <>
      <KeyValue label={name} rows={rows.slice(0, 12)} />
      {rows.length > 12 ? <p className="muted">and {rows.length - 12} more.</p> : null}
      <details className="cfg-raw">
        <summary>Show the full value</summary>
        <pre className="code cfg-value" aria-label={name}>
          {JSON.stringify(value, null, 2)}
        </pre>
      </details>
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

/**
 * Which layer the console reads and proposes on: the factory's (one document for the fleet; `config.propose`), or one
 * project's (P1-5: `project.settings.edit`, a settings approval at the project's admin slot).
 */
export type ConfigLayer =
  { readonly kind: 'factory' } | { readonly kind: 'project'; readonly project: string };
const FACTORY_LAYER: ConfigLayer = { kind: 'factory' };

/** A key's own draft editor (the role map as slot by people, the gating profile as toggles); the generated form stays. */
export interface DraftEditorProps {
  readonly value: unknown;
  readonly onChange: (v: unknown) => void;
  /** The project's tier and deploys (project layer), for the floors. */
  readonly tier: string | null;
  readonly deploys: boolean | null;
}

const slotWord = (slot: string) => lookupTerm('roleSlot', slot)?.label ?? 'the deciding role';

export function ConfigConsole({
  configKey,
  csrf,
  layer = FACTORY_LAYER,
  editor: Editor,
  problemsOf,
  readOnly = false,
}: {
  configKey: string;
  csrf: string;
  layer?: ConfigLayer;
  /** A form made for this key; the generated form is still offered under it. */
  editor?: ComponentType<DraftEditorProps>;
  /** Rules the schema cannot see (the tier floors), the same functions the server runs. */
  problemsOf?: (draft: unknown, ctx: { tier: string | null; deploys: boolean | null }) => string[];
  /** Shown, never changed here (generated, or changed on another screen). */
  readOnly?: boolean;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const project = layer.kind === 'project' ? layer.project : null;
  const queryKey = project === null ? ['config', configKey] : ['config', project, configKey];
  const q = useQuery({
    queryKey,
    queryFn: (): Promise<ConfigKeyWire> =>
      project === null ? api.configKey(configKey) : api.projectConfigKey(project, configKey),
    refetchInterval: 15_000,
  });
  const [draft, setDraft] = useState<unknown>(undefined);
  const base = q.data?.effective.value;
  const head = q.data?.head_rev_hash ?? null;
  // A new head (a change put in force since) resets the draft to the new value in force.
  const [draftFor, setDraftFor] = useState<string | null>(null);
  const loadedFor = q.data ? `${configKey}@${head ?? 'none'}` : null;
  if (q.data && loadedFor !== draftFor) {
    setDraftFor(loadedFor);
    setDraft(structuredClone(q.data.effective.value));
  }

  // the project layer proposes through its own route (Project › Settings); no preview there yet
  const proposeProject = useMutation({
    mutationFn: () =>
      api.proposeProjectConfig(
        project as string,
        configKey,
        { value: draft, parent_rev_hash: head },
        csrf,
      ),
    onSuccess: () => {
      toast('Proposed. It waits for approval; nothing changed yet.', 'ok');
      void qc.invalidateQueries({ queryKey });
    },
  });
  const [asJson, setAsJson] = useState(false);

  if (q.isPending) return <Loading what="the setting" />;
  if (q.isError) return <PageError error={q.error} retry={() => void q.refetch()} />;
  const v = q.data;
  const names = v.principal_names;
  const who = (id: string) => names[id] ?? id;
  const schema = v.key.json_schema as JsonSchema;
  const ctx = { tier: v.tier ?? null, deploys: v.deploys ?? null };
  const problems =
    draft === undefined
      ? []
      : [...validateAgainst(schema, draft), ...(problemsOf ? problemsOf(draft, ctx) : [])];
  const changes = draft === undefined ? [] : diffValues(base, draft);
  const settingsGate = label('gate', 'M1');
  const decideLink = (gate: string) =>
    project === null ? `/config/revisions/${gate}` : `/revisions/${gate}`;
  const blocked =
    changes.length === 0
      ? 'Change a field to send a change.'
      : problems.length > 0
        ? 'Fix the problems above first.'
        : null;
  const proposer = v.history.find((r) => r.rev_hash === v.effective.rev_hash)?.proposed_by;

  return (
    <div className="cfg" data-config-key={configKey}>
      <Card title="In force now" testId="cfg-effective">
        <ValueView value={v.effective.value} label="Value in force" />
        <p className="muted" data-testid="cfg-source">
          {v.effective.source === 'default'
            ? 'The default: no change has been approved for this setting.'
            : v.effective.source === 'factory'
              ? 'The factory-wide value: this project does not set its own.'
              : project !== null
                ? `In force: a published revision of this project${
                    v.effective.published_at ? `, since ${shortTime(v.effective.published_at)}` : ''
                  }.`
                : `In force since ${v.effective.published_at ? shortTime(v.effective.published_at) : '—'}${
                    proposer ? `, proposed by ${who(proposer)}` : ''
                  }, approved in the decision log.`}
        </p>
        <details className="cfg-audit">
          <summary>For auditors</summary>
          <KeyValue
            rows={[
              ['Change', <code key="r">{short(v.effective.rev_hash)}</code>],
              ['Approval', <code key="g">{short(v.effective.gate_instance_id)}</code>],
              ['Decision log entry', <code key="l">{short(v.effective.ledger_entry_id)}</code>],
            ]}
          />
        </details>
      </Card>

      {readOnly ? null : (
        <Card title="Change it">
          <p className="muted">
            {v.key.description}. A change waits for “{settingsGate}”
            {project === null ? '' : ` (decided by the project's admins)`}; the value changes only
            once it is approved.
          </p>
          {draft === undefined ? null : (
            <form
              aria-label="Draft of the change"
              onSubmit={(e) => {
                e.preventDefault();
              }}
            >
              {Editor && !asJson ? (
                // keyed by the head: a new head resets the editor's own text with the draft
                <Editor key={draftFor ?? ''} value={draft} onChange={setDraft} {...ctx} />
              ) : (
                <SchemaField
                  schema={schema}
                  value={draft}
                  onChange={setDraft}
                  label="The setting"
                />
              )}
              {Editor ? (
                <p>
                  <button
                    type="button"
                    className="ui-btn ui-btn-sm"
                    onClick={() => setAsJson((x) => !x)}
                  >
                    {asJson ? 'Back to the form' : 'Edit every field (generated form)'}
                  </button>
                </p>
              ) : null}
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
          {project === null ? (
            v.may_propose ? (
              <ChangeActions
                configKey={configKey}
                draft={draft}
                parent={head}
                csrf={csrf}
                mayApplyNow={v.may_apply_now === true}
                blocked={blocked}
              />
            ) : (
              <p className="muted" data-testid="cfg-read-only">
                You can read this setting but not change it.
              </p>
            )
          ) : (
            <>
              <h3>What changes</h3>
              {changes.length === 0 ? (
                <p className="muted" data-testid="cfg-nochange">
                  The draft is what is in force.
                </p>
              ) : (
                <Table
                  caption="Changes in the draft"
                  captionHidden
                  rows={changes}
                  rowKey={(c) => c.path}
                  columns={[
                    {
                      key: 'p',
                      header: 'Field',
                      rowHeader: true,
                      // the project squad's screen keeps the field path (Project › Settings)
                      render: (c) => <code>{c.path}</code>,
                    },
                    { key: 'b', header: 'Now', render: (c) => valueWord(c.before) },
                    { key: 'a', header: 'After the change', render: (c) => valueWord(c.after) },
                  ]}
                />
              )}
              <Guarded
                action="project.settings.edit"
                resource={pdpResource.project(project)}
                label="Propose this change"
              >
                <button
                  type="button"
                  className="ui-btn ui-btn-primary"
                  disabled={!v.may_propose || blocked !== null || proposeProject.isPending}
                  onClick={() => proposeProject.mutate()}
                >
                  Propose this change
                </button>
              </Guarded>
              {proposeProject.isError ? (
                <p className="ui-help ui-help-bad" role="alert">
                  {changeError(proposeProject.error)}
                </p>
              ) : null}
            </>
          )}
        </Card>
      )}

      <Card title="Waiting for approval" testId="cfg-pending">
        {v.pending.length === 0 ? (
          <p className="muted">No change is waiting.</p>
        ) : (
          <ul className="plain st-pending" aria-label="Changes waiting for approval">
            {v.pending.map((p) => (
              <li key={p.revision.rev_hash} data-rev={p.revision.rev_hash}>
                <Pill tone="warn">
                  <WireTerm family="configRevision" value={p.revision.state} />
                </Pill>{' '}
                Proposed by {who(p.revision.proposed_by)}, {shortTime(p.revision.proposed_at)}.{' '}
                {p.revision.changes_key
                  ? 'It changes this setting.'
                  : 'It changes another setting, not this one.'}
                <div>
                  Decided by{' '}
                  {project === null ? slotWord(p.deciders.slot) : 'the project’s admin slot'}:{' '}
                  {p.deciders.holders.length === 0
                    ? 'nobody holds it yet, so nobody can decide it.'
                    : p.deciders.holders.map(who).join(', ')}
                </div>
                {p.revision.gate_instance_id ? (
                  <div>
                    <Link to={decideLink(p.revision.gate_instance_id)}>
                      {project === null ? 'Open it to decide' : 'Open the revision to decide it'}
                    </Link>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card title="History" flush>
        <Table<ConfigKeyRevision>
          caption="Changes to the settings, newest first"
          captionHidden
          rows={v.history.filter((r) => r.changes_key)}
          rowKey={(r) => r.rev_hash}
          empty={<EmptyState title="No change yet">The setting has its default value.</EmptyState>}
          columns={[
            {
              key: 'state',
              header: 'State',
              rowHeader: true,
              render: (r) => (
                <Pill tone={STATE_TONE[r.state]}>
                  <WireTerm family="configRevision" value={r.state} />
                </Pill>
              ),
            },
            {
              key: 'by',
              header: 'Proposed',
              render: (r) => `${who(r.proposed_by)}, ${shortTime(r.proposed_at)}`,
            },
            {
              key: 'pub',
              header: 'In force from',
              render: (r) => (r.published_at ? shortTime(r.published_at) : '—'),
            },
            {
              key: 'v',
              header: 'Value',
              render: (r) => (r.set ? valueWord(r.value) : 'the default'),
            },
          ]}
        />
      </Card>
    </div>
  );
}
