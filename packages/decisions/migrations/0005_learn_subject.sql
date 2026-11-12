-- Gate subjects (PLAN M15.5): `learn`, the subject of a 9.4 Learn proposal's META gate (M1, M2, M3, M5, M6), whose id is
-- the proposal's (`learnSubjectId`) and whose subject hash is the proposal id.
ALTER TABLE decisions.gate_instance DROP CONSTRAINT gate_instance_subject_kind_check;
ALTER TABLE decisions.gate_instance
  ADD CONSTRAINT gate_instance_subject_kind_check
  CHECK (subject_kind IN ('item', 's0_record', 'config', 'breaker', 'merge', 'learn'));
