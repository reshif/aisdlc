import { z } from 'zod';
import { GateId, TerminalState } from '../flow.js';
import { DataClass, Lane } from '../values.js';
import { CardId, GateInstanceId, IsoDateTime, PrincipalId, ProjectId, WorkItemId } from './ids.js';
import { OpsAlertKind, OpsAlertSubject } from './ops-health.js';
import { RoleSlot } from './projects.js';

// Notifications (PLAN M18; ADR-0003 §1 Integration plane "notifier"; docs/specs/notifier-api.md). One vocabulary for
// the notifier service, its channel port (`NotificationChannelPort` in `@aisdlc/ports`), the config key of its channel
// rows, core (which registers the key so a factory revision that sets it validates) and the bff.
//
// The portal inbox stays the authoritative channel: a notification is a best-effort pointer at it ("something waits
// for you in the portal"), never a place where anything is decided, and a channel that fails blocks nothing. A
// notification carries NO free text: only ids, enums and times from the record (`NotificationContent`), so it can
// never carry a request's text, a design, a secret or anything of class D2.

// ---------------------------------------------------------------- channel rows (config `notifications.channels`)

/** The config key of the channel rows: factory layer, M1-gated like every revision (`registerNotificationsConfig`). */
export const NOTIFICATIONS_CONFIG_KEY = 'notifications.channels';

/** A credential reference the notifier reads: a mounted FILE only (never `env:`, never the value). */
export const FILE_SECRET_REF_PATTERN = /^file:\/[A-Za-z0-9_./-]{1,200}$/;
export const FileSecretRef = z
  .string()
  .regex(
    FILE_SECRET_REF_PATTERN,
    'a file: reference to a mounted secret (never the secret itself)',
  );
export type FileSecretRef = z.infer<typeof FileSecretRef>;

export const NotificationChannelId = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, 'a channel id: lower-case letters, digits and dashes');
export type NotificationChannelId = z.infer<typeof NotificationChannelId>;

/** The adapters behind `NotificationChannelPort`. Teams stays deferred (on hold in the specs) behind the same port. */
export const NotificationChannelKind = z.enum(['slack_webhook', 'email_smtp']);
export type NotificationChannelKind = z.infer<typeof NotificationChannelKind>;

/** The most a channel may be sent: D0 or D1. No schema here can name D2 or D3, so no row can widen past D1. */
export const NotificationDataClass = DataClass.extract(['D0', 'D1']);
export type NotificationDataClass = z.infer<typeof NotificationDataClass>;

/** A DNS host name (an SMTP relay). Its egress is bounded by the deployment (`NOTIFIER_EGRESS_HOSTS`), not here. */
export const NotificationHost = z
  .string()
  .regex(/^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?$/, 'a host name');

/** A label people choose a channel by. No `:` or `/`, so it can never hold a URL (a webhook URL is a credential). */
export const NotificationChannelName = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9 ._#()'-]{0,79}$/, 'a plain label (no URL)');

const channelBase = {
  channel_id: NotificationChannelId,
  display_name: NotificationChannelName,
  enabled: z.boolean(),
  /** What this channel's audience may read: a D1 channel gets project and gate ids, a D0 one only "see the portal". */
  data_class_max: NotificationDataClass,
  /** Used for a person who has not chosen channels (`NotificationPreferences.channels === null`). */
  default_on: z.boolean(),
};

/** A Slack incoming webhook: the webhook URL IS the credential, so it lives in a mounted file, never in config. */
export const SlackWebhookChannel = z.strictObject({
  ...channelBase,
  kind: z.literal('slack_webhook'),
  webhook_ref: FileSecretRef,
});
export type SlackWebhookChannel = z.infer<typeof SlackWebhookChannel>;

export const SmtpTls = z.enum(['implicit', 'starttls', 'none']);
export type SmtpTls = z.infer<typeof SmtpTls>;

