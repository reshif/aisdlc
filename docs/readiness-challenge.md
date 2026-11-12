# Production-readiness challenge

Status: 2026-11-12. Reviewed at `origin/main` `2e1861f` (M19 part 3 merged). Written by an independent reviewer who did not
build any of it. This file changes no product code. It lists what the builder must answer, prove or fix before a real team
uses the factory for real work. Every item names the evidence that would settle it. "Partly answered" points at what the
reviewer already found, with file and line at `2e1861f`.

## How to read it

- **Severity.** BLOCKER: cannot hand off. HIGH: must be fixed soon after handoff (or before, if the team's first use depends on
  it). MEDIUM: should be fixed, a known risk until then. LOW: worth doing.
- **"Show me".** Prefer a run, a test or a screen that a person other than the builder can repeat. A sentence in a plan is not
  evidence.
- **Ids** are `RC-<area>-<n>`. Areas: E2E (the core promise), HAI (human and agent), CFG (configuration), NOT (notifications),
  TRC (traceability), SEC (security), OPS (reliability and operations), DATA (data integrity), UI (portal), LIVE (real-world
  gaps and owner actions), PROC (process).

## What the reviewer ran

| Run | Result |
|---|---|
| `npm ci` | ok (10 moderate advisories, dev-only: `minimatch`) |
| `npm run typecheck` | ok, 47 workspaces in 4 programs |
| `npm run build` | ok |
| `npx vitest run --project ledger --project killswitch --project catalogue` | 14 files, 139 passed, 1 skipped (the catalogue snapshot writer) |
| `npm run smoke:compose` (own project and subnet `10.235`), twice | **failed** at `up -d --wait`: `docker-proxy-coding` unhealthy (§12) |
| Full `npm run check`, `e2e:compose` | not run here: another session was using the CPU, and no Chromium is installed. The builder should attach a fresh run of both to the answers |

---

## 1. The core promise end to end (E2E)

The claim: a person submits a request in the portal and gets a real PR, reviewed and merged by a human, released and closed,
with every gate decided by the right person. The reviewer's reading: **no part of that path has run end to end on any
deployment, with or without fakes, and several of its steps have no portal surface at all.**

### RC-E2E-1 — A person cannot submit a work request in the portal
- **Challenge.** Show the screen where a requester types a request and submits it. Show it in a browser e2e.
- **Why it matters.** It is the first step of the product. Without it every item is created by someone with an API client.
- **Evidence that settles it.** A web route with the form, `api.ts` calling `POST /api/requests`, and the compose e2e creating
  its items through that form instead of `context.request.post`.
- **Severity.** BLOCKER.
- **Found.** The bff route exists (`services/bff/src/portal.ts:290`), the web client never calls it (`services/web/src/api.ts`
  has no `/api/requests`), and the compose e2e posts the request with Playwright's API client
  (`platform/compose/e2e-portal.mjs:436`, `:709`). "Ask the factory" offers an `ask_for_work` button
  (`services/core/src/conversation/assistant.ts:216`) that navigates to `/projects/:id`, a page with no request form. PLAN
  M13.1's follow-up ("a portal Ask for work form ... belongs with the Conversation milestone") is still open after M18 merged.

### RC-E2E-2 — The deployed stack cannot produce a pull request
- **Challenge.** Name the compose configuration in which a request goes S1 → S7 with the real kits, a Draft PR appears on the
  (fake or real) GitHub, a person approves G4, merges, S8b releases, G6 accepts and the item closes. Run it and show the record,
  the ledger (`verify-ledger`) and the PR.
- **Why it matters.** Every stage after S5 has only been exercised in-process. The wiring between services (tokens, scopes,
  networks, env flags) is where a distributed system breaks, and none of it is proven for S6 to S9.
- **Evidence.** One documented profile (or the default) with the push-mode codehost, the sandbox-controller, verify, the object
  store, gate-check and gate-relay all wired, and an e2e that ends in `Done` with a merged PR.
- **Severity.** BLOCKER.
- **Found.** `docker-compose.yml` has no codehost instance in `CODEHOST_MODE=push` (the Push Broker), and sets none of
  `CORE_WORKER_PUSH_BROKER`, `CORE_WORKER_SESSION_STORE`, `CORE_WORKER_CODER_MODEL`, `CORE_WORKER_RELEASE` (grep count 0).
  `CORE_WORKER_STAGE_PORTS` defaults to `none` (`docker-compose.yml:853`), and `CORE_WORKER_VERIFY_URL` and
  `CORE_WORKER_SANDBOX_CONTROLLER_URL` default to empty, so S6 and S7 stay on the stage-port fakes. PLAN §0 still carries "compose
  wiring of real coding sessions" and "codehost push in registry mode" as open M13 follow-ups. The only request-to-PR run is
  `services/core/test/push.test.ts`, in one process, on the fake GitHub, and it stops at a Draft PR.

### RC-E2E-3 — L8, the only lane most repos get, has no way to carry code
- **Challenge.** On an L8 (human-led) item, where does the human's change enter the factory, what does S7 verify, and which PR
  does G4 review? Show it in the portal.
- **Why it matters.** DEC-10 (refined) says the human never pushes: a human-led change is written on a card or as a patch and
  pushed by the factory as an `agent/*` PR under the L8 profile. If there is no such input, every L8 item either stalls or
  passes S7 on nothing, and the only way to merge is the bypass list, which turns every change into an X4 break-glass review.
- **Evidence.** A portal flow where the developer attaches a patch (or names a commit) for D5, the Push Broker opens the L8 PR,
  S7 runs on that head, and gate-check passes it under the L8 profile.
