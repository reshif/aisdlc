-- The browser edge (PLAN M4.5): server-side sessions, pending OIDC transactions and step-up
-- proofs. Nothing here is a read model of the record: it is the bff's own state. Losing it logs
-- everyone out and voids pending step-ups; it cannot change who may do what.
--
-- Every secret the browser holds is stored here only as a hash (the session id, the login binder).
-- All times are written by the application from its clock, never `now()`, so expiry is testable.

CREATE SCHEMA bff;

DO $$
BEGIN
  CREATE ROLE aisdlc_app NOLOGIN;
EXCEPTION WHEN duplicate_object OR unique_violation THEN
  NULL;
END
$$;
GRANT USAGE ON SCHEMA bff TO aisdlc_app;

-- One row per started sign-in or step-up. `state_hash` is sha256 of the OIDC `state`; the
-- `binder_hash` ties the callback to the browser that started it (login CSRF). Consumed once.
CREATE TABLE bff.oidc_attempt (
  attempt_id     uuid        PRIMARY KEY,
  state_hash     text        NOT NULL UNIQUE,
  purpose        text        NOT NULL CHECK (purpose IN ('login', 'step_up')),
  nonce          text        NOT NULL,
  code_verifier  text        NOT NULL,
  binder_hash    text        NOT NULL,
  return_to      text        NOT NULL,
  -- step_up only: the session it belongs to, the hash it binds, and the proof it produced
  session_hash   text,
  bound_hash     text,
  proof_id       uuid,
  -- the signed proof, held only until the session that started the step-up collects it once
  proof_token    text,
  proof_delivered_at timestamptz,
  created_at     timestamptz NOT NULL,
  expires_at     timestamptz NOT NULL,
  consumed_at    timestamptz,
  CHECK (purpose = 'login' OR (session_hash IS NOT NULL AND bound_hash IS NOT NULL))
);

-- A browser session. The cookie carries the opaque id; only its sha256 is stored. The IdP's
-- tokens are never sent to the browser; the ID token is kept here for a later logout hint.
CREATE TABLE bff.session (
  id_hash              text        PRIMARY KEY,
  principal_id         text        NOT NULL,
  issuer               text        NOT NULL,
  subject              text        NOT NULL,
  auth_time            timestamptz,
  id_token             text,
  csrf_token           text        NOT NULL,
  created_at           timestamptz NOT NULL,
  last_seen_at         timestamptz NOT NULL,
  absolute_expires_at  timestamptz NOT NULL,
  revoked_at           timestamptz,
  revoke_reason        text
);
CREATE INDEX session_principal ON bff.session (principal_id) WHERE revoked_at IS NULL;

-- Step-up proofs as issued. The signed proof proves who issued it; this row is what makes it
-- single-use: consuming it is an UPDATE that succeeds once. A proof with no row here is unknown.
CREATE TABLE bff.step_up_proof (
  proof_id     uuid        PRIMARY KEY,
  principal_id text        NOT NULL,
  bound_hash   text        NOT NULL,
  method       text        NOT NULL CHECK (method IN ('reauth', 'reconfirm')),
  auth_time    timestamptz NOT NULL,
  issued_at    timestamptz NOT NULL,
  expires_at   timestamptz NOT NULL,
  consumed_at  timestamptz
);

GRANT SELECT, INSERT, UPDATE, DELETE ON bff.oidc_attempt, bff.session, bff.step_up_proof TO aisdlc_app;
