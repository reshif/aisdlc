# Portal: what the prototype covers, what is missing, and how the real portal gets there

Status: 2026-11-12 (steps 1 and 2 of §6 done). M21 was dissolved on 2026-11-12 (PLAN.md §7a): screens are built as their backends land, the floor is in M19, and this file is the checklist M20's closing portal pass closes.

The portal prototype lives in [`portal-prototype/`](portal-prototype/) (plain browser JS, example data, in memory). Build it with
`node docs/design/portal-prototype/assemble.mjs <out.html>` and open the file; the published copy is the "AISDLC Portal" artifact.
It is a **design reference**: the real portal is `services/web` (React + Vite, served by the bff), and nothing in the prototype
calls the bff. Where the prototype and the specs disagree, the specs win; the open points are listed in §5.

Configuration and maintenance (what each setting is, who proposes and decides it, which routes exist, the one propose → M1 → publish
pattern, the onboarding agent console and the backend gaps) are specified in [`portal-config.md`](portal-config.md).

## 1. What the prototype is built on

- **Access model, mirrored from the contracts** (`portal-prototype/src/access.js`):
  - the 14 roles of `ROLE_CATALOGUE`, each with its view level V1–V3 and data class D0–D2;
  - the `ACTION_CATALOGUE`, with the six portal rows marked `proposed` (added to the catalogue on 2026-11-12, §5 item 6);
  - `GATE_POLICIES`, which gives each gate one deciding slot;
  - `TWO_PERSON_GATES`: X1, X2, E2 and M4;
  - the cross-cutting rules:
    - the requester never decides their own gate, except G6;
    - the plan author and the code author never approve their own work;
    - step-up for G5, M4 and a G4 that touches a sensitive path;
    - confidential projects are invisible without a role on them;
    - factory.admin decides no gate unless a project gives it the slot;
    - fail closed;
    - expiry never approves;
    - an active kill blocks approvals.
- **One engine for every screen**: `A.why(action, resource)`, `A.can`, `A.decideCheck(gate, item)`, `A.act` (a locked button explains itself and offers "request access"), `A.visibleItems()`, `A.viewLevel`, `A.dataClass`. Route guards hide navigation the person cannot open; a direct link gives a 403 with the reason, and an invisible item gives the same 404 as a key that does not exist.
- **Accounts** (dev IdP list):

  | Account | Role |
  |---|---|
  | lt | factory owner |
  | oh | deputy factory admin |
  | rb | project admin |
  | ar | approver and code owner |
  | pm | product owner |
  | dn | engineer (requester) |
  | ks | security |
  | jm | exception approver |
  | mw | web lead, onboarding a repo |
  | nf | auditor |
  | tb | viewer guest |

## 2. Screens that exist (40 routes)

