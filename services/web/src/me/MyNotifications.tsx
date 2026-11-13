import {
  NotificationKind,
  UNMUTABLE_NOTIFICATION_KINDS,
  label,
  type NotificationPreferences,
  type NotificationPreferencesView,
  type NotificationView,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent } from 'react';
import { errorText } from '../admin';
import { ApiError, api } from '../api';
import { Loading } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import {
  Card,
  EmptyState,
  PageHeader,
  Pill,
  Table,
  Tabs,
  Term,
  WireTerm,
  useToast,
  type Column,
} from '../ui';

// My notifications (screen map §1.3): what the factory told me, newest first, and my preferences per kind and
// channel ("always sent" kinds locked). The inbox stays the record of what waits; a notification only points there,
// and a channel that fails blocks nothing. The session's own: no route here names anybody else.

const renderLink = (to: string, text: string) => <Link to={to}>{text}</Link>;

function detailOf(n: NotificationView): string {
  const c = n.content;
  const parts: string[] = [];
  if (c.kind === 'questions_waiting' && c.round != null)
    parts.push(
      c.rounds_left == null ? `round ${c.round}` : `round ${c.round} of ${c.round + c.rounds_left}`,
    );
  if (c.kind === 'questions_waiting' && c.due_at !== null)
    parts.push(`waits until ${shortTime(c.due_at)}`);
  else if (c.kind === 'item_parked' && c.due_at !== null)
    parts.push(`abandoned ${shortTime(c.due_at)}`);
  else if (c.due_at !== null) parts.push(`due ${shortTime(c.due_at)}`);
  return parts.join(' · ');
}

const sentText = (n: NotificationView): string =>
  n.deliveries.length === 0
    ? 'Portal only'
    : n.deliveries
        .map((d) => `${d.channel_id}: ${d.status === 'given_up' ? 'not delivered' : d.status}`)
        .join(', ');

const notifierDown = (e: unknown) =>
  e instanceof ApiError && (e.status === 503 || e.status === 502);

function Down() {
  return (
    <EmptyState title="Notifications are not available">
      The notifier is not set up or not answering. Nothing else depends on it; your{' '}
      <Link to="/inbox">inbox</Link> is up to date.
    </EmptyState>
  );
}

function List() {
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(),
    retry: (n, e) => !notifierDown(e) && n < 2,
  });
  const cols: ReadonlyArray<Column<NotificationView>> = [
    {
      key: 'what',
      header: 'What',
      rowHeader: true,
      render: (n) => (
        <Link to={n.content.link_path}>
          <WireTerm family="notificationKind" value={n.content.kind} />
        </Link>
      ),
    },
    {
      key: 'where',
      header: 'Where',
      render: (n) => (
        <>
          {n.content.project_id ?? label('concept', 'factory')}
          {n.content.gate_id ? (
            <div className="adm-muted">
              <WireTerm family="gate" value={n.content.gate_id} />
            </div>
          ) : null}
        </>
      ),
    },
    { key: 'detail', header: 'Detail', render: (n) => detailOf(n) },
    { key: 'when', header: 'When', render: (n) => shortTime(n.raised_at) },
    { key: 'sent', header: 'Sent to', render: (n) => sentText(n) },
  ];
  if (q.isPending) return <Loading what="your notifications" />;
  if (q.isError)
    return notifierDown(q.error) ? (
      <Down />
    ) : (
      <p className="adm-note" role="alert">
        {errorText(q.error)}
      </p>
    );
  return (
    <Card flush>
      <Table
        caption="Your notifications, newest first"
        captionHidden
        columns={cols}
        rows={q.data.notifications}
        rowKey={(n) => n.notification_id}
        empty={
          <EmptyState title="Nothing yet">
            When an approval waits for you, your request needs you, an item you asked for ends or
            agents are stopped, it shows here.
          </EmptyState>
        }
      />
    </Card>
  );
}

