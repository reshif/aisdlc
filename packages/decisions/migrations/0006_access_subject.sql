-- Gate subjects (portal-review P1-6): `access`, the subject of the M1 gate that decides a role-binding grant or revoke
-- (or an access request); its id is the grant's id and its subject hash the proposal's.
ALTER TABLE decisions.gate_instance DROP CONSTRAINT gate_instance_subject_kind_check;
ALTER TABLE decisions.gate_instance
  ADD CONSTRAINT gate_instance_subject_kind_check
  CHECK (subject_kind IN ('item', 's0_record', 'config', 'breaker', 'merge', 'learn', 'access'));
