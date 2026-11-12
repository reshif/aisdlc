# Portal review: the real portal against what the factory must do

Status: 2026-11-12, against `origin/main` at `72b48d1` (M17 merged). This is a review and a gap list; no product code was changed.
Inventory: [`portal-inventory.md`](portal-inventory.md) is the machine-built list of every step, gate, edge, setting, action, role,
route, event and screen; [`portal-review-rows.md`](portal-review-rows.md) gives every inventory row a review status. Journeys as the portal
behaves today: [`portal-journeys.md`](portal-journeys.md).

## 0. How the review was run

- **The real stack.** The image was built from this commit as `aisdlc/factory:review`. The build used `docker build --network=host`, the agent
  proxy as build args, the proxy CA as the `extra_ca` secret, and a local node 22 image with git as `RUNTIME_IMAGE`. It ran as compose project
  `aisdlc-review` from a copy of `platform/compose/docker-compose.yml` that changes only the image tag and gives each of the 40 networks an
  explicit /24. Without those subnets the daemon refused the stack with "all predefined address pools have been fully subnetted".
  - Profiles: `fake-github`, `gate-check`, `gate-relay`, `notifier`, `audit`.
  - Not started: the `sandbox` profile, which brings the two socket proxies, the sandbox-controller, the verify service and the package mirror.
    So the Sandboxes page and the floor's sandbox tile read "unknown" on this stack.
  - The environment was the same as `npm run e2e:compose`: `CORE_WORKER_STAGE_PORTS=agents`, `CORE_WORKER_FAKE_VERIFY=exceptions`.
- **Data.** `platform/compose/e2e-portal.mjs` was run first, unchanged. It onboarded `reshif/asf-factory-testbed` at Census through cards 1, 4
  and 5 with a step-up, drove two items through G0, D5, SECT, X2, E2, G4 and E6, and decided Ready.
  - Five more requests were then made through `POST /api/requests` (lanes asked L1, L6, L7, L2 and L3). The L3 request carries an injection.
    A Census project routes every request to L8.
  - Two of those items were made Ready in the browser.
  - Bob then decided one G0+G1 in the browser.
- **Personas.** The dev IdP seeds two accounts only: `alice`, factory admin, who after card 4 holds admin, kill, m4, g5 and requesters on testbed;
  and `bob`, who holds intent, design, g4, x and sec (`platform/compose/config/idp-seed.json`). The prototype's 11 personas do not exist. Viewer,
  auditor, security-only and product-owner cuts could not be clicked through. They are reviewed from source and marked "source" in the
  persona column.
- **Crawl.** Playwright 1.63 (global install), driving Chrome, visited 64 routes as each persona: every static route, every item, every card
  and the onboarding record. It used a 1280 px viewport, plus 390 px phone width and the light colour scheme on a subset. For each page it
  recorded the h1, nav, buttons, "not built" panels and console errors, and ran axe-core 4.14.0 with the tags `wcag2a`, `wcag2aa`,
  `wcag21a`, `wcag21aa` and `wcag22aa`. axe was injected into the authenticated page with `bypassCSP`, because the strict CSP blocks inline
  injection. The vendored accessibility-tester's `npx @axe-core/cli` would only have seen the sign-in page.
- **Scripts (scratchpad, not committed).** All under `/tmp/claude-0/-home-user/fd91d272-8d85-5423-ac89-51234d5138f6/scratchpad/`:
  - `review/crawl.mjs`, `review/journeys.mjs`, `review/controls.mjs`, `review/seed-items.mjs`;
  - the inventory generator `inv/gen.py`, with `inv/dump.ts` and `inv/config.ts` bundled by esbuild from the repo;
  - raw results `portal-review/crawl.json` and `portal-review/j/journeys.log`.
- **Screenshots.** In `/tmp/claude-0/-home-user/fd91d272-8d85-5423-ac89-51234d5138f6/scratchpad/portal-review/`. The `SHOT/` prefix in the
  tables below means that directory: crawl shots `<persona>-<route>.png`, journey shots `j/*.png`, the e2e's own shots `e2e/*.png`.
- **Screenshot index.** [`portal-review-screenshots.md`](portal-review-screenshots.md) lists every file with its persona, route, h1 and axe
  result.
- **Cleanup.** The stack was taken down with `down -v`. The two images created (`aisdlc/factory:review`, `aisdlc/review-runtime:local`)
  were removed.

Status words:
- **BUILT**: the job can be done in the portal.
- **THIN**: the screen exists but the job is partial, awkward or read-only where the spec needs an action.
- **MISSING**: no screen. The backend may exist.
- **NOT-IN-PORTAL-BY-DESIGN**: the spec keeps it out of the portal. The reason and its file are given.

