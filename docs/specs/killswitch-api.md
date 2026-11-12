# Kill switch: HTTP contract (M9.6, RC-SEC-3)

The kill switch (`services/killswitch`, AR9) stops agent work by scope (fleet, project, lane, session) and lifts a stop only on release. It has its own database, its own key (`dev:killswitch`) and its own signed, hash-chained journal; it imports nothing of core, the work engine, the record, the ledger or the bff, and it calls nothing but key custody. Who may do what is decided by the same Cedar policies as everywhere (`kill.request`, `kill.release`, `project.settings.edit`, the fleet rule), evaluated in process over the kill switch's own facts (`KillswitchEntities`: its factory admins, the holders core-worker pushes, its delegations). Shapes are contracts' (`packages/contracts/src/entities/controls.ts`).

## 1. Credentials: a process, and a person

| Who | Credential | Scopes | Opens |
|---|---|---|---|
| a process that carries a person's act (operator client; the bff once it has kill routes) | service token (`Authorization: Bearer`) | `act`, `read` | `POST /v1/kills`, `POST /v1/kills/:id/release`, `POST /v1/delegations`, `POST /v1/delegations/:id/revoke`, the reads |
| core-worker | service token | `read`, `sync` | `PUT /v1/holders/:project`, `GET /v1/events`, the reads |
| enforcement points (core-worker's work driver, the gateway) | service token | `read` | `GET /v1/status` |
| anyone | none | | `GET /healthz` |

`KILLSWITCH_CALLERS` is `{caller: {token_ref, scopes}}`. A missing or unknown token is `401 unauthenticated`; a scope the caller lacks is `403 forbidden`.

**A service token never says who acts.** Every act (§2) carries `step_up: {proof}`: the acting person's step-up proof (`su1.<claims>.<signature>`, `StepUpClaims`, `packages/ports/src/step-up-proof.ts`) that the bff issued after that person authenticated again at the identity provider (`POST /api/step-up` with the act's hash, then `GET /api/step-up/:id`). The kill switch verifies it itself, in `PersonVerifier` (`services/killswitch/src/person.ts`):

1. well-formed, and signed by the bff's step-up key (`dev:bff-stepup`), whose PUBLIC key the kill switch reads from key custody once, at start (it does not start without it, so a kill never waits for the KMS afterwards);
2. not expired (proofs live 300 s), not issued in the future (30 s skew);
3. method `reauth`: a DEC-11(c-ii) `reconfirm` proof is refused here;
4. `bound_hash` equals `killActHash(act)` for exactly this request: `sha256(RFC 8785 JSON of {domain: "aisdlc/kill-act/1", action, ...fields})`, the fields as the body carries them (§2). A proof for another act, another kill, another reason or another delegate is refused, and a kill-act hash can never equal a gate's subject hash;
5. never used here before: its `proof_id` goes into `killswitch.person_proof` (append-only, the kill switch's own single-use ledger) before the act is decided, so a refused act burns it.

Any failure is `401 unauthenticated` and nothing is done. The actor of the act, in the journal and for the PDP, is the proof's principal. A body that names someone (`on_behalf_of`) is malformed (`400`). So one token holder with one person's proofs is one person: the second approval of a two-person release needs a second person's proof, which needs that person's own sign-in. Distinctness is then the release rule's (§3), and authority is the PDP's over the proof's principal.

The reads (`GET /v1/capabilities?on_behalf_of=`) still take a name: they change nothing and only say what that person could do.

## 2. Acts

| Route | Body | `KillAct` the proof binds |
|---|---|---|
| `POST /v1/kills` | `{step_up, scope, reason}` | `{action: "kill.request", scope, reason}` |
| `POST /v1/kills/:id/release` | `{step_up}` | `{action: "kill.release", kill_id}` |
| `POST /v1/delegations` | `{step_up, delegate, scope}` | `{action: "kill.delegate", delegate, scope}` |
| `POST /v1/delegations/:id/revoke` | `{step_up}` | `{action: "kill.revoke", delegation_id}` |

`KillswitchClient` (`services/killswitch/src/client.ts`) takes the proof as each act's first argument. In tests `startTestKillswitch(...).clientFor(caller)` mints a proof per call with the fake custody's bff key (`mintTestStepUpProof`), and `prove(principal, act)` gives one to send by hand; the compose smoke test stands in for a person's sign-in with `platform/compose/kill-proof.mjs`, run inside the bff container (the only caller kms-local lets use the step-up key).

## 3. Release

A release is one `KillReleaseApproval` per person. It needs the number of distinct people the project's two-person setting says, counted when the approval is made: two where the setting is on, always two on T2, always two for the fleet (two factory admins), and two for a project the kill switch has never been told about. The same principal approving twice is `409 conflict`. Until the count is reached the kill is `release_pending` and still kills. A release, a delegation and a holder sync widen rights, so they need the journal signature and are refused while the KMS is down; a kill does not wait for it (it is journaled `pending_signature` and attested later).

## 4. Errors

`{"error": {"code", "message", "reasons"?}}`: `invalid_request 400`, `unauthenticated 401` (service token, or the person's proof), `forbidden 403` (scope, or the PDP: `reasons` are its reasons), `not_found 404`, `conflict 409`, `unavailable 503`.

## 5. Not covered here

The bff carries no kill routes yet (RC-UI-1): an operator obtains the step-up proof from the bff and calls the kill switch with the operator client. Key custody is kms-local (RC-SEC-1); in production the bff's step-up key and the kill switch's journal key are KMS keys in separate accounts.
