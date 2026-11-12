# gate-check: the check run `aisdlc/gate`, its App, and bypass merges (M14.5)

gate-check (`services/gate-check`; ADR-0003 §1 Integration plane, AR9 gate plane) writes ONE thing on the code host: the check run `aisdlc/gate` on the head commit of every open pull request of a registered repo, through its OWN GitHub App. Branch protection requires that check, pinned to gate-check's App id (onboarding-roadmap LF2). gate-check never merges, approves, reviews or changes a rule: a person merges (FL 8.2, D11). Its vocabulary is `packages/contracts/src/entities/gate-check.ts`, the source of truth for every shape below.

## 1. Credentials and reach

| What | Holder | Can | Cannot |
|---|---|---|---|
| gate-check's App (key `GATE_CHECK_APP_KEY_REF`, a `file:` reference) | gate-check only | one installation token with exactly `checks: write`, `pull_requests: read`, `metadata: read` (`GATE_CHECK_APP_PERMISSIONS`); a token that comes back with more is discarded | push, open or edit a PR, merge, review, statuses, administration |
| the codehost's App (the Push Broker) | codehost only | `agent/*` branches and draft PRs (M13.6) | write a check run: its port has no such method, and its installation holds no `checks` permission |
| the bypass people (`codehost.merge_bypass`) | named humans | merge a PR whose `aisdlc/gate` did not pass (on GitHub, as a bypass actor) | be an App: the schema takes GitHub user logins only (`name[bot]`, `app/x` are refused) |

The port is `GateCheckHostPort` (`packages/ports/src/gate-check-host.ts`): `list_pulls`, `pull_commits`, `branch_head`, `check_runs`, `write_check_run`. No method name contains a forbidden verb (compile-time and test). Implementations: `FakeGitHub.asApp(app)` (the in-memory fake, which models each App's permissions on one shared host) and `GitHubChecksHost` (`services/gate-check/src/github.ts`), the seven requests it can make: the token mint, `GET /repos/{r}/pulls?state=`, `GET /repos/{r}/pulls/{n}` (a merged PR's `merged_by`), `GET /repos/{r}/pulls/{n}/commits`, `GET /repos/{r}/branches/{b}` (the watch start's head), `GET /repos/{r}/commits/{sha}/check-runs?check_name=`, `POST /repos/{r}/check-runs`. The base URL is https, or plain http to loopback or a host the deployment names (`GATE_CHECK_GITHUB_PLAIN_HTTP_HOSTS`: the compose fake). Redirects are never followed; no log line carries a header, a body or the token. Both run the same contract suite (`gateCheckHostContract`).

gate-check has no route to core (AR9): it reads the record database as its own least-privilege role `gate_check` (group `aisdlc_gatecheck`, the migration `services/gate-check/migrations/0001_gatecheck.sql`): its own tables and `gatecheck:` record streams (row-level security), `gate:` streams (read: the G3 instance of an item), each item's `item.created` (read: its pinned profile and tier), `ledger.ledger_entry` (read: gate status is a fold of ledger decisions, never a projection), `config.genuine_publish` (read: the bypass list), `core.repo`, `core.pull_request`, `core.push_receipt`, `core.evidence_pack` (read). A database read is chosen over a core API so that a core outage cannot answer for the gate plane, and so no core write or command path is reachable from it. It reads the signed packs from the object store and the Notary's PUBLIC key from kms-local (a caller with no key) or a pinned public JWK (`GATE_CHECK_NOTARY_KEY_REF`).

## 2. Agent PR or not

A PR is an **agent PR** when all three hold: its author is the Push Broker's bot (`GATE_CHECK_PUSH_BROKER_LOGIN`, type `Bot`); `core.pull_request` has that repo and number (recorded from the Push Broker's receipt); and its branch is that row's, exactly `agent/<item>/<unit>` (`badPushBranch`). A PR the bot authored that core never recorded is `failure: unknown_agent_pr`. Every other PR is a **non-agent PR**.

## 3. The verdict (profiles)