| Group | Route | Access rule | Notes |
|---|---|---|---|
| Shell | `login` | signed out | SSO → account → security key; session policy shown |
| Shell | `home` | signed in | per person: needs you, your requests, your projects, role summary; extra blocks for factory admin, auditor, security, viewer |
| Shell | `my-access` | signed in | bindings, the per-project "what can I do" matrix (click a cell for the policy), own access requests, sessions |
| Work | `floor` | floor.read | live belts, gates with waiting initials, rooms, pods, back-edges, lane shortcuts; hover a chip for its route; station, gate and room drawers; agent score chips; lane holds and kills; viewer mode without titles. **Built (M19, `build/m19`)**: `/floor` over core's `core.floor_position` / `core.floor_move` read model and the bff's cut (`/api/floor/:project`): belts, gates with initials, rooms, pods, back-edges, lane filters, drawers, viewer mode, stale banner; score chips per station, stuck by heartbeat silence, gates nobody can decide flagged, the kill banner (unreachable reads killed) |
| Work | `fleet` | visible projects | one row per project; confidential collapsed for fleet roles only. **Built (M19, `build/m19`)**: `/fleet` over `GET /api/fleet`: stations with counts, gates waiting, rooms, stuck, flagged gates, kills; a confidential project without a role there collapsed to its count, a project the person may not view left out |
| Work | `board`, `items` | project.view | filtered to visible items; titles at D1 |
| Work | `item-<KEY>` | item.view_floor | 7 tabs by view level and data class; actions item.ready / observe / plan; decide only when decideCheck allows |
| Work | `ask` | project.view + work.request to submit | normalise, taint marks, injection lint, de-dupe, derived lane, who decides G0+G1 |
| Work | `chat` | assistant.use | answers only from what the person can see; proposal buttons guarded |
| Decide | `inbox` | signed in | waiting on me / my team / across the factory (fleet roles) / decided by me / watching; "named but the policy says no" |
| Decide | `gate-<G>-<KEY>` | gate.view | bespoke for G0+G1, G2, G3, G4, X1, SECT, E4, G6, M1; generic for the rest (§3) |
| Decide | `card-<ID>` | card.decide | C1, C4, C5, SECR; bootstrap decider until card 4 |
| Projects | `projects`, `project-<ID>` | project.view | overview, work, people & access, settings (edit = M1), drift, audit |
| Projects | `onboard` | project.onboard | repo from the App installation, Census/Light/Full, DEC-18 allow-list |
| Projects | `s0-<ID>`, `readiness-<ID>`, `issues` | project.view | S0 steps 0.1–0.5 and M4; PRR pillars and caps; issue twin batches |
| Operate | `capacity`, `sessions`, `health` | ops.read | pods, queue (H1–H3, WIP), HUMAN-WAIT, envelopes; sandbox classes and ceilings, tripwires, SEC-OB-3; service and loop tiles |
| Operate | `controls`, `kill` | ops.read / kill.request / session.stop / audit.read | preview → nonce → step-up; kill scopes, two-person release, signed journal |
| Quality | `agents`, `agent-<ID>`, `evals`, `gateway`, `integrations` | quality.read | changes via config.propose (factory admin) |
| Govern | `ledger` | audit.read | fleet sees all (confidential collapsed); project admins see their projects |
| Govern | `audit`, `config`, `catalogue`, `notifications` | audit.read / config.propose / everyone / everyone | erasure and legal hold need identity.admin |
| Admin | `org`, `people`, `teams`, `roles`, `access-requests`, `access-explain`, `signins` | identity.admin / access.manage / audit.read (read-only) / everyone for `roles` | bindings change access across the portal at once |

## 3. Thin: the screen exists but is generic or shallow

