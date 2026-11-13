import {
  NotificationKind,
  UNMUTABLE_NOTIFICATION_KINDS,
  type NotificationPreferences,
  type NotificationPreferencesView,
  type NotificationView,
} from '@aisdlc/contracts';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { ErrorNote, Loading, PageError } from '../components/Notice';
import { shortTime } from '../format';
import { Link } from '../router';
import { Card, EmptyState, PageHead, Pill, Table, useToast, type Column } from '../ui';

// A person's notifications and their preferences (PLAN M18; docs/specs/notifier-api.md). The inbox stays the record
// of what waits; a notification only points at the portal, and a channel that fails blocks nothing. Both screens are
// the session's own: no route here names anybody else.

const KIND_TEXT: Readonly<Record<NotificationKind, string>> = {
  gate_waiting: 'A gate waits for you',
  sla_escalated: 'A card was escalated',
  quarantine: 'An item was quarantined',
  handoff: 'An item was handed off',
  kill_engaged: 'A kill switch was engaged',
  kill_released: 'A kill switch was released',
  questions_waiting: 'Your request has questions for you',
  ready_waiting: 'Your request waits for your Ready',
  acceptance_waiting: 'Your request waits for your acceptance (G6)',
  item_parked: 'Your request is parked',
  item_done: 'A work item is done',
  item_ended: 'A work item ended',
  control_halt: 'A halt stopped work',
  breaker_tripped: 'A circuit breaker tripped',
  drift_suspended: 'A project is suspended by drift',
  release_failed: 'A release failed',
  factory_alert: 'Factory alert',
};

/** What a notification adds to its kind: the rounds left, a date, an outcome, a lane, an alert's subject. */
function detailOf(n: NotificationView): string {
  const c = n.content;
  const parts: string[] = [];
  if (c.kind === 'questions_waiting' && c.rounds_left != null)
    parts.push(c.rounds_left === 0 ? 'last round' : `${c.rounds_left} round(s) left`);
  if (c.kind === 'questions_waiting' && c.due_at !== null)
    parts.push(`parked ${shortTime(c.due_at)}`);
  else if (c.kind === 'item_parked' && c.due_at !== null)
    parts.push(`abandoned ${shortTime(c.due_at)}`);
  else if (c.due_at !== null) parts.push(`due ${shortTime(c.due_at)}`);
  if (c.outcome) parts.push(c.outcome);
  if (c.lane) parts.push(c.lane);
  if (c.release) parts.push(c.release.replace('_', ' '));
  if (c.alert_kind) parts.push(`${c.alert_kind.replace(/_/g, ' ')}: ${c.alert_subject ?? ''}`);
  return parts.join(' · ');
}

const deliveryText = (n: NotificationView): string =>
  n.deliveries.length === 0
    ? 'portal only'
    : n.deliveries
        .map((d) => `${d.channel_id}: ${d.status === 'given_up' ? 'gave up' : d.status}`)
        .join(', ');

const notifierDown = (e: unknown) =>
  e instanceof ApiError && (e.status === 503 || e.status === 502);

export function NotificationsPage() {
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.notifications(),
    // a notifier that is off stays off for a while: say so at once
    retry: (n, e) => !notifierDown(e) && n < 2,
  });
  const cols: ReadonlyArray<Column<NotificationView>> = [
    {
      key: 'what',
      header: 'What',
      rowHeader: true,
      render: (n) => <Link to={n.content.link_path}>{KIND_TEXT[n.content.kind]}</Link>,
    },
    { key: 'project', header: 'Project', render: (n) => n.content.project_id ?? 'the factory' },
    { key: 'gate', header: 'Gate', render: (n) => n.content.gate_id ?? '' },
    { key: 'detail', header: 'Detail', render: (n) => detailOf(n) },
    { key: 'when', header: 'Raised', render: (n) => shortTime(n.raised_at) },
    { key: 'sent', header: 'Sent to', render: (n) => deliveryText(n) },
  ];
  return (
    <>
      <PageHead
        title="Notifications"
        sub="What the factory pointed you at. The inbox is where things wait for you; a notification only says to look there."
        actions={
          <Link className="ui-btn" to="/me/notifications/preferences">
            Preferences
          </Link>
        }
      />
      {q.isPending ? <Loading what="your notifications" /> : null}
      {q.isError ? (
        notifierDown(q.error) ? (
          <EmptyState title="Notifications are not available">
            The notifier is not configured or not answering. Nothing else in the portal depends on
            it; your <Link to="/inbox">inbox</Link> is up to date.
          </EmptyState>
        ) : (
          <PageError error={q.error} retry={() => void q.refetch()} />
        )
      ) : null}
      {q.data && q.data.notifications.length === 0 ? (
        <EmptyState title="Nothing yet">
          When a gate waits for you, your request needs you (questions, Ready, acceptance), an item
          you asked for ends, a card is escalated or a kill switch moves, it shows here.
        </EmptyState>
      ) : null}
      {q.data && q.data.notifications.length > 0 ? (
        <Card flush>
          <Table
            caption="Your notifications, newest first"
            columns={cols}
            rows={q.data.notifications}
            rowKey={(n) => n.notification_id}
          />
        </Card>
      ) : null}
    </>
  );
}