## 1. Sign-in, sessions, step-up, access, 403/404, nav

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Sign in | OIDC with the IdP; strict CSP (coverage §6.3) | "Sign in" goes to `/auth/login`, then the dev IdP's account picker, then home. The CSP has `default-src 'self'` and `frame-ancestors 'none'`, with no inline code. The session cookie cannot be read by script | BUILT | `SHOT/signedout-.png` | signed out, alice, bob |
| Sign out | sign-out ends the session | the Sign out button; `/api/me` is 401 afterwards (checked by the e2e) | BUILT | `SHOT/alice-.png` | alice |
| Deep link when signed out | after sign-in, return to the page asked for | `/items/:id` and `/config` show the same "Sign in" page. After sign-in the person lands on `/`, not on the page they asked for | THIN | `SHOT/signedout-items-c54641de-3007-83d3-9c84-5d90ffdd7386.png` | signed out |
| Sessions: list, end, sign-in history | coverage §2 `signins`; portal-config gap 7 | no screen; sessions are bff rows with no route | MISSING | — | alice |
| Session policy shown | coverage §2 `login` "session policy shown" | not shown (`BFF_IDLE_SECONDS`/`BFF_ABSOLUTE_SECONDS` are deployment env) | MISSING | — | — |
| Step-up | G5, M4 and G4 on a sensitive path need step-up (`GATE_POLICIES.step_up`) | M4 on card 5 re-logs in at the dev IdP, returns to the card, and binds the proof to the hash (e2e). The G5 screen does not exist (§4). Controls take no step-up ("not built yet (M9.7 follow-up)") | THIN | `SHOT/e2e/m8-c5.png` | alice |
| My access | bindings, per-project "what can I do", own access requests, sessions | bindings table (6 for alice: role, scope, view and data class, source, end, state), and per-project actions from the PDP. Access requests and sessions are absent | THIN | `SHOT/alice-me-access.png`, `SHOT/bob-me-access.png` | alice, bob |
| 403 with reason | an entry the person cannot open lists nothing; a direct link gives 403 with the reason and "See my access" | bob gets "You cannot open this" on `/scheduler`, `/sandboxes`, `/controls`, `/kill`, `/health`, `/agents`, `/evals`, `/models`, `/integrations`, `/ledger`, `/audit`, `/config`, `/people`, `/teams`, `/access-explain`, `/projects/testbed/ledger` and `/projects/testbed/learn` | BUILT | `SHOT/bob-scheduler.png` | bob |
| One 404 for missing and invisible | "Nothing here" for both | `/items/<unknown uuid>` and `/nope` both show "Nothing here". A confidential project without a role could not be tested (one project) | BUILT | `SHOT/alice-nope.png` | alice, bob |
| Nav per persona | nav entries match the PDP; groups Work/Decide/Projects/Operate/Quality/Govern/Admin | alice: all 28 NAV entries, plus the project shortcut `testbed` and "What can I do?". bob: Home, Floor, Fleet, Board, Items, Ask, Inbox, Notifications, Projects, Catalogue, Roles, Access requests. Operate and Quality are guarded by `audit.read` on the fleet until `ops.read`/`quality.read` exist (`shell/nav.ts`), so a security or ops person without `audit.read` sees no Operate at all | THIN | `SHOT/alice-.png`, `SHOT/bob-.png` | alice, bob |
| Deep link to a config key | `/config/<key>` is a page | a reload or a pasted link to `/config/gateway.routes`, `/config/sandbox.caps` (any key with a dot) returns the bff's raw JSON `{"error":{"code":"not_found","message":"no such file"}}`: the static server treats a dotted last segment as a file. In-app navigation works | THIN (bug) | `SHOT/alice-config-gateway-routes.png` | alice, bob |
| Personas beyond two | prototype accounts lt, oh, rb, ar, pm, dn, ks, jm, mw, nf, tb (coverage §1) | the dev IdP seeds alice and bob only. No viewer, auditor or security persona exists to test the viewer cut, data-class cuts or `audit.read` for project admins | THIN (test data) | — | source |

## 2. Integrations (factory admin)

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Integrations page | registry rows with health, events (portal-config §2.1: V E D P H T C) | health tiles (fake, Anthropic, GitHub App) with state, adapter and "enabled for N project(s)", and the published-change table with its M1 ledger entry. Link: "Registry in Configuration" | BUILT (read) | `SHOT/j/a1-integrations.png` | alice |
| GitHub read App (code host row): app id, installation, key file ref | a code_host row of `integrations.registry` (`github_app` adapter, `config` with app id, installation, base URL, credential `app_key` as `file:`) | editable only as the generic schema form of `integrations.registry`: 73 fields for 3 rows, `config` as raw JSON, every row's 8 `forbidden` selects. No GitHub-specific form, and no validation of the app id or installation against GitHub before proposing. The seed puts the first row in from `SEED_GITHUB_APP_ID`/`_INSTALLATION_ID` | THIN | `SHOT/j/a2-config-integrations-registry.png` | alice |
| Push Broker App | `services/codehost` in `CODEHOST_MODE=push` with its own App and `PUSH_ALLOW_LIST` | not a registry row and not in compose (no `CODEHOST_MODE=push` service). Nothing in the portal names it except gate-check's `GATE_CHECK_PUSH_BROKER_LOGIN` | MISSING | — | source |
| gate-check App (`aisdlc/gate`) | its OWN App with exactly `GATE_CHECK_APP_PERMISSIONS` (gate-check-api.md) | deployment env only (`GATE_CHECK_APP_ID`, `_INSTALLATION_ID`, `_APP_KEY_REF`); not in the registry or on the Integrations page. The item page reads its verdicts ("unknown" when unreachable) | NOT-IN-PORTAL-BY-DESIGN for the key (portal-config §6); MISSING for showing its identity and health | — | source |
| gate-relay App (G5 deploy) | its own App (`GATE_RELAY_APP_PERMISSIONS`, gate-relay-api.md) | deployment env only, as above; no health tile | MISSING (show) | — | source |
| Tracker App (issue twin) | `TRACKER_APP_PERMISSIONS` (codehost `issue-tracker.ts`) | the issue-twin page works, but the App's identity and permissions are shown nowhere | MISSING (show) | `SHOT/alice-projects-testbed-issues.png` | alice |
| Guided "create the App on GitHub" (manifest flow) | not specified; the runbook `docs/runbooks/m8.5-live-census.md` does it by hand | none: the admin creates each App on GitHub, downloads the key, drops it into `platform/compose/secrets/` and edits env/seed. Five Apps × (id, installation, key file) | MISSING | — | alice |
| Model providers (anthropic, openai_compat, fake) | rows of the same registry; add/edit/enable, credential reference, test connection (T), rotate (C) | the same generic form: add a row, pick an adapter, set the `secret_ref` (pattern `file:`/`env:`), status enabled/disabled. No "test connection". No rotate button: a rotation is a new revision plus the gateway's `POST /v1/admin/reload {force:true}`, which no screen calls. The health tile reads `unknown · no_recent_call` for Anthropic until a call happens | THIN | `SHOT/alice-health.png` | alice |
| Proposing a registry change | `config.propose`, decided under `factory.m1_policy` | a proposal is refused at once: "the factory M1 needs 1 approver(s) other than the proposer, and allows no waiver (slot admin, 1 holder(s))". There is one factory admin, and no portal screen can make a second (§8) | THIN (blocked on this stack) | `SHOT/j/a5-config-proposed.png` | alice |
| What the admin must do outside the portal | portal-config §1.5, §6: keys are files read by their one holder; `GATEWAY_SECRET_REFS` / `GATEWAY_EGRESS_HOSTS` bound the registry | keys stay out by design. But the portal never shows which references and hosts the deployment allows, so a proposal that names a file outside `GATEWAY_SECRET_REFS` publishes and then fails at the gateway's reload | NOT-IN-PORTAL-BY-DESIGN (values); THIN (the bounds are not shown read-only) | — | source |
| Per-project installs | `integrations.installs` (repos_allowed, models_allowed) | generic form under Configuration; not shown on the project page | THIN | — | alice |