| What | Missing detail | Lands with |
|---|---|---|
| Gate screens G1f, G3d, G3s, G3o, G5, X4, E1, E3, E5, M2–M6, and M4 as a gate | gate-specific facts: G3d design and threat review, G3s skeleton, G3o oracle deviation, E3 the envelope extension, G5 release evidence, M5 autonomy promotion with its eval comparison, M6 approver grant. **Built in M14.6** (`services/web/src/cards/ExceptionGate.tsx`, bff `GET /api/cards/:id/gate/context`): Q1 (decided through SECT: confirmed or false positive), E6, X2 (the patch hash 6.6 pushed), X3 (licence and advisories shown as unknown until a source exists), E2 (the constitution report), each with the subject hash and what it binds, who may decide and why not you, the two-person state, step-up and a reason bound to the ledger. The compose e2e decides Q1, X2, E2 and E6 in the browser on the scripted S7 (`CORE_WORKER_FAKE_VERIFY=exceptions`); X3 is covered by the component and route tests only, because it is raised only at 6.4 and the census testbed routes every item to L8, which never runs 6.4 | M15 (G5, X4, M2–M6), M17 (G3o) |
| S7 Verify on the item page | **Built in M14.6**: the item page's Verify tab (V2 and above; `services/web/src/items/VerifyTab.tsx`, bff `GET /api/items/:id/verify`) with each check 7.1–7.6, its verdict, findings cut to the data class and the gate it raised; the Evidence Pack viewer (`/items/:id/evidence`: signed, head SHA, the signed bytes re-hashed to their object key, "verify offline" with `aisdlc-verify-pack`: the portal does not check the Notary signature itself); the gate-check runs (`GET /api/items/:id/gate-check`; unreachable or not configured reads unknown, never passing). Still thin: on the compose stack S7 runs over the fakes, so the checks have no findings or pack there | M14 (done), the real kits on compose with M14.3's verify service |
| S8 and S9 | **Built (2026-11-12, `build/portal`)**: G5's decisions and RELHOLD's re-request and B14 on the item page (`items/Governance.tsx`), the 9.3 close-out record with B17 escapes (`/items/:id/closeout`). Still thin: merge reconciliation (B15a, B15b), DeployMarker and rollback B16 as a linked item have no screen of their own | M15 (done), the rest with the floor (M19) |
| Lifecycle states | explain screens for re-laning R1–R4, the R3 breaker, PARK and BLOCKED, the rework budget, MM-2 | M15 |
| Onboarding cards 2 and 3 | card 2 (Light: claims ≤50 with evidence, practices, instruction text with step-up, never affirmed in the proposing session) opens only as decided; card 3 (Full: the code map, seeds, the exam measured, golden candidates, the oracle-lock proposal, the interview) built in M17.1 (`cards/C3Form.tsx`) | M16, M17 |
| After onboarding | per-area level editing (DEC-25), level-up, re-affirm card, drift suspension → L8 and one-click restore with bypass re-attestation (DEC-21), expiry | M16, M17 |
| Notifications | real-time delivery; Slack and email adapter settings per channel | M18 |

## 4. Missing: no screen yet

| What | Spec | Lands with |
|---|---|---|
| 9.4 Learn: proposals the factory makes into M1, M2, M3, M5, M6, with their evidence. **Built** (`/projects/:id/learn`: proposals by META gate with their card, earned autonomy, run 9.4 now) | FL S9, PLAN M15.5 | M15 (done) |
| 9.5 mode-E audit sample and the B19 suspension (>10% over ≥20 samples). **Built**: the audit form on the close-out page, the suspension and the M5 lift request on the learn page | FL S9, PLAN M15.4 | M15 (done) |
| Autonomy: a project's level (A1…) and the history of promotions | PLAN M15.5 | M15 |
| Knowledge: repo index, system map, CodeGraph, spec seeds, golden tasks, knowledge-lint defects | OB 0.3, PLAN M17 | M17 |
| Assumptions (the Assumption entity on an item) | DM §3.3, PLAN M9.4 | M20 (portal pass) |
| Cost reports per project and team (spend, budget burn, cost per merged item) | DM §3.6 | M20 (portal pass) |
| Global search across items, gates and the ledger (only an item-key jump today) | — | M20 (portal pass) |
| Onboarding assistant (M18) beside "Ask the factory" | PLAN M18 | M18 |
| Degraded states: kill switch unreachable (= killed), Notary down with backfill, stale read model | AR9, PLAN M19 | M19 |
| Light theme; accessibility pass (WCAG 2.2 AA); keyboard map | — | M20 (portal pass) |

## 5. Open decisions the prototype exposed

The prototype shows today's spec or contract behaviour for each of these. The real portal follows whatever is decided.

