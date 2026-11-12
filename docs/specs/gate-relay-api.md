# gate-relay: G5 release, DeployMarker, RELHOLD and B16 (M15.3)

gate-relay (`services/gate-relay`; ADR-0003 §1 Integration plane "gate-relay: G5 release, deploy markers, RELHOLD", AR9 gate plane) writes ONE kind of thing on the code host: a deployment (GitHub's Deployments API) of a merged commit to the project's release target, through its OWN GitHub App. It does so only for an approved G5 whose card binds that merged commit to the Evidence Pack's head, once per G5 instance. It never merges, approves, reviews, writes a deployment status or changes an environment: a person merges (FL 8.2), the deploy system reports. Its vocabulary is `packages/contracts/src/entities/gate-relay.ts`, the source of truth for every shape below.

## 1. Credentials and reach

| What | Holder | Can | Cannot |
| --- | --- | --- | --- |
| gate-relay's App (key `GATE_RELAY_APP_KEY_REF`, a `file:` reference) | gate-relay only | one installation token with exactly `deployments: write`, `metadata: read` (`GATE_RELAY_APP_PERMISSIONS`); a token that comes back with more is discarded | push, open or edit a PR, merge, review, check runs, statuses, environments, administration |
| the codehost's App (the Push Broker) | codehost only | `agent/*` branches and draft PRs (M13.6) | create a deployment: its port has no such method, and its installation holds no `deployments` permission |
| gate-check's App | gate-check only | the check run `aisdlc/gate` (M14.5) | create a deployment: likewise |

The port is `GateRelayHostPort` (`packages/ports/src/gate-relay-host.ts`): `list_deployments` (a commit's deployments to an environment), `create_deployment`, `deployment_statuses`. No method name contains a forbidden verb (compile-time and test); `badDeploymentCreate` (the ref is a 40-hex commit, never a branch; a valid environment; a tag) runs before any request. Implementations: `FakeGitHub.asDeployApp(app)` (the in-memory fake; `setDeploymentStatus` is the deploy system in tests) and `GitHubDeploymentsHost` (`services/gate-relay/src/github.ts`): the token mint, `GET /repos/{r}/deployments?sha=&environment=`, `POST /repos/{r}/deployments` (ref = the sha, `auto_merge: false`, the tag as `payload`), `GET /repos/{r}/deployments/{id}/statuses`. The in-repo fake GitHub HTTP server knows a third App (`deployApp`). Both run the same contract suite (`gateRelayHostContract`), which also shows the Push Broker's and gate-check's credentials are refused.

gate-relay has no route to core (AR9): it reads the record database as its own least-privilege role `gate_relay` (group `aisdlc_gaterelay`, the migration `services/gate-relay/migrations/0001_gaterelay.sql`): its own tables and `gaterelay:` record streams (row-level security), `gate:` streams (read: the G5 instance and its card), `ledger.ledger_entry` (read: G5's status is a fold of ledger decisions), `config.genuine_publish` (read: `project.release`), `core.evidence_pack` (read: where the bound pack is) and `gatecheck.merge` (read: gate-check's record of the merge). No item stream, no other core table. It reads the signed packs from the object store and the Notary's PUBLIC key from kms-local (a caller with no key) or a pinned public JWK (`GATE_RELAY_NOTARY_KEY_REF`).

## 2. The release setting

`project.release` (project layer, M1-gated, registered by `registerReleaseConfig`): `{"mode": "off"}`, `{"mode": "target", "environment": "<GitHub environment>"}`, or `null` (default: not chosen). It is set with the project's settings (`PUT /v1/projects/:id/settings` takes `release`; a settings change keeps it), like every revision an M1 decision before it is in force.

At intake the item pins its gating profile with it (`applyReleaseSetting`): `off` turns G5 off in every lane and says the project does not deploy (so the T2 floor does not put G5 back): the route has no G5, S8b releases nothing and the item goes on to S9. A target says it deploys (the T2 floor keeps G5 on). Not chosen leaves the readiness record's profile, and nothing is released (unknown is not released).

## 3. The G5 card binds the release (core)

When the engine opens G5, core's work driver binds the card (`releaseBindingOf`, `services/core/src/release/binding.ts`): the merged commit of the item's newest `item.merge_observed`, the item's newest PASSING Evidence Pack, the PR the Push Broker opened for that pack's Unit (its head must be the pack's head), and the target in force. `ReleaseBinding` rides in the card's facts (`facts.release`, beside the engine's own subject hash in `facts.engine_subject_hash`) and the gate's subject hash is `g5SubjectHash(engine, binding)`: an approval is an approval of exactly this merged commit to exactly this environment. What core cannot bind is opened `unbound` with the reason (`no_merge_observed`, `no_passing_pack`, `no_pull_request`, `pack_head_not_pr_head`, `no_release_target`): the card says so and an approval of it releases nothing. G5 is decided by the `g5` slot with step-up (`GATE_POLICIES`), through the decision kernel like every gate.

## 4. Consuming an approved G5 exactly once

Loop `gate_relay_consume`: every item's NEWEST G5 instance that is not answered yet (no refusal, no release marker). Pending waits; a denied, expired or superseded instance is never released. A decided `approve` is checked again here, all of it:

| Check | Refusal |
| --- | --- |
| the subject hash is `g5SubjectHash` of the card's binding and engine hash; the binding names the gate's item and project | `subject_mismatch` |
| the gate wanted a step-up | `no_step_up` |
| the binding is `bound` | `unbound` |
| the project's `project.release` is a target, and that environment, now | `target_changed` |
| gate-check recorded a `gated` merge of the bound PR at the pack's head whose merge commit IS the merged commit (`gatecheck.merge`): the merged content is the evidence's content | `merged_content_mismatch` |
| the pack row is the passing pack of the bound head and item; its bytes verify OFFLINE (`checkSignedEvidencePack`, the Notary's public key) and bind this repo | `pack_invalid` |
| the host accepts the deployment | `host_refused` |

A refusal is a `gaterelay.release_refused` event: final for that instance (core's S8b then holds the release: RELHOLD; a re-request is a new G5). A dependency that does not answer (the Notary key, the object store, the host) is a retry: nothing is recorded as refused and nothing is released (unknown is not released).

Record-first and exactly once: `gaterelay.release_intended` is recorded before the host is asked; then the host is asked for a deployment of that commit to that environment already tagged with this G5 (a crash between the host and the record finds it and records it, never a second one); else ONE is created with the tag `{aisdlc: {item_id, gate_instance_id, kind, binding_sha256}}`. Then the DeployMarker: `gaterelay.deployment_created` (`DeployMarker`: marker id `deployMarkerId(gate, kind)`, kind, item, project, repo (DM `service`), environment, merged commit (DM `digest`), pack, gate, binding hash, deployment id, rollback_of). One marker per G5 instance and kind (unique in the read model and by idempotency key).

## 5. Health and B16

Loop `gate_relay_health`: every marker with no verdict. The newest status the deploy system wrote decides (`healthOf`): `success` is `gaterelay.deploy_healthy`; `failure` or `error` is `gaterelay.deploy_unhealthy`; anything else (none, pending, queued, in progress, a state this build does not know) is no verdict yet. The first verdict is final. An unhealthy RELEASE is rolled back (B16): a deployment of the environment's last healthy release's merged commit, tagged `rollback`, with its own marker (`rollback_of` the unhealthy one); with no earlier healthy release there is nothing to roll back to (`rollback_marker_id: null`).

## 6. S8b in core (`GateRelayReleasePort`)

With `CORE_WORKER_RELEASE=gate-relay`, the release stage port reads `gaterelay:<item>` (`foldReleaseStatus`) for the item's newest G5 (decided approve in the ledger):

| gate-relay's record | S8b |
| --- | --- |
| release `off` | completed (nothing to release) |
| not chosen or unreadable | failed `not_released:no_target` |
| no approved G5 | failed `not_released:no_g5` |
| none, intended, deployed with no verdict | deferred (the command waits, uncounted, never dead-lettered) |
| refused | failed `not_released:<refusal>` |
| healthy | completed, the output hash the DeployMarker's |
| unhealthy | B16: `item.spawn_requested` (kind `rollback`, lane L0: a NEW linked item), then failed `not_released:rolled_back` |

The engine takes an S8b failure `not_released:*` as RELEASE HELD (`release_held`: merged, not deployed), the same state as a denied G5 (B26). Its exits: `POST /v1/items/:id/release/re-request` (`{on_behalf_of, key}`; scope `work`, PDP `item.release`: the `g5` slot or the project admin) opens G5 again on a new instance; "needs change" is a NEW linked item (B26 `release_change`).

## 7. Record and read models

| Event (stream `gaterelay:<item>`) | Payload | Read model |
| --- | --- | --- |
| `gaterelay.release_intended` | `ReleaseIntendedPayload` | `gaterelay.intent` |
| `gaterelay.release_refused` | `ReleaseRefusedPayload` | `gaterelay.refusal` |
| `gaterelay.deployment_created` | `DeployMarker` | `gaterelay.deploy_marker` |
| `gaterelay.deploy_healthy`, `gaterelay.deploy_unhealthy` | `DeployHealthPayload` | `gaterelay.deploy_health` |

Every table is append-only (INSERT only for the role) and rebuilt from the events alone (`rebuildGateRelay`).

## 8. HTTP

| Route | Credential | Answer |
| --- | --- | --- |
| `GET /healthz` | none | the loops' health (`gate_relay_consume`, `gate_relay_health`); 503 when one is failing or stalled |
| `GET /metrics` | none | Prometheus text of the loops |
| `GET /v1/releases?item=` | service token, scope `read` | `{markers: [DeployMarker], health: [{marker_id, health, state}], refusals: [{gate_instance_id, reason, detail}]}` |

Nothing on the API writes, decides or deploys. `GATE_RELAY_CALLERS` is `{caller: {token_ref, scopes: ["read"]}}`.

## 9. Configuration

`GATE_RELAY_DATABASE_URL`, `GATE_RELAY_CALLERS`, `GATE_RELAY_APP_ID`, `GATE_RELAY_INSTALLATION_ID`, `GATE_RELAY_APP_KEY_REF`, `GATE_RELAY_GITHUB_API_URL` (default `https://api.github.com`), `GATE_RELAY_GITHUB_PLAIN_HTTP_HOSTS`, `GATE_RELAY_OBJECT_STORE_URL` with `_ACCESS_KEY_REF` and `_SECRET_KEY_REF`, `GATE_RELAY_NOTARY_KEY_REF` or `KMS_URL` with `KMS_TOKEN_REF`, `GATE_RELAY_CONSUME_INTERVAL_MS` (15000), `GATE_RELAY_HEALTH_INTERVAL_MS` (30000), `GATE_RELAY_HOST`, `GATE_RELAY_PORT` (8470). Compose: profile `gate-relay` (`platform/compose/README.md`).

## 10. Not yet

- Card 4 of onboarding does not ask for the release choice yet: it is set with the project's settings (an M1 revision). A card-4 revision written after it does not carry it over.
- One gate-relay process: two at once could both create a deployment between the host lookup and the create (the tag makes the duplicate visible; a lock is not taken).
- The bff and portal do not show `/v1/releases` or offer the re-request button yet.