## 3. Models, routes, budgets, agents

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Models and routes | `gateway.models` (limits, prices), `gateway.routes` ((env, data class) to model; no D3) | read tables of both with "Open in Configuration"; edits through the generic form; propose blocked as in §2 | BUILT (read) / THIN (change) | `SHOT/alice-models.png` | alice |
| Budget groups and limits | gateway budget groups per Unit or job: used, reserved, `exhausted_at` (portal-config §2.2 RO) | no screen. The bff has no route to the gateway admin API | MISSING | — | source |
| Agent registry | definitions, contract, tools, data class, prompt sha, scores | `/agents`: 14 rows with steps, contract version, prompt sha256, tools, data class, preferred models, eval score ("no eval run") | BUILT | `SHOT/alice-agents.png` | alice |
| Agent detail (contract schemas, prompt text) | RO: definition, JSON Schemas, tool list, lock entry, PR link | no per-agent page | MISSING | — | alice |
| Agent scores, pass^k, eval history | `GET /api/agents/:id/scores`, `/api/evals/*` | `/evals` run history and the newest result per task with pass^k. The per-agent scores route exists in the bff, but the web never calls it | THIN | `SHOT/alice-evals.png` | alice |
| Per-agent run list and run detail | `GET /api/agent-runs?item=`, `/api/agents/:id/stats` (`core.agent_run`) | the bff routes exist; the web never calls them (inventory §6, bff routes with no web call). No run list, run detail, transcript policy or cost per run | MISSING | — | source |
| Production outcomes, rework caused, cost per agent | DM §3.5/§3.6; `foldAgentScores`, `agentStats` | none in the portal | MISSING | — | source |
| Changing an agent's route | routes are per (environment, data class), not per agent (portal-config §2.1) | the Models page; per-agent is code | NOT-IN-PORTAL-BY-DESIGN (portal-config §2.1, §6: contracts and prompts are code) | — | — |
| Enabling or disabling an agent | portal-config gap 14 | "Switching an agent off: not built yet (M19)". No scope kind for it | MISSING | `SHOT/alice-agents.png` | alice |
| Eval gate verdicts | `gateRun` (CLI) | "Gate results: not built yet (no milestone yet)" | MISSING | `SHOT/alice-evals.png` | alice |