1. **Coding pods.** The floor draws 3 pods, but the code allows one coding session (`CODING_SESSION_CAP = 1`). Decide whether the pod count is config.
2. **Kill scopes.** The domain model has session, item, project, role, model and fleet. `contracts/controls.ts` has fleet, project, lane and session. One vocabulary is needed (DM §8 gap 8).
3. **Payments API readiness.** The example project is at Light but runs L4 lanes, which OB opens only at Full. The prototype makes `api/` and `billing/` Full per area (DEC-25). Keep that, or change the example data.
4. **E4.** The flow text says "the owner of record chooses", but `GATE_POLICIES` gives E4 to the exception slot `x`.
5. **Factory-wide M1.** `GATE_POLICIES.M1` is the project admin slot, and no slot covers a fleet configuration change. Who decides it?
6. **Proposed actions. Decided 2026-11-12 (PLAN.md §7a):** the six actions are in `ACTION_CATALOGUE` (PDP policy 1.5.0; the role catalogue is unchanged). Each switch is checked on the server (core and/or the bff) and hinted in the portal (`useCan`/`Guarded`, the nav guards).

   | Action | What it covers | Held by | Switched from |
   |---|---|---|---|
   | `identity.admin` | SSO, sessions, suspension, erasure and legal hold | factory.admin (fleet only) | `config.decide`: the audit service's and the bff's erasure and hold writes, the Audit panel's buttons |
   | `access.manage` | role bindings and access requests | the project admin slot, factory.admin | nothing yet: no portal route changes a binding (they change through the role map) and access requests have no backend |
   | `ops.read` | scheduler, sandboxes, controls, kill journal, health | factory.admin, factory.auditor, the project admin and security slots | `audit.read`: core `/v1/admission`, `/v1/controls`, `/v1/kills`; bff `/api/admission`, `/api/slots`, `/api/controls` (and the read before a lift), `/api/kills`, `/api/integrations` (with `quality.read`); the Operate nav |
   | `session.stop` | stopping one sandbox session (a kill-class action; the fleet is factory.admin only) | the kill, admin and security slots, factory.admin | nothing: the sandbox-controller cannot stop a running session, so there is no route or button yet |
   | `quality.read` | agents, evals, models and routes, integrations | factory.admin, factory.auditor, the project admin slot | `audit.read`: core `/v1/agents`, `/v1/agents/:id/stats`, `/v1/evals/summary`, `/v1/evals/runs`, `/v1/agents/:id/scores`; the bff's same routes and `/api/integrations`; the Quality nav |
   | `assistant.use` | Ask the factory and the onboarding assistant (a V1 read) | every role that sees the project | `project.view` alone: core and the bff now ask `project.view` AND `assistant.use` (`ASSISTANT_ACTIONS`); the onboarding panel's hint and the Ask nav entry |

   The project admin and security slots hold `ops.read` on their project only, but the Operate screens read fleet-wide views, so in practice Operate is the factory admins' and auditors' until a per-project Operate view exists.

## 6. How the real portal gets there

Decided 2026-11-12: there is no separate portal milestone. Each milestone builds the screens for what it adds, using the prototype as the reference; the screens whose backends were already on main are built on `build/portal` (step 4); the floor is built in M19 on its live read models; M20 closes with the cross-cutting pass (step 5). The work in order:

1. **Foundation.** Done (2026-11-12, branch `feat/portal-foundation`).
   - `services/web/src/ui`: the prototype's tokens as CSS custom properties (`tokens.css`, dark theme; a light theme is one more block) and the components: PageHead, Card, Stat/Stats, KeyValue, Table, Pill, Chip, GateTag, ActorGlyph, Tabs, Timeline, Steps, Drawer, Modal, Toast, LockedButton, EmptyState, ErrorState (403 with the reason; one 404 for invisible and missing).
   - Gates, lanes, steps and actors come from `packages/contracts` (a `Record<Value, look>` per vocabulary, so a new value fails the build until it has a look).
   - The shell (`src/shell`): top bar, navigation grouped Work, Decide, Projects, Operate, Quality, Govern, Admin (an entry the person cannot open is not listed; a group with nothing to open is not shown), My access, sign-out. Every existing screen (projects, project, onboarding, S0, cards, gate cards, items, inbox, settings revision, readiness, ledger) runs in it; Badge is a library Pill and page loads use ErrorState.
   - The configuration pattern (`src/config/ConfigConsole`): for any key registered in core's config registry, the effective value with its revision, M1 gate and ledger entry; a draft form generated from the key's JSON Schema; the diff; Propose (an ordinary revision with its M1 gate, `config.propose`); the open proposals with who decides; the history. Secret references are shown and edited as references. Govern > Configuration lists the keys. Proven on `sandbox.caps` and `sandbox.exec_allowed_repos`.
