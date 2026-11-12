-- M17 part 2: deciding a re-onboarding proposal (OB §8: "Accept -> S0 from 0.1 -> new version -> M4"). A person of the
-- project's admin slot accepts or declines; `reonboard.decided` on `reonboard:<repo>` (with its `reonboard.decided`
-- ledger entry) folds into the proposal's row: its status and the decision. Rebuilt from the events alone
-- (`rebuildKnowledgeDefects`).

ALTER TABLE core.reonboard_proposal DROP CONSTRAINT reonboard_proposal_status_check;
ALTER TABLE core.reonboard_proposal
  ADD CONSTRAINT reonboard_proposal_status_check CHECK (status IN ('proposed', 'accepted', 'declined'));
ALTER TABLE core.reonboard_proposal ADD COLUMN decision jsonb;
