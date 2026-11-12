-- Core: the Evidence Packs 7.6 signed (PLAN M14.4; FL S7 "signed Evidence Pack bound to head SHA"; DM §3.4 EvidencePack).
--
-- READ MODEL. The authority is the record: `evidence.pack_signed` on the stream `evidence:<item>` and the ledger entry
-- (`evidence.pack_signed`) written in the same transaction (the ledger lock before the first append, the entry last).
-- The pack itself is NOT here: its signed bytes are in the object store's write-once bucket under their sha256
-- (`object_key`); the record holds only hashes (ADR-0003 §2). core folds each event into this table as it writes it and
-- can rebuild it from the events alone (`rebuildEvidencePacks`). One row per 7.6 (or D2 at 7.2/7.3) command: a retry
-- of the same command finds its row and signs nothing again.

CREATE TABLE core.evidence_pack (
  pack_sha256         text        PRIMARY KEY CHECK (pack_sha256 ~ '^[0-9a-f]{64}$'),
  command_key         text        NOT NULL UNIQUE,
  item_id             uuid        NOT NULL,
  unit_key            text        NOT NULL,
  base_sha            text        NOT NULL CHECK (base_sha ~ '^[0-9a-f]{40}$'),
  head_sha            text        NOT NULL CHECK (head_sha ~ '^[0-9a-f]{40}$'),
  disposition         text        NOT NULL CHECK (disposition IN ('passed', 'rework', 'handoff')),
  passing             boolean     NOT NULL,
  -- the whole disposition (edge, loop, trigger, reason) as recorded
  detail              jsonb       NOT NULL,
  bucket              text        NOT NULL,
  object_key          text        NOT NULL CHECK (object_key ~ '^[0-9a-f]{64}$'),
  key_id              text        NOT NULL,
  handoff_pack_sha256 text        CHECK (handoff_pack_sha256 ~ '^[0-9a-f]{64}$'),
  handoff_object_key  text        CHECK (handoff_object_key ~ '^[0-9a-f]{64}$'),
  produced_at         timestamptz NOT NULL,
  event_gseq          bigint      NOT NULL,
  CHECK (passing = (disposition = 'passed'))
);
CREATE INDEX evidence_pack_item_idx ON core.evidence_pack (item_id, event_gseq);
CREATE INDEX evidence_pack_head_idx ON core.evidence_pack (head_sha);

GRANT SELECT, INSERT, UPDATE, DELETE ON core.evidence_pack TO aisdlc_app;