2. **Access from the server.** Done (same branch).
   - `GET /api/me/access`: the person's bindings (in force or not, with the reason), and per project the highest view level and data class of the roles in force there and what the PDP allows on the project. Only projects the person holds a binding on are listed.
   - `POST /api/me/decisions`: up to 50 `{action, resource}` pairs decided by the real PDP as capability probes (not logged). A pair on a project the person cannot view answers `not_visible`, exactly like a project that does not exist.
   - `AccessProvider`, `useCan(action, resource)` (batched per render) and `<Guarded action resource>` (hide, or a LockedButton with the PDP's reason and "Request access" to My access, which names the roles that would grant it). A pending, failed or mismatched answer is a deny.
   - Every write is still decided by the PDP on the server; a bff test shows a write the hint called allowed refused once the PDP says no.
   - Still open: the per-project matrix asks only project-level actions (gate, item and card actions need a resource the screen has); access requests have no API yet (My access says whom to ask); bootstrap grants (`liveBootstrap`) are not listed as bindings; a factory-layer M1 is decided at `/config/revisions/:gate` (M15.5's `factory.m1_policy`; the console links each pending revision there).
3. **Sign-in.** OIDC with the real IdP (the dev IdP in local-prod), the session policy from config, step-up as today (`SignedStepUp`), sign-out, ending sessions.
4. **Screens whose backends are on main** (`build/portal`, 2026-11-12): home and the items list/board; quality (agents, evals, models and routes, integrations); operate (scheduler and capacity, sandboxes, controls and the kill switch, health); govern (ledger, audit, catalogue); admin (people, teams, roles, access requests, who can do what). A screen whose backend does not exist shows "not built yet (Mxx)", never example data. Still to build with their milestones: the floor (M19), the gate screens of §3 (M15, M17), knowledge (M17), S8/S9 and learn (M15).
   - Done (2026-11-12): web routes `/`, `/projects`, `/items`, `/board`, `/agents`, `/evals`, `/models`, `/integrations`, `/scheduler`, `/sandboxes`, `/controls`, `/kill`, `/health`, `/ledger`, `/audit`, `/catalogue`, `/people`, `/teams`, `/roles`, `/access-requests`, `/access-explain`. Shapes in contracts `portal-lists.ts`; core `GET /v1/items|agents|catalogue|admission|controls|kills|audit/decisions`; bff the same under `/api/` plus `/api/slots` (sandbox-controller, scope read), `/api/integrations`, `/api/directory`, `/api/projects/:id/explain` and `POST /api/controls/preview|/api/controls|/api/controls/:id/lift` (core scope `ops` for the bff). Operate, Quality, Audit, People and Teams are guarded by `audit.read` on the fleet until `ops.read`/`quality.read` exist (§5 item 6).
   - Marked "not built" on those screens: kill request and release from the portal (no bff route to the kill switch, AR9), step-up on a control and banner publishing, session stop, agent on/off (M19), eval gate verdicts (core records runs only), service and loop health tiles (M19), access requests (no API), suspension (identity). Erasure, legal hold, retention and signed exports are built in M19 (`/audit` tabs over the audit service, `docs/specs/audit-api.md`), guarded by `config.decide` on the fleet until `identity.admin` exists.
5. **M20 closing pass: proof per persona and the cross-cutting work** (WCAG 2.2 AA, light theme, keyboard map, global search, cost reports).
   - Playwright runs as each account in §1. For every route it checks that the menu and the buttons match the PDP's answers.
   - A viewer sees no title, artefact or transcript.
   - An invisible project gives 404.
6. **Done when:**
   - every row of §3 and §4 is built or explicitly dropped by the user;
   - §5 is decided;
   - the persona e2e is green in CI.
