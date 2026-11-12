-- Gate subjects (PLAN M14.5): `merge`, the subject of the X4 post-hoc review of a merge that gate-check observed
-- without `aisdlc/gate` passing (a bypass merge, DEC-10 as refined), whose id is the merge's (`mergeSubjectId`). The
-- constraint also gets `breaker`, the subject of the R3 reset (M5, PLAN M9.5), which the contracts' `SubjectKind`
-- has had since then and 0002 did not list.
ALTER TABLE decisions.gate_instance DROP CONSTRAINT gate_instance_subject_kind_check;
ALTER TABLE decisions.gate_instance
  ADD CONSTRAINT gate_instance_subject_kind_check
  CHECK (subject_kind IN ('item', 's0_record', 'config', 'breaker', 'merge'));