- **Severity.** BLOCKER.
- **Found.** D5 is `POST /v1/items/:id/human-done` with a body of only `{on_behalf_of, key}`
  (`packages/contracts/src/entities/item-actions.ts:73`): no patch, no commit. The portal has no D5 button (AGENTS.md: "no
  portal button yet"; the e2e posts it by API at `e2e-portal.mjs:619`). No route in core or the bff accepts a human patch.

### RC-E2E-4 — Agent lanes are unreachable for any repo the owner did not write
- **Challenge.** For a real team's repository (not the testbed, not this repo), which lanes can the factory run with agents
  today? Show the decision that allows it.
- **Why it matters.** Light (and so L1–L3) needs the K-exec probe, which needs DEC-18's owner allow-list. DEC-18 allows
  container-class execution only for repos the user owns and says any other repo is re-decided before its code runs. ADR-0002
  accepts container-class isolation only "because the sole operator runs it against their own testbed". So a real team's repo
  reaches Census at most, Census routes everything to L8, and L8 has no code path (RC-E2E-3).
- **Evidence.** The microVM (or equivalent) runner driver behind `SandboxPort`, SEC-OB-3 re-run on it for every class, and DEC-18
  re-decided for third-party repos on that evidence.
- **Severity.** BLOCKER.
- **Found.** `docs/adr/0002-sandbox-container-class.md` §1 and Consequences; PLAN §7a DEC-18 row; no microVM driver in the tree
  (`grep -ri firecracker\|microvm` hits only ADR-0003 and PLAN); `sandbox.exec_allowed_repos` defaults to `[]`.

### RC-E2E-5 — No real model has ever done any of the work
- **Challenge.** Show one recorded run of each agent (A1–A12 and `coder`) through the gateway against Anthropic, on the
  testbed, with its cost, its output validated, and its outcome at the gate.
- **Why it matters.** Every planning and coding result so far is a canned fixture or a scripted fake. The product's value is the
  agents' work; nobody knows whether the prompts, contracts, context budgets and tool allow-lists produce acceptable output, how
  often B3/ET8 retries fire, or what an item costs.
- **Evidence.** Eval baselines per agent on a real provider (`aisdlc-evals baseline`, pass^k), and a live run log.
- **Severity.** BLOCKER.
- **Found.** The local routing table sends D0, D1 and D2 to `fake-model` (`services/core/src/seed.ts:157`); the fake provider
  answers with `fixtures: 'planning'`; the coding-runner tests run "real sessions ... against a fake Messages server"
  (AGENTS.md). No test or doc records a real vendor call. The eval store's key is a placeholder until the owner runs `aisdlc-evals
  pin` (PLAN §0), so no eval has run either.

### RC-E2E-6 — Nothing has run against real GitHub
- **Challenge.** Show the M8.5 live census log, then a live run of each App: the Push Broker writing a branch and a Draft PR,
  gate-check writing `aisdlc/gate`, gate-relay creating a deployment, the tracker creating an issue, and a human merge observed.
- **Why it matters.** The fake GitHub encodes the builder's understanding of GitHub. Real permissions, rate limits, pagination,
  `mergeable_state` timing, check-run semantics and App token scopes differ in ways only a live run finds.
- **Evidence.** The `CODEHOST_LIVE_CONTRACT` suite green against the real App, the same for `gateCheckHostContract` and the
  tracker contract, and a recorded live end-to-end on the testbed.
- **Severity.** BLOCKER.
- **Found.** PLAN §0 "User actions pending: live Census on their machine"; M8.5's acceptance ("Recorded demo and log") and
  M14.5's ("the live run on the testbed once the user has created the App") are unmet;
  `services/codehost/test/contract.test.ts:13-16` skips the live suite unless `CODEHOST_LIVE_CONTRACT` is set.

### RC-E2E-7 — Prove every gate on the route is decided in the browser by the right person
- **Challenge.** For each lane a team will use first (L1–L3, L8), list every gate on its route and show a browser e2e step in
  which the slot holder decides it and a non-holder sees why not.
- **Why it matters.** The e2e decides G0 and G4 "through the same API the screen uses" (`e2e-portal.mjs:590`), not in the
  browser; X3 is covered only by component tests (portal-coverage §3). A screen that renders but cannot be completed is found by
  the first real user.
- **Evidence.** The persona e2e (PLAN M20) for the gate path.
- **Severity.** HIGH.

### RC-E2E-8 — Is `aisdlc/gate` actually required on the protected branch?
- **Challenge.** Show the check, at onboarding and in drift, that the default branch's rules require the `aisdlc/gate` check run
  from gate-check's App (by integration id), and that onboarding refuses or raises a blocker when it does not.
- **Why it matters.** The factory never changes branch protection (principle 8). If the repo admin never makes `aisdlc/gate`
  required, any person with write access merges anything, and gate-check only records it afterwards as an `unauthorised_merge`
  for X4. The whole evidence chain is then advisory.
- **Evidence.** A census blocker or PRR criterion with a test on the fake host and a live read.
- **Severity.** HIGH.
- **Found.** B4 checks only that, if the App has `statuses`, required checks are pinned to an integration
  (`services/knowledge/src/census/blockers.ts:100-105`). The reviewer found no check that names `aisdlc/gate` outside
  gate-check itself.

### RC-E2E-9 — S8b release is fake by default
- **Challenge.** Show G5 and a deployment through gate-relay on a real GitHub environment, a rollback (B16) and a RELHOLD.
- **Why it matters.** "Released" in the close-out record is otherwise the fake's word.
- **Evidence.** A live gate-relay run on the testbed.
- **Severity.** HIGH.
- **Found.** `CORE_WORKER_RELEASE` "default the fake" (`services/core-worker/src/config.ts`, env doc); gate-relay is a compose
  profile; PLAN §7a "The release path is built against a fake target".

### RC-E2E-10 — One coding session for the whole factory
- **Challenge.** What throughput does a team of N get? How many runner hosts can there be, and where is the second one?
- **Why it matters.** `CODING_SESSION_CAP = 1` (`packages/contracts/src/entities/sandbox.ts:166`) and one local runner host mean
  one Unit is coded at a time across every project. A queue that long makes people work around the factory.
- **Evidence.** Two runner hosts registered with the sandbox-controller, a raised cap through `sandbox.caps`, and a load test.
- **Severity.** MEDIUM (HIGH once more than one team uses it).

---

## 2. Human and agent interaction (HAI)

### RC-HAI-1 — The item page does not show the work
- **Challenge.** Open an item in the portal and show its request text, its artefacts (intent, spec, design, plan) with versions,
  its agent runs and their outcomes, its PR and head, and its gate history.
- **Why it matters.** The item page is where a requester, an approver and an engineer understand what an agent did and why it is
  waiting. Today it shows repo, lane, phase, a waiting sentence and the actions (`services/web/src/pages/ItemPage.tsx:23-90`),
  with two tabs, Now and Verify (`:107-109`). The prototype has seven.
- **Evidence.** The item page tabs of the design reference built over the record, each with a test.
- **Severity.** HIGH.
- **Found.** The bff serves `GET /api/agent-runs?item=` (`services/bff/src/portal.ts:652`) but the web never calls it;
  artefacts are visible only on the G1f/G2 gate cards (`/api/cards/:id/artefacts`); the item list says "the request is on the item
  page" (`ItemsPage.tsx:164`) but the item page does not render it.

### RC-HAI-2 — The requester is never told that the factory has a question or needs "Ready"
- **Challenge.** When S1 raises clarification questions (1.5) or waits for the Ready decision (1.6), how does the requester find
  out without polling the portal?
- **Why it matters.** Neither is a gate or a card, so the notifier raises nothing. B1 parks the item after two unanswered rounds,
  and PARK ends in ABANDONED after 5 business days. Items will die silently.
- **Evidence.** A notification kind for open questions and for Ready, with a test in `services/notifier/test`.
- **Severity.** HIGH.
- **Found.** The notifier's sources are only `gate.opened`, `card.opened`, `card.escalated` and `kill.observed`
  (`services/notifier/src/sources.ts:106`, `:131`, `:149`, `:177`; `docs/specs/notifier-api.md` §1).

### RC-HAI-3 — An agent that is stuck after S1 cannot ask; it can only hand off
- **Challenge.** When a planning or coding agent needs a fact from a person after S1, what happens? Show the person seeing the
  agent's question or reason in the portal and answering it.
- **Why it matters.** A D1/D2 handoff to E4 with no readable reason makes the owner of record guess. The Handoff Pack as an
  artefact type is still an open M13 follow-up (PLAN §0).
- **Evidence.** The handoff's reason and pack rendered on the E4 screen, and a decision record of whether mid-stage questions are
  in scope.
- **Severity.** HIGH.

### RC-HAI-4 — No per-item conversation or agent console
- **Challenge.** Can a person ask "why did the coder do this?" about one item and get an answer grounded in that item's record and
  transcripts? The onboarding assistant exists; is there an item one?
- **Why it matters.** Without it, people read raw events or ask the builder.
- **Evidence.** A decision (in scope or not) and, if in scope, a screen.
- **Severity.** MEDIUM.

---

## 3. Configuration (CFG)

### RC-CFG-1 — Project settings cannot be changed in the portal after onboarding
- **Challenge.** A new engineer joins: show the project admin putting them into the `intent` or `g4` slot, changing two-person,
  the gating profile, the WIP limit, the envelope or the release target, in the portal, through M1.
- **Why it matters.** The role map is who may decide each gate. If it can be edited only through core's API, the first staffing
  change of a real team needs the builder.
- **Evidence.** A bff route for `PUT /v1/projects/:id/settings`, a screen, and an e2e.
- **Severity.** BLOCKER.
- **Found.** Core has `GET` and `PUT /v1/projects/:id/settings` (`services/core/src/app.ts:313`, `:1278`); the bff has no
  `/settings` route and `services/web/src/api.ts` none either. The configuration console proposes only on the factory layer
  (`services/core/src/config-console.ts:32`). Card 4 sets these once, during onboarding.

### RC-CFG-2 — Model per agent or stage, turns and budgets per agent are not configurable
- **Challenge.** Show a factory admin changing the model the coder uses, the model A5 uses, the maximum turns of the coder and the
  budget of one agent, each as an M1-gated revision.
- **Why it matters.** Model choice and spend per agent are the first things an operator tunes. Today the route is chosen only by
  (environment, data class) (`gateway.routes`), the coder's model is an environment variable (`CORE_WORKER_CODER_MODEL`), and
  budgets are defaults in the agent contracts (code). Changing them is a code release.
- **Evidence.** Config keys for per-agent routing and budgets (or a recorded decision that they stay code), with a screen.
- **Severity.** HIGH.
- **Found.** The registered keys (grep of `.setting({`/`.opsFlag({`) include no agent, prompt or per-agent budget key;
  `docs/design/portal-config.md` §1.1 says the same.

### RC-CFG-3 — There is no way to create a production factory
- **Challenge.** On a deployment that is not `FACTORY_ENV=local`, how are the first factory admin and the first PDP bundle
  created? Run it.
- **Why it matters.** The seed refuses outside local (`services/core/src/seed.ts:232`). With `pdp.bundle` defaulting to `null`
  (deny everything), a non-local factory starts with nobody able to do anything.
- **Evidence.** The M8.0b "non-local genesis" (open in PLAN §0) built and run.
- **Severity.** BLOCKER.

### RC-CFG-4 — Integrations are files and environment variables, not portal settings
- **Challenge.** Show a factory admin adding a GitHub App, an Anthropic key and a Slack channel, rotating each, and seeing its
  health, without shell access to the host.
- **Why it matters.** The registry row holds a reference; the key file must be placed on the host by `init-secrets`, the
  deployment must allow it (`CODEHOST_SECRET_REFS`, `NOTIFIER_SECRET_REFS`), and rotation needs a forced reload
  (portal-config §3). That is safe, but it means every integration change is an operator task with host access. Say so, and
  document it per integration.
- **Evidence.** A runbook per integration (create, install, place key, publish row, verify health, rotate, revoke).
- **Severity.** HIGH.

### RC-CFG-5 — One pending revision per layer
- **Challenge.** Is it still true that a new proposal on the factory layer supersedes the pending one, so two admins editing two
  different keys silently replace each other (portal-config §1.2 step 2)? If so, what does the second admin see?
- **Severity.** MEDIUM.

### RC-CFG-6 — The configuration documentation is stale
- **Challenge.** Bring `docs/design/portal-config.md` to the code. It is "written against `build/m14` at `cced4a0`" and says the
  factory M1 is "not built", which M15.5 built.
- **Why it matters.** An admin cannot use a guide that is wrong about who decides.
- **Severity.** MEDIUM.

---

## 4. Notifications (NOT)

### RC-NOT-1 — Most events a person must know about notify nobody
- **Challenge.** For each event below, name the recipient and the notification kind, or say why none is needed: S1 questions,
  Ready (1.6), PARK, ABANDONED, BLOCKED, DECLINED, an item Done, a PR opened, a merge observed, a release succeeded or rolled
  back (RELHOLD, B16), a D1/D2 handoff to the requester, ET1 budget exhausted, a control (hold, clamp, halt, MM-2) set or lifted,
  drift suspension to L8, the R3 breaker tripping, R4 blocking new items, a gate nobody can decide (GateFeasibility), an
  Evidence Pack or gate-check failure, an unauthorised or bypass merge, a service or loop down, a dead-lettered outbox message.
- **Why it matters.** People act on what they are told. The notifier knows four source events (RC-HAI-2).
- **Evidence.** A table in the notifier spec, one source per row, each with a test.
- **Severity.** HIGH.

### RC-NOT-2 — The notifier is optional and has never sent a real message
- **Challenge.** Show a Slack post and an email (with STARTTLS and AUTH against a real relay) delivered from a running stack, and
  the portal list showing the delivery.
- **Why it matters.** The notifier is a compose profile (`docker-compose.yml:1444`), off by default; the spec says the SMTP
  adapter with TLS has never run (notifier-api §8); there is no real-time push to the browser.
- **Severity.** HIGH.

### RC-NOT-3 — Nobody is paged when the factory is down
- **Challenge.** When the Notary, Postgres, the kill switch, the gateway or the codehost is down for ten minutes at 03:00, who
  finds out and how?
- **Why it matters.** The kill switch unreachable means no agent work; the Notary down means no decisions. The health tiles exist
  only in the portal. Telemetry goes to the collector's `debug` exporter (`platform/compose/config/otel-collector.yaml:44`,
  `:48`). There are no alert rules and no on-call document.
- **Evidence.** Alert rules on `/metrics` and `/healthz`, a pager route, and a test alert fired in a drill.
- **Severity.** HIGH.

---

## 5. Traceability (TRC)

### RC-TRC-1 — Show one item's chain from request to release
- **Challenge.** For one finished item, show in the portal, as a reviewer at V2 and as an auditor: the request text, the intent
  block, the spec and oracle specs, the design and ADRs, the plan and its Units, the commits and the PR, the Evidence Pack for
  exactly the head, every gate decision with its ledger entry, the merge and the release, each with its version and hash.
- **Why it matters.** It is the product's audit claim. The close-out record (9.3) builds the chain from the record after the
  fact (`/items/:id/closeout`), but the parts in the middle are scattered (gate cards, the Verify tab, the pack viewer) or not
  shown (RC-HAI-1).
- **Evidence.** A traceability view or a documented path through existing screens, tested in the persona e2e.
- **Severity.** HIGH.

### RC-TRC-2 — Versions and diffs of artefacts
- **Challenge.** When a spec is reworked (B10, B23) or a plan is rewritten (B5), can an approver see what changed between
  versions before deciding again?
- **Why it matters.** Without a diff, an approver re-reads everything or approves blind.
- **Severity.** MEDIUM.

### RC-TRC-3 — Cut by role and data class, proven
- **Challenge.** Show the tests that a V1 viewer sees no title, artefact or transcript, and that D2 findings are cut for a D1
  role, on every read route the portal uses.
- **Severity.** MEDIUM (part of the M20 persona pass).

---

## 6. Security (SEC)

### RC-SEC-1 — There is no production key custody
- **Challenge.** Show the Notary, the Witness, the kill switch and the bff's step-up signing with a non-exportable key in a KMS
  or HSM, in separate accounts as ADR-0003 asks.
- **Why it matters.** The ledger's integrity is the Notary's key. Today every key is a `dev:` key on a local disk, and kms-local
  refuses to start unless `FACTORY_ENV=local` (`services/kms-local/src/boot.ts:19`). The only `KeyCustodyPort` adapter is the
  HTTP client to kms-local (`services/kms-local/src/client.ts:46`).
- **Evidence.** An AWS KMS (or HSM) adapter passing the key-custody contract, and a ledger signed with it that `verify-ledger`
  accepts.
- **Severity.** BLOCKER.

### RC-SEC-2 — There is no real identity provider, no suspension and no session revocation
- **Challenge.** Show a person signing in through the organisation's IdP, a group change reaching their bindings, a leaver
  disabled in the IdP losing access within the stated SLO, an admin ending a person's sessions, and suspension in the portal.
- **Why it matters.** People are the seed file (`platform/compose/config/dev-oidc-users.json`, `idp-seed.json`); the only
  `IdentityProviderPort` adapters are `SeedIdentityProvider` and `FakeIdentityProvider`
  (`packages/ports/src/identity-provider.ts:89`, `:127`); dev-oidc runs only locally. The portal marks "Suspend, erase, legal hold"
  as not built (`services/web/src/pages/AdminPages.tsx:64`) and portal-config lists sessions (list, end) as missing. A real team
  cannot be added or removed safely.
- **Evidence.** A real IdP adapter (OIDC is generic, `HttpOidcClient`; the directory sync is not), a leaver drill, and the
  session screens.
- **Severity.** BLOCKER.

### RC-SEC-3 — One operator token can release a two-person kill alone
- **Challenge.** Show that the kill switch's two-person release cannot be satisfied by one person.
- **Why it matters.** The kill switch's `POST /v1/kills/:id/release` takes `on_behalf_of` from the body of a service-token call
  (`services/killswitch/src/app.ts:151-156`), and `approveRelease` checks only that this asserted principal has not approved
  already (`services/killswitch/src/service.ts:319-330`). The operator token (`tok-operator-killswitch`, scopes `act`, `read`,
  `docker-compose.yml:563`) is "how a person reaches the kill switch". Whoever holds it can approve as two different principals
  and release any kill, and can also request kills in anyone's name.
- **Evidence.** A test where one caller tries two principals and is refused, and the operator path bound to a verified human
  identity (a signed assertion or step-up the kill switch verifies itself).
- **Severity.** HIGH.

### RC-SEC-4 — Core trusts the bff's word about who the person is
- **Challenge.** If the bff's core token is stolen, or the core operator token (scopes `read onboard portal`,
  `docker-compose.yml:751`) is misused, which human acts can be forged? Show the list and the mitigation.
- **Why it matters.** Core decides "about the human named in `on_behalf_of`" (`services/core/src/app.ts:162-177`). Step-up, the
  only cryptographic proof of a person, is required for G5, M4 and a sensitive G4 only
  (`packages/contracts/src/entities/gate-lifecycle.ts:211`, `:226`). The two-person gates X1, X2 and E2 can then be satisfied by
  one compromised process. The design intends the bff as the only caller, but production-readiness means saying what the blast
  radius is.
- **Evidence.** A per-request signed user assertion from the bff that core verifies, or step-up on every two-person gate, plus a
  threat model entry.
- **Severity.** HIGH.

### RC-SEC-5 — The coding class (W) has no hostile-probe evidence, and SEC-OB-3 is stale
- **Challenge.** Re-run SEC-OB-3 on the current driver and add the W class: a hostile repo's tests running inside a coding
  session that has the gateway as a peer and a live per-Unit key.
- **Why it matters.** W is where repo code and model output meet a credential and a network. SEC-OB-3 probes only K and K-exec
  (`docs/evidence/sec-ob-3.json`, `profiles`); its evidence is from 2026-11-09 and the sandbox driver changed on 2026-11-12
  (`363df3f`: images by digest). DEC-18 was decided on that evidence.
- **Evidence.** `npm run evidence:sec-ob-3` re-run, extended to W (key exfiltration through the gateway, calling models outside the
  key's allow-list, reaching other session networks, using the key after the session).
- **Severity.** HIGH.

### RC-SEC-6 — Prompt injection is tested against a script, not a model
- **Challenge.** Show the planted-instruction test (SP-STD-1) and the context-builder tests run against a real model, and a red
  team of the assistant's answers.
- **Why it matters.** SP-STD-1 scripts the model "to OBEY" (`services/coding-runner/test/isolation.test.ts:31`), which proves
  the harness and tripwires stop an obedient model (good), but says nothing about how often a real model tries, or about
  injection through tool results that the tripwires do not classify.
- **Evidence.** An eval suite of injection cases on the real provider, with its pass rate gated.
- **Severity.** HIGH.

### RC-SEC-7 — Personal data cannot be erased from the record
- **Challenge.** A requester pastes a customer's name and email into a request. Show how it is erased.
- **Why it matters.** Erasure removes only conversation payloads kept off the hash chain (`docs/specs/audit-api.md` §3).
  Request text, artefacts and every record event are immutable for ever. That is a legal decision for the organisation, not a
  technical one, and it must be made before real data enters.
- **Evidence.** A DPIA or legal sign-off, or request text and artefacts moved off the hash chain like conversation payloads.
- **Severity.** HIGH.

### RC-SEC-8 — Notary key rotation and compromise
- **Challenge.** Rotate the Notary key and show `verify-ledger` verifying entries signed by the old and the new key. Then describe
  the response to a compromised Notary key.
- **Why it matters.** `verify-ledger` takes exactly one `--notary-key` and one `--witness-key` (`packages/ledger/src/cli.ts:14`),
  so a rotation breaks verification of the older entries or is never done.
- **Severity.** MEDIUM (HIGH once real keys exist).

### RC-SEC-9 — Tenancy between projects and confidential projects
- **Challenge.** Show a penetration test, or at least a test per read route, that a person with a role on project A cannot read
  anything of confidential project B through any bff route, the assistant, the floor, the fleet, the ledger page, notifications,
  search or exports.
- **Why it matters.** All projects share one core and one database; isolation is the bff's cut and the PDP. One missed route
  leaks a confidential project.
- **Severity.** MEDIUM.

### RC-SEC-10 — Service-to-service traffic is plain HTTP with bearer tokens
- **Challenge.** In production, how are service tokens protected in transit and rotated?
- **Why it matters.** Docker networks give reach, not encryption (compose README "Network separation").
- **Severity.** MEDIUM.

### RC-SEC-11 — Secrets never in the browser, the record or the logs: proven on a full run
- **Challenge.** Run the e2e and then scan every container log, every record event body and every bff response captured by the
  browser with the secret ruleset and the canaries. Show zero hits.
- **Why it matters.** The grep tests cover code paths; a full-run scan covers wiring.
- **Severity.** MEDIUM.

### RC-SEC-12 — Non-streamed model responses are returned unredacted
- **Challenge.** Redact non-streamed responses the way streamed ones are, and show the planted-secret test (M10.6's acceptance).
- **Why it matters.** `GatewayService.complete` checks the tool allow-list and returns `out.content` as the vendor sent it
  (`services/gateway/src/service.ts:538-600`); only `stream` runs `StreamRedactor` and `redactValue`. A secret the model echoes
  reaches the caller. The planning port's secret scan before storing an artefact narrows it; it does not cover every caller.
- **Severity.** MEDIUM. (PLAN §0 lists it as open; it is.)

### RC-SEC-13 — Dependency advisories
- **Challenge.** `npm audit` reports 10 moderate advisories (`minimatch`, dev only; `--omit=dev` reports none). Record the
  decision.
- **Severity.** LOW.

---

## 7. Reliability and operations (OPS)

### RC-OPS-1 — There is no backup and no restore drill
- **Challenge.** Back up the record database, the Notary's, the Witness's and the kill switch's databases and the object store;
  restore them to a fresh host; show `verify-ledger` passing, the Notary journal agreeing with the ledger, the Witness's
  checkpoints covering the head, every read model rebuilt, and the evidence packs re-hashing to their keys.
- **Why it matters.** The record is the source of truth and the ledger is append-only and signed: a lost or inconsistent restore
  is unrecoverable. The Postgres runbook's answer to lost data is "restore from backup" (`docs/runbooks/drill-postgres.md` §3),
  but no backup exists. ADR-0003 lists "backups with a tested restore" in the operations baseline (`:339`).
- **Evidence.** A backup runbook, a restore drill script and its recorded result, with the RPO and RTO stated.
- **Severity.** BLOCKER.

### RC-OPS-2 — There is no production deployment
- **Challenge.** Show the factory running anywhere other than Docker Compose on one machine with `FACTORY_ENV=local`.
- **Why it matters.** `FACTORY_ENV: local` is fixed in the compose file (`docker-compose.yml:443`, `:712`, `:856`, `:1136`);
  kms-local, dev-oidc and the seed refuse anything else. The cloud column of "What local-prod stubs" (Aurora, KMS, Entra, ECS,
  CloudFront, WAF, Secrets Manager) is unbuilt. If the owner's "production" is this compose stack on one machine, say so and
  accept the single points of failure in writing.
- **Evidence.** Either the cloud deployment, or a signed decision that local-prod is the production target, with its limits.
- **Severity.** BLOCKER.

### RC-OPS-3 — Can anything run as two instances?
- **Challenge.** Run two core-worker replicas and two core replicas for an hour of load and show no duplicated job, census, push,
  notification or ledger entry.
- **Why it matters.** M7.7 (single-flight S0 driver) is still open (PLAN §0): two core-workers start two census jobs for one
  record. Without a second instance there is no high availability and every upgrade is an outage.
- **Severity.** HIGH.

### RC-OPS-4 — No load test
- **Challenge.** Run the load test M19 promised: N projects, M items in flight, the inbox, the floor and the ledger at a year's
  volume. Show latency, Postgres size, `verify-ledger` time and the outbox lag.
- **Why it matters.** The drills ran on a ledger of 5 entries (the Results sections of the three drill runbooks). The floor and the inbox poll every 5
  seconds per open page.
- **Severity.** HIGH.

### RC-OPS-5 — Outage drills that do not exist yet
- **Challenge.** Add and run drills for: the gateway down and the vendor down or rate-limiting (429) mid-session; GitHub down and
  rate-limited; the object store down during 7.6; a runner killed mid-session (open in M19); disk full on the Postgres volume;
  clock skew between services.
- **Why it matters.** Only Postgres, the Notary and the kill switch have drills.
- **Severity.** HIGH.

### RC-OPS-6 — Upgrades and migrations on a live database
- **Challenge.** Write and run the upgrade procedure: new image, `aisdlc-migrate` on a database with items in flight, mixed
  versions during the roll, and the way back when a migration is wrong (migrations are append-only and never edited).
- **Why it matters.** ADR-0003 lists "a written upgrade procedure (M19)"; none exists.
- **Severity.** HIGH.

### RC-OPS-7 — Secret rotation without downtime
- **Challenge.** Rotate each service token, the App keys, the vendor key and the object store credentials on a running stack and
  show nothing fails.
- **Why it matters.** `init-secrets --rotate` writes files; whether each service re-reads them or needs a restart is undocumented.
- **Severity.** MEDIUM.

### RC-OPS-8 — The health screen cannot see half the services
- **Challenge.** Make every service's health visible to someone.
- **Why it matters.** The profile services (sandbox-controller, verify, gate-check, gate-relay, notifier) "read unknown: never
  shown as healthy" because core-worker does not reach them (`docker-compose.yml`, core-worker `CORE_WORKER_HEALTH_TARGETS`
  comment). An operator sees grey tiles for the services that matter most to S6–S9.
- **Severity.** MEDIUM.

### RC-OPS-9 — On-call runbooks
- **Challenge.** Write runbooks for: an item stuck in a stage, a dead-lettered outbox message, a gate nobody can decide, budget
  exhaustion, a read model behind, a kill that will not release, a failed census, a quarantined item, a gate-check verdict stuck
  at pending.
- **Why it matters.** Three drill runbooks and one onboarding runbook exist (`docs/runbooks/`).
- **Severity.** MEDIUM.

### RC-OPS-10 — Record growth
- **Challenge.** What is the expected size of `record.record_event` per item and per year, is it partitioned, and how long does
  `verify-ledger` take at that size?
- **Severity.** MEDIUM.

---

## 8. Data model integrity (DATA)

### RC-DATA-1 — Rebuild every read model from the record, on demand
- **Challenge.** Give an operator one command that drops and refolds every read model of every service from the record, and run it
  on a stack after the e2e, comparing before and after.
- **Why it matters.** Principle 2 says every read model is rebuildable. Core alone has 36 tables in its migrations and the
  reviewer counted 11 `rebuild*` functions in `services/core/src` (others may refold under different names). There is no CLI to
  run them, so after a bad deploy the claim cannot be used.
- **Evidence.** The command, plus a test that enumerates the tables of every schema and fails when one has no rebuild.
- **Severity.** HIGH.

### RC-DATA-2 — A catalogue bug on a pinned version
- **Challenge.** If a released catalogue version has a bug (a wrong limit, a missing gate), what happens to the items pinned to it?
  They "must keep running on exactly that". Who decides to move them, and how?
- **Why it matters.** Immutability is right; a way to supersede an item's pin through a decided gate is needed, or items run a
  known-wrong flow to the end.
- **Severity.** MEDIUM.

### RC-DATA-3 — External effects that can happen twice or half
- **Challenge.** Show the self-heal for a crash between the push and its receipt (open M13 follow-up), and list every external
  effect (push, PR, check run, deployment, issue, Slack post) with its idempotency key and its recovery.
- **Why it matters.** The notifier says a Slack webhook "may post twice"; a duplicate PR or a half-recorded push breaks the
  evidence binding.
- **Severity.** MEDIUM.

### RC-DATA-4 — Kill delegations in two stores; kill scope vocabulary
- **Challenge.** Is `project.kill_delegations` (config) or the kill switch's table the truth? Can a kill target an item, an agent
  or a model?
- **Why it matters.** portal-config gap 11 and portal-coverage §5.2; `KILL_SCOPE_KINDS` is `fleet, project, lane, session`
  (`packages/contracts/src/entities/controls.ts:21`). A misbehaving model across projects can only be stopped with a fleet kill.
- **Severity.** MEDIUM.

### RC-DATA-5 — Offline verification of a restored copy
- **Challenge.** Show `verify-ledger` and `aisdlc-verify-pack` run by someone other than the operator, on a copy, with keys
  obtained independently of the factory.
- **Severity.** LOW (the tools exist; the procedure does not).

---

## 9. Portal (UI)

### RC-UI-1 — The safety controls are not in the portal
- **Challenge.** Show a project admin requesting a kill and two people releasing it in the portal, an operator stopping one
  session, a control with its step-up, and an agent switched off.
- **Why it matters.** These are the controls people reach for when something goes wrong. The portal marks each "not built":
  kill request and release (`services/web/src/pages/OperatePages.tsx:612`, "a kill is requested and released with the operator's
  client today"), session stop (`:270`), step-up on a control (`:526`), agent off (`QualityPages.tsx:217`). Combined with
  RC-SEC-3, today's kill path is a shared token and curl.
- **Severity.** BLOCKER.

### RC-UI-2 — Every role's day, proven
- **Challenge.** Run the persona e2e: each account of portal-coverage §1 signs in and does its day (requester, intent approver,
  designer, code owner, security, exception approver, release approver, project admin, factory admin, auditor, viewer). Menus and
  buttons match the PDP; a viewer sees no content; an invisible project is 404.
- **Why it matters.** The compose e2e uses two people (alice, bob). The rest is component tests with fixtures. PLAN puts the
  persona pass in M20, so it is not done.
- **Severity.** HIGH.

### RC-UI-3 — Accessibility
- **Challenge.** Run an automated WCAG 2.2 AA checker (axe or equivalent) on every route plus a manual keyboard and screen reader
  pass, and fix what it finds.
- **Why it matters.** The e2e's own checks (names, one h1, width) cover the onboarding pages; there is no axe dependency; the
  light theme and keyboard map are not built (portal-coverage §4).
- **Severity.** MEDIUM (HIGH if the organisation has an accessibility obligation).

### RC-UI-4 — Phone, empty and error states
- **Challenge.** Show every route at 390 px wide, empty, loading, 403, 404 and degraded.
- **Why it matters.** The e2e checks phone width "on the pages that matter" (step 11) only.
- **Severity.** MEDIUM.

### RC-UI-5 — Screens that are still "not built"
- **Challenge.** Decide, with the owner, each `NotBuilt` panel: access requests (`AdminPages.tsx:190`), eval gate results
  (`QualityPages.tsx:315`), and the portal-coverage §4 list (assumptions, cost reports, global search). Is "Suspend, erase, legal
  hold" (`AdminPages.tsx:64`, "M19") stale now that the audit service is built?
- **Severity.** MEDIUM.

### RC-UI-6 — The six open decisions of portal-coverage §5
- **Challenge.** Close them (coding pods, kill scopes, the example project's level, E4, factory M1, the six proposed actions) or
  mark each decided.
- **Why it matters.** Operate, Quality, Audit, People and Teams are guarded by `audit.read` on the fleet "until `ops.read` /
  `quality.read` exist", which is broader than the design.
- **Severity.** MEDIUM.

### RC-UI-7 — Is the floor useful to anyone?
- **Challenge.** Show the floor with a realistic number of items and ask a team lead what decision it helped them make.
- **Why it matters.** It is built over live read models, but on a stack with one coding pod and a handful of items its value is
  unproven.
- **Severity.** LOW.

---

## 10. Real-world gaps and owner actions (LIVE)

### RC-LIVE-1 — The owner's checklist does not exist
- **Challenge.** Write one document of everything the owner must do before first real use, in order, with how to verify each:
  create five GitHub Apps (read/census, Push Broker, gate-check `checks:write`, gate-relay `deployments:write`, tracker
  `issues:write`) with exact permissions and installation, make `aisdlc/gate` required (RC-E2E-8), put the Anthropic key, confirm
  model ids and prices, pin the eval-store key, attest DEC-4 for the testbed, set DEC-18's allow-list, set notification channels,
  and create the first admin.
- **Why it matters.** Only the census App has a runbook (`docs/runbooks/m8.5-live-census.md`). The others are scattered in the
  compose README.
- **Severity.** HIGH.

### RC-LIVE-2 — Cost controls
- **Challenge.** What stops the factory spending more than X per day or month, for the fleet and per project? Show the limit and a
  test that hits it.
- **Why it matters.** Budget groups are per Unit, job or session (`docs/specs/gateway-api.md:83-97`); there is no fleet or project
  ceiling, and prices are "placeholders to be reviewed before any real spend" (`services/core/src/seed.ts:69-71`). Cost reports are
  M20 (portal-coverage §4).
- **Severity.** HIGH.

### RC-LIVE-3 — Evals gate nothing yet
- **Challenge.** With no baselines and a placeholder store key, does any decision depend on evals today? When a prompt changes,
  what stops a regression reaching a real repo?
- **Why it matters.** `gateRun` fails without a baseline, but core only records runs; the portal shows "Gate results" as not built
  (`QualityPages.tsx:315`).
- **Severity.** MEDIUM.

### RC-LIVE-4 — Licences
- **Challenge.** State the licence of this repo (there is no LICENSE file and no `license` field), the terms the Claude Agent SDK
  (`@anthropic-ai/claude-agent-sdk` 0.3.319) is used under, and a licence report of the dependencies in the shipped image.
- **Severity.** MEDIUM.

### RC-LIVE-5 — What has only run against fakes
- **Challenge.** Keep a list, in the plan, of every port whose real adapter has never run against the real thing, and burn it down
  to zero before handoff. From this review: GitHub (codehost read, Push Broker, gate-check, gate-relay, tracker), the model vendor
  (Anthropic, OpenAI-compatible), the IdP directory, KMS, Slack and SMTP with TLS, the microVM runner, a real deploy target.
- **Severity.** HIGH (each item is covered above; the list itself is missing).

---

## 11. Process (PROC)

### RC-PROC-1 — The wiring tests are not in CI
- **Challenge.** Run `smoke:compose`, `e2e:compose` and the drills in CI (or nightly) on main.
- **Why it matters.** CI runs the checks, the build, the non-Docker tests in four shards and the Docker tests
  (`.github/workflows/ci.yml`). The compose stack, the browser e2e and the drills run only when someone runs them on their machine,
  so a wiring regression merges green.
- **Severity.** HIGH.

### RC-PROC-2 — The status documents are out of date
- **Challenge.** Bring PLAN §0 to the code and keep it there.
- **Why it matters.** PLAN §0 says "In progress: M14" while M14 to M19 are merged, and "Next: M15 ... M19" for work that is
  merged; `portal-config.md` is from `build/m14`;
  `notifier-api.md` §8 says the portal has no notification screens, but `NotificationsPage.tsx` exists; the screenshots in
  `docs/screenshots/` are from 2026-11-08 (M8). The owner cannot tell what is done.
- **Severity.** MEDIUM.

### RC-PROC-3 — Milestones closed with their acceptance unmet
- **Challenge.** For each, either meet the acceptance or record that the owner waived it: M8.5 (live exit), M8.0b (non-local
  genesis), M7.7 (single-flight), M14.5 (live run), M14.6 (X3 in the browser), M19 (load test, the runner-killed drill, the
  upgrade procedure, backups), M10.6 (prices).
- **Severity.** MEDIUM.

### RC-PROC-4 — Conditional skips
- **Challenge.** For each conditional skip (13 `skipIf`/`runIf`/`skip` in the tree: Docker, MinIO, the live GitHub contract, the
  audit boot test, a knowledge presence case at `services/knowledge/test/presence.test.ts:258`), say where it actually runs.
  Does CI reach MinIO, so the S3 object-store contract (`packages/ports/test/object-store.test.ts:150`) and the audit boot test
  (`services/audit/test/boot.test.ts:147`) run, or are they skipped there?
- **Severity.** MEDIUM.

---

## 12. Compose smoke run by the reviewer

The reviewer built the image from `2e1861f` (`platform/compose/Dockerfile`, runtime image with git as PLAN §0 describes,
tagged `aisdlc/factory:review`, retagged to `:local` only for the run and restored after) and ran `npm run smoke:compose` with
`COMPOSE_PROJECT_NAME=aisdlc-review`, `AISDLC_SUBNET_PREFIX=10.235`, `SMOKE_SKIP_BUILD=1`, twice.

| Run | Result |
|---|---|
| 1 and 2 | **FAILED after about 30 s at `up -d --wait`**: `dependency failed to start: container aisdlc-review-docker-proxy-coding-1 is unhealthy`. Its log shows `docker-proxy listening on http://0.0.0.0:2375 (coding)` four times in 15 s, i.e. it restarted with nothing logged. `down -v` left 0 containers and 0 volumes. |
| The same proxy outside compose | `docker run` of the same image, `DOCKER_PROXY_MODE=coding` and `cvw`, the socket's group added, `mem_limit 64m`: stays up, `healthcheck.mjs 2375` exits 0. |

The cause was not isolated (it may be this host: Docker 29.9.2, socket group 996). It is reported, not counted as a finding of
its own. It does sharpen RC-PROC-1: the smoke is the only proof that the stack comes up, it runs on nobody's CI, and a crash that
logs nothing fails it without a reason. The builder should answer with a green `smoke:compose` and `e2e:compose` on a clean
machine at the commit being handed off, and make a process that exits or restarts log why.

---

## 13. Top 10 BLOCKER and HIGH items, in order

1. **RC-E2E-2** The deployed stack cannot produce a pull request: no Push Broker, S6 and S7 on fakes by default; request → PR → merge → release → close has never run outside one test process.
2. **RC-E2E-1** A person cannot submit a work request in the portal; the e2e posts requests through the API.
3. **RC-E2E-3** L8 has no way to carry code: D5 takes no patch or commit and has no portal button, so the lane most repos get cannot produce a PR.
4. **RC-E2E-4** Agent lanes are unreachable for any repo the owner did not write (DEC-18, container-class only, no microVM runner).
5. **RC-SEC-1** No production key custody: every signing key is a `dev:` key in kms-local, which runs only with `FACTORY_ENV=local`.
6. **RC-SEC-2** No real identity provider, no suspension, no session revocation: people are a seed file.
7. **RC-OPS-1** No backup and no restore drill for the record, the ledger, the Notary, the Witness, the kill switch and the object store.
8. **RC-E2E-5** No real model has ever done any of the work, and no eval baseline exists.
9. **RC-CFG-1** Project settings (role map, two-person, gating, WIP, envelope, release) cannot be changed in the portal after onboarding.
10. **RC-UI-1** with **RC-SEC-3** The kill switch is not in the portal, and its operator token can request kills and release a two-person kill alone.

Just below the line: RC-E2E-6 (nothing has run against real GitHub), RC-OPS-2 (no production deployment), RC-CFG-3 (no
non-local genesis), RC-HAI-2 and RC-NOT-1 (people are not told), RC-NOT-3 (nobody is paged).

## 14. Verdict

**Not ready.** What exists is a carefully built and well-tested set of parts, with good instincts (fail closed, record first,
ports and fakes, a signed ledger, least-privilege database roles, an honest "not built" in the portal). What does not exist is
the product: a person cannot ask for work in the portal, the stack cannot produce a pull request, the lane a real repo gets
cannot carry code, no real model, GitHub App, IdP or KMS has been used, and there is no backup.

"Ready" for a first real team would require, at minimum:

1. One compose (or cloud) configuration in which a request typed in the portal becomes a PR on the real testbed, is approved
   and merged by a person on GitHub, is released and closed, every gate decided in the browser by its slot holder, with
   `verify-ledger` passing at the end, run in CI or nightly (RC-E2E-1, -2, -6, -7, RC-PROC-1).
2. An L8 path that carries a human's change to a PR (RC-E2E-3), and either the microVM runner or an explicit, written decision
   that the team's repos are on DEC-18's allow-list (RC-E2E-4).
3. Real models behind the gateway with baselines, prices and a fleet spend ceiling (RC-E2E-5, RC-LIVE-2).
4. Real key custody, a real IdP with offboarding, and the factory genesis outside `local` (RC-SEC-1, -2, RC-CFG-3), or a written
   decision that local-prod on one machine is the production target with its limits accepted (RC-OPS-2).
5. A tested backup and restore (RC-OPS-1), alerting to a person (RC-NOT-3), and the kill switch in the portal without a shared
   token that can act for anyone (RC-UI-1, RC-SEC-3).
6. Project settings editable in the portal (RC-CFG-1) and the requester told when the factory needs them (RC-HAI-2, RC-NOT-1).

## 15. Counts

70 items.

| Severity | Count | Items |
|---|---|---|
| BLOCKER | 13 | RC-E2E-1, -2, -3, -4, -5, -6; RC-CFG-1, -3; RC-SEC-1, -2; RC-OPS-1, -2; RC-UI-1 |
| HIGH | 27 | RC-E2E-7, -8, -9; RC-HAI-1, -2, -3; RC-CFG-2, -4; RC-NOT-1, -2, -3; RC-TRC-1; RC-SEC-3, -4, -5, -6, -7; RC-OPS-3, -4, -5, -6; RC-DATA-1; RC-UI-2; RC-LIVE-1, -2, -5; RC-PROC-1 |
| MEDIUM | 27 | the rest, except the three below |
| LOW | 3 | RC-SEC-13, RC-DATA-5, RC-UI-7 |
