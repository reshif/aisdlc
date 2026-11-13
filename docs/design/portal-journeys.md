# Portal journeys, as the portal behaves today

Status: 2026-11-12, `origin/main` at `72b48d1`. These were driven on the local-prod compose stack with the fake GitHub; the method is in
[`portal-review.md`](portal-review.md) §0. `SHOT/` is `/tmp/claude-0/-home-user/fd91d272-8d85-5423-ac89-51234d5138f6/scratchpad/portal-review/`.
A step marked **(outside)** is done outside the portal; **(API)** means the portal has no screen for the step, so it was done with the bff
route; **(breaks)** is where a person cannot go on. Gap numbers (P1-x, P2-x) are those of portal-review.md §12.

## (a) A factory admin sets up GitHub and Anthropic

Persona: alice, the factory admin.

1. **(outside)** Create the GitHub App for reading repos on GitHub:
   - set its permissions by hand (nothing in the portal states them; the constant is `CODEHOST_ROLE_PERMISSIONS`);
   - install it on the repo;
   - download the private key.

   Do the same for the gate-check App (`GATE_CHECK_APP_PERMISSIONS`), the gate-relay App (`GATE_RELAY_APP_PERMISSIONS`), the Tracker App
   (`TRACKER_APP_PERMISSIONS`) and the Push Broker App. Compose deploys no Push Broker (P2-4).
2. **(outside)** Put each key file under `platform/compose/secrets/`. Then set the read App's id and installation through `init-secrets`/env
   (`SEED_GITHUB_APP_ID`, `SEED_GITHUB_INSTALLATION_ID`), and the other Apps' as `GATE_CHECK_APP_ID`, `GATE_RELAY_APP_ID` and so on.
   Put the Anthropic key in `secrets/anthropic-api-key`. Allow the key file in `GATEWAY_SECRET_REFS` and the host in `GATEWAY_EGRESS_HOSTS`.
   Start the stack. The seed writes the first `integrations.registry` rows (fake, Anthropic, GitHub App). The key files stay out of the portal
   by design (portal-config §6). The portal does not show which references and hosts the deployment allows (P2-5).
3. Sign in, then open Quality > Integrations. The health tiles show "Deterministic fake: ok", "Anthropic: unknown · no_recent_call" and
   "GitHub App: ok", each "enabled for 0 project(s)". Below them, the published changes with their M1 ledger entries.
   `SHOT/j/a1-integrations.png`
4. Click "Registry in Configuration". `/config/integrations.registry` shows:
   - the effective value as JSON, with its revision, M1 gate and entry;
   - a draft form generated from the schema: 73 fields for three rows, `config` as a raw JSON textarea, eight `forbidden` selects per scope,
     and `secret_ref` as a pattern-checked text box.

   There is no GitHub-specific form, no "test connection" and no "rotate" (P2-5, P2-6). Reloading this URL returns raw JSON
   `{"error":{"code":"not_found",...}}` (P2-13). `SHOT/j/a2-config-integrations-registry.png`
5. Quality > Models and routes shows `gateway.models` (vendor name, tools, max tokens, USD per Mtok) and `gateway.routes` ((environment,
   data class) to model) as read tables, with "Open in Configuration". `SHOT/alice-models.png`
6. Propose a change (tried with `sandbox.caps` total 4 to 3; the same path applies to any key). The diff shows "total 4 → 3".
   **(breaks)** "Propose this change" is refused: *"the factory M1 needs 1 approver(s) other than the proposer, and allows no waiver (slot
   admin, 1 holder(s))"*. Alice is the only factory admin, and no screen grants the role to a second person (P1-6).
   `SHOT/j/a5-config-proposed.png`
7. After a decided M1 (on a stack with two factory admins), the revision publishes. **(outside)** The gateway picks up a rotated key file
   only on `POST /v1/admin/reload {force:true}`, which no screen calls (P2-5).
8. Operate > Health later shows Anthropic "ok" after a call. There is no per-call or per-budget view (P2-8).

## (b) A requester's request, from asking to close-out

Persona: alice as requester (she holds `requesters` on testbed), and bob as approver.

1. **(breaks)** There is no "Ask for work" form (P1-1).
   - Home says "Ask the factory what to ask for".
   - "Ask the factory" answers questions; its `ask_for_work` proposal button opens `/projects/testbed`, which has no form.
   - The request was made with `POST /api/requests` **(API)**: `{project_id, repo, lane, text}`. The answer carries the item id and a
     verdict (`state: routed_l8`, the PRR level `census`).
   - Nothing tells the person that their asked lane (L1, L2, L3, L6 or L7) became L8 because the project is at Census (P2-17).
