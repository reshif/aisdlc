-- The S0 cards (PLAN M7.3) look up the cards of one S0 record on the authoritative record: the
-- `card.opened` event names the record as its subject. No read model, an index only.

CREATE INDEX core_card_opened_s0_idx ON record.record_event ((body ->> 'subject_id'))
  WHERE type = 'card.opened' AND body ->> 'subject_kind' = 's0_record';