function PrefsForm({ view, csrf }: { view: NotificationPreferencesView; csrf: string }) {
  const toast = useToast();
  const qc = useQueryClient();
  const p = view.preferences;
  const [useDefaults, setUseDefaults] = useState(p.channels === null);
  const [channels, setChannels] = useState<readonly string[]>(
    p.channels ?? view.channels.filter((c) => c.default_on).map((c) => c.channel_id),
  );
  const [muted, setMuted] = useState<readonly NotificationKind[]>(p.muted_kinds);
  const [slack, setSlack] = useState(p.slack_member_id ?? '');
  const save = useMutation({
    mutationFn: (prefs: NotificationPreferences) => api.setNotificationPrefs(prefs, csrf),
    onSuccess: async (v) => {
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
    <form onSubmit={submit} className="asst-stack">
      <fieldset>
        <legend>Channels</legend>
        <label className="asst-check">
          <input
            type="checkbox"
            checked={useDefaults}
            onChange={(e) => setUseDefaults(e.target.checked)}
          />{' '}
          Use the factory&apos;s default channels
        </label>
        {view.channels.length === 0 ? (
          <p className="asst-fine">No channel is enabled: notifications stay in the portal.</p>
        ) : (
          view.channels.map((c) => (
            <label key={c.channel_id} className="asst-check">
              <input
                type="checkbox"
                disabled={useDefaults}
                checked={useDefaults ? c.default_on : channels.includes(c.channel_id)}
                onChange={(e) => setChannels(toggle(channels, c.channel_id, e.target.checked))}
              />{' '}
              {c.display_name}{' '}
              <Pill plain tone="mute">
                {c.kind === 'slack_webhook' ? 'Slack' : 'email'} · {c.data_class_max}
              </Pill>
            </label>
          ))
        )}
      </fieldset>
      <fieldset>
        <legend>What to be told about</legend>
        {NotificationKind.options.map((k) => {
          const fixed = UNMUTABLE_NOTIFICATION_KINDS.includes(k);
          return (
            <label key={k} className="asst-check">
              <input
                type="checkbox"
                checked={!muted.includes(k)}
                disabled={fixed}
                onChange={(e) => setMuted(toggle(muted, k, !e.target.checked))}
              />{' '}
              {KIND_TEXT[k]}
              {fixed ? <span className="asst-fine"> (cannot be muted)</span> : null}
            </label>
          );
        })}
      </fieldset>
      <div>
        <label htmlFor="slack-id">Slack member id (to be mentioned in a channel post)</label>
        <input
          id="slack-id"
          className="asst-input asst-input-line"
          value={slack}
          placeholder="U012ABCDEF"
          onChange={(e) => setSlack(e.target.value)}
        />
      </div>
      {save.isError ? (
        <p role="alert" className="asst-error">
          {save.error instanceof ApiError ? save.error.message : 'The preferences were not saved.'}
        </p>
      ) : null}
      <div>
        <button type="submit" className="ui-btn ui-btn-primary" disabled={save.isPending}>
          {save.isPending ? 'Saving…' : 'Save preferences'}
        </button>
      </div>
    </form>
  );
}

export function NotificationPrefsPage({ csrf }: { csrf: string }) {
  const q = useQuery({
    queryKey: ['notifications', 'prefs'],
    queryFn: () => api.notificationPrefs(),
    retry: (n, e) => !notifierDown(e) && n < 2,
  });
  return (
    <>
      <PageHead
        title="Notification preferences"
        crumbs={[{ label: 'Notifications', to: '/me/notifications' }, { label: 'Preferences' }]}
        renderLink={(to, label) => <Link to={to}>{label}</Link>}
        sub="Where the factory points you at the portal. Your inbox is the same whatever you choose here."
      />
      {q.isPending ? <Loading what="your preferences" /> : null}
      {q.isError ? (
        notifierDown(q.error) ? (
          <EmptyState title="Notifications are not available">
            The notifier is not configured or not answering.
          </EmptyState>
        ) : (
          <ErrorNote error={q.error} retry={() => void q.refetch()} />
        )
      ) : null}
      {q.data ? (
        <Card title="Your preferences">
          <PrefsForm view={q.data} csrf={csrf} />
          {q.data.set_at ? (
            <p className="asst-fine">Last set {shortTime(q.data.set_at)}.</p>
          ) : (
            <p className="asst-fine">Never set: the defaults apply.</p>
          )}
        </Card>
      ) : null}
    </>
  );
}