2. Open `/items/<id>` (from Home > Your requests, or from Items).
   - The page shows repo, "Lane L8 (proposed, not yet approved)", "Where it is S1" and the waiting sentence.
   - It does **not** show the request text, title, intent, classification, timeline or artefacts (P2-1).
   - The injected request shows a callout: "The request text looks like it is trying to instruct the factory. It is treated as data and was
     not obeyed." `SHOT/bob-items-e89e27ad-2c64-8c1f-b94e-d2d1abbf4a26.png`
   - A duplicate is detected (`dedupe_links` names item 70933bc8) but is not shown.
3. Clarification (1.5, B1): when the classifier asks, "Questions from the factory" lists each question with an answer box and
   "Send answer". An answer that looks like an instruction is flagged.
   - The round, its limit and the PARK date are shown (`ItemView.clarify`), and the notifier tells the requester each round of questions with the same round and date (`questions_waiting`, P2-16).
   - On this stack the fake asked nothing.
4. Ready (1.6): "Is this ready?", then **Say it is ready**. The item moves to "Waiting for decisions: G0, G1". `SHOT/alice-item-ready.png`
5. G0+G1 (bob):
   - Inbox shows "Gate G0: item e89e27ad" and "Gate G1: …", "decided by Bob Example", "answer due: no time limit".
   - **(breaks)** The link opens the item page. It has no decision form and no link to the card (P1-2).
   - The card is reachable only by its URL `/cards/<card_id>`; the id was read from the record.
   - On the card: Classification and Intent are shown with their sha256 ("intact"), with the subject hash and Approve / Ask for changes /
     Reject with a reason.
   - Approve shows "Decision recorded on the ledger · LEDGER ENTRY #43 · G0: approved".
   - `SHOT/j/c1-bob-inbox.png`, `SHOT/j/c2-bob-item-from-inbox.png`, `SHOT/j/c3-bob-g0g1-card.png`, `SHOT/j/c4-bob-g0g1-decided.png`
6. Then per lane family:
   - **L8 (human-led; every lane on a Census project).**
     1. The item says "S6 · A developer has the work". **(breaks)** There is no "I have done the work" button. D5 was sent with
        `POST /api/items/:id/human-done` **(API)** (P1-4). `SHOT/j/c5-alice-item-after-g0g1.png`
     2. S7: the Verify tab lists 7.1–7.6 with verdicts. The exception gates are decided on their cards:
        - Q1/SECT "Test integrity quarantine": Confirmed or False positive;
        - X2 "Protected-path change";
        - E2 "Constitution exception";
        - E6 "Locked test change".

        Each card shows the subject hash, who may decide, "I have read the evidence" and a reason, and gives a ledger receipt
        (`SHOT/e2e/m14-q1.png`, `m14-x2.png`, `m14-e2.png`, `m14-e6.png`). These cards are also reached only by URL (P1-2).
     3. E6 rejected leads to D2 and the item goes to "Handoff: Handed to a person to decide what happens next". **(breaks)** No choice is
        offered. The E4 card shows "this card binds no artefacts (not_found)" (P1-4).
        `SHOT/alice-items-8a1cc927-223d-8b41-bf0f-a573d688dc8d.png`, `SHOT/bob-cards-18a7b358-6051-8822-a908-013d7d8d55ca.png`
     4. G4: **(breaks)** The G4 card shows "this card binds no artefacts (not_found)". G4 was decided with the bff's card routes **(API)**
        (P1-3). `SHOT/bob-cards-040289d9-b5bc-8f07-ac3d-dc0d8f447588.png`
     5. 8.2: "Waiting for a person to merge the change". **(outside)** The person merges on GitHub, by design. No PR link is shown (P3-5).
        "Not sure about this merge?" (B14, `item.unsure`) is offered.
     6. G5 (when `project.release` names a target): the item lists G5 decisions and offers "Re-request the release" on RELHOLD.
        **(breaks)** G5 itself has no decision screen (P1-7).
     7. G6 and 9.3: the close-out page `/items/:id/closeout` shows the record, B17 escapes and the mode-E audit once 9.3 ran. Before that
        it is a 404 "Nothing here". G6 has no accept screen for the requester (P1-7). `SHOT/j/b-closeout.png`
   - **L0–L5 (agent lanes, Light or Full).** They could not be run on this stack: the project is Census.
     - From source, the gate cards of G1f, G2, G3d and G3+G3s render their artefacts the same way as G0+G1.
     - B4/R2 ("Observe") and B5 ("Write the plan") appear on the item page when allowed.
     - HUMAN-WAIT gates in S6 (X1, G3o) have no screen (P1-8). X3 and E6 do.
     - Everything after S7 is as for L8.
   - **L6 (initiative).** It adds 2.4 and G1f (2.5). G1f has a card; there is no initiative view of spawned children (`item.spawned`).
   - **L7 (spike).** It ends at 6.5 in a spike report. The `SpikeReport` wait state has no screen.