## 4. Request intake and every point where an agent needs a person

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| **Ask for work form** | coverage §2 `ask`: "normalise, taint marks, injection lint, de-dupe, derived lane, who decides G0+G1"; channel N1 | **no form.** `POST /api/requests` exists in the bff (PDP `work.request`) but no web file calls it. The home page says "Ask the factory what to ask for", and the assistant's `ask_for_work` proposal only navigates to `/projects/:id`, which has no form either. The e2e and this review submitted requests by API | **MISSING** | `SHOT/alice-.png`, `SHOT/alice-projects-testbed.png` | alice |
| Normalise / taint / injection / de-dupe feedback | 1.1, 1.2, B27 | after the fact on the item page: a callout when `injection_suspected` ("treated as data and was not obeyed"). `dedupe_links` (the L2 request was linked to 70933bc8) are in the item view but not rendered. Taint marks are not shown | THIN | `SHOT/bob-items-e89e27ad-2c64-8c1f-b94e-d2d1abbf4a26.png` | alice, bob |
| The request text, title, intent, classification on the item page | the item page is the requester's view of their work | the item page shows repo, lane, phase, "waiting" sentence and holds; **no request text, no title, no intent block, no classification, no timeline, no artefacts, no agent runs, no gates list (except G5)**, no assumptions, no rework count, no catalogue version. The approver sees intent and classification only on the G0+G1 card | THIN | `SHOT/alice-items-7c6330d3-98d8-8a4b-aa5b-248018dd457f.png` | alice |
| Classification and lane | 1.3: the factory derives the lane | "Lane L8 (proposed, not yet approved)". There is no explanation of why: Census eligibility routed the L1, L2, L3, L6 and L7 asks to L8. The verdict (`routed_l8`) is in the request response, not on the page | THIN | same | alice |
| S1 1.5 clarifying questions | B1: at most 2 rounds, then PARK 5 bd | "Questions from the factory" with an answer box per question, and a flag when the answer looks like an instruction. PARK shows as a sentence. The round count and the PARK deadline are not shown, and no notification is sent to the requester (no kind for it). Not exercised live: the fake classifier asks nothing | BUILT (source and e2e branch) / THIN (rounds, deadline) | — | source |
| Ready (1.6) | `item.ready` | "Is this ready?" and "Say it is ready" on the item page; it moved to G0+G1 | BUILT | `SHOT/alice-item-ready.png` | alice |
| **Reaching a work gate from the inbox** | inbox: "waiting on me" opens the gate | the inbox lists "Gate G0: item e89e27ad" for bob, but it **links to `/items/:id`, which has no decision form and no link to the card**. The card (`/cards/:card_id`) is reachable only by its URL: the e2e reads card ids from `record.record_event` | **MISSING (dead end)** | `SHOT/j/c1-bob-inbox.png`, `SHOT/j/c2-bob-item-from-inbox.png` | bob |
| G0+G1 decision | bespoke card: classification and intent artefacts, bound by hash | the card renders both artefacts with sha256 and "intact", the subject hash, Approve / Ask for changes / Reject with a reason, and a ledger receipt. Decided live | BUILT (once reached) | `SHOT/j/c3-bob-g0g1-card.png`, `SHOT/j/c4-bob-g0g1-decided.png` | bob |
| G1f, G2, G3d, G3+G3s, E1 | artefact gate cards (`GateArtefacts`, `GateDecide`) | the same component by source. Not reachable on a Census stack (L8 only), and they carry the same inbox dead end | BUILT (source) | — | source |
| B5 human plan | `item.plan`, `submitHumanPlan` | "PlanForm" on the item page when `may.plan` | BUILT (source) | — | source |
| B4 / R2 observe | `item.observe` | B4 (spec gap or ambiguity) and R2 (to a smaller lane) on the item page while G3d is open | BUILT (source) | — | source |
| G3o oracle deviation | its own gate (design slot) | no screen (`EXCEPTION_GATES` lists SECT, Q1, E6, X2, X3, E2 only) | MISSING | — | source |
| X1 irreversible operation (two-person) | HUMAN-WAIT in S6 | no screen | MISSING | — | source |
| X3 new dependency | licence and advisories | ExceptionGate shows the dependency, with licence and advisories as "unknown" | BUILT (source; not reachable on L8) | — | source |
| E6 locked test change | HUMAN-WAIT in S6 / 7.2 | ExceptionGate. Decided live (reject, then D2) | BUILT | `SHOT/e2e/m14-e6.png` | bob |
| HUMAN-WAIT in S6 (G3o, X1, X3, E6) | snapshot kept, slot released | the Scheduler shows a HUMAN-WAIT count and list (0 here). The item page says only "waiting for decisions" | THIN | `SHOT/alice-scheduler.png` | alice |
| Q1 quarantine and SECT | security triage before any handoff | ExceptionGate "Test integrity quarantine" with Confirmed / False positive. Decided live | BUILT | `SHOT/e2e/m14-q1.png` | bob |
| X2 protected path | patch hash bound | ExceptionGate; decided live | BUILT | `SHOT/e2e/m14-x2.png` | bob |
| E2 constitution exception | the report bound | ExceptionGate; decided live | BUILT | `SHOT/e2e/m14-e2.png` | bob |
| D1–D5 handoffs and E4 | the owner of record chooses (FL): D1 S6, D2 S7, D3 G4, D4 hand-back, D5 human-led; E4 takeover or abandon | **no screen.** The item page says "Handed to a person to decide what happens next". Item 8a1cc927 waits at `handoff:e4` with E4 pending, and its E4 card shows only "this card binds no artefacts (not_found)". D5 (`POST /api/items/:id/human-done`) has a bff route the web never calls: "A developer has the work", with no "done" button. D4 hand-back has no route | **MISSING** | `SHOT/alice-items-8a1cc927-223d-8b41-bf0f-a573d688dc8d.png`, `SHOT/bob-cards-18a7b358-6051-8822-a908-013d7d8d55ca.png`, `SHOT/j/c5-bob-item-after-g0g1.png` | alice, bob |
| G4 merge review | always human; modes C/E; B13 changes requested; step-up on a sensitive path | **no screen**: the G4 card shows "this card binds no artefacts (not_found)". The e2e decides G4 by API. The modes, B13 and B14 have no UI, except "Not sure about this merge?" (`item.unsure`) on the item page | **MISSING** | `SHOT/bob-cards-040289d9-b5bc-8f07-ac3d-dc0d8f447588.png` | bob |
| 8.2 the human merges on GitHub | the factory never merges (AGENTS.md) | "Waiting for a person to merge the change". No PR link or head SHA on the item page | NOT-IN-PORTAL-BY-DESIGN (the merge); THIN (no link to the PR) | `SHOT/alice-items-70933bc8-e836-8361-8344-b0b85bc4c94c.png` | alice |
| G5 release | g5 slot, step-up kept; RELHOLD re-request | the item page lists the G5 decisions and offers "Re-request the release" on RELHOLD. **Deciding G5 has no screen** (step-up included); its card would land on the generic artefacts screen | MISSING (decide) / BUILT (re-request) | — | source |
| G6 acceptance | the requester accepts | shown on the close-out page as a decision; no accept screen for the requester | MISSING (decide) | — | source |
| 9.3 close-out, B17 escape, 9.5 mode-E audit | close-out record, escapes, audit sample | `/items/:id/closeout` with escapes (`item.escape`) and the audit form. 404 until 9.3 ran (true for every item here) | BUILT (source) | `SHOT/j/b-closeout.png` | alice |
| E3 / E5 envelope extension, X4 break-glass review, M2/M3/M5/M6 | gate cards | no bespoke screen. Learn proposals link to their META card, which falls to the generic screen | MISSING | `SHOT/alice-projects-testbed-learn.png` | alice |
| B21 SLA escalation | `sla_escalated` notification; inbox due and overdue | onboarding cards carry an SLA. **Work gates in the inbox always have `sla_due_at: null`, `overdue: false`, `escalated: false`** (`services/core/src/portal-reads.ts` `inboxWorkGates`) | MISSING (for work gates) | `SHOT/j/c1-bob-inbox.png` | bob |
| A per-item agent conversation | not specified as a thread. FD-D18: actions by buttons only; human input through cards (OB §6.4) | no per-item thread. Questions are a form, gates are cards. "Ask the factory" is a separate, read-only assistant whose proposals are buttons | NOT-IN-PORTAL-BY-DESIGN (OB §6.4, conversation.ts) | — | — |
| Ask the factory | answers only from what the person can see, cites, proposal buttons (open card, recheck, open s0, open item, ask for work) | thread list, budget bar (`assistant_user_day`), "What it can see for you". On this stack the fake provider's answer is refused ("could not produce an answer that passes the factory checks") | BUILT (structure); not judged (fake provider) | `SHOT/j/b-ask.png` | alice |
| Onboarding assistant | beside the S0 page (portal-config §4) | `assistant/OnboardingAssistant.tsx` on the S0 page | BUILT (source) | `SHOT/alice-s0-01a1d113-12ec-70ff-b78e-11de3e0241fa.png` | alice |
| Per lane: L0 hotfix, L1–L3, L4–L5, L6 epic/initiative (2.4, G1f), L7 spike (report, no push), L8 human-led | the item follows its lane's route | Census routes everything to L8, so only L8 was live (G0+G1, D5, S7, G4, merge). L6's G1f and the L7 spike report have no specific view. "SpikeReport" is a wait state with no screen. L0's follow-up L1 and its overdue block are not shown | THIN | — | alice |
| Assumptions on an item | DM §3.3, coverage §4 | `assumptions` is in the item view (1 per item here) but not rendered | MISSING | — | alice |