| Profile | When | `success` only if | Otherwise |
|---|---|---|---|
| `agent` | an agent PR | the item's newest pack for this Unit is for exactly the PR head and passing; its bytes verify OFFLINE (`checkSignedEvidencePack`: canonical, object key, pack hash, the Notary's signature under the public key, head, item); the pack binds this repo, this Unit and the Push Broker's receipt for this PR and head; and, when the item's route has G3, the item's newest G3 (from its `gate.opened` events) is decided `approve` (folded from the ledger) and is the G3 the pack carries (`passed`; a route without G3 is `passed_no_g3`) | `failure`: `no_pack`, `pack_not_passing`, `head_moved` (a new push: the old pass no longer applies), `pack_invalid`, `g3_missing`, `g3_pending`, `g3_not_approved`, `g3_changed`; `pending` when the pinned catalogue or the item's pin cannot be read |
| `s0` | the repo's onboarding level is `none` (S0) | never | `action_required: s0_onboarding` (the factory's evidence does not apply; an S0 pack PR waits for the X2 path, DEC-13(i)); laundering is `failure` |
| `non_agent` | any other PR | never | `failure` for laundering (§4), else `action_required: not_factory_work` (a person reviews; only a named bypass person may merge it) |

**Whether the route has G3** is the engine's own rule, never a lane list: `presentGates(lane, effectiveProfile(profile, tier))` (`@aisdlc/work`) over the pack's lane in its PINNED catalogue (`catalogueFor(pack.catalogue_ref)`, hash checked), under the gating profile and tier the item pinned at intake (its `item.created`, the one item event the role may read; its hash must be the pack's signed `profile_sha256`, else `pack_invalid`). L8 (DEC-10(a): the human's change pushed by the factory as an `agent/*` PR) comes out of the same rule: its route has no G3. A lane or project profile with G3 switched off likewise needs none ("off means absent"). A catalogue this build does not carry, a hash mismatch or a missing pin is `pending`.

Fail closed: the record, the object store, the Notary key or a PR's commit list not answering is `pending` (`in_progress`, reason `dependency_unavailable`), never `success`. The code host not answering writes nothing. `neutral` and `skipped` are never written (GitHub counts both as passing a required check).

A check run belongs to a COMMIT. When several open PRs share a head, the run written on it is the strictest of their verdicts (failure > pending > action_required > success): a PR that borrows an agent's head turns that head's run into its laundering failure and never inherits the pass. A head is written again when any of its PRs' verdicts, or the strictest of them, changed since it was recorded.

## 4. Laundering (DEC-13(a))

A non-agent PR fails with:

