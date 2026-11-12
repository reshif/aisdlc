# notifier: Slack and email notifications of what waits for a person (M18)

The notifier (`services/notifier`; ADR-0003 §1 Integration plane) tells a person, on Slack or by email, that something waits for them in the portal. It holds the channel credentials and absorbs their outages; it decides nothing. **The portal inbox stays the authoritative channel**: a notification is a pointer at it, never a place where anything is decided, and a channel that fails blocks nothing in the factory. Its vocabulary is `packages/contracts/src/entities/notifications.ts`, the source of truth for every shape below.

## 1. What is notified, and to whom

The notifier reads the record (never core's API) and raises one notification per recipient of each event it knows (`services/notifier/src/sources.ts`, a pure function of one event):

| Source event | Kind | Recipients (read from identity at raise time) |
|---|---|---|
| `gate.opened` on `gate:<id>`, family `quarantine` (Q1, SECT) | `quarantine` | the holders of the gate's quorum slot on its project |
| `gate.opened`, gate E4 (the owner of record chooses) | `handoff` | the same |
| `gate.opened`, any other gate (G0..G6, X, E, M) | `gate_waiting` | the same |
| `card.opened` of a card with no gate (an S0 step card: card 5's sign-off) | `gate_waiting` | the holders of the card's role |
| `card.escalated` (B21, one business day past) | `sla_escalated` | the backup principals the escalation named (reason `escalated_backup`), then the card's own slot holders |
| `kill.observed`, kind `kill.requested` / `kill.released` | `kill_engaged` / `kill_released` | a project or lane kill: the project's `admin` and `kill` slot holders; a fleet kill: the fleet's `factory.admin` holders |

A slot's holders are the principals whose grant of the slot's role at the project is in force now (`queryGrants` from `@aisdlc/identity/read`, no blocker: active human, membership running, binding not expired, qualification valid). That is who the slot names, not who may decide: SoD, two-person and step-up stay the inbox's and the PDP's. A gate already closed, superseded or expired when the event is read raises nothing; an event older than `NOTIFIER_MAX_SOURCE_AGE_MS` (24 h) raises nothing (a restart after an outage does not flood); the first start places the cursor at the record's head (a new notifier never notifies about the past). An event the notifier cannot parse raises nothing.

## 2. Content and data class

A notification carries **no free text** (`NotificationContent`): its kind, the project, the gate id and instance, the card, the kill id, a due time and a portal path. So it can never carry a request's text, an artefact, a reason, a secret or anything of class D2. A kill's free-text reason is never read into it.

Each delivery is rendered at the **lower** of the channel's `data_class_max` (D0 or D1; no schema can name D2) and the recipient's class (the `data_class_default` of the role that made them a recipient). In full (D1) the message names the project and the gate and links to the path; at D0 it says only that something waits in the portal and links to `/inbox`. Every rendering goes through the shared secret ruleset (`@aisdlc/secrets-rules`) before it is sent; a hit refuses the delivery (`content_refused`), it is never redacted and sent. A person's email address is their `email` identity link (the IdP's, never one they type), read at delivery time and **never recorded**.

## 3. Record first, at least once

| Event (stream `notifier:<principal>`) | Written when | Read model |
|---|---|---|
| `notifier.notification_raised` | the raise loop, in ONE transaction with its cursor move | `notifier.notification`, and one pending `notifier.delivery` per channel chosen |
| `notifier.delivery_succeeded` | the channel accepted it | delivery `delivered` |
| `notifier.delivery_failed` | an attempt failed: a code (`DeliveryErrorCode`) and `retry_at`, or `null` (given up) | delivery `pending` with `next_attempt_at`, or `given_up` |
| `notifier.preferences_set` (stream `notifier-pref:<principal>`) | the person replaced their preferences | `notifier.preference` |

The ids are derived (`deterministicId`): a notification's from its source event and recipient, a delivery's from the notification and channel, so a re-read of the record (a crash, a rewound cursor, a rebuild) raises nothing twice. The delivery rows are the notifier's outbox: the delivery loop claims one due row at a time (`FOR UPDATE SKIP LOCKED`), sends it through the channel port under its delivery id (the idempotency key: email's `Message-ID`; Slack webhooks have none, so a lost answer may post twice), and records the outcome in the same transaction. A transient failure (unreachable, timeout, 429, 5xx, SMTP 4xx, the channel rows unreadable, a key file missing) is retried after `base * 2^(n-1)`, capped (`NOTIFIER_RETRY_BASE_MS` 30 s, `NOTIFIER_RETRY_MAX_MS` 1 h), up to `NOTIFIER_MAX_ATTEMPTS` (6); a permanent one (a 4xx webhook answer, SMTP 5xx, a channel removed or disabled, no address, a host outside the bounds, `content_refused`) is given up at once. A failure is a code: never a URL, a response body or an address. The read models are rebuilt from the events alone (`rebuildNotifier`); the cursor (`notifier.source_cursor`) is bookkeeping and survives a rebuild.