## 5. Per-project human gates and settings

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Gating profile (which gates are on, within the floors) | `project.gating_profile` (project layer, M1 at admin); T2 floor | **after onboarding, no screen shows or changes a project's gating profile.** The project page's "Settings" holds per-area levels only. `/config/project.gating_profile` edits the **factory layer** (the default for every project), and only through a JSON textarea for `gates`. Card 4 sets it once, at onboarding | **MISSING** (per project) | `SHOT/j/d1-project.png`, `SHOT/j/d2-config-gating-profile-factory-layer.png` | alice |
| Role map (who decides each gate) | `project.role_map` | set on card 4 at onboarding. Afterwards it is read-only on "Who can do what" (per person: roles, scope, view and data class, allowed actions). No edit screen. Core's `PUT /v1/projects/:id/settings` has no bff route | MISSING (change) / BUILT (see) | `SHOT/j/d3-who-can-do-what.png`, `SHOT/e2e/m8-c4.png` | alice |
| Two-person rule | `project.two_person` (X1, X2, E2, M4, kill release; T2 locked on) | card 4 only; the gate screens show the two-person state | MISSING (change) | `SHOT/e2e/m8-c4.png` | alice |
| Deciders per gate | GateFeasibility; "named but the policy says no" | inbox entries name the deciders and flag "nobody can decide it". The floor shows gate initials and a red dot for an infeasible gate | BUILT | `SHOT/j/c1-bob-inbox.png`, `SHOT/alice-floor.png` | bob, alice |
| Step-up per gate | `GATE_POLICIES.step_up` | M4 only, live (§1) | THIN | — | — |
| How a project's settings change | a project-layer revision with its M1 | the RevisionPage (`/revisions/:gate`) shows and decides one, but only the one card 4 proposed. Nothing proposes a new one | THIN | — | alice |
| Floor and item page reflect gates on/off and who decides | coverage §2 floor | the floor draws every gate of the catalogue (G1f, G2, G3d, G3+G3s, G5, G6) whether or not the project's profile has it. The item page has no gates list | MISSING | `SHOT/alice-floor.png` | alice |
| Release (G5) setting | `project.release` (off or a deploy target) | card 4; factory-layer form only | MISSING (per project) | — | source |
| Merge bypass list | `codehost.merge_bypass` (per repo, factory layer) | generic form under Configuration | THIN | — | alice |
| Exec allow-list | `sandbox.exec_allowed_repos` (DEC-18) | generic form, and a checkbox on the Onboard page | BUILT | `SHOT/alice-onboard.png` | alice |
| WIP limit and default envelope | `project.wip_limit`, `project.default_envelope` (project layer) | factory-layer form only | MISSING (per project) | — | alice |
| Kill delegations | `project.kill_delegations` (DEC-29) | factory-layer form; killswitch delegations have no route | MISSING | — | source |

## 6. Onboarding

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Request onboarding: Census, Light or Full | `/onboard`; Full only as a level-up after Light | repo owner and name, level, project slug, attestations, tier floor, Request. The repo is typed, not picked from the App installation (coverage §2 says "repo from the App installation") | THIN | `SHOT/alice-onboard.png` | alice |
| S0 record (0.1–0.5) | step list, cards, waiting | S0 page with steps and status; done | BUILT | `SHOT/e2e/m8-s0.png` | alice |
| Card 1 (census, gaps, T0, regulatory, criticality) | C1 | decided live | BUILT | `SHOT/e2e/m8-c1.png` | alice |
| Card 2 (Light: claims, practices, instruction text with step-up) | C2 | `C2Form.tsx`; not exercised (Census) | BUILT (source) | — | source |
| Card 3 (Full: code map, seeds, exam, golden, oracle lock, interview) | C3 | `C3Form.tsx`; not exercised | BUILT (source) | — | source |
| Card 4 (controls, attestations, role map, two-person) | C4 | decided live | BUILT | `SHOT/e2e/m8-c4.png` | alice |
| Card 5 (sign-off, M4 with step-up) | C5 | decided live with a step-up | BUILT | `SHOT/e2e/m8-c5.png` | alice |
| SECR | security card | `SecrForm.tsx` | BUILT (source) | — | source |
| BATCH card, X2 pack card | `CardKind` BATCH, X2 | the card page says "The portal does not show this kind of card yet" for BATCH. X2 cards go through ExceptionGate | MISSING (BATCH) | — | source |
| Probe and LF floors, PRR | criteria by level, floors CF/LF/FF, caps | Readiness page: level, tier, effective autonomy, lanes open, criteria and pillars | BUILT | `SHOT/e2e/m8-prr.png` | alice |
| Per-area levels (DEC-25) | per area | a read table on the project page ("Not a setting") | BUILT (read; by design not editable) | `SHOT/alice-projects-testbed.png` | alice |
| Level-up | a new onboarding at the higher level | the Onboard form again; no "level up" action from the project | THIN | — | alice |
| Pack PRs via X2 | onboarding pack through X2 | ExceptionGate X2 | BUILT (source) | — | source |
| Drift, suspension to L8, one-click restore with re-attestation (DEC-21), re-affirm, expiry | coverage §3 "After onboarding" | PRR states (stale, suspended, expired) are labelled. There is no restore, re-affirm or re-onboarding proposal screen: core's `GET /v1/repos/:o/:n/reonboarding` is not proxied | MISSING | — | source |
| Withdraw or resume an onboarding; lower the signable level | core `/v1/s0/:id/withdraw\|resume\|signable-level` | none proxied by the bff | MISSING | — | source |
| Issue twin | gap issues on GitHub, batches, links | `/projects/:id/issues` with "Make a request" per gap. Linking an existing issue (`POST /api/projects/:id/issue-twin/links`) has no web call | THIN | `SHOT/alice-projects-testbed-issues.png` | alice |
| Knowledge | index, system map, code graph, seeds, golden, defects | `/projects/:id/knowledge` | BUILT | `SHOT/alice-projects-testbed-knowledge.png` | alice |
| Onboarding assistant | §4 above | beside S0 | BUILT (source) | — | — |

## 7. Operate

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Scheduler and admission holds | H1–H3, WIP, HUMAN-WAIT | Scheduler page: coding slot, held, HUMAN-WAIT, lists | BUILT | `SHOT/alice-scheduler.png` | alice |
| Sandboxes and caps | slots, class ceilings, sessions; caps via config | class ceilings table. Slots read "unknown" when the controller is down (as here) | BUILT | `SHOT/alice-sandboxes.png` | alice |
| Stop one session | `session.stop` (proposed) | "not built yet (M19)" | MISSING | `SHOT/alice-sandboxes.png` | alice |
| Controls: preview, apply, lift | hold, clamp, halt, maintenance on fleet, project or lane; nonce; ledger | done live: hold on project testbed, preview (7 open items, preview hash, valid until), apply, lift with a reason | BUILT | `SHOT/j/o1-control-preview.png`, `SHOT/j/o2-control-applied.png`, `SHOT/j/o3-control-lifted.png` | alice |
| Step-up on a control; banners | ops verbs `banner.publish`; banner targets | "not built yet (M9.7 follow-up)". Banners are listed; publishing one has no screen (core `POST /v1/banners` is not proxied) | MISSING | `SHOT/alice-controls.png` | alice |
| Kill switch: request, release, two-person, journal | AR9: its own service; DEC-28 two-person release | the signed journal (verified, ledgered). Request and release are "not built yet (M9.7 follow-up)": the bff has no route to the kill switch | THIN (journal BUILT; request/release MISSING) | `SHOT/alice-kill.png` | alice |
| Kill from the portal vs by design | AR9 keeps the kill switch apart from core | a kill when core is down is an operator token, by design out of the portal. The normal request and release by `kill.request`/`kill.release` holders should be in the portal, with the killswitch's own PDP | MISSING (normal path); NOT-IN-PORTAL-BY-DESIGN (core-down operator path, AR9) | — | — |
| Health tiles | integrations, services, loops | integration tiles only. "Service and loop tiles: not built yet (M19)" | THIN | `SHOT/alice-health.png` | alice |
| Degraded banners | kill unreachable counts as killed, Notary down, stale read model | the floor's kill banner and stale banner (source: `FloorPage.tsx`); the Sandboxes "unknown" state seen live | BUILT (floor) | `SHOT/alice-floor.png` | alice |
| Telemetry | OTel collector in compose | not in the portal | NOT-IN-PORTAL-BY-DESIGN (ops tooling; compose README) | — | — |
| R3 breaker: state, reset | `GET /v1/projects/:id/breakers`, `POST .../reset` (opens M5) | not proxied; no screen | MISSING | — | source |