function PrefsForm({ view, csrf }: { view: NotificationPreferencesView; csrf: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const id = useId();
  const p = view.preferences;
  const [useDefaults, setUseDefaults] = useState(p.channels === null);
  const [channels, setChannels] = useState<readonly string[]>(
    p.channels ?? view.channels.filter((c) => c.default_on).map((c) => c.channel_id),
  );
  const [muted, setMuted] = useState<readonly NotificationKind[]>(p.muted_kinds);
  const [slack, setSlack] = useState(p.slack_member_id ?? '');
  const save = useMutation({
    mutationFn: (prefs: NotificationPreferences) => api.setNotificationPrefs(prefs, csrf),
    onSuccess: (v) => {
      qc.setQueryData(['notifications', 'prefs'], v);
      toast('Preferences saved', 'ok');
    },
  });
  const toggle = <T,>(xs: readonly T[], x: T, on: boolean): T[] =>
    on ? [...new Set([...xs, x])] : xs.filter((y) => y !== x);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    save.mutate({
      channels: useDefaults ? null : [...channels],
      muted_kinds: [...muted],
      slack_member_id: slack.trim() === '' ? null : slack.trim(),
    });
  };
  return (
    <form onSubmit={submit} className="adm-form">
      <fieldset className="adm-form">
        <legend className="adm-sub">Channels</legend>
        <label className="adm-check">
          <input
            type="checkbox"
            checked={useDefaults}
            onChange={(e) => setUseDefaults(e.target.checked)}
          />
          Use the factory’s default channels
        </label>
        {view.channels.length === 0 ? (
          <p className="ui-help">No channel is set up: notifications stay in the portal.</p>
        ) : (
          view.channels.map((c) => (
            <label key={c.channel_id} className="adm-check">
              <input
                type="checkbox"
                disabled={useDefaults}
                checked={useDefaults ? c.default_on : channels.includes(c.channel_id)}
                onChange={(e) => setChannels(toggle(channels, c.channel_id, e.target.checked))}
              />
              {c.display_name}{' '}
              <Pill plain tone="mute">
                {c.kind === 'slack_webhook' ? 'Slack' : 'Email'} ·{' '}
                <Term family="dataClass" value={c.data_class_max} />
              </Pill>
            </label>
          ))
        )}
      </fieldset>
      <fieldset className="adm-form">
        <legend className="adm-sub">What to be told about</legend>
        {NotificationKind.options.map((k) => {
          const fixed = UNMUTABLE_NOTIFICATION_KINDS.includes(k);
          return (
            <label key={k} className="adm-check">
              <input
                type="checkbox"
                checked={fixed || !muted.includes(k)}
                disabled={fixed}
                onChange={(e) => setMuted(toggle(muted, k, !e.target.checked))}
              />
              <Term family="notificationKind" value={k} />
              {fixed ? <span className="adm-muted"> (always sent)</span> : null}
            </label>
          );
        })}
      </fieldset>
      <div>
        <label className="ui-label" htmlFor={`${id}-s`}>
          Slack member id (to be mentioned in a channel post)
        </label>
        <input
          id={`${id}-s`}
          className="ui-input"
          value={slack}
          placeholder="U012ABCDEF"
          onChange={(e) => setSlack(e.target.value)}
        />
      </div>
      {save.isError ? (
        <p role="alert" className="ui-help ui-help-bad">
          {errorText(save.error)}
        </p>
      ) : null}
      <div className="adm-acts">
        <button type="submit" className="ui-btn ui-btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save preferences'}
        </button>
        <span className="ui-help">
          {view.set_at
            ? `Last saved ${shortTime(view.set_at)}.`
            : 'Never saved: the defaults apply.'}
        </span>
      </div>
    </form>
  );
}

function Prefs({ csrf }: { csrf: string }) {
  const q = useQuery({
    queryKey: ['notifications', 'prefs'],
    queryFn: () => api.notificationPrefs(),
    retry: (n, e) => !notifierDown(e) && n < 2,
  });
  if (q.isPending) return <Loading what="your preferences" />;
  if (q.isError)
    return notifierDown(q.error) ? (
      <Down />
    ) : (
      <p className="adm-note" role="alert">
        {errorText(q.error)}
      </p>
    );
  return (
    <Card>
      <PrefsForm view={q.data} csrf={csrf} />
    </Card>
  );
}

export function MyNotificationsPage({ csrf, prefs }: { csrf: string; prefs?: boolean }) {
  const [tab, setTab] = useState(prefs ? 'prefs' : 'list');
  return (
    <>
      <PageHeader
        title={label('screen', 'my_notifications')}
        meta="What the factory pointed you at. Your inbox is where things wait for you."
        renderLink={renderLink}
      />
      <Tabs
        label={label('screen', 'my_notifications')}
        tabs={[
          { id: 'list', label: 'Notifications' },
          { id: 'prefs', label: 'Preferences' },
        ]}
        selected={tab}
        onSelect={setTab}
      >
        {tab === 'list' ? <List /> : <Prefs csrf={csrf} />}
      </Tabs>
    </>
  );
}
