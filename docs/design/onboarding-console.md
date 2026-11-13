# Onboarding Agent Console: design and the owner's decisions (2026-11-13)

## Owner's decisions (these override the design's recommendations below)
1. **Chat, and the agent acts more.** The onboarder is conversational. Beyond explaining, it may take low-risk onboarding actions itself. Gates (C5/M4 sign-off, step-ups, M1 config changes, X2) stay human-decided, because AGENTS.md says humans decide gates. Wherever "acts more" meets a gate, the agent prepares everything and the person presses one button in the console.
2. **Autonomy: the agent checks the repo, figures out what's missing, proposes changes and creates PRs to get the repo ready for onboarding.** Then it prompts the person for everything else needed (tier, role map, settings, attestations), explains each, records the answers and walks the onboarding to sign-off. Automatic: reading the census, facts, floors and probe; re-check controls; re-census; running the probe (DEC-18 and B1 guards unchanged); drafting the fix PR. The fix PR still goes through X2 before the Push Broker pushes. The factory never merges; the person merges.
3. **Test command missing: the agent proposes one and the human decides** (accept, edit or reject in the console). If accepted, it goes into the fix PR (package.json script / Makefile target that the detector reads) and/or a person-attested `s0` event the probe uses, decided by the person.
4. **/assistant ("Ask the factory"): the owner wants the right mental model, not this page.** Working model: the Console is the factory's ONE agent surface. A session has a subject (an onboarding today; a project or an item later). /assistant becomes the console's session list, with "start a session". The old one-shot Q&A page is removed. Write this mental model up in the design doc so the owner can change it.
5. Guidelines: factory-level config `onboarding.agent_guidelines`, M1-gated (the factory admin may act alone, recorded); per-session person notes may only narrow.