## 8. Quality, Govern, Admin, notifications

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Evals | run history, scores | §3 | BUILT (read) | `SHOT/alice-evals.png` | alice |
| Configuration, factory layer: propose | ConfigConsole for every key | 30 keys listed. Each has the effective value, source, revision, M1 gate and entry, a draft form from the JSON Schema, a diff and propose. Propose was refused on this stack (one factory admin) | BUILT (blocked here) | `SHOT/j/a3-config-list.png`, `SHOT/j/a5-config-proposed.png` | alice |
| Configuration, factory layer: decide | `/config/revisions/:gate` (FactoryRevisionPage) | built by source; not reachable here (no proposal could be made) | BUILT (source) | — | source |
| Configuration, project layer: propose and decide | project revisions | decide only, via RevisionPage, for the card 4 revision. Nothing proposes one (§5) | THIN | — | alice |
| Ledger with verify | entries, offline verify | fleet and project ledger lists, hash-chained entries, "verify offline" instructions | BUILT | `SHOT/alice-ledger.png`, `SHOT/e2e/m8-ledger.png` | alice |
| Audit: exports, erasure, legal hold, retention, decision log | audit-api.md, M19 | `/audit` tabs over the audit service: signed exports (create, download), erasure, legal hold, retention, decision log. Export detail (`GET /api/audit/exports/:id`) is not called | BUILT | `SHOT/alice-audit.png` | alice |
| Catalogue versions | immutable releases | `/catalogue` for everyone: versions, lanes, limits, gating | BUILT | `SHOT/alice-catalogue.png` | alice, bob |
| People, teams | directory | lists. "Suspend, erase, legal hold: not built yet (M19)" on People | THIN | `SHOT/alice-people.png`, `SHOT/alice-teams.png` | alice |
| Roles | role catalogue as data | `/roles` for everyone | BUILT | `SHOT/alice-roles.png` | alice, bob |
| Bindings and grants | identity bindings; coverage §5.6 `access.manage` | no write. Identity writes have no PDP action and no bff route (portal-config gap 6). So **no one can grant a role from the portal**: no second factory admin, no new approver outside card 4 | **MISSING** | — | alice |
| Access requests | an access-request entity | "Access requests: not built yet (no milestone yet)" | MISSING | `SHOT/alice-access-requests.png` | alice, bob |
| Who can do what | the PDP's explain | per project, every person with roles, scope, view, data class and allowed actions | BUILT | `SHOT/j/d3-who-can-do-what.png` | alice |
| Notifications | in-portal list; kinds gate_waiting, sla_escalated, quarantine, handoff, kill | list ("A gate waits for you · testbed · M4 · portal only") | BUILT | `SHOT/alice-me-notifications.png` | alice |
| Notification preferences | channels and kinds; kill kinds unmutable | default channels, per-kind toggles (kill unmutable), Slack member id | BUILT | `SHOT/alice-me-notifications-preferences.png` | alice |
| Notification channels (Slack, email) | `notifications.channels` | generic form under Configuration | THIN | — | alice |

## 9. Floor and fleet

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Catalogue-generated routes, stations, gates with deciders' initials, rooms, pods, back-edges | coverage §2 floor (M19) | all drawn: belts S1–S9, the bypass track, rooms (Declined, Holding, Quarantine, Handoff desk, Scheduler, Done), G0+G1 with "BO", the B12 back-edge, flow and station tables, lane filters, Tags/Mine/Fit | BUILT | `SHOT/alice-floor.png`, `SHOT/j/f1-floor-drawer.png` | alice, bob |
| Stuck, gate feasibility, score chips | M19 | stuck counter, the infeasible-gate dot, score chips "A1 1.0", "A2 1.0" | BUILT | same | alice |
| Kill banner, stale banner, viewer cut | AR9, M19 | in source. Not seen live: no kill, and no viewer account | BUILT (source) | — | source |
| The project's own gating profile on the floor | the floor shows the project's gates | not reflected (§5) | MISSING | `SHOT/alice-floor.png` | alice |
| Fleet | one row per project; confidential collapsed | one row (testbed) with stations, gates, rooms, stuck, kills | BUILT | `SHOT/alice-fleet.png` | alice, bob |
| Board | items by where they stand | BUILT | BUILT | `SHOT/alice-board.png` | alice |

## 10. Cross-cutting

| Item | Spec / plan says | Real portal does | Status | Screenshot | Persona |
|---|---|---|---|---|---|
| Menus and buttons match the PDP for every route | coverage §6.5: Playwright per persona | for alice and bob, every nav entry opened, and every hidden one gave 403 with a reason. No button was found enabled that the server refused. Bob holds no factory role, so he cannot open the factory ledger, yet he decides every gate of testbed (V2) | BUILT (2 personas) | `SHOT/bob-*.png` | alice, bob |
| A viewer sees no titles, artefacts or transcripts | coverage §6.5 | items carry no title for anyone (by design: "Items carry no title here"). The viewer cut is in the bff and floor sources; not tested (no viewer account) | BUILT (source) | — | source |
| Phone width (390 px) | no sideways scroll | no page scrolled sideways (home, inbox, item, floor, agents, project, config) | BUILT | `SHOT/alice--phone.png`, `SHOT/alice-floor-phone.png` | alice |
| Keyboard | a skip link and visible focus | Tab order: "Skip to content", brand, My access, Sign out, then the nav; every stop has a 3 px solid outline. No keyboard map | BUILT / THIN (no keyboard map) | — | alice |
| Contrast (axe 4.14, WCAG 2.2 AA) | WCAG 2.2 AA | **`color-contrast` (serious) on every page: 5 to 25 nodes** (muted text and eyebrows on the dark theme); `link-in-text-block` on most; floor `label-content-name-mismatch` (21) and `target-size` (7); `scrollable-region-focusable` on Fleet and Models. Raw per page: `crawl.json` | THIN | `SHOT/alice-floor.png` | alice, bob |
| Light theme | coverage §4 | `tokens.css`: "Dark is the only theme today". `prefers-color-scheme: light` renders dark | MISSING | `SHOT/alice--light.png` | alice |
| Empty, error and loading states | ErrorState, EmptyState, Loading | used throughout ("Nothing waits on you", "No conversations yet", "The sandbox-controller did not answer" with Try again) | BUILT | `SHOT/alice-sandboxes.png` | alice |
| Global search | coverage §4 | none (no search box on any page) | MISSING | — | alice |
| Cost reports (project, team, per merged item) | DM §3.6, coverage §4 | none | MISSING | — | alice |
| Console errors | none | every work-gate card page logs a 404 on load: `/cards/:id` first asks the onboarding-card route, then falls back to the gate card. The config deep links log a 404 too (P2-13), and `/sandboxes` a 502 when the controller is absent. None is visible to the person | THIN | — | alice, bob |

