-- Core: the Push Broker's receipts and the pull requests they opened (PLAN M13.6; DM §3.6 PushReceipt, PullRequest). Needs
-- 0008_units.
--
-- READ MODELS. The authority is the record: `push.intended` (recorded BEFORE the broker is asked, DEC-12(a)) and
-- `push.receipt_recorded` on the stream `push:<item>`, and the ledger entry (`push.receipt`) written in the same transaction
-- as the receipt event. core folds each event into these rows as it writes it and can rebuild them from the events alone
-- (`rebuildPushes`). A refusal is a receipt too (status `refused`, with its code): what was tried is as recorded as what was
-- written.

CREATE TABLE core.push_receipt (
  receipt_id   text        PRIMARY KEY,
  item_id      uuid        NOT NULL,
  unit_key     text        NOT NULL,
  repo         text        NOT NULL,
  branch       text        NOT NULL,
  lease_epoch  integer     NOT NULL CHECK (lease_epoch >= 1),
  patch_hash   text        NOT NULL CHECK (patch_hash ~ '^[0-9a-f]{64}$'),
  status       text        NOT NULL CHECK (status IN ('applied', 'refused_stale_epoch', 'no_lease', 'refused')),
  code         text,
  base_sha     text        NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha     text        CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  pr_number    integer,
  files        integer     NOT NULL CHECK (files >= 0),
  at           timestamptz NOT NULL,
  -- the global_seq of the event that made it: the order receipts happened in
  event_gseq   bigint      NOT NULL,
  -- an applied receipt has a head and a pull request; a refusal says why
  CHECK ((status = 'applied') = (head_sha IS NOT NULL AND pr_number IS NOT NULL)),
  CHECK ((status = 'applied') = (code IS NULL))
);
CREATE INDEX push_receipt_unit_idx ON core.push_receipt (item_id, unit_key, event_gseq);

CREATE TABLE core.pull_request (
  repo      text    NOT NULL,
  number    integer NOT NULL,
  item_id   uuid    NOT NULL,
  unit_key  text    NOT NULL,
  head_ref  text    NOT NULL,
  head_sha  text    NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  state     text    NOT NULL CHECK (state IN ('open', 'closed')),
  draft     boolean NOT NULL,
  PRIMARY KEY (repo, number)
);
CREATE INDEX pull_request_item_idx ON core.pull_request (item_id);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.push_receipt, core.pull_request TO aisdlc_app;
