-- The effective-config query as a view (PLAN M10 follow-up: least-privilege roles).
--
-- A published revision counts only while the ledger holds the decided-approve M1 entry for exactly that
-- hash (see lineage.ts GENUINE_PUBLISH_SQL). Readers used to join `ledger.ledger_entry` themselves, which
-- meant every reader needed SELECT on the whole ledger. The view runs with its owner's rights, so a
-- reader that may only read config (the model gateway) is granted this one view and nothing of the
-- ledger. The condition below MUST stay equal to GENUINE_PUBLISH_SQL; a test compares the two.

CREATE VIEW config.genuine_publish AS
SELECT p.rev_hash,
       p.lineage,
       p.parent_rev_hash,
       r.parent_rev_hash AS rev_parent,
       r.doc,
       p.global_seq,
       l.subject_id
  FROM config.config_published p
  JOIN config.config_revision r ON r.rev_hash = p.rev_hash AND r.lineage = p.lineage
  JOIN ledger.ledger_entry l ON l.entry_id = p.ledger_entry_id
   AND l.entry_type = 'decision' AND l.gate_id = 'M1' AND l.decision = 'approve'
   AND l.subject_kind = 'config' AND l.subject_hash = p.rev_hash
   AND l.gate_instance_id = p.gate_instance_id;

GRANT SELECT ON config.genuine_publish TO aisdlc_app;