## 11. Counts

Over the rows of the area tables above (a row with two statuses counts once, under the first):

| Status | Rows |
|---|---|
| BUILT | 59 |
| THIN | 29 |
| MISSING | 43 |
| NOT-IN-PORTAL-BY-DESIGN | 6 |
| total | 137 |

[`portal-review-rows.md`](portal-review-rows.md) gives every inventory row its status. Its counts per status are at the end of that file.

## 12. Prioritised gap list

P1 = a user cannot complete a core job. P2 = possible but awkward or thin. P3 = polish. Size: S ≤ 1 day, M 2–4 days, L a week or more.

### P1

| # | Gap | Spec | Proposed screen / behaviour | Backend | Size |
|---|---|---|---|---|---|
| P1-1 | **No "Ask for work" form**: a requester cannot submit a request from the portal | coverage §2 `ask`; FL S1 1.1–1.4; `work.request` | `/ask-for-work` (and a button on Home, the project page and Items): project and repo, text, optional lane hint. After submit, show the normalised text, taint marks, injection flags, de-dupe links and the derived lane with its reason (eligibility by level), plus who decides G0+G1 | exists (`POST /api/requests`, core `/v1/requests`) | M |
| P1-2 | **Inbox work gates dead-end on the item page**: an approver cannot reach the decision card from the inbox or the item page | coverage §2 `inbox`, `gate-<G>-<KEY>` | The inbox links a `work_gate` to its card. The item page lists every gate (pending and decided, with outcome and ledger entry) and links each pending one to its card. `PortalInboxItem` carries the card id | missing: the card id in `inboxWorkGates` (it has only `gate_instance_id`) and in `ItemView.gates` | S |
| P1-3 | **G4 merge review has no screen** (the card says "binds no artefacts"); modes C/E, B13 changes requested, B14 and step-up on a sensitive path have no UI | FL S8 8.1, G4 always human; `GATE_POLICIES.G4` | A G4 card: the Evidence Pack (signed, head SHA, pass/fail per step), the PR link, the diff summary by path with protected paths flagged, mode C/E, Approve / Request changes (B13 rounds left) / Reject, step-up when a sensitive path is touched | partial: decide routes exist; the G4 subject facts for the portal are missing | M |
| P1-4 | **Handoffs D1–D5 and E4 cannot be acted on**: an item in Handoff, or at D5 human-led, stops with "Handed to a person"; the D5 "done" route is never called; the E4 card shows nothing | FL handoffs; `HANDOFF_DESCRIPTIONS`; `item.human_done` | A handoff panel on the item page: trigger (ET), origin phase, the Handoff Pack, the choices the flow allows (take over, hand back D4, abandon), and the E4 card for the owner of record. For D5 (L8): "I have done the work" with the PR or commit reference | partial: `POST /api/items/:id/human-done` exists; E4 decide facts and D4 hand-back route missing | M |
| P1-5 | **A project's gates and settings cannot be changed after onboarding** (gating profile, role map, two-person, release, WIP, envelope, kill delegations); the ConfigConsole edits only the factory default | OB §1B–1C; ADR-0003 §6; portal-config gap 5 | Project > Settings: the project-layer ConfigConsole for the 8 `project.*` keys. Effective value per project, a form (gates as toggles within the floors, the role map as slot-by-people), diff, propose (an M1 at the project admin slot), pending and history | missing: bff proxy for `PUT /v1/projects/:id/settings` and a project-layer `GET` (core has both) | M |
| P1-6 | **No one can grant a role from the portal** (bindings, a second factory admin, approvers beyond card 4); with one factory admin, every factory config proposal is refused | portal-config gap 6; coverage §5.6 `access.manage`, `identity.admin` | Admin > People: grant or revoke a binding (role, scope, end date), behind a new `access.manage` action and an M1 or two-person rule; access requests (request a role from My access, decide in the inbox) | missing: actions in `ACTION_CATALOGUE`, identity writes behind the PDP, bff routes, an access-request entity | L |
| P1-7 | **G5 release cannot be decided** (step-up kept), and **G6 acceptance** has no screen for the requester | FL S8b, S9 9.2; `GATE_POLICIES.G5` step-up | A G5 card: deploy target, release evidence, gate-relay's deployment state, step-up. A G6 card for the requester: intent and acceptance criteria against what merged | partial: decide routes; G5/G6 subject facts | M |
| P1-8 | **X1 (irreversible operation) and G3o (oracle deviation)** have no screen; both are HUMAN-WAIT in S6 | FL S6; `HUMAN_WAIT_GATES` | Add them to ExceptionGate: X1 shows the command and target (two-person); G3o shows the oracle diff against the G2-approved spec | partial: decide routes; the gate context for X1 and G3o in `GET /v1/cards/:id/gate/context` | M |

### P2