/** An SMTP relay. Credentials are references; `tls: none` never carries a password (refused by the schema). */
export const EmailSmtpChannel = z
  .strictObject({
    ...channelBase,
    kind: z.literal('email_smtp'),
    host: NotificationHost,
    port: z.number().int().min(1).max(65535),
    tls: SmtpTls,
    from: z.email().max(200),
    username_ref: FileSecretRef.nullable(),
    password_ref: FileSecretRef.nullable(),
  })
  .refine((c) => (c.username_ref === null) === (c.password_ref === null), {
    message: 'username_ref and password_ref are set together or not at all',
  })
  .refine((c) => c.tls !== 'none' || c.password_ref === null, {
    message: 'a password is never sent without TLS',
  });
export type EmailSmtpChannel = z.infer<typeof EmailSmtpChannel>;

export const NotificationChannelRow = z.discriminatedUnion('kind', [
  SlackWebhookChannel,
  EmailSmtpChannel,
]);
export type NotificationChannelRow = z.infer<typeof NotificationChannelRow>;

export const NOTIFICATION_CHANNELS_MAX = 20;
export const NotificationChannels = z
  .array(NotificationChannelRow)
  .max(NOTIFICATION_CHANNELS_MAX)
  .superRefine((rows, ctx) => {
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.channel_id)) {
        ctx.addIssue({ code: 'custom', message: `channel ${r.channel_id} is listed twice` });
      }
      seen.add(r.channel_id);
    }
  });
export type NotificationChannels = z.infer<typeof NotificationChannels>;

// ---------------------------------------------------------------- what a notification says

/**
 * What a notification is about (PLAN M18): a gate waiting on the person (`gate.opened`, and an S0 step card with no
 * gate), B21 (`card.escalated`), a quarantine (Q1, SECT), a handoff (E4: the owner of record chooses) and the kill
 * switch (`kill.observed`: engaged, released).
 *
 * RC-HAI-2, RC-NOT-1: what the factory needs from the requester (S1 questions with the rounds left and the PARK date,
 * the Ready decision, G6 acceptance, a PARK, a handoff to them) and what owners must know (an item done, an item that
 * ended otherwise, a halt, the R3 breaker tripped, a drift suspension, a release that failed or rolled back). RC-NOT-3:
 * a factory alert (a service or loop down, the ledger's checkpoint overdue) for the factory admins.
 */
export const NotificationKind = z.enum([
  'gate_waiting',
  'sla_escalated',
  'quarantine',
  'handoff',
  'kill_engaged',
  'kill_released',
  'questions_waiting',
  'ready_waiting',
  'acceptance_waiting',
  'item_parked',
  'item_done',
  'item_ended',
  'control_halt',
  'breaker_tripped',
  'drift_suspended',
  'release_failed',
  'factory_alert',
]);
export type NotificationKind = z.infer<typeof NotificationKind>;

/** Kinds a person cannot mute: a kill is everyone's business on the scope it stops, and a page is a page. */
export const UNMUTABLE_NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'kill_engaged',
  'kill_released',
  'factory_alert',
];

/** How a release failed (`release_failed`): refused by gate-relay, unhealthy, rolled back (B16), or held (RELHOLD). */
export const NotificationReleaseFailure = z.enum(['refused', 'unhealthy', 'rolled_back', 'held']);
export type NotificationReleaseFailure = z.infer<typeof NotificationReleaseFailure>;

/** A path inside the portal (never a host: the link is the portal's own). */
export const PortalPath = z.string().regex(/^\/[A-Za-z0-9/_.-]{0,200}$/, 'a portal path');

/**
 * The whole content of a notification: ids, enums and times, never free text. Rendered in full it is D1 (it names a
 * project and a gate); rendered for a D0 audience it is only its kind and the portal link (`renderNotification`).
 */