## (c) An approver's day in the inbox

Persona: bob (intent, design, g4, x and sec on testbed).

1. Home: "4 decisions wait for you". The list repeats the inbox, followed by Your roles, Your requests and Your projects. `SHOT/bob-.png`
2. Inbox, "Waiting for you": one entry per gate, so a G0+G1 card shows as two entries.
   - Each entry has project, opened, "answer due" ("no time limit" for every work gate, P2-2) and the deciders. "nobody can decide it" is
     flagged when infeasible.
   - "Open, but not yours to decide" follows. `SHOT/j/c1-bob-inbox.png`
3. Open an entry. Onboarding cards and settings revisions open their card. **(breaks)** Work gates open the item page, which has no decision
   form and no card link (P1-2).
4. On a card reached by URL, read the bound evidence (artefacts with hashes, or the exception's context), tick "I have read the evidence",
   give a reason, then decide. The receipt names the ledger entry.
5. Notifications: "A gate waits for you · testbed · M4 · portal only". Preferences toggle each kind; kill kinds cannot be muted.
   `SHOT/alice-me-notifications.png`
6. There is no batch decide, no filter by gate or project in the inbox, and no "decided by me" or "watching" tabs (coverage §2 lists them).

## (d) A project admin changes the project's gates

Persona: alice (project admin of testbed).

1. Projects > testbed shows level, tier, latest onboarding, links (Readiness, Knowledge, Ledger, Issue twin, Learn), repos and "Settings".
   "Settings" holds only the per-area levels table ("Not a setting"). `SHOT/j/d1-project.png`
2. **(breaks)** No screen shows or changes testbed's gating profile, role map, two-person rule, release target, WIP limit, default envelope or
   kill delegations (P1-5). They were set once, on card 4 at onboarding (`SHOT/e2e/m8-c4.png`).
3. Govern > Configuration > `project.gating_profile` edits the **factory** default for every project, with `gates` as a JSON textarea, not
   testbed's own value. `SHOT/j/d2-config-gating-profile-factory-layer.png`
4. Admin > Who can do what shows who holds which role on testbed and what the PDP allows each person, read-only. `SHOT/j/d3-who-can-do-what.png`
5. The floor draws every gate of the catalogue (G1f, G2, G3d, G3+G3s, G5, G6) whatever testbed's profile says (P2-10). `SHOT/alice-floor.png`
6. The core route exists: `PUT /v1/projects/:id/settings` (`project.settings.edit`) opens a project M1 that RevisionPage can decide. The bff
   has no route to it.

## (e) Watching agent performance

Persona: alice (`audit.read` on the fleet).

1. Quality > Agents lists the 14 agents with the steps each acts at, contract version, prompt sha256, tools, data class, preferred models and
   "Eval score: no eval run". "Switching an agent off: not built yet (M19)". `SHOT/alice-agents.png`
2. Quality > Evals shows run history and the newest result per task with pass^k. Empty here: no `aisdlc-evals run` was recorded.
   "Gate results: not built yet". `SHOT/alice-evals.png`
3. **(breaks)** No per-agent page, run list, run detail, production outcomes (accepted, sent back, reworked, handed off), rework caused or
   cost per agent (P2-3). The bff serves `/api/agent-runs`, `/api/agents/:id/stats` and `/api/agents/:id/scores`, but the web calls none of
   them.
4. The floor shows a score chip per station ("A1 1.0", "A2 1.0") and marks a low score below `factory.floor.low_score`. `SHOT/alice-floor.png`
5. The item page has no "agent runs" tab, so which agent produced an artefact and at what cost is not visible per item (P2-1).