| # | Gap | Spec | Proposed screen / behaviour | Backend | Size |
|---|---|---|---|---|---|
| P2-1 | The item page shows no request text, title, intent, classification, artefacts, timeline, assumptions, rework count or catalogue version | DM §3.3; coverage §2 item (7 tabs) | Item tabs: Request (text, marks, de-dupe), Intent, Artefacts (by hash), Timeline (events folded), Gates, Agent runs, Verify. All cut by view level and data class | partial: `ItemView` has assumptions, dedupe links, rework and gates; artefacts per item and the timeline need routes | M |
| P2-2 | Work gates in the inbox have no SLA (`sla_due_at` null), so B21 escalation is invisible | FL B21; `sla_escalated` | Due, overdue and escalated for work gates, from the gate's SLA; a notification on escalation | missing (SLA for work gates in `inboxWorkGates`) | M |
| P2-3 | No agent run list, run detail, or production outcomes per agent (rework caused, acceptance, cost) | DM §3.5; PLAN M11 | `/agents/:id`: contract and schemas, prompt sha, scores over time (pass^k), runs (state, verdict, cost), run detail with the transcript policy by data class | exists (`/api/agent-runs`, `/api/agents/:id/stats`, `/api/agents/:id/scores`) | M |
| P2-4 | GitHub Apps are configured outside the portal (5 Apps × id, installation, key file) with no guided setup; gate-check, gate-relay, Push Broker and Tracker Apps are not shown at all | portal-config §2.1; gate-check-api, gate-relay-api | Integrations > GitHub: one row per App role (read, push, gate-check, gate-relay, tracker): its id, installation, key reference, the permissions required against those granted (from the App's installation), health. A "create this App" helper with the GitHub App manifest pre-filled with exactly the permission constant | missing: a read route for each App's identity and permissions; the manifest flow (a callback that exchanges the code; key download stays with the operator) | L |
| P2-5 | Model providers: no "test connection" and no "rotate" (reload) action; the deployment's allowed secret refs and hosts are not shown | portal-config §2.1 T, C | Per provider: Test (one metered tiny call through the gateway), Reload after rotation (`POST /v1/admin/reload {force}`), and the read-only bounds `GATEWAY_SECRET_REFS` and `GATEWAY_EGRESS_HOSTS` | missing: bff routes to the gateway admin API | M |
| P2-6 | The `integrations.registry` form is a 70-field generic form with `config` as raw JSON | portal-config §3 | A per-adapter form (github_app, anthropic, openai_compat) generated from `ADAPTER_CONFIG`, with the `forbidden` list fixed and shown, not editable | exists (schema) | M |
| P2-7 | Kill request and release are not in the portal | AR9; DEC-28 | Kill page: request (scope, reason), and release with the second person, through a bff route to the killswitch's own PDP | missing: a bff route to the killswitch (its API exists) | M |
| P2-8 | Budget groups (used, reserved, exhausted) and cost reports per project, team and merged item | DM §3.6; coverage §4 | Operate > Budgets; Govern > Cost: spend over time, budget burn, cost per merged item | partial: `gateway.model_call` events; read routes missing | M |
| P2-9 | Drift, restore with re-attestation, re-affirm, re-onboarding proposals; withdraw or resume an onboarding; signable level | coverage §3; DEC-21; OB §8 | On the PRR and S0 pages: restore, re-affirm, withdraw, resume, lower the signable level, re-onboarding proposals | exists in core (not proxied) | M |
| P2-10 | The floor and the item page do not reflect the project's gating profile (gates drawn though off) | coverage §2 floor | Draw only the gates the item's pinned profile has; mark "off for this project" | partial (the profile is in core) | S |
| P2-11 | R3 breaker state and reset have no screen | FL R3; `breaker.ts` | Project > Breakers: per-lane state, the reset that opens M5 | exists (not proxied) | S |
| P2-12 | Banners cannot be published; controls take no step-up | ops verbs; controls.ts | "Publish a banner" on Controls; step-up on fleet controls | exists (core `POST /v1/banners`; step-up is a core change) | S |
| P2-13 | Deep links to `/config/<dotted.key>` return raw JSON 404 on reload | — | The bff static handler serves the shell for any SPA path, including dotted last segments | bff static fix | S |
| P2-14 | Service and loop health tiles; session stop; agent on/off | M19 | as the NotBuilt panels say | missing | M |
| P2-15 | E3/E5 envelope extension, X4 break-glass review, M2/M3/M5/M6 have no bespoke card | coverage §3 | Gate-specific facts on the card (the envelope and the extension asked; the break-glass act; the eval comparison for M5) | partial | M |
| P2-16 | Clarifying questions: rounds left and the PARK deadline are not shown; the requester is not notified of questions | FL B1 | Show "round 1 of 2, parks on <date>", and notify on questions raised | partial (a notification kind is missing) | S |
| P2-17 | Lane decision unexplained (why a Census project routes L1–L7 asks to L8) | OB §2.1; eligibility | On the item and the request receipt: the eligibility verdict and what level would open the asked lane | exists (in the request response) | S |
| P2-18 | Deep link back after sign-in lands on `/` | — | Keep the asked path through `/auth/login` | bff | S |
| P2-19 | Contrast fails WCAG 2.2 AA on every page (axe `color-contrast`, serious) | WCAG 2.2 AA (coverage §6.5) | Raise the muted and eyebrow tokens; fix `link-in-text-block`, the floor's `label-content-name-mismatch` and `target-size` | none | S |
| P2-20 | Operate and Quality are guarded by `audit.read` until `ops.read`/`quality.read` exist | coverage §5.6 | Add the actions; guard the nav by them | a catalogue change (M3) | S |
| P2-21 | Onboard form takes a typed repo, not one from the App installation | coverage §2 onboard | A picker over the installation's repos | exists (codehost reads) | S |
| P2-22 | The dev IdP seeds two people; the persona e2e of coverage §6.5 cannot run | coverage §6.5 | Seed the prototype's 11 accounts with bindings | seed only | S |

### P3

| # | Gap | Spec | Proposed screen / behaviour | Backend | Size |
|---|---|---|---|---|---|
| P3-1 | Light theme | coverage §4 | the `:root[data-theme='light']` block and a toggle | none | S |
| P3-2 | Global search (items, gates, ledger) | coverage §4 | a search box in the top bar | missing (an index or core queries) | M |
| P3-3 | Keyboard map | coverage §4 | `?` opens the shortcuts | none | S |
| P3-4 | Sessions list and sign-in history; the session policy shown | coverage §2 `signins` | My access > Sessions | missing (bff route) | S |
| P3-5 | No PR link or head on the item at S8a | — | Link the PR (`core.pull_request`) and the head | exists in core | S |
| P3-6 | BATCH card kind not rendered | CardKind | a BATCH card view | exists | S |
| P3-7 | Issue twin: link an existing issue (route not called) | issue-twin.ts | "Link an issue" on the gap row | exists | S |
| P3-8 | A 404 console error on every work-gate card page (onboarding-card probe first) | — | Ask the card kind once (one route answering both kinds) | bff/web | S |