export const NotificationContent = z.strictObject({
  kind: NotificationKind,
  project_id: ProjectId.nullable(),
  gate_id: GateId.nullable(),
  gate_instance_id: GateInstanceId.nullable(),
  card_id: CardId.nullable(),
  kill_id: z.uuid().nullable(),
  /** B21's due time (an escalation), the gate's expiry, the PARK date (questions) or the ABANDON date (parked). */
  due_at: IsoDateTime.nullable(),
  link_path: PortalPath,
  // RC-NOT-1 (optional, so a notification raised before them still reads):
  /** The work item it is about. */
  item_id: WorkItemId.nullable().optional(),
  /** `questions_waiting`: the clarifying rounds left after this one (B1) before the item is parked. */
  rounds_left: z.number().int().min(0).max(10).nullable().optional(),
  /** `item_done` / `item_ended`: the terminal the item reached. */
  outcome: TerminalState.nullable().optional(),
  /** `breaker_tripped`: the lane whose breaker tripped. */
  lane: Lane.nullable().optional(),
  /** `release_failed`: how. */
  release: NotificationReleaseFailure.nullable().optional(),
  /** `factory_alert`: what is wrong, and with what (a tile id or `ledger.checkpoint`; codes, never probed text). */
  alert_kind: OpsAlertKind.nullable().optional(),
  alert_subject: OpsAlertSubject.nullable().optional(),
});
export type NotificationContent = z.infer<typeof NotificationContent>;

/** The class of a full rendering of `NotificationContent`. */
export const NOTIFICATION_CONTENT_CLASS: NotificationDataClass = 'D1';

/** Why the person got it: the role that made them a recipient. Never a right to decide (the inbox says that). */
export const NotificationReason = z.enum([
  'slot_holder',
  'escalated_backup',
  'project_admin',
  'factory_admin',
  /** The person who asked for the work item (RC-HAI-2). */
  'requester',
]);
export type NotificationReason = z.infer<typeof NotificationReason>;

/** The record event a notification was raised from. */
export const NotificationSource = z.strictObject({
  stream: z.string().min(1).max(200),
  stream_seq: z.number().int().min(1),
  global_seq: z.number().int().min(1),
  type: z.string().min(1).max(80),
});
export type NotificationSource = z.infer<typeof NotificationSource>;

// ---------------------------------------------------------------- per-person preferences (not config: a person's own)

/** A Slack member id, to mention the person in a channel post (`<@U...>`). */
export const SlackMemberId = z.string().regex(/^[UW][A-Z0-9]{2,20}$/, 'a Slack member id');

export const NotificationPreferences = z.strictObject({
  /** The channel rows to use; `null`: the rows marked `default_on`. An empty list: no channel (the inbox only). */
  channels: z.array(NotificationChannelId).max(NOTIFICATION_CHANNELS_MAX).nullable(),
  muted_kinds: z
    .array(NotificationKind)
    .max(NotificationKind.options.length)
    .refine((ks) => ks.every((k) => !UNMUTABLE_NOTIFICATION_KINDS.includes(k)), {
      message: 'a kill notification cannot be muted',
    }),
  slack_member_id: SlackMemberId.nullable(),
});
export type NotificationPreferences = z.infer<typeof NotificationPreferences>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  channels: null,
  muted_kinds: [],
  slack_member_id: null,
};

// ---------------------------------------------------------------- record events (stream `notifier:<principal>`)

export const NOTIFIER_EVENT = {
  raised: 'notifier.notification_raised',
  delivered: 'notifier.delivery_succeeded',
  failed: 'notifier.delivery_failed',
  preferences_set: 'notifier.preferences_set',
} as const;
export const NotifierEventType = z.enum([
  NOTIFIER_EVENT.raised,
  NOTIFIER_EVENT.delivered,
  NOTIFIER_EVENT.failed,
  NOTIFIER_EVENT.preferences_set,
]);
export type NotifierEventType = z.infer<typeof NotifierEventType>;

/** A person's notifications and deliveries. */
export const notifierStream = (principal: string): string => `notifier:${principal}`;
/** A person's preferences. */
export const notifierPrefStream = (principal: string): string => `notifier-pref:${principal}`;

/** At most this many deliveries (channels) per notification. */
export const NOTIFICATION_DELIVERIES_MAX = 8;

export const NotificationRaisedPayload = z.strictObject({
  notification_id: z.uuid(),
  principal_id: PrincipalId,
  content: NotificationContent,
  reason: NotificationReason,
  slot: RoleSlot.nullable(),
  /** The recipient's class for this content (the role that made them a recipient); caps every rendering. */
  data_class: DataClass,
  source: NotificationSource,
  /** One per channel the person's preferences chose at raise time. No address is recorded (resolved at delivery). */
  deliveries: z
    .array(z.strictObject({ delivery_id: z.uuid(), channel_id: NotificationChannelId }))
    .max(NOTIFICATION_DELIVERIES_MAX),
  raised_at: IsoDateTime,
});
export type NotificationRaisedPayload = z.infer<typeof NotificationRaisedPayload>;

