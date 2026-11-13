-- Portal v2 (intent §4, agent-led onboarding): the fixes the onboarding agent proposes are a third pack projection of
-- an S0 record (`kind = 'fixes'`), on their own branch `agent/<s0_id>/onboarding-fixes` and their own X2, bound to
-- card 1 and the agent proposal's hash. The same `pack.*` events; rebuilt from them alone (`rebuildPacks`).
--
-- The agent's proposals themselves are record events on `onboarding-agent:<s0_id>` folded into
-- `core.onboarding_proposal` (every proposal per record, the newest by event_gseq; rebuildable from the events).

ALTER TABLE core.onboarding_pack DROP CONSTRAINT IF EXISTS onboarding_pack_kind_check;
ALTER TABLE core.onboarding_pack
  ADD CONSTRAINT onboarding_pack_kind_check CHECK (kind IN ('light', 'full', 'fixes'));

CREATE TABLE core.onboarding_proposal (
  s0_id         uuid        NOT NULL,
  output_hash   text        NOT NULL,
  census_hash   text        NOT NULL,
  base_sha      text        NOT NULL,
  agent_id      text        NOT NULL,
  prompt_sha256 text        NOT NULL,
  model         text        NOT NULL,
  output        jsonb       NOT NULL,
  proposed_at   timestamptz NOT NULL,
  event_gseq    bigint      NOT NULL,
  PRIMARY KEY (s0_id, output_hash)
);
CREATE INDEX onboarding_proposal_s0_idx ON core.onboarding_proposal (s0_id, event_gseq);
GRANT SELECT, INSERT, UPDATE, DELETE ON core.onboarding_proposal TO aisdlc_app;