## Diagnosis (from the design pass, checked in code)
- The `onboarding` agent (services/core/src/onboarding-v2/agent.ts) is one batch call per census from the `onboarding_agent` loop. No tools are wired (KnowledgeSearch is in its contract but not offered), it is D1 so it can't read repo text, and "Ask the agent again" reruns the batch. Locally it is FakeOnboardingAgent, the same canned AGENTS.md for every repo.
- The assistant (services/core/src/conversation/, web assistant/OnboardingAssistant.tsx, AskPage.tsx) is a separate agent. Its grounding has census counts plus "card Cx open", with no floors, probe, SECR or agent proposal. It can only act through five closed navigation buttons (ProposalActionId).
- The person is the integrator: census, then C1, C2, C4, C5, SECR and X2, decided in different places; OB §6.4 says "not a chat, buttons only".
- Owner-hit failures:
  - Tier is raise-only (packages/onboarding/src/fold.ts raiseAttestations). Nothing checks M4 quorum feasibility before C1 (gateFeasibility exists in packages/decisions/src/feasibility.ts but isn't used here).
  - **Bug:** the agent's test_command fix writes `.factory/test-command`, but planProbe (packages/onboarding/src/light/probe.ts) reads only task_command facts from services/knowledge/src/detectors/task-contract.ts, which never reads that file. LF3 can never unblock that way.
  - Probe b1_blocked from an open SECR finding becomes LF3 unknown with no explanation chain.
- There is no "what blocks sign-off and whose move" layer anywhere.

## The console (/onboard/:id), three panes
- **Plan (left):** a live checklist from a deterministic blocker graph `explainS0(state)` (new, packages/onboarding/src/explain.ts). Nodes: steps, floors, cards, findings, controls, feasibility; edges "blocked by"; each node has an owner (agent | you | security | signer | github), a reason code and a next action. Includes `signoffFeasibility(tier, roleMap)` via gateFeasibility over the M4/C5 quorum the choice would freeze.
- **Conversation (centre):** person turns, agent turns, tool calls folded. Proposals render inline as chips (Accept / Edit / Reject). Accepted chips write the person's choice into a server-side summary draft (N12 `PATCH /v1/s0/:id/summary`, new). The one sign-off (onboarding-v2/sign-off.ts) then decides the cards with today's ledger semantics. SECR and X2 chips call the existing card routes, with the same decider, PDP, step-up and ledger.
- **Evidence (right):** facts with path and commit, controls rows, probe log tail, AGENTS.md diff against the template, PR patch, sign-off package hash.

## The agent `onboarder` (replaces `onboarding`, and `assistant` for S0)
- A server-side tool loop in core, on the pattern of services/core/src/conversation/assistant.ts runTool. Driven by person turns and by record events: census, probe or card changes append an observation turn and wake the session.
- Scope enforcement, with existing mechanisms:
  - The contract (packages/agents/src/spec-data.ts) has steps [] and tools OnboardingRead, KnowledgeSearch, RepoRead, OnboardingPropose, OnboardingAct; D2 to read repo text.
  - The key comes from agentKeyRequest with scope job `onboarding:<s0>` and is revoked on stop.
  - The gateway refuses tools off the key (tool_not_allowed).
  - Tool handlers bind s0, repo, commit and card ids from the session; the model supplies only ids from closed sets the session listed.
  - The PDP: the agent actor holds no grant; every state change is a person's request (card.decide, config.propose, step-up). New actions `onboarding.console.use` and `onboarding.console.steer`.
  - Repo text is data: quoteAsData, text-lint, planted-instruction flags.
- **Control:** session states running | awaiting_person | paused | stopped | done. Pause stops new model calls; stop revokes the key; the kill switch reads as paused. Autonomy per act tool comes from config `onboarding.console` (M1-gated). Budget goes through agents.config. The transcript is `onboarding-session:<s0>` events with text as a RedactablePayload (reuse conversation/store.ts and erasable.ts); each turn records the prompt sha and guideline revision.
- **Tools:**
  - OnboardingRead (census_facts, controls, floors, probe, cards, blockers, signoff_feasibility)
  - KnowledgeSearch
  - RepoRead (new knowledge route GET /v1/repos/:o/:n/file?path=&sha=; secret-hit files are never served)
  - OnboardingPropose (tier, gap_disposition, role_map, settings, claim, instruction_text, fix_file, manual_step, test_command)
  - OnboardingAct (recheck_controls, rerun_census, run_probe, render_fix_pack: record plus X2, never pushes before X2; sync_cards)

## Phases (each shippable, push each to main once `npm run check` passes)
- **P0, why is it stuck (no LLM):**
  - explainS0 and signoffFeasibility
  - core GET /v1/s0/:id/blockers, the bff passthrough, and a blocker list on the current S0 page
  - fix the test-command bug (the proposal must target what the detector reads, or a person-attested `s0.test_command_declared` that planProbe uses)
  - a tier infeasibility warning on C1
  - tests for the three owner scenarios
- **P1:** contracts `onboarding-console.ts`; agent `onboarder` (spec, OutputSchema `onboarder.turn.v1` with no lane/gate/tools/egress/budget fields, prompt, npm run gen); config keys `onboarding.console` and `onboarding.agent_guidelines`.
- **P2:** session engine in core (services/core/src/onboarding-console/: store, tools, loop, port with a scripted fake, routes, wake loop), the bff passthrough, scope, pause, budget and rebuild tests.
- **P3:** the console UI (services/web/src/onboard/Console.tsx with plan, evidence and chips); /assistant becomes the console session list; the e2e onboards through the console on the fake.
- **P4:** proposals and acts, the summary draft, chips wired to the card routes and signOff, the fix PR through render_fix_pack, X2 and the Push Broker, Inbox rows collapsed to one per onboarding.
- **P5:** guidelines, onboarder evals (packages/evals), RepoRead on.
- **P6:** delete the old `onboarding` agent loop and route, OnboardingAssistant and the assistant's `s0` subject (keep the event folds); update docs (AGENTS.md layout entry, PLAN, the OB §6.4 amendment).

## Mental model: /assistant and the Console (decision 4, for the owner to review)

- The Console is the factory's ONE agent surface: a single agent runtime (tool loop, key, budget, transcript, pause and stop) and a single place to see it.
- A **session** has a **subject**. Today the only subject is an onboarding (`s0`); later a project or a work item. The subject fixes what the session may read and which closed sets of ids its tools accept. A session is never free-floating.
- `/assistant` stops being a Q&A page. It becomes the **session list**: every session the person may see, its subject, its state (running, awaiting_person, paused, stopped, done) and a "start a session" button. Opening a session opens its console (`/onboard/:id` for an onboarding).
- The old one-shot "Ask the factory" is removed (P6). Its event folds stay, so history is still rebuildable.
- Unchanged: an agent never decides a gate; a session's actions are a person's requests through the same PDP, step-up and ledger.
- Open question for the owner: should a subject-less session (a general question) exist at all? This draft says no.

## Deviations from the design (code wins)

(Kept up to date per phase.)

### P0
- The test-command fix now writes a `Makefile` or `justfile` with a `test` target (what the task-contract detector reads), never `.factory/test-command`. Because fix files replace whole files and the factory never replaces an existing one, a task file the census already saw (or an unreadable census: fail closed) drops the fix, and a file with no `test` target is dropped. The person-attested `s0.test_command_declared` event is deferred to P4 (accept/edit/reject chips), where the person's choice is recorded.
- `explainS0` lives in `packages/onboarding/src/explain.ts` and is pure over an input the core reads (`services/core/src/onboarding-v2/blockers.ts`); the signing arithmetic is `signoffFeasibility` in `@aisdlc/decisions` (the same `planQuorum` the gate applies, asked before the gate opens). It is not `gateFeasibility`, because no gate is open yet at C1 time.
- The tier warning is per tier on the role map the factory proposes (`role_map.m4_by_tier` in the summary), shown on the Risk selector. It does not yet follow edits to the draft role map: the blocker list and the warning refresh after a save.

### P1
- The agent's output schema id is `onboarder.v1` (the registry requires `name.vN`), not `onboarder.turn.v1`.
- The onboarder's tools are named in `AgentTool` (`OnboardingRead`, `RepoRead`, `OnboardingPropose`, `OnboardingAct`) so the gateway key carries them; core runs them and offers only those it can run (P2: `OnboardingRead`, `KnowledgeSearch`).
- Guidelines (`onboarding.agent_guidelines`) are registered and glossary-listed in P1, but not yet read into the context (P5).

### P2
- The tool loop is in core (`services/core/src/onboarding-console/engine.ts`) on the assistant's pattern, behind a model port (`OnboarderModelPort`: `GatewayOnboarderModel`, `ScriptedOnboarderModel`). A wake runs inline in the person's request (start, message, resume) and in the `onboarding_console` loop of core-worker (agents mode only, kill switch asked per project, unreachable is a kill).
- The key is per wake: minted from the contract with scope `job` `onboarding:<s0>` on budget group `onboarding_console:<s0>`, revoked when the wake ends. So "stop revokes the key" holds by construction; pause and stop end new model calls.
- Session text is kept in `core.console_payload` (own table naming the S0 id, so a deletion of the onboarding sweeps it) rather than the assistant's `conversation_payload`. It is not yet exposed to the audit service's erasure port (`ErasablePayloadsPort`); the stream type `onboarding-session` is in the deletion engine's project stream types.
- PDP: `onboarding.console.use` (a V1 read, like `assistant.use`) and `onboarding.console.steer` (project admin, factory admin and onboarder roles). The routes ask `project.view` and `onboarding.console.use`, steering also `onboarding.console.steer`.
- P2 offers read tools only. `RepoRead`, `OnboardingPropose` and `OnboardingAct` are refused if called; the proposal tables and events exist and fold, and are used from P4. Context guidelines come in P5.
- The observation is the blockers' fingerprint (ids, codes, owners): the same state is never observed twice. Tests do not yet drive a record change through a decided card; that is covered when P4 wires the card routes.

### P3
- `/onboard/:id` keeps its one page header and gets two tabs: **Console** (the default; plan | conversation | evidence) and **Summary and sign-off** (the existing page, unchanged). The sign-off and the cards stay where they are until P4 wires the chips; the Console never decides anything. No new route name was needed.
- `/assistant` renders the console session list (`services/web/src/onboard/ConsoleSessions.tsx`): the sessions the person may see, plus the onboardings that have none yet, each linking to its console. The old one-shot Ask page is no longer routed (its component and the assistant panel in the summary rail stay until P6). The shell (nav label "Ask the factory", guard `assistant.use`) is another agent's area and was not touched: both actions are V1 reads, so visibility matches; renaming the entry to "Sessions" is a one-line change in `services/web/src/shell/nav.ts` and the glossary once the shell work lands.
- The plan pane reuses the P0 blocker list; the evidence pane shows what the summary already holds (census, controls, fixes, the agent's summary). Probe log tail and the AGENTS.md diff come with P4's proposals.