/** Why a delivery attempt failed. A code only: never a URL, a response body or an address. */
export const DeliveryErrorCode = z.enum([
  'channel_unknown',
  'channel_disabled',
  'config_unreadable',
  'secret_unavailable',
  'egress_refused',
  'no_address',
  'content_refused',
  'unreachable',
  'timeout',
  'rejected',
  'rate_limited',
  'server_error',
]);
export type DeliveryErrorCode = z.infer<typeof DeliveryErrorCode>;

export const DeliverySucceededPayload = z.strictObject({
  delivery_id: z.uuid(),
  notification_id: z.uuid(),
  channel_id: NotificationChannelId,
  attempt: z.number().int().min(1),
  /** The class the message was rendered at: the lower of the channel's and the person's. */
  rendered_class: NotificationDataClass,
  delivered_at: IsoDateTime,
});
export type DeliverySucceededPayload = z.infer<typeof DeliverySucceededPayload>;

export const DeliveryFailedPayload = z.strictObject({
  delivery_id: z.uuid(),
  notification_id: z.uuid(),
  channel_id: NotificationChannelId,
  attempt: z.number().int().min(1),
  error_code: DeliveryErrorCode,
  /** The next attempt; `null`: given up (permanent, or out of attempts). */
  retry_at: IsoDateTime.nullable(),
  failed_at: IsoDateTime,
});
export type DeliveryFailedPayload = z.infer<typeof DeliveryFailedPayload>;

export const PreferencesSetPayload = z.strictObject({
  principal_id: PrincipalId,
  preferences: NotificationPreferences,
  /** Always the person themself (the bff passes the session's principal). */
  set_by: PrincipalId,
  set_at: IsoDateTime,
});
export type PreferencesSetPayload = z.infer<typeof PreferencesSetPayload>;

// ---------------------------------------------------------------- API views

export const DeliveryStatus = z.enum(['pending', 'delivered', 'given_up']);
export type DeliveryStatus = z.infer<typeof DeliveryStatus>;

export const DeliveryView = z.strictObject({
  delivery_id: z.uuid(),
  channel_id: NotificationChannelId,
  status: DeliveryStatus,
  attempts: z.number().int().min(0),
  last_error: DeliveryErrorCode.nullable(),
  next_attempt_at: IsoDateTime.nullable(),
  delivered_at: IsoDateTime.nullable(),
});
export type DeliveryView = z.infer<typeof DeliveryView>;

export const NotificationView = z.strictObject({
  notification_id: z.uuid(),
  content: NotificationContent,
  reason: NotificationReason,
  raised_at: IsoDateTime,
  deliveries: z.array(DeliveryView),
});
export type NotificationView = z.infer<typeof NotificationView>;

export const NotificationList = z.strictObject({ notifications: z.array(NotificationView) });
export type NotificationList = z.infer<typeof NotificationList>;

/** A channel as a person sees it when choosing: no credential reference, no host. */
export const NotificationChannelChoice = z.strictObject({
  channel_id: NotificationChannelId,
  kind: NotificationChannelKind,
  display_name: NotificationChannelName,
  default_on: z.boolean(),
  data_class_max: NotificationDataClass,
});
export type NotificationChannelChoice = z.infer<typeof NotificationChannelChoice>;

export const NotificationPreferencesView = z.strictObject({
  principal_id: PrincipalId,
  preferences: NotificationPreferences,
  /** `null`: never set (the defaults apply). */
  set_at: IsoDateTime.nullable(),
  /** The enabled channel rows in force. */
  channels: z.array(NotificationChannelChoice),
});
export type NotificationPreferencesView = z.infer<typeof NotificationPreferencesView>;

/** The body of `POST /v1/people/:principal/preferences` (the bff's `PUT /api/me/notifications/preferences`). */
export const SetPreferencesRequest = z.strictObject({ preferences: NotificationPreferences });
export type SetPreferencesRequest = z.infer<typeof SetPreferencesRequest>;
