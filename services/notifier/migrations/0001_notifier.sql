-- notifier (PLAN M18; ADR-0003 §1 Integration plane "notifier"; docs/specs/notifier-api.md): the notifications it
-- raised from the record, their deliveries to Slack and email, and each person's preferences, as read models of the
-- `notifier.*` events on the `notifier:<principal>` and `notifier-pref:<principal>` record streams. Rebuildable from the
-- record alone (`rebuildNotifier`): each event carries the whole fact. `notifier.delivery` is also the notifier's
-- outbox: a delivery row is written in the same transaction as the event that raises it (record first), and its
-- retry schedule is the `retry_at` of the last `notifier.delivery_failed` event.
--
-- Least privilege. The notifier decides nothing and holds channel credentials (mounted files), so it holds the least
-- database right that works, as the login role `notifier` (db-init), a member of the NOLOGIN group role below:
--
--   notifier.notification, .delivery,   SELECT, INSERT, UPDATE (its own read models; a delivery row moves from pending
--   .preference, .source_cursor         to delivered or given up). Never DELETE: only the owner's rebuild empties them
--   record.record_event                 SELECT and INSERT of its own `notifier:%` and `notifier-pref:%` streams;
--                                       SELECT of exactly what it notifies about: `gate.opened` and the gate's closing
--                                       events on `gate:%`, `card.opened` and `card.escalated` on `card:%`, and
--                                       `kill.observed` on `kill:observed`, by row-level security; never UPDATE or
--                                       DELETE
--   record.global_counter               SELECT and UPDATE: every append locks this one row and moves it forward
--   config.genuine_publish              SELECT: the published channel rows (`notifications.channels`)
--   identity.principal, .membership,    SELECT: who holds a slot (the recipients) and a person's email link
--   .binding, .grp, .qualification,
--   .identity_link
--
-- and nothing else: no ledger, decisions, core, knowledge or gateway table, no outbox of the record, no DDL.

CREATE SCHEMA IF NOT EXISTS notifier;

CREATE TABLE notifier.notification (
  notification_id uuid        PRIMARY KEY,
  principal_id    text        NOT NULL,
  kind            text        NOT NULL,
  project_id      text,
  reason          text        NOT NULL,
  slot            text,
  data_class      text        NOT NULL CHECK (data_class IN ('D0', 'D1', 'D2', 'D3')),
  content         jsonb       NOT NULL,
  source_stream   text        NOT NULL,
  source_gseq     bigint      NOT NULL,
  raised_at       timestamptz NOT NULL,
  event_gseq      bigint      NOT NULL
);
CREATE INDEX notification_principal_idx ON notifier.notification (principal_id, event_gseq DESC);
CREATE INDEX notification_source_idx ON notifier.notification (source_gseq);

CREATE TABLE notifier.delivery (
  delivery_id     uuid        PRIMARY KEY,
  notification_id uuid        NOT NULL REFERENCES notifier.notification (notification_id),
  principal_id    text        NOT NULL,
  channel_id      text        NOT NULL,
  status          text        NOT NULL CHECK (status IN ('pending', 'delivered', 'given_up')),
  attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  last_error      text,
  -- due now when null and pending
  next_attempt_at timestamptz,
  delivered_at    timestamptz,
  rendered_class  text,
  event_gseq      bigint      NOT NULL
);
CREATE INDEX delivery_due_idx ON notifier.delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX delivery_notification_idx ON notifier.delivery (notification_id);

CREATE TABLE notifier.preference (
  principal_id  text        PRIMARY KEY,
  preferences   jsonb       NOT NULL,
  set_at        timestamptz NOT NULL,
  event_gseq    bigint      NOT NULL
);

-- Bookkeeping, not a read model: how far the raise loop has read the record. A rebuild keeps it (re-reading old
-- events is harmless: a notification's id is derived from its source event and recipient, so it is raised once).
-- The first start sets it to the record's head, so a new notifier never notifies about the past.
CREATE TABLE notifier.source_cursor (
  id               boolean     PRIMARY KEY DEFAULT true CHECK (id),
  last_global_seq  bigint      NOT NULL CHECK (last_global_seq >= 0),
  started_at       timestamptz NOT NULL,
  updated_at       timestamptz NOT NULL
);

DO $$
BEGIN
  CREATE ROLE aisdlc_notifier NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;

GRANT USAGE ON SCHEMA notifier, record, config, identity TO aisdlc_notifier;
GRANT SELECT, INSERT, UPDATE ON notifier.notification, notifier.delivery, notifier.preference,
  notifier.source_cursor TO aisdlc_notifier;
GRANT SELECT, INSERT ON record.record_event TO aisdlc_notifier;
GRANT SELECT, UPDATE ON record.global_counter TO aisdlc_notifier;
GRANT SELECT ON config.genuine_publish TO aisdlc_notifier;
GRANT SELECT ON identity.principal, identity.membership, identity.binding, identity.grp, identity.qualification,
  identity.identity_link TO aisdlc_notifier;

-- The record's row-level security (enabled by the gateway migration, which runs before this one in the plan).
CREATE POLICY record_event_notifier_read ON record.record_event
  FOR SELECT TO aisdlc_notifier USING (
    stream LIKE 'notifier:%' OR stream LIKE 'notifier-pref:%'
    OR (stream LIKE 'gate:%' AND type IN ('gate.opened', 'gate.closed', 'gate.superseded', 'gate.expired'))
    OR (stream LIKE 'card:%' AND type IN ('card.opened', 'card.escalated'))
    OR (stream = 'kill:observed' AND type = 'kill.observed')
  );
CREATE POLICY record_event_notifier_append ON record.record_event
  FOR INSERT TO aisdlc_notifier WITH CHECK (stream LIKE 'notifier:%' OR stream LIKE 'notifier-pref:%');
