-- M17: the oracle lock through X2. Card 3's Full pack (the oracle lock and the seeds it made `intended`) is a
-- second pack projection of an S0 record beside card 2's: the same `pack.rendered` and `pack.x2_opened` events on
-- `pack:<s0_id>`, told apart by the payload's `kind` (absent on every earlier event: `light`). `c2_card_id` holds
-- the deciding card (card 2 or card 3). Rebuilt from the events alone (`rebuildPacks`).

ALTER TABLE core.onboarding_pack
  ADD COLUMN kind text NOT NULL DEFAULT 'light' CHECK (kind IN ('light', 'full'));
CREATE INDEX onboarding_pack_kind_idx ON core.onboarding_pack (s0_id, kind, event_gseq);
