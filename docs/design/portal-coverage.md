# Portal: what the prototype covers, what is missing, and how the real portal gets there

Status: 2026-11-10. Owner of the plan: PLAN.md M21 (portal lift). This file is the checklist M21 closes.

The portal prototype lives in [`portal-prototype/`](portal-prototype/) (plain browser JS, example data, in memory). Build it with
`node docs/design/portal-prototype/assemble.mjs <out.html>` and open the file; the published copy is the "AISDLC Portal" artifact.
It is a **design reference**: the real portal is `services/web` (React + Vite, served by the bff), and nothing in the prototype
calls the bff. Where the prototype and the specs disagree, the specs win; the open points are listed in §5.

## 1. What the prototype is built on

- **Access model, mirrored from the contracts** (`portal-prototype/src/access.js`):
  - the 14 roles of `ROLE_CATALOGUE`, each with its view level V1–V3 and data class D0–D2;
  - the `ACTION_CATALOGUE`, plus six portal rows marked `proposed`;
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
| Work | `floor` | floor.read | live belts, gates with waiting initials, rooms, pods, back-edges, lane shortcuts; hover a chip for its route; station, gate and room drawers; agent score chips; lane holds and kills; viewer mode without titles |
| Work | `fleet` | visible projects | one row per project; confidential collapsed for fleet roles only |
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
| Gate screens G1f, G3d, G3s, G3o, G5, X2, X3, X4, E1, E2, E3, E5, E6, Q1, M2–M6, and M4 as a gate | gate-specific facts: G3d design and threat review, G3s skeleton, G3o oracle deviation, X2 protected-path diff with the patch hash, X3 the new package with licence and advisory facts, E2 the constitution report, E3 the envelope extension, E6 the locked-test change request, Q1 the test-integrity finding, G5 release evidence, M5 autonomy promotion with its eval comparison, M6 approver grant | M14 (Q1, E6, X2, X3, E2), M15 (G5, X4, M2–M6), M17 (G3o) |
| S7 Verify on the item page | per-check results 7.1–7.6 with mutation score, holdout, stub probe, conformance findings; Evidence Pack viewer (signed, head SHA, verify offline); gate-check run status | M14 |
| S8 and S9 | merge reconciliation (B15a clean rebase → S7, B15b conflict → S6), release and DeployMarker, RELHOLD, rollback B16 as a linked item, close-out record 9.3 | M15 |
| Lifecycle states | explain screens for re-laning R1–R4, the R3 breaker, PARK and BLOCKED, the rework budget, MM-2 | M15 (before M21) |
| Onboarding cards 2 and 3 | card 2 (Light: claims ≤50 with evidence, practices, instruction text with step-up, never affirmed in the proposing session) opens only as decided; card 3 (Full) absent | M16, M17 |
| After onboarding | per-area level editing (DEC-25), level-up, re-affirm card, drift suspension → L8 and one-click restore with bypass re-attestation (DEC-21), expiry | M16, M17 |
| Notifications | real-time delivery; Slack and email adapter settings per channel | M18 |

## 4. Missing: no screen yet

| What | Spec | Lands with |
|---|---|---|
| 9.4 Learn: proposals the factory makes into M1, M2, M3, M5, M6, with their evidence | FL S9, PLAN M15.5 | M15 |
| 9.5 mode-E audit sample and the B19 suspension (>10% over ≥20 samples) | FL S9, PLAN M15.4 | M15 |
| Autonomy: a project's level (A1…) and the history of promotions | PLAN M15.5 | M15 |
| Knowledge: repo index, system map, CodeGraph, spec seeds, golden tasks, knowledge-lint defects | OB 0.3, PLAN M17 | M17 |
| Assumptions (the Assumption entity on an item) | DM §3.3, PLAN M9.4 | M21 |
| Cost reports per project and team (spend, budget burn, cost per merged item) | DM §3.6 | M21 |
| Global search across items, gates and the ledger (only an item-key jump today) | — | M21 |
| Onboarding assistant (M18) beside "Ask the factory" | PLAN M18 | M18 |
| Degraded states: kill switch unreachable (= killed), Notary down with backfill, stale read model | AR9, PLAN M19 | M19 |
| Light theme; accessibility pass (WCAG 2.2 AA); keyboard map | — | M21 |

## 5. Open decisions the prototype exposed

The prototype shows today's spec or contract behaviour for each of these. The real portal follows whatever is decided.

1. **Coding pods.** The floor draws 3 pods, but the code allows one coding session (`CODING_SESSION_CAP = 1`). Decide whether the pod count is config.
2. **Kill scopes.** The domain model has session, item, project, role, model and fleet. `contracts/controls.ts` has fleet, project, lane and session. One vocabulary is needed (DM §8 gap 8).
3. **Payments API readiness.** The example project is at Light but runs L4 lanes, which OB opens only at Full. The prototype makes `api/` and `billing/` Full per area (DEC-25). Keep that, or change the example data.
4. **E4.** The flow text says "the owner of record chooses", but `GATE_POLICIES` gives E4 to the exception slot `x`.
5. **Factory-wide M1.** `GATE_POLICIES.M1` is the project admin slot, and no slot covers a fleet configuration change. Who decides it?
6. **Proposed actions.** Six actions are not in `ACTION_CATALOGUE` yet. Adding them is an M3 catalogue/permission change.

   | Action | What it covers |
   |---|---|
   | `access.manage` | role bindings and access requests |
   | `identity.admin` | SSO, sessions, suspension, erasure and legal hold |
   | `ops.read` | scheduler, sandboxes and health |
   | `session.stop` | stopping one sandbox session |
   | `quality.read` | agents, evals, gateway and integrations |
   | `assistant.use` | Ask the factory |

## 6. How the real portal gets there (M21)

Each milestone from M14 on builds the screens for what it adds, using the prototype as the reference. M21 then closes what remains. The work in order:

1. **Foundation.**
   - Move the prototype's tokens and components into `services/web` as a small component library: page head, card, stats, table, pills, chips, gate tags, actor glyphs, tabs, timeline, steps, drawer, modal, toast, locked button.
   - The vocabulary comes from `packages/contracts`, never re-listed.
2. **Access from the server.**
   - A bff route `GET /api/me/access` returns the person's bindings, view levels and data classes per project, and a batch of PDP decisions for the actions the current screen shows (from `access.explain`).
   - `A.act` becomes a `<Guarded action resource>` component.
   - Every write is still decided by the PDP on the server. The client hint only hides or locks buttons, and never grants.
3. **Sign-in.** OIDC with the real IdP (the dev IdP in local-prod), the session policy from config, step-up as today (`SignedStepUp`), sign-out, ending sessions.
4. **Screens, ported in this order:**
   1. home and inbox;
   2. the item page and the gate screens (all gates, §3);
   3. the floor: live through the M19 read models, routes generated from the catalogue, so DM gap 12 never appears;
   4. projects and onboarding;
   5. operate;
   6. quality;
   7. govern;
   8. admin.
5. **Proof per persona.**
   - Playwright runs as each account in §1. For every route it checks that the menu and the buttons match the PDP's answers.
   - A viewer sees no title, artefact or transcript.
   - An invisible project gives 404.
6. **Done when:**
   - every row of §3 and §4 is built or explicitly dropped by the user;
   - §5 is decided;
   - the persona e2e is green in CI.