- `laundering_agent_branch`: its branch is under `agent/` (the Push Broker's namespace);
- `laundering_agent_head`: its head, or any of its commits, is a head the Push Broker wrote (`core.push_receipt`, applied);
- `laundering_pack_cited`: its title or body names a pack id or a pack's object key (64-hex tokens looked up in `core.evidence_pack`, any case), or the pack format marker;
- `laundering_trailer`: its commits, title or body carry the factory's commit trailers (`Aisdlc-Item:` and kin) or the Push Broker's PR marker.

## 5. Merges, bypass and X4

**The watch start.** The first time gate-check looks at a repo's merges it records `gatecheck.repo_watched` on the repo's stream `gatecheck:<owner/name>` (the time and the default branch's head then; once per repo; folded into `gatecheck.repo_watch`). A merge whose `merged_at` is at or before it is recorded as `pre_watch` (`gatecheck.pre_watch_merge`): never classed, never reviewed (gate-check could not have checked it). A merge with no `merged_at` counts as after (fail closed).

Every other merged PR of a registered repo is classed once (its id `mergeSubjectId(repo, number, head)`):

- `gated`: gate-check's OWN App's newest `aisdlc/gate` on the merged head was `success`, and gate-check's record for that PR at that head says `success`;
- `bypass`: not gated, and the merger's login is on the repo's list `codehost.merge_bypass` (factory layer, M1-gated, default `{}`; `{"owner/name": [{login, principal_id}]}`, at most 10 per repo, logins compared without case);
- `unauthorised`: not gated and the merger is not on the list (or the list cannot be read: nobody is on it).

Each is a record event on the PR's stream (`gatecheck.merge_gated`, `gatecheck.bypass_merge`, `gatecheck.unauthorised_merge`). Core's loop `gatecheck_merges` (core-worker, `services/core/src/merge-review.ts`) reads the bypass and unauthorised ones after its cursor and opens an **X4** card for each through the decision kernel: subject kind `merge` (subject id the merge id), the subject hash binding the whole payload, slot `x`, a card of its own; the bypass person is the requester, so the SoD rule keeps them from reviewing their own bypass. An unauthorised merge's card carries `security: true`: protect-main was not effective for it (the spec's posture rules make that a security matter: onboarding-roadmap §8 "rules weakened ... PRR suspended" and the residual risk "a bypass actor added without weakening any rule is invisible"). Suspending the PRR on an unauthorised merge is not automatic yet: it is a person's call on the X4 card (a follow-up of M14.5). M15.2: core's 8.2 reconcile (`merge_reconcile`, `services/core/src/review/merge.ts`) also opens X4 for an agent PR merged without an approved G4 for its head; both observers open through `openMergeX4Once`, so one merge (repo, PR and merged head, or repo, PR and merge commit) has one X4, whoever saw it first.

Changing the list is an M1 config revision like any other: a proposed list is not in force until its M1 decision is approved and published.

## 6. Record and read models

| Event (stream `gatecheck:<owner/name>#<pr>`) | Payload | Read model |
|---|---|---|
| `gatecheck.verdict_recorded` | `VerdictRecordedPayload`: the verdict, its hash, the hash of the verdict written as the run on that head, the check run id | `gatecheck.verdict` |
| `gatecheck.merge_gated`, `gatecheck.bypass_merge`, `gatecheck.unauthorised_merge`, `gatecheck.pre_watch_merge` | `MergeObservedPayload` | `gatecheck.merge` |
| `gatecheck.repo_watched` (stream `gatecheck:<owner/name>`) | `RepoWatchedPayload` | `gatecheck.repo_watch` |

Both read models are rebuilt from the events alone (`rebuildGateCheck`).

## 7. HTTP

| Route | Credential | Answer |
|---|---|---|
| `GET /healthz` | none | the loops' health (`gate_check_verdicts`, `gate_check_merges`); 503 when one is failing or stalled |
| `GET /metrics` | none | Prometheus text of the loops |
| `GET /v1/verdicts?item=` or `?repo=&pr=` | service token, scope `read` | `{verdicts: [{seq, verdict, verdict_sha256, check_run_id, recorded_at}]}`, newest first (the portal's gate-check run status, M14.6) |
| `GET /v1/merges?repo=` | scope `read` | `{merges: [MergeObservedPayload]}` |

Nothing on the API writes or decides. `GATE_CHECK_CALLERS` is `{caller: {token_ref, scopes: ["read"]}}`.

## 8. Configuration

`GATE_CHECK_DATABASE_URL`, `GATE_CHECK_CALLERS`, `GATE_CHECK_APP_ID`, `GATE_CHECK_INSTALLATION_ID`, `GATE_CHECK_APP_KEY_REF`, `GATE_CHECK_GITHUB_API_URL` (default `https://api.github.com`), `GATE_CHECK_GITHUB_PLAIN_HTTP_HOSTS`, `GATE_CHECK_PUSH_BROKER_LOGIN`, `GATE_CHECK_OBJECT_STORE_URL` with `_ACCESS_KEY_REF` and `_SECRET_KEY_REF`, `GATE_CHECK_NOTARY_KEY_REF` or `KMS_URL` with `KMS_TOKEN_REF`, `GATE_CHECK_VERDICT_INTERVAL_MS` (15000), `GATE_CHECK_MERGE_INTERVAL_MS` (60000), `GATE_CHECK_CONFIG_RELOAD_MS` (5000), `GATE_CHECK_HOST`, `GATE_CHECK_PORT` (8450). Compose: profile `gate-check` (`platform/compose/README.md`).