Nothing on the factory's path waits for the notifier: it writes only its own streams, nothing a decision or a gate reads, and its health is its loops' (a channel that is down is a delivery's state, not an unhealthy notifier).

## 4. Channels: config, bounded by the deployment

The channel rows are config key `notifications.channels` (`registerNotificationsConfig` in `@aisdlc/config`; factory layer only, M1-gated, empty by default; core registers it so a factory revision that sets it validates). A row is a Slack incoming webhook (`webhook_ref`: the webhook URL is the credential) or an SMTP relay (`host`, `port`, `tls` implicit/starttls/none, `from`, `username_ref` and `password_ref` together or neither; never a password without TLS). Credentials are `file:` references only, the whole document goes through the secret ruleset (a finding names the rule, never the value), and a label cannot hold a URL. `enabled`, `data_class_max` and `default_on` (used for a person who has not chosen) are per row.

What a published row may make the notifier do is bounded by the deployment (`services/notifier/src/channels.ts`), as the gateway's rows are:

| Variable | Bound |
|---|---|
| `NOTIFIER_SECRET_REFS` | the only key files a row may name (JSON list of `file:` references; default none) |
| `NOTIFIER_EGRESS_HOSTS` | the only hosts a webhook URL or a relay may be (default `hooks.slack.com`) |
| `NOTIFIER_PLAIN_HOSTS` | of those, the hosts reachable without TLS (a local relay or a test sink; never with a password) |

A webhook must be https (or plain http to a plain host), carry no userinfo, and is never redirected. A row outside the bounds is not built (`secret_unavailable`, `egress_refused`); nothing else is affected. The adapters (`SlackWebhookChannel`, `SmtpEmailChannel`) live in the notifier, the only holder of the credentials, behind `NotificationChannelPort` (`packages/ports/src/notification-channel.ts`) with the deterministic `FakeNotificationChannel`; all three pass `notificationChannelContract`. Teams stays deferred (on hold in the specs) behind the same port.

## 5. Preferences

A person's own (not config, no M1): `channels` (the rows to use; `null`: the `default_on` rows; `[]`: the inbox only), `muted_kinds` (a kill cannot be muted), `slack_member_id` (to mention them in a channel post). Only enabled rows can be chosen. A notification is raised (and listed) even when it has no delivery; a muted kind raises nothing.

## 6. API

Service tokens (`NOTIFIER_CALLERS`, scope `people`): the bff is its only caller. The notifier has no session and no PDP: it trusts the principal in the path from the bff, which always passes the signed-in person's.

| Route | Answer |
|---|---|
| `GET /healthz`, `GET /metrics` | the loops' health (no credential) |
| `GET /v1/people/:principal/notifications?limit=` (1..200, default 50) | `NotificationList`: newest first, each with its deliveries (status, attempts, last error code, next attempt) |
| `GET /v1/people/:principal/preferences` | `NotificationPreferencesView`: the preferences (or the defaults, `set_at: null`) and the enabled channels as choices (no reference, no host) |
| `POST /v1/people/:principal/preferences` `{preferences}` | the new view; `400 unknown_channel` for a row that is not enabled |

The bff (`services/bff/src/notifications.ts`; `BFF_NOTIFIER_URL`, `BFF_NOTIFIER_TOKEN_REF`):

| Route | |
|---|---|
| `GET /api/me/notifications?limit=` | the session's notifications; one about a project the person can no longer view (`project.view`, asked now) is left out |
| `GET /api/me/notifications/preferences` | the session's preferences |
| `PUT /api/me/notifications/preferences` `{preferences}` | replace them (CSRF-checked like every write) |

No route takes a principal. Without a notifier these answer 503, and 502 when it fails; nothing else in the portal depends on it.

## 7. Least privilege

The login role `notifier` (db-init) is a member of `aisdlc_notifier` (`services/notifier/migrations/0001_notifier.sql`): SELECT, INSERT, UPDATE on its own four tables (never DELETE); SELECT and INSERT on `record.record_event` of its own `notifier:` and `notifier-pref:` streams, and SELECT of exactly the events it notifies about (`gate.opened` and the gate's closing events, `card.opened`, `card.escalated`, `kill.observed`), by row-level security; the record's counter; `config.genuine_publish`; identity's read model (`principal`, `membership`, `binding`, `grp`, `qualification`, `identity_link`). No ledger, decisions, core, knowledge or gateway table, no record outbox, no DDL. In compose it is the profile `notifier` on `data-notifier`, `notifier-api` (the bff) and `notifier-egress` only (`platform/compose/README.md`).

## 8. Not yet

- Real-time delivery to the portal (a push channel to the browser); the portal screens for the notification list and the preferences (the bff routes exist).
- Per-channel Slack routing per person (an incoming webhook posts to its own channel: a person picks among rows), and the Slack and email settings screen per channel (the config console's generic pattern applies to the key).
- An SMTP test with TLS (the adapter verifies certificates; the local sink speaks plain SMTP only, so STARTTLS and AUTH run against a real relay only).
