-- Core: the onboarding console's proposals carry the census head they were made at and, once a person has decided, the
-- value that stands (theirs when they edited it). Both are folds of the `onboarding_session.proposal_*` events; the
-- columns are nullable so the fold of the older events stays valid. Needs 0026_onboarding_console.

ALTER TABLE core.console_proposal ADD COLUMN census_hash   text;
ALTER TABLE core.console_proposal ADD COLUMN decided_value jsonb;
