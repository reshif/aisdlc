# Portal v2 glossary

Status: draft for the owner's approval, 2026-11-13. Written against `origin/docs/portal-v2-intent`
([`portal-v2-intent.md`](portal-v2-intent.md) wins over this file). No screen is built until the owner approves it.

What this file is: every word a person can see in the portal, with the plain label they see, the one-sentence tooltip, where it
shows, and whether the code stays as a small secondary label. The codes stay in the record, the ledger and the API; they leave
the screen.

How to read the tables:

- **Plain label**: what the screen shows. At most four words.
- **Tooltip**: one sentence, shown on hover, focus or tap (the info icon on a phone).
- **Where**: the screens of [`screen-map.md`](screen-map.md) where it appears.
- **Code kept?** `no`: the code never appears. `audit`: the code is shown as a small secondary label only on the Decision log &
  audit screen, the evidence pack viewer and exports. `secondary`: shown as a small grey label next to the plain label on the
  screens named (an auditor needs it there). Nobody has to know a code to use the portal.

Contents: [1 Style rules](#1-style-rules) · [2 Stages](#2-stages) · [3 Steps](#3-steps) · [4 Approvals (gates)](#4-approvals-gates)
· [5 Decisions and verbs](#5-decisions-and-verbs) · [6 Tracks (lanes)](#6-tracks-lanes) · [7 Onboarding](#7-onboarding) ·
[8 Item states](#8-item-states) · [9 Sent back, handed over, paused](#9-sent-back-handed-over-paused) · [10 Parts of the plan
(Units)](#10-parts-of-the-plan-units) · [11 Checks and evidence](#11-checks-and-evidence) · [12 Roles](#12-roles) ·
[13 Actions](#13-actions) · [14 Access levels](#14-access-levels) · [15 Agents](#15-agents) · [16 Operate](#16-operate) ·
[17 Integrations](#17-integrations) · [18 Settings](#18-settings) · [19 Status words](#19-status-words) · [20 Core nouns](#20-core-nouns)
· [21 Machine shape](#21-machine-shape-glossary-in-the-code) · [22 Open points for the owner](#22-open-points-for-the-owner)

---

## 1. Style rules

| Rule | Do | Don't |
|---|---|---|
| Sentence case everywhere: titles, buttons, tabs, menu items | "Approve the plan", "People & gates" | "Approve The Plan", "PEOPLE & GATES" |
| Buttons are verbs, saying what happens | "Approve", "Request changes", "Reject", "Ask for work", "Hand back", "Sign off", "Stop agents" | "OK", "Submit", "Proceed", "G3" |
| The three decision verbs are always the same words, in this order, on every approval | Approve · Request changes · Reject | "Accept", "Deny", "Send back", "Decline" for a decision |
| A destructive button says what it destroys and is red; the confirm repeats the name | "Delete project *payments-api*" | "Delete", "Remove?" |
| Say who and why when something is locked | "Only the release approver can approve this. Ask Ana Ruiz." | a greyed button with no reason |
| No codes in running text, titles or buttons | "Waiting for code review" | "Waiting at G4" |
| When a code is kept (auditors), it follows the label, small and grey, in a monospace chip | Approve the plan `G3` | `G3` Approve the plan; "G3 (Approve the plan)" |
| Numbers: digits, never words; thousands with a thin space or comma per locale; money with currency and two decimals; percentages without decimals unless < 10 | 3 parts, 1,200 tokens, $4.20, 85%, 2.5% | "three", "0.85", "4.2 USD" |
| Limits show used of total | "2 of 3 tries used", "$3.10 of $5.00" | "ET3", "62%" alone |
| Times and dates: relative when under 7 days ("2 h ago", "in 3 working days"); otherwise "13 Nov 2026"; full timestamp with time zone in the tooltip and in Decision log & audit | "Due in 1 working day" | "2026-11-13T09:12:44Z" on a card |
| Working days are called "working days", never "bd" | "Paused after 5 working days" | "5 bd" |
| Unknown is said and treated as no | "Unknown: treated as not passed" | a green tick for unknown, a blank |
| People are names, not handles or ids; the handle goes in the tooltip | "Ana Ruiz" | "ar", "prn_018f…" |
| Hashes and SHAs: never on a decision screen except "Commit 3f2a91c" (7 characters) with copy; full hashes only in the evidence pack viewer and Decision log & audit | "Commit 3f2a91c" | 64 hex characters on a card |
| Plain words for the factory's parts | "agent", "approval", "track", "part", "budget", "readiness scorecard" | "A4", "gate", "lane", "Unit", "envelope", "PRR" |
| One term per thing, from this glossary only (the `GLOSSARY` record, §21) | "code review" everywhere | "merge approval" on one screen, "G4" on another |
| Empty states say what will appear and how to make it appear | "No work yet. Ask for work to start." | "No data" |
| Errors say what happened, what it means and what to do | "GitHub did not answer. Nothing was changed. Try again." | "Error 502" |

---

## 2. Stages

The stage strip on the work item, the floor columns and the items list use these. `S8a` and `S8b` are split only when release is on
for the project.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| S0 | Onboarding | Getting a repo ready so agents can work on it safely. | Onboard, Project › Readiness, Home | audit |
| S1 | Intake | The factory reads the request, checks for duplicates, picks a track and asks questions. | Work item stage strip, Floor, Items | audit |
| S2 | Research | An agent studies the code and docs and lays out the options. | same | audit |
| S3 | Spec | An agent writes what will change and the acceptance tests that prove it. | same | audit |
| S4 | Design | An agent writes the design, contracts, data changes and risks. | same | audit |
| S5 | Plan | The work is split into parts, ordered and given a budget. | same | audit |
| S6 | Build | A coding agent writes the code in a locked-down sandbox and opens a draft PR. | same | audit |
| S7 | Verify | The factory checks the PR (tests, spec, secrets, rules) and signs the evidence. | same | audit |
| S8 | Review and merge | A code owner reviews the PR; a person merges it on GitHub. | same | audit |
| S8a | Merge | The approved PR is merged on GitHub by a person, and re-checked if the base moved. | same | audit |
| S8b | Release | The merged change is deployed, if this project releases through the factory. | same | audit |
| S9 | Close | The requester accepts the result and the factory records what it learned. | same | audit |

---

## 3. Steps

Steps show on the work item's Timeline and Now tabs and in the agent console. Most people never need them; the stage is enough.
"Who" uses the actor glyphs: agent, factory (automatic check), person.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| 0.1 | Read-only scan | The factory and the onboarding agent read the repo: owners, tests, security, settings. | Onboard, Readiness | audit |
| 0.2 | Small-changes review | The agent checks the repo facts and agent instructions needed for small changes. | Onboard | audit |
| 0.3 | Full-work review | The agent maps the code, drafts specs and locks the acceptance tests needed for all work. | Onboard | audit |
| 0.4 | Controls and people | GitHub protections are read and who decides what is set. | Onboard | audit |
| 0.5 | Sign-off | A person signs off the onboarding. | Onboard | audit |
| 1.1 | Read the request | The request is cleaned up and marked as untrusted input. | Timeline | audit |
| 1.2 | Check for duplicates | The factory looks for the same or conflicting requests. | Timeline, Request tab | audit |
| 1.3 | Pick a track | An agent sizes the work; the factory picks the track from the rules. | Timeline, Request tab | audit |
| 1.4 | Check eligibility | The factory checks this repo is ready for this track. | Timeline, Request tab | audit |
| 1.5 | Ask questions | An agent asks what is unclear and writes the agreed goal. | Now, Request tab | audit |
| 1.6 | Mark ready | The requester says the request is ready to be accepted. | Now | audit |
| 2.1 | Study the code | An agent reads the relevant code and docs at the current commit. | Timeline | audit |
| 2.1b | Dig deeper | An agent reverse-engineers an unclear area. | Timeline | audit |
| 2.2 | Find impact | An agent lists what and who the change affects. | Timeline | audit |
| 2.3 | Lay out options | An agent writes the options and a decision brief. | Timeline, Documents | audit |
| 2.4 | Elaborate the initiative | Large initiatives only: an agent breaks the goal down. | Timeline | audit |
| 2.5 | Final goal sign-off | Large initiatives only: a person accepts the goal for good. | Timeline | audit |
| 3.1 | Find affected requirements | An agent finds which existing requirements change. | Timeline | audit |
| 3.2 | Draft the spec change | An agent writes the change to the spec. | Timeline, Documents | audit |
| 3.3 | Validate the spec | The factory checks the spec is complete and consistent. | Timeline | audit |
| 3.4 | Write acceptance criteria | An agent writes the tests that will prove the change. | Timeline, Documents | audit |
| 3.5 | Independent spec review | A second agent with fresh context reviews the spec. | Timeline | audit |
| 4.1 | Decisions | An agent records the design decisions. | Timeline, Documents | audit |
| 4.2 | Contracts | An agent writes interface contracts; the factory checks them. | same | audit |
| 4.3 | Data and migrations | An agent writes the data and migration plan. | same | audit |
| 4.4 | Risks and operations | An agent writes performance, security and operations notes. | same | audit |
| 4.5 | Factory rules check | The design is checked against the factory rules. | same | audit |
| 4.6 | Design review | A person reviews the design and threats. | Now | audit |
| 5.1 | Split into parts | An agent splits the work into parts that can be built separately. | Timeline, Documents | audit |
| 5.2 | Order the parts | An agent decides which part goes first. | same | audit |
| 5.3 | Task list per part | An agent writes the task list for each part. | same | audit |
| 5.4 | Link the tests | Each part is linked to the tests that prove it. | same | audit |
| 5.5 | Set the budget | The factory works out the budget for each part. | same | audit |
| 5.6 | Check capacity | The factory checks there is room to build. | same | audit |
| 5.7 | Schedule | A person or the factory schedules the build. | same | audit |
| 5.8 | Plan approval | A person approves the plan. | Now | audit |
| 6.0 | Start building | The factory gives the part a coding slot and budget. | Timeline, Agent console | audit |
| 6.1 | Prepare the sandbox | A clean sandbox is made from the approved commit. | Agent console | audit |
| 6.2 | Run tests first | The existing tests are run before any change. | Agent console | audit |
| 6.3 | Confirm new tests fail | The new acceptance tests are run and must fail first. | Agent console | audit |
| 6.4 | Write the code | The coding agent works through the task list. | Agent console | audit |
| 6.5 | Self-check | The factory checks the change against the scope, budget and safety rules. | Agent console | audit |
| 6.6 | Open draft PR | The factory bot opens or updates the draft PR. | Agent console, Now | audit |
| 7.1 | Build and tests | Build, lint and the full test suite on the PR's commit. | Verify tab | audit |
| 7.2 | Test integrity | Tests were not weakened and the acceptance tests are real. | Verify tab | audit |
| 7.3 | Matches the spec | The change does what the approved spec says. | Verify tab | audit |
| 7.4 | Secrets and dependencies | No new secret and no unapproved dependency. | Verify tab | audit |
| 7.5 | Factory rules | The change follows the factory rules. | Verify tab | audit |
| 7.6 | Sign the evidence | The factory signs the evidence pack for this exact commit. | Verify tab | audit |
| 8.1 | Code review | A code owner reviews the PR. | Now, Decide | audit |
| 8.2 | Merge on GitHub | A person merges the PR on GitHub; the factory never merges. | Now | audit |
| S8b | Release | The change is deployed after release approval. | Now | audit |
| 9.2 | Requester accepts | The requester checks the result does what they asked. | Now | audit |
| 9.3 | Close-out record | The factory writes the final record of the item. | Timeline | audit |
| 9.4 | Learn | The factory proposes improvements from finished work. | Project › Overview | audit |
| 9.5 | Spot-check audit | A person audits a sample of lightly reviewed merges. | Inbox | audit |

---

## 4. Approvals (gates)

"Gate" becomes **approval** on every screen. Every approval card shows: what is being approved, the evidence, who may decide, and
the three verbs (§5). Approvals that are always on say "Always required". Approvals a project can switch off are listed in
Settings › Approvals.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| G0 | Accept the request | Decide whether the factory should take this request on. | Inbox, Decide, Work item, Floor | secondary (Decide, Floor) |
| G1 | Confirm the goal | Agree what the request is for, before the factory studies it. | same | secondary |
| G1f | Final goal sign-off | Large initiatives only: accept the goal after it has been worked out. | same | secondary |
| G2 | Approve the spec | Approve what will change and the acceptance criteria. | same | secondary |
| G3d | Approve the design | Approve the design and the risks it names. | same | secondary |
| G3s | Approve the outline | Approve how the work is split into parts and ordered. | same | secondary |
| G3 | Approve the plan | Approve the full plan for this exact commit. | same | secondary |
| G3o | Approve test changes | The acceptance tests differ from the approved criteria; approve the difference. | same | secondary |
| G4 | Code review | A code owner approves the PR. Always required. | same | secondary |
| G5 | Approve the release | Approve deploying the merged change. Needs "confirm it's you". | same | secondary |
| G6 | Accept the result | The requester says the change does what they asked. | same | secondary |
| X1 | Allow irreversible action | The agent wants to do something that cannot be undone. | same | secondary |
| X2 | Allow protected-file change | The change touches files only people may change. | same | secondary |
| X3 | Allow new dependency | The change adds a new package. | same | secondary |
| X4 | Review a bypassed merge | Someone merged without the factory's check; review it after the fact. | same | secondary |
| E1 | Allow a lighter track | Move the work to a track with fewer steps. | same | secondary |
| E2 | Allow a rule exception | The work breaks a factory rule; allow it once or not. | same | secondary |
| E3 | Allow more budget | The work needs more budget than planned. | same | secondary |
| E4 | Choose what happens next | The agents are stuck; choose to resume, re-plan, take over or stop. | same | secondary |
| E5 | Override an escalation | Decide an overdue approval on someone else's behalf. | same | secondary |
| E6 | Change a locked test | A locked acceptance test must change; approve the change. | same | secondary |
| M1 | Approve a settings change | Approve a change to the factory's or a project's settings. | Settings, Inbox, Decide | secondary |
| M2 | Approve a rule variance | Let one project differ from a standard rule. | same | secondary |
| M3 | Approve a process change | Change the standard tracks, steps or limits. | same | secondary |
| M4 | Sign off onboarding | Confirm the repo is ready for the level asked. Needs "confirm it's you". | Onboard, Inbox, Decide | secondary |
| M5 | Raise agent autonomy | Let agents do more on this project with less review. | Project, Inbox, Decide | secondary |
| M6 | Grant approver rights | Let a person decide approvals they could not before. | People, Inbox, Decide | secondary |
| Q1 | Security hold | Work stopped because an agent did something unsafe. | Work item, Floor, Inbox | secondary |
| SECT | Security review | A security approver decides if the hold was real before anything else happens. | Inbox, Decide | secondary |
| (gate family) stage | Step approval | An approval on the normal path of the work. | Settings › Approvals | no |
| (gate family) action | Risky action approval | An approval for one risky action. | same | no |
| (gate family) exception | Exception approval | An approval for leaving the normal rules. | same | no |
| (gate family) meta | Factory change approval | An approval for changing how the factory works. | same | no |
| (gate family) quarantine | Security approval | An approval after a security hold. | same | no |
| (gate family) onboarding | Onboarding approval | The approval that ends onboarding. | same | no |
| Toggle group `g0g1` | Accept and confirm goal | Switch "Accept the request" and "Confirm the goal" on or off together. | Settings › Approvals | no |
| Toggle group `g2` | Spec approval | Switch "Approve the spec" on or off. | same | no |
| Toggle group `g3d` | Design approval | Switch "Approve the design" on or off. | same | no |
| Toggle group `g3_g3s` | Plan approval | Switch "Approve the outline" and "Approve the plan" on or off together. | same | no |
| Toggle group `g5` | Release approval | Switch "Approve the release" on or off. | same | no |
| Toggle group `g6` | Result acceptance | Switch "Accept the result" on or off. | same | no |
| `alwaysRequired` | Always required | No project can switch this approval off. | Settings › Approvals | no |
| Off (`GateSwitch` off) | Off: step skipped | This approval does not exist on this project; nothing is approved automatically. | same | no |
| SOLO card / consolidatable | Decided together | Several approvals shown and decided as one card when one person holds them all. | Decide | no |

---

## 5. Decisions and verbs

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| `approve` | Approve | Agree; the work moves on. | Decide, Inbox, Settings | audit |
| `request_changes` | Request changes | Send it back with what must change; the agent tries again. | same | audit |
| `reject` | Reject | Say no; the work stops or goes back as the rules say. | same | audit |
| `supersede` | Replaced | A newer version replaced this one before it was decided. | Decision log | audit |
| `expire` | Expired, not approved | Nobody decided in time; expiry never approves. | Inbox, Decision log | audit |
| `withdraw` | Withdrawn | The request or approval was withdrawn. | same | audit |
| reason (bound into the ledger) | Reason | Why you decided this; saved with your decision. | Decide | no |
| step-up (`SignedStepUp`, D37) | Confirm it's you | Sign in again with your security key before this decision. | Decide, Settings, Kill switch | no |
| two-person (`TWO_PERSON_GATES`, DEC-28) | Needs two people | Two different people must approve this. | Decide, Settings | no |
| `sod_waiver` | Single-approver exception | You decided your own request because you are the only person who can. Recorded. | Decide, Decision log | audit |
| factory-admin override (NEW, intent) | Decide as factory admin | You are deciding outside the normal rules. Your name and reason are recorded. | Decide, Onboard, Settings | no |
| Ask for work (`work.request`) | Ask for work | Send a request to the factory. | Shell, Project, Home | no |
| D4 hand back | Hand back | Give the work back to the agents. | Work item | no |
| D5 dev completes | Mark my work done | Tell the factory your human-led work is ready to be checked. | Work item | no |
| B14 mode-E unsure | I'm not sure | Ask a code owner to do a full review instead. | Decide | no |

---

## 6. Tracks (lanes)

"Lane" becomes **track**: the path a piece of work follows, set by its size and risk. The factory picks the track (step 1.3);
people see the name only.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Lane (concept) | Track | The path this work follows: which steps run and which approvals it needs. | Work item, Items, Floor, Settings | no |
| L0 | Hotfix | An urgent fix that skips planning; a follow-up small change is opened after. | same | secondary (Settings › Tracks) |
| L1 | Quick fix | The smallest change: spec and a short plan, no research or design. | same | secondary |
| L2 | Readiness fix | A fix the factory proposes to close a readiness gap in the repo. | same | secondary |
| L3 | Small change | A small change with a short spec and plan, no design step. | same | secondary |
| L4 | Feature | A normal feature: research, spec, design, plan, build. | same | secondary |
| L5 | Higher-risk feature | A feature with more risk; needs a separate staging environment. | same | secondary |
| L6 | Large initiative | A large piece of work whose goal is worked out and signed off first. | same | secondary |
| L7 | Experiment | A throwaway build to answer a question; ends in a report, never a PR. | same | secondary |
| L8 | Done by a person | A person does the work; the factory still checks and records it. | same | secondary |
| R1 upshift | Moved to a bigger track | The work turned out bigger; steps were added. No approval needed. | Work item, Timeline | audit |
| R2 downshift | Moved to a lighter track | The work is smaller than thought; needs "Allow a lighter track". | same | audit |
| R3 circuit breaker (ET14) | Agents paused on this track | Too many items failed on this track; new work goes to a person until reset. | Project, Floor, Operate | audit |
| R4 hotfix done | Hotfix follow-up | The hotfix is done; a follow-up small change makes it permanent. | Work item | audit |
| eligibility (`eligible`, `unspecified`) | Allowed on this repo | Whether this repo's onboarding level allows this track. | Project › Readiness, Ask for work | no |

---

## 7. Onboarding

Onboarding becomes agent-led (intent §4): the person sees one summary and one sign-off. The cards stay in the record and appear
only on the summary's sections and in Decision log & audit.

### 7.1 Levels and tiers

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Level (concept) | Onboarding level | How much agents may do on this repo. | Onboard, Project, Settings | no |
| `census` | Read only | Agents may read the repo and plan, run experiments, and support people's own work; no agent code. | same | audit |
| `light` | Small changes | Agents may also make small changes, hotfixes and readiness fixes. | same | audit |
| `full` | All work | Agents may also build features and large initiatives. | same | audit |
| Per-area level (DEC-25) | Level by folder | A different level for one part of the repo. | Project › Readiness | no |
| Tier `T0` | Low risk | No production use and no real data; the owner confirms it. | Onboard, Project | secondary |
| Tier `T1` | Standard risk | A normal repo. | same | secondary |
| Tier `T2` | High risk | Production, money or personal data; more approvals and two people. | same | secondary |
| Autonomy `A0` | Agents propose only | Every agent change gets a full human review. | Project › Readiness | secondary |
| Autonomy `A1` | Agents assisted | Agents work; every PR gets a full review. | same | secondary |
| Autonomy `A2` | Agents trusted | Agents work; low-risk PRs may get a light review. | same | secondary |
| Autonomy `A3` | Agents highly trusted | Most PRs get a light review with spot-checks. | same | secondary |
| G4 mode C | Full review | A code owner reviews every line. | Decide | no |
| G4 mode E | Light review | A lighter review; some merges are spot-checked later. | Decide | no |

### 7.2 Onboarding flow and records

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| S0 record | Onboarding | One repo's onboarding: what the agent found, what was fixed, who signed off. | Onboard, Project | no |
| Onboarding agent (NEW; today A9 + deterministic steps) | Onboarding agent | The agent that reads the repo, works out what is missing and proposes fixes as PRs. | Onboard | no |
| Onboarding summary (NEW, replaces cards C1–C5 as the workflow) | Onboarding summary | Everything the agent found and proposes, on one page, for you to adjust and sign off. | Onboard | no |
| Fix PR (pack PR, `agent/<s0>/onboarding-pack`) | Proposed fix (PR) | A pull request the agent opened to fix something; you or a teammate merge it on GitHub. | Onboard | no |
| Card C1 | Owners and risk | Who owns the repo, its risk tier, and what to do about each gap. | Onboard summary section, Decision log | audit |
| Card C2 | Repo facts and instructions | The facts the agent claims about the repo and the instructions agents will get. | same | audit |
| Card C3 | Code map and tests | The code map, draft specs and the tests that will be locked. | same | audit |
| Card C4 | GitHub protection and people | Main-branch protection, the GitHub App's access and who decides what. | same | audit |
| Card C5 | Sign-off | The final onboarding sign-off. | same | audit |
| Card SECR | Secrets found | Secrets found in the repo or its history, and what was done with each. | same | audit |
| Card BATCH | Issues to file | Gaps to file as GitHub issues. | same | audit |
| Card X2 (pack) | Onboarding files change | Approve the files the agent wants to add (AGENTS.md, CODEOWNERS, `.factory/`). | same | audit |
| Claims (≤50, affirm/correct/unknown) | Repo facts | Statements the agent makes about the repo; confirm, correct or mark unknown. | Onboard summary | no |
| `affirm` / `correct` / `unknown` (ClaimVerdict) | Confirm · Correct · Don't know | Your answer to one repo fact. | same | no |
| Intent questions / answers | Questions about the repo's purpose | What the repo is for and what must never break. | same | no |
| Instruction text (AGENTS.md / CLAUDE.md, LF5) | Agent instructions | The only repo text agents follow as guidance; you approve it. | same | no |
| Practices interview | How your team works | Your team's conventions, asked once and reused. | same | no |
| Gap | Gap | Something the repo is missing for the level asked. | Onboard, Readiness | no |
| Gap disposition `file_issue` / `track_only` / `waive` | Fix now (PR or issue) · Track · Accept | What to do about one gap. | same | no |
| Gap status `open` / `closed_verified` / `waived` | Open · Fixed · Accepted | Where a gap stands. | same | no |
| Census posture `red` / `amber` / `green` | Not safe yet · Needs fixes · Ready | The overall result of the read-only scan. | Onboard, Project | no |
| Blocker B1 (onboarding) | Open secret found | A secret in the repo or its history has not been dealt with. | Onboard | audit as `OB-B1` (never "B1": clashes with §9) |
| Blocker B2 | Scan incomplete | The security scan did not finish or is out of date. | same | audit `OB-B2` |
| Blocker B3 | Main branch not protected | The default branch lacks the required protection. | same | audit `OB-B3` |
| Blocker B4 (B4a, B4b, B4c) | GitHub App too powerful | The App holds a permission it must not have, or required checks are wrong. | same | audit `OB-B4` |
| Blocker B5 | Unsafe workflow | A GitHub workflow could leak secrets to an agent PR. | same | audit `OB-B5` |
| Blocker B6 | Deploys on merge, undocumented | Merging deploys, but operations are not documented. | same | audit `OB-B6` |
| Blocker B7 | Test run not isolated | The test run did not run in the isolated sandbox, so it does not count. | same | audit `OB-B7` |
| Control `protect_main` | Main branch protected | The default branch needs PRs, approval and the factory check. | Onboard, Readiness | no |
| Control `app_scope` | App limited to this repo | The GitHub App is installed on selected repos only, with the right permissions. | same | no |
| Control `codeowners` | Code owners file | A valid CODEOWNERS file exists. | same | no |
| Control `instructions` | Agent instructions | Agent instructions exist and are approved. | same | no |
| CF1 | App installed | The GitHub App can reach this repo. | Readiness | audit |
| CF2 | Owner confirmed | A person confirmed they own the repo. | same | audit |
| CF3 | Risk tier set | The risk tier is signed; it can only go up. | same | audit |
| CF4 | Repo facts recorded | Visibility, owner type and plan are recorded. | same | audit |
| LF1 | No open security issues | No blocking security finding is open. | Onboard, Readiness | audit |
| LF2 | Main branch protected | Protection is in force and the factory check is required. | same | audit |
| LF3 | Tests run and pass | Setup and tests run cleanly in the sandbox. | same | audit |
| LF4 | Agent tooling checked | Files that run code or grant tools were checked, and isolation was tested. | same | audit |
| LF5 | Agent instructions approved | A person approved the agent instructions. | same | audit |
| LF6 | Repo facts confirmed | At least 90% of the repo facts are confirmed or marked unknown. | same | audit |
| LF7 | Operations documented | Whether a merge deploys is known and written down. | same | audit |
| LF8 | Network needs declared | Outside hosts the tests need are listed. | same | audit |
| FF1 | Code map complete | The full code map, system map and draft specs exist. | same | audit |
| FF2 | Staging is separate | Staging is separate from production (higher-risk features only). | same | audit |
| Oracle lock (`.factory/oracle-lock.json`) | Locked tests | Tests the agents may not change without an approval. | Onboard, Verify | no |
| Spec seeds (`observed` / `intended`) | Draft specs (as found · as intended) | Specs drafted from the code; you mark which describe the intended behaviour. | Onboard | no |
| Golden tasks | Practice tasks | Past tasks used to test the agents on this repo. | Onboard | no |
| Exam (`correct` / `incorrect` / `unsure`) | Knowledge quiz | Questions that test what the agent learned about the repo. | Onboard | no |
| Onboarding status `app` | Waiting for the GitHub App | Install the factory's GitHub App on this repo to start. | Onboard, Projects | no |
| `running` | Agent working | The onboarding agent is working. | same | no |
| `card` | Needs your review | The summary is ready for you. | same | no |
| `blocked` | Blocked | Something must be fixed on GitHub before the agent can go on. | same | no |
| `starter` | Needs starter files | The repo needs basic files first; the agent proposes them. | same | no |
| `parked` | Paused: no answer | Nobody answered for 5 working days. Resume when ready. | same | no |
| `done` | Onboarded | The repo is signed off at its level. | same | no |
| `rejected` | Sign-off refused | The sign-off was refused; fix and ask again. | same | no |
| `superseded` | Replaced | A newer onboarding replaced this one. | same | no |
| `withdrawn` | Withdrawn | The onboarding was stopped. | same | no |
| PRR (Project Readiness Record) | Readiness scorecard | What this repo is ready for, signed at onboarding and kept up to date. | Project › Readiness | secondary |
| PRR `proposed` / `active` / `stale` / `suspended` / `expired` / `superseded` | Awaiting sign-off · In force · Out of date · Suspended · Expired · Replaced | Where the readiness scorecard stands. | same | no |
| Pillar VRL | Testing | Can agents check their own work. | same | secondary |
| Pillar ERL | Environment | Can the code be built and run safely. | same | secondary |
| Pillar ORL | Operations | Is it known how changes reach production. | same | secondary |
| Pillar KRL | Knowledge | What agents are told and can read about the repo. | same | secondary |
| Readiness level RL0–RL4 | Readiness 0–4 | The scorecard's overall score: the lowest of the four pillars. | same | no |
| Drift | Changes since onboarding | Something on GitHub changed since sign-off (protection, App, files). | Project › Drift | no |
| `reaffirm` / `suspend` / `security` (DriftEffect) | Confirm again · Agents suspended · Security check needed | What a change since onboarding means. | same | no |
| Restore (DEC-21) | Restore | Re-check and lift the suspension once the change is fixed. | same | no |
| Re-onboarding | Re-onboard | Run onboarding again, for example after many knowledge errors. | Project | no |
| Level up (`level_up`) | Raise the level | Onboard further to let agents do more. | Project | no |
| `re_sign` | Sign again | Renew the sign-off. | Project | no |
| Expiry (`PRR_FRESH_DAYS` 90) | Expires on | The scorecard must be renewed by this date. | Project | no |
| Bootstrap grant (`liveBootstrap`) | First-time setup access | Lets the person onboarding the first repo decide its setup alone. | People | no |
| DEC-18 exec allow-list | Agents may run code here | The repo is on the factory list of repos where agents may run code. | Project › Settings | no |

---

## 8. Item states

### 8.1 Work item phases (`WorkItemPhase`)

The item's main status, shown as a pill.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Draft | Draft | Not sent yet. | Items, Work item | no |
| Clarifying | Questions asked | The factory asked questions; answer them to go on. | same, Home | no |
| S1–S9, S8a, S8b | (the stage name, §2) | The stage the work is in now. | same | no |
| Scheduling | Queued for build | The plan is approved; waiting for a coding slot. | same | no |
| G4 | In code review | Waiting for a code owner to approve the PR. | same | no |
| G5 | Waiting for release approval | Merged; waiting for release approval. | same | no |
| G6 | Waiting for your acceptance | Done; the requester must accept it. | same | no |
| Held | On hold | Paused for a reason shown beside it (§9.4). | same | no |
| Handoff | Needs a person | The agents stopped; a person must choose what happens next. | same, Home | no |
| Quarantined | Security hold | Stopped after unsafe agent behaviour; security decides next. | same | no |
| Parked | Waiting for answers | Paused until the questions are answered; ends after 5 working days. | same | no |
| Done | Done | Finished and accepted. | same | no |
| Declined | Declined | The factory will not do this request. | same | no |
| Abandoned | Abandoned | Stopped before it finished. | same | no |
| Withdrawn | Withdrawn | The requester withdrew it. | same | no |
| HandedOverClosed | Closed by a person | A person took the work over and closed it. | same | no |
| Superseded | Replaced | Another item replaced this one. | same | no |
| Deferred | Deferred | Put off to later. | same | no |

### 8.2 Named waits (`WaitState`) and floor rooms (`FloorRoom`)

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| PARK (`Parked`) | Waiting for answers | See above. | Work item, Floor | no |
| BLOCKED (`Blocked`) | Blocked: environment | The tests fail before any change, or the sandbox is broken; fix and retry. | same | no |
| RELHOLD (`ReleaseHeld`) | Release on hold | The release was refused; fix and ask again, or open a new item. | same | no |
| SPIKE (`SpikeReport`) | Experiment report | The experiment finished; read its report. | same | no |
| Room SCHED | Queue | Waiting to start building. | Floor | no |
| Room HOLD | On hold | Paused items. | Floor | no |
| Room QUAR | Security hold | Items stopped for security. | Floor | no |
| Room DESK | Needs a person | Items waiting for a person to take over or choose. | Floor | no |
| Room BIN | Declined | Requests the factory will not do. | Floor | no |
| Room DONE | Done | Finished items. | Floor | no |
| Floor status `working` / `waiting` / `held` / `stuck` / `done` / `declined` | Working · Waiting · On hold · Stuck · Done · Declined | What the item is doing now on the floor. | Floor, Items | no |
| `stuck` | Stuck | No sign of life from the agent for longer than the set time. | same | no |
| Floor move `F` / `B` / `R` | Forward · Sent back · Moved track | How an item last moved. | Floor | no |

### 8.3 Approval and card statuses

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Gate `pending` | Waiting | Waiting for a decision. | Inbox, Decide, Work item | no |
| `decided` | Decided | Decided; the decision is shown. | same | no |
| `superseded` | Replaced | A newer version replaced it before a decision. | same | no |
| `expired` | Expired, not approved | Nobody decided in time. Nothing was approved. | same | no |
| `closed` | Closed | The work ended, so the approval closed. | same | no |
| Card `open` / `decided` / `sent_back` / `rejected` / `withdrawn` / `expired` / `superseded` | Waiting · Decided · Changes requested · Rejected · Withdrawn · Expired · Replaced | Where an inbox card stands. | Inbox | no |
| Feasibility `feasible` / `infeasible` / `unknown` | Can be decided · Nobody can decide · Unknown | Whether someone holds the right to decide this approval. | Inbox, Floor, Project › People & gates | no |
| Inbox reason `eligible` / `escalated_backup` | You can decide · Overdue: you are the backup | Why this is in your inbox. | Inbox | no |

---

## 9. Sent back, handed over, paused

People never see B-, D-, ET-, H- codes. They see a one-line reason: **what happened → what happens next**, with the tries left
("1 of 2 tries left") from the item's own pinned limits.

### 9.1 Sent back (back-edges)

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| B1 | Needs more information | Questions asked; up to 2 rounds, then paused 5 working days. | Work item, Timeline, Home | audit |
| B2 | Goal unclear | Research found the goal unclear; the goal is confirmed again (2 tries, then a person). | same | audit |
| B3 | Spec failed checks | The spec failed validation; the agent retries (3 tries). | same | audit |
| B4 | Design found a spec gap | The design shows the spec is missing something; back to spec once. | same | audit |
| B5 | Plan changes requested | The plan was sent back; after 2 times, a person writes the plan. | same | audit |
| B6 | Blocked: environment | Tests fail before any change; the build waits until the environment is fixed. | same | audit |
| B7 | Checks failing, retrying | The agent's own checks fail; it retries within its limits. | same | audit |
| B8 | Out of scope: re-plan | The change went beyond its part; the part is split and approved again. | same | audit |
| B9 | Fixing check findings | Verify found something fixable; the agent fixes it. | same | audit |
| B10 | Spec unclear | Verify found the spec ambiguous; the spec is approved again once. | same | audit |
| B11 | Wrong approach: re-plan | Verify found the approach wrong; the plan is approved again once. | same | audit |
| B12 | Locked test must change | A locked test must change; needs "Change a locked test". | same | audit |
| B13 | Changes requested in review | The code owner requested changes; up to 2 rounds. | same | audit |
| B14 | Reviewer unsure | A light reviewer was unsure; a code owner does a full review. | same | audit |
| B15 (B15a) | Base branch moved | The main branch moved; checks run again (2 times). | same | audit |
| B15 (B15b) | Merge conflict | The PR conflicts; the agent resolves it and checks again. | same | audit |
| B16 | Deploy unhealthy: rolled back | The release was rolled back; a new fix item was opened. | same | audit |
| B17 | Bug found after merge | A problem was found after merge; a new fix item was opened. | same | audit |
| B18 | Result not accepted | The requester did not accept the result; a new linked item was opened. | same | audit |
| B19 | Spot-check found a miss | An audit found a missed problem; too many suspend light reviews. | same | audit |
| B20 | Scope changed | The requester changed the scope; back to spec (once). | same | audit |
| B21 | Decision overdue | Waited over 1 working day; sent to the backup approver. Never approved automatically. | Inbox, Work item | audit |
| B22 | Not eligible | The request does not fit this repo or the factory. | Work item | audit |
| B23 | Spec rejected | The spec was rejected; 2 rounds, then a person chooses. | same | audit |
| B24 | Design rejected | The design was rejected; 2 rounds, then a person chooses. | same | audit |
| B25 | Exception refused | The rule exception was refused; redesign once, then a person chooses. | same | audit |
| B26 | Release refused | The release was refused; it is on hold. | same | audit |
| B27 | Possible prompt injection | The request contains text that looks like instructions to the agent; it is treated as data. | Work item, Decide | audit |
| B28 | Rework limit reached | The work was sent back too often; a person chooses what happens next. | same | audit |
| Rework budget (`total` 5, `item_age` 10) | Rework limit | How many times the work may be sent back, and for how long. | Work item | no |

### 9.2 Handed to a person (handoffs) and reasons (ET triggers)

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| D1 | Needs a person: build | The agents stopped while building. | Work item, Home, Inbox | audit |
| D2 | Needs a person: checks | The agents stopped while fixing check findings. | same | audit |
| D3 | Needs a person: review | Review rejected the work twice. | same | audit |
| D4 | Hand back | A person gives the work back to the agents (once). | Work item | audit |
| D5 | Mark my work done | The person who took over says the work is ready for checks. | Work item | audit |
| Handoff Pack (A11) | Handover notes | What the agent did, where it stopped and why. | Work item › Now | no |
| E4 choices: resume / re-plan / re-spec / take over / abandon | Resume · Re-plan · Rewrite spec · Take over · Stop the work | The options when the agents are stuck. | Decide (E4) | no |
| ET1 | Budget used up | The work spent its whole budget. | Work item | audit |
| ET2 | Taking too long | Too many CI rounds or twice the planned time. | same | audit |
| ET3 | Keeps failing | The same check failed 3 times. | same | audit |
| ET4–ET6 | Check limit reached | A verify check hit its retry limit. | same | audit |
| ET7 | Rejected twice | The review rejected the work twice. | same | audit |
| ET8 | Agent gave up | The agent said it cannot do this. | same | audit |
| ET9 | Scope drift | The change drifted out of scope twice. | same | audit |
| ET10 | Unsafe agent behaviour | The agent tried something not allowed; security hold. | same | audit |
| ET11 | Going in circles | The agent keeps undoing its own changes. | same | audit |
| ET12 | Unstable results | Results change between runs (flaky). | same | audit |
| ET13 | Bug found after merge | A problem was found after merge. | same | audit |
| ET14 | Too many failures | Too many items failed on this track; agents paused on it. | same | audit |

### 9.3 Risky actions the build stops for (tripwires)

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Tripwire X1 (irreversible command) | Irreversible command | The agent wanted to run a command that cannot be undone. | Agent console, Verify | audit |
| Tripwire X3 (new dependency) | New dependency | The agent added a package. | same | audit |
| Tripwire ET10 (credential hunting, secret read) | Tried to read secrets | The agent tried to read credentials. | same | audit |
| Protected path / protected glob | Protected file | A file only people may change. | same | no |
| Diff budget | Change size limit | The most lines this track may change. | Agent console, Settings › Tracks | no |
| Stub test | Fake test | A test that passes without testing anything. | Verify | no |

### 9.4 Why it is paused (holds)

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| H1 | Waiting for an approver | Nobody who can approve the next step is available. | Work item, Floor | audit |
| H2 | Waiting for a coding slot | All coding sandboxes are busy. | same | audit |
| H3 | Waiting for environment | The build environment is not available. | same | audit |
| WIP | Too much in progress | The project's work-in-progress limit is reached. | same | audit |
| N8 | Repo not ready | The repo has no readiness scorecard in force for this track. | same | audit |
| `kill` | Agents stopped | The emergency stop is on for this scope. | everywhere (banner) | audit |
| `maintenance` (MM-2) | Maintenance mode | Timers frozen and decisions disabled; drafts kept. | everywhere (banner) | audit |
| `quota` | Over quota | The model provider's quota is reached. | Work item | audit |
| `control` | Paused by an operator | An operator paused this scope. | same | audit |
| HUMAN-WAIT | Waiting for a person | The build stopped for an approval; its slot is freed and its clock paused. | Work item, Agent console | no |

---

## 10. Parts of the plan (Units)

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Unit | Part | One part of the plan, built on its own branch and PR. | Work item, Agent console, Floor | no |
| Implicit Unit `main` | Whole item | The item has one part only. | same | no |
| Unit size `small` / `medium` / `large` | Small · Medium · Large | How big the part is; sets its share of the budget. | Documents | no |
| `Planned` | Planned | In the plan; not started. | Work item | no |
| `Admitted` | Ready to build | Has a coding slot and budget. | same | no |
| `Building` | Building | The coding agent is working on it. | same | no |
| `Pushed` | Draft PR open | The PR is open. | same | no |
| `Verifying` | Being checked | The factory is checking the PR. | same | no |
| `InReview` | In code review | A code owner is reviewing the PR. | same | no |
| `Merged` | Merged | Merged on GitHub. | same | no |
| `Released` | Released | Deployed. | same | no |
| `HumanHeld` | Waiting for a person | Paused for an approval. | same | no |
| `Tainted` | Flagged unsafe | Unsafe behaviour seen; going to a security hold. | same | no |
| `Quarantined` | Security hold | Stopped for security review. | same | no |
| `Stopped` | Stopped | Stopped by an operator, a budget or the emergency stop. | same | no |
| `GrantReleased` | Slot released | Its slot and budget were released. | same | no |
| Envelope | Budget | The most this work may spend on models, in money and tokens. | Work item, Settings | no |
| Budget group (gateway) | Budget | Same as above; the gateway's hard stop. | Operate | no |
| Admission grant / lease / epoch | Coding slot | The right to build one part now. Lease numbers are not shown. | Agent console, Operate | no |
| Push Broker | Factory bot | The only part of the factory that can push branches and open draft PRs. | Work item, Integrations | no |
| `agent/<item>/<unit>` branch | Agent branch | The branch the factory bot pushes to. | Work item | no |

---

## 11. Checks and evidence

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Oracle | Acceptance tests | Tests written from the spec that prove the change works. | Documents, Verify | no |
| Oracle specs | Acceptance criteria | What the acceptance tests must prove. | Documents, Decide (Approve the spec) | no |
| Oracles red (6.3) | New tests fail first | The new tests must fail before the change, so they really test it. | Agent console | no |
| Locked tests | Locked tests | Tests agents may not change without approval. | Verify | no |
| Constitution | Factory rules | Rules every design and change must follow (for example, no unapproved network access). | Settings, Verify | no |
| `C-EGRESS` rule | No unapproved network access | Code may not call hosts that are not approved. | Settings › Factory rules | secondary |
| `C-MIGRATION` rule | Migrations reversible | Database changes must be reversible or flagged. | same | secondary |
| Verdict `passed` / `failed` / `unknown` | Passed · Failed · Unknown (not passed) | The result of one check. | Verify | no |
| Finding severity `info`…`critical` | Info · Low · Medium · High · Critical | How serious a finding is. | Verify | no |
| Repair class `repairable` | Agent can fix | The agent will fix this. | Verify | no |
| `spec_ambiguous` | Spec unclear | The spec must be clarified. | same | no |
| `approach_wrong` | Wrong approach | The plan must change. | same | no |
| `locked_test_change` | Locked test change | A locked test must change; needs approval. | same | no |
| `hard_fail` | Cannot go on | A person must decide. | same | no |
| `quarantine` | Security hold | Unsafe; security decides. | same | no |
| Mutation testing | Test strength | Whether the tests catch small deliberate bugs. | Verify | no |
| Holdouts | Hidden tests | Tests the agent never sees. | Verify | no |
| Evidence Pack | Evidence pack | The signed proof of every check for one exact commit. | Verify, Decide (Code review) | no |
| Notary signature | Signed by the factory | The factory's signature; anyone can check it offline. | Evidence pack | no |
| `aisdlc/gate` check (gate-check) | Factory check | The required GitHub check that passes only for signed, approved agent PRs. | Work item, Integrations, Readiness | secondary (`aisdlc/gate`) |
| Gate-check `action_required` | Needs a person on GitHub | Not an agent PR the factory can approve. | Work item | no |
| `pre_watch` / `bypass_merge` / `unauthorised_merge` | Before the factory watched · Merged around the check · Merged without permission | How a merge happened. | Project › Audit | no |
| Merge bypass list | Who may merge without the check | GitHub users allowed to merge without the factory check. | Settings | no |
| Taint mark | Untrusted input | Text from outside; agents treat it as data, never instructions. | Request tab | no |
| De-dupe / conflict | Possible duplicate · Possible conflict | Another request looks the same or clashes. | Request tab | no |
| Intent block | Agreed goal | The goal everyone agreed on, which later steps follow. | Request tab, Documents | no |
| Artefact | Document | Something an agent wrote (spec, design, plan…). | Documents | no |
| Proposal rejected (invalid output) | Agent answer refused | The agent's answer did not fit the required shape; it retries. | Agent console | no |
| Merged-SHA grounding / citation | Based on commit 3f2a91c | Agents only cite code at an exact merged commit. | Documents | no |
| Ledger | Decision log | The signed, append-only list of every decision. | Decision log & audit | no |
| Ledger checkpoint / witness | Log checkpoint | A signed snapshot that proves the log was not changed. | Decision log & audit | no |
| Record / record event | History | Everything that happened, in order. | Timeline, Decision log & audit | no |

---

## 12. Roles

Roles show on People, teams & roles; on "who can decide this"; and in locked-button reasons. The slot code is never shown.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| `project.admin` (slot `admin`) | Project admin | Runs the project: settings, people, project approvals. | People, Project › People & gates | audit |
| `project.requester` (`requesters`) | Requester | Asks for work and accepts the result. | same | audit |
| `project.intent_approver` (`intent`) | Request and spec approver | Accepts requests, confirms goals, approves specs. | same | audit |
| `project.design_approver` (`design`) | Design and plan approver | Approves designs, outlines and plans. | same | audit |
| `project.code_owner` (`g4`) | Code reviewer | Reviews agent PRs; the code owners on GitHub. | same | audit |
| `project.release_approver` (`g5`) | Release approver | Approves releases. | same | audit |
| `project.exception_approver` (`x`) | Exception approver | Decides risky actions and exceptions. | same | audit |
| `project.security_approver` (`sec`) | Security approver | Decides security holds and reviews. | same | audit |
| `project.onboarding_signer` (`m4`) | Onboarding signer | Signs off onboarding. | same | audit |
| `project.kill_holder` (`kill`) | Can stop agents | Can stop and restart agents on the project. | same | audit |
| `project.viewer` | Viewer | Can see the project; no titles of restricted work. | same | audit |
| `factory.admin` | Factory admin | Can change and decide anything in the factory; every action is recorded. | People | audit |
| `factory.onboarder` | Can onboard repos | Can start onboarding a repo. | People | audit |
| `factory.auditor` | Auditor | Can read the whole factory record; decides nothing. | People | audit |
| Binding | Role assignment | A person or group given a role on a project, team or the factory. | People | no |
| Group | Group | People who get roles together (from sign-in). | People | no |
| Team | Team | People who work together; owns projects and requests. | People | no |
| Qualification | Qualification | A check a person must pass to hold some roles (for example security). | People | no |
| Access request | Access request | Ask for a role; an admin approves. | My access, People | no |
| Principal kind (human, service, agent) | Person · Service · Agent | Who or what acted. | Decision log, People | no |

---

## 13. Actions

Action names appear in locked-button reasons ("You can't *Approve the plan*: ..."), on My access and in the who-can-do-what matrix.

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| `project.onboard` | Onboard a repo | Start onboarding a repo. | Onboard, My access | audit |
| `work.request` | Ask for work | Send a request to the factory. | Shell, My access | audit |
| `item.ready` | Mark ready / Answer questions | Say the request is ready, or answer the factory's questions. | Work item | audit |
| `item.observe` | Raise a concern | During design review, say the spec has a gap or the work is smaller than its track. | Work item | audit |
| `item.plan` | Write the plan | Write the plan yourself after it was sent back twice. | Work item | audit |
| `item.release` | Ask to release again | Ask for release approval again after a refusal. | Work item | audit |
| `item.human_done` | Mark my work done | Say your human-led work is ready for checks. | Work item | audit |
| `item.unsure` | I'm not sure | Ask for a full code review. | Decide | audit |
| `item.escape` | Report a bug after merge | Report a problem found after the item closed. | Work item | audit |
| `audit.record` | Record a spot-check | Record the audit of a lightly reviewed merge. | Inbox | audit |
| `closeout.read` | See the close-out | Read an item's final record. | Work item | audit |
| `learn.propose` | Suggest improvements | Ask the factory to propose changes from finished work. | Project | audit |
| `project.view` | See the project | See a project and its settings. | everywhere | audit |
| `project.settings.edit` | Change project settings | Change who decides what, approvals and two-person rules. | Project › Settings | audit |
| `floor.read` | See the floor | See the live floor. | Floor | audit |
| `item.view_floor` | See the item | See an item on the floor. | Floor | audit |
| `gate.view` | See the approval | See an approval and its evidence. | Decide | audit |
| `gate.decide` | Decide approvals | Approve, request changes or reject. | Decide | audit |
| `card.decide` | Decide inbox cards | Decide a card that carries several approvals. | Inbox | audit |
| `kill.request` | Stop agents | Emergency stop for a scope. | Operate, phone | audit |
| `kill.release` | Restart agents | Lift an emergency stop (two people). | Operate | audit |
| `config.propose` | Propose a settings change | Draft a change to settings for approval. | Settings | audit |
| `config.decide` | Approve factory settings | Approve a change to factory-wide settings. | Settings | audit |
| `audit.read` | Read the audit trail | See the decision log and audit views. | Decision log & audit | audit |
| `control.apply` | Pause or limit | Pause, limit, halt or put a scope in maintenance. | Operate | audit |
| `control.lift` | Lift a pause | Lift a pause or limit. | Operate | audit |
| `banner.publish` | Post a notice | Show a notice to everyone in a scope. | Operate | audit |
| `access.explain` | See who can do what | See who can decide each approval. | Project › People & gates | audit |
| `identity.admin` | Manage sign-in and data | Sign-in, sessions, suspension, deleting personal data, legal hold. | People, Decision log & audit | audit |
| `access.manage` | Manage roles | Give and take away roles; answer access requests. | People | audit |
| `ops.read` | See operations | See scheduling, sandboxes, controls and health. | Operate | audit |
| `session.stop` | Stop a session | Stop one running agent sandbox. | Operate, Agent console | audit |
| `quality.read` | See agent quality | See agents, evaluations, models and integrations. | Agents, Integrations | audit |
| `assistant.use` | Ask the assistant | Ask the factory questions about what you can see. | Shell | audit |
| Delete (NEW) | Delete | Remove the object and all its data for good; the log keeps hashes only. | Admin lifecycle | no |

---

## 14. Access levels

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| View level `V1` | Overview | Sees that work exists and where it is; no titles of restricted work. | People, My access | secondary |
| `V2` | Details | Sees requests, documents and checks. | same | secondary |
| `V3` | Everything | Sees transcripts, settings and the full record. | same | secondary |
| Data class `D0` | Public | Safe to show anyone. | People, Settings, Integrations | secondary |
| `D1` | Internal | Company-internal; not personal or secret. | same | secondary |
| `D2` | Confidential | Sensitive business or security detail. | same | secondary |
| `D3` | Restricted | Never sent to a model and never shown in the portal. | same | secondary |
| Confidential project | Private project | Hidden from anyone without a role on it. | Projects | no |
| 403 with reason | You can't open this | Says why and who to ask. | everywhere | no |
| 404 (invisible = missing) | Not found | Shown the same whether it does not exist or you cannot see it. | everywhere | no |

---

## 15. Agents

| Code | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| A1 `triage` | Triage agent | Checks duplicates, sizes the work and checks eligibility. | Agents, Agent console | secondary (Agents) |
| A2 `intent` | Spec writer | Asks questions, writes the goal and the spec. | same | secondary |
| A3 `planner` | Planner | Researches, designs and plans. | same | secondary |
| A4 `coding` | Coding agent (one-shot) | The one-call coding agent. | same | secondary |
| A5 `review` | Reviewer | Reviews specs, designs and changes with fresh context. | same | secondary |
| A6 `test` | Test writer | Writes acceptance criteria and acceptance tests. | same | secondary |
| A7, A8, A10 (unnamed) | Not in use | Reserved; does nothing today. | Agents | secondary |
| A9 `reverse engineering` | Repo reader | Reads the repo at onboarding and digs into unclear code. | same | secondary |
| A11 `handoff pack` | Handover writer | Writes the handover notes when agents stop. | same | secondary |
| A12 `extraction` | Knowledge extractor | Builds the code map and draft specs at onboarding. | same | secondary |
| `coder` | Coding agent | Writes the code in the sandbox and opens the draft PR. | same | secondary |
| `assistant` | Assistant | Answers your questions from what you can see. | Shell | no |
| Onboarding agent (NEW) | Onboarding agent | Leads onboarding and proposes fix PRs. | Onboard, Agents | no |
| Agent run `dispatched` / `finished` | Started · Finished | An agent's run at one step. | Agent console | no |
| Run result `completed` / `classified` / `gate_needed` / `relane` | Finished · Sized · Needs approval · Track changed | What the run produced. | same | no |
| Run verdict `accepted` / `sent_back` / `reworked` / `handed_off` | Accepted · Sent back · Redone · Handed to a person | What happened to the run's output. | same | no |
| Session `starting`…`tainted` | Starting · Running · Idle · Waiting for a tool · Interrupted · Finished · Stopped · Flagged unsafe | The live sandbox session. | Agent console, Operate | no |
| Prompt sha / contract version | Prompt version | Which exact instructions the agent ran with. | Agents | audit |
| Eval / eval suite | Evaluation | A test set that measures an agent's quality. | Agents | no |
| Eval case kinds `regression` / `holdout` / `pooled` / `canary` / `seeded_defect` | Regression · Hidden · Shared · Canary · Planted bug | Kinds of evaluation case. | Agents › Evaluations | no |
| Baseline | Baseline | The score a new version must not fall below. | same | no |
| pass^k / significance | Pass rate · Real change | How often the agent succeeds; whether a drop is real. | same | no |
| Tool allow-list | Tools allowed | The tools the agent may use. | Agents | no |
| `data_class_max` | Most sensitive data | The most sensitive data the agent may see. | Agents | no |
| Virtual key (vkey) | (hidden) | Never shown. | — | no |
| Agent score chip (floor) | Agent quality | Recent quality of the agent at this station. | Floor | no |

---

## 16. Operate

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Kill switch | Emergency stop | Stops all agent work in a scope at once. | Operate, banner, phone | no |
| Kill scopes fleet / project / lane / session | Whole factory · Project · Track · Session | What the stop covers. | Operate | no |
| Kill `active` / `release_pending` / `released` | Stopped · Restart waiting for second person · Restarted | Where an emergency stop stands. | Operate, banner | no |
| Unreachable kill switch | Agents stopped (cannot reach the stop switch) | When the stop switch cannot be read, agents are treated as stopped. | banner | no |
| Kill delegations (DEC-29) | Who can stop agents | People given the right to stop agents on a project. | Project › Settings | no |
| Control `hold` | Pause | Pause new work in a scope. | Operate | no |
| `clamp` | Limit | Allow at most N items in progress. | Operate | no |
| `halt` | Halt | Stop work in a scope now. | Operate | no |
| `maintenance` | Maintenance mode | Freeze timers and decisions everywhere. | Operate | no |
| Control state `active` / `lifted` / `expired` | In force · Lifted · Ended | Where a control stands. | Operate | no |
| Preview → nonce → apply | Preview, then apply | See what a control will affect before applying it. | Operate | no |
| Banner (targets banner / channel / statuspage) | Notice (portal · Slack · status page) | A message shown to everyone in a scope. | Operate | no |
| Banner severity | Info · Warning · Critical | How prominent the notice is. | Operate | no |
| Scheduler / admission / capacity | Queue and capacity | What is waiting to build and why. | Operate | no |
| Sandbox | Sandbox | A locked-down container agents work in. | Operate, Agent console | no |
| Sandbox class `K` | Read-only scan | Reads files; runs nothing. | Operate | secondary |
| `K-exec` | Test run | Runs the repo's setup and tests, offline. | same | secondary |
| `P` | Planning | Agents read and plan; no code runs. | same | secondary |
| `W` | Coding | The coding agent writes and runs code. | same | secondary |
| `O` | Checks | Runs the verify checks. | same | secondary |
| `V` | Verify | Runs the final verification. | same | secondary |
| Sandbox caps (total, coding) | Sandbox limits | How many sandboxes, and coding sandboxes, may run at once. | Settings, Operate | no |
| SEC-OB-3 | Sandbox escape test | The hostile-probe test the sandbox must pass. | Operate | audit |
| Health `ok` / `degraded` / `down` / `unknown` | Healthy · Degraded · Down · Unknown | A service's state; no reading in 2 minutes is unknown. | Operate, Integrations | no |
| Degraded banners (Notary down, stale read model) | Signing paused · Data may be stale | Decisions wait for signing; the view may be behind. | banner | no |
| Notary | Signer | The service that signs evidence and decisions. | Operate | no |
| Witness | Log witness | The service that co-signs log checkpoints. | Operate | no |
| Gateway | Model gateway | The only service that holds model keys and talks to model providers. | Integrations, Operate | no |
| Loops (poll loops, outbox) | Background jobs | Work the factory does on a timer. | Operate | no |
| Cost / spend | Spend | Money spent on models. | Operate, Project | no |
| Erasure | Delete personal data | Remove a person's data on request. | Decision log & audit | no |
| Legal hold `active` / `released` | Legal hold · Released | Data kept for legal reasons; nothing is deleted while on. | same | no |
| Erasure `requested` / `blocked` / `approved` / `executed` / `rejected` | Requested · Blocked · Approved · Done · Refused | Where a deletion stands. | same | no |
| Signed export | Signed export | A signed download of the record for auditors. | same | no |
| Retention class | Keep for | How long a kind of data is kept. | Settings › Retention | no |

---

## 17. Integrations

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Integration | Integration | A connection to an outside service. | Integrations | no |
| Kind `code_host` | Code host | Where the code lives (GitHub). | Integrations | no |
| `model_provider` | Model provider | Who runs the AI models (Anthropic, OpenAI-compatible). | same | no |
| `notifier` | Notifications | Slack and email. | same | no |
| `tracker` | Issue tracker | Where gaps are filed as issues. | same | no |
| `identity` | Sign-in | The sign-in provider (Keycloak, any OIDC). | same | no |
| Adapter `github_app` / `fake_github` | GitHub App · Test GitHub | How the factory talks to the code host. | same | no |
| `anthropic` / `openai_compat` / `fake` | Anthropic · OpenAI-compatible · Test model | How the factory talks to the model provider. | same | no |
| Status `draft` / `enabled` / `disabled` / `retired` | Draft · On · Off · Retired | Whether the integration is used. | same | no |
| Factory App / gate-check App / gate-relay App / tracker App | Factory bot App · Check App · Release App · Issues App | The GitHub Apps the factory uses, each with only the permissions it needs. | same | no |
| Installation, `repository_selection` all / selected | Installed on: all repos · selected repos | Which repos the App can see. | same, Onboard | no |
| Forbidden permissions (`administration`, `workflows`, `statuses`) | Permissions it must not have | The factory refuses an App with these. | same | no |
| Credential reference `file:` (today) / Vault path (NEW) | Secret (saved) | A secret stored in the vault; never shown again. | Integrations | no |
| Write-only secret field (NEW) | Paste secret | Paste once; it is stored and never shown again. | same | no |
| Rotate | Replace secret | Paste a new secret; the old one stops working. | same | no |
| Test connection (NEW) | Test | Try the connection now with the saved secret. | same | no |
| Integration health | Health | Last result of the connection check. | same | no |
| Model (`gateway.models`) | Model | One AI model with its limits and price. | Integrations › Models | no |
| Route (`gateway.routes`) | Model per data class | Which model handles each data sensitivity. | same | no |
| Model per agent (NEW) | Model for this agent | The model this agent uses. | Agents, Integrations | no |
| `repos_allowed` / `models_allowed` (installs) | Repos it may use · Models it may use | What one project may use. | Project › Settings | no |
| Egress hosts | Allowed hosts | The outside hosts a service may call. | Integrations | no |
| Slack webhook / SMTP | Slack channel · Email | Notification channels. | Integrations › Notifications | no |
| Notification kinds `gate_waiting` / `sla_escalated` / `quarantine` / `handoff` / `kill_engaged` / `kill_released` | Approval waiting · Approval overdue · Security hold · Needs a person · Agents stopped · Agents restarted | What a notification is about. | Notifications, preferences | no |
| Notification reasons `slot_holder` / `escalated_backup` / `project_admin` / `factory_admin` | You can decide · You are the backup · You run the project · You run the factory | Why you got it. | Notifications | no |
| Unmutable kinds | Always sent | You cannot turn these off. | Preferences | no |
| Sign-in: company SSO / local account / security key | Sign in with company SSO · Local account · Security key | The ways to sign in. | Sign-in | no |
| Session idle / absolute | Signed out after inactivity · Maximum session | Session limits. | Sign-in, Settings | no |

---

## 18. Settings

Every setting gets a human name. Settings show in Settings (factory) or Project › Settings. "Today" says whether it is config
already; "NEW" means the intent needs it and it is hard-coded today (see the hard-coded list in
[`screen-map.md` §5](screen-map.md#5-hard-coded-settings-found-in-the-code)).

| Key | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| `project.role_map` | Who decides what | Who holds each project role. | Project › People & gates | audit |
| `project.two_person` | Two-person approvals | Whether risky approvals need two different people. | Project › Settings | audit |
| `project.gating_profile` | Which approvals are on | Which optional approvals this project has, per track, and how builds are scheduled. | same | audit |
| `project.kill_delegations` | Who can stop agents | People given the right to stop agents here. | same | audit |
| `project.release` | Releases | Off, or the GitHub environment to deploy to after release approval. | same | audit |
| `project.wip_limit` | Work-in-progress limit | The most parts of this project building at once. | same | audit |
| `project.default_envelope` | Default budget | The budget of an item with no plan, and the most one part may use. | same | audit |
| `s0.failure_model` | Onboarding retries and pauses | Retries, send-backs, and when onboarding pauses for silence. | Settings › Onboarding | audit |
| `s0.timeboxes` | Onboarding time limits | How long each onboarding step may take. | same | audit |
| `s0.calendar` | Working days | Weekends, holidays and time zone for every timer. | Settings › General | audit |
| `s0.t0_attestation_required` | Low risk needs owner confirmation | The owner must confirm "no production, no real data". | Settings › Onboarding | audit |
| `onboarding.instruction_template` | Agent instructions template | What agent instructions may and may not contain. | same | audit |
| `onboarding.reonboard_triggers` | When to re-onboard | How many knowledge errors in how many days suggest re-onboarding. | same | audit |
| `onboarding.sandbox_image` | Test-run image | The sandbox image used to run a repo's tests. | Settings › Sandboxes | audit |
| `onboarding.light_tests` | Coding image and isolation tests | The coding image and the thresholds of its isolation tests. | same | audit |
| `factory.constitution` | Factory rules | The rules every design and change is checked against. | Settings › Factory rules | audit |
| `factory.m1_policy` | Who approves factory settings | Which role approves factory changes, and whether one or two people. | Settings › General | audit |
| `factory.learn` | Learning from finished work | When the factory proposes improvements. | Settings › General | audit |
| `factory.floor` | Floor display | When an item is drawn stuck and when an agent score is low. | Settings › General | audit |
| `sandbox.exec_allowed_repos` | Repos agents may run code in | Agents run code only in these repos. | Settings › Sandboxes, Project | audit |
| `sandbox.caps` | Sandbox limits | How many sandboxes and coding sandboxes run at once. | Settings › Sandboxes | audit |
| `ops.maintenance.mm2` | Maintenance mode | Freeze timers and decisions everywhere. | Operate | audit |
| `pdp.bundle` | Access policy | The published permission rules (generated from roles). | Settings › Access (read-only) | audit |
| `integrations.registry` | Integrations | The outside services the factory uses. | Integrations | audit |
| `integrations.installs` | Integrations per project | Which repos and models each project may use. | Project › Settings | audit |
| `gateway.models` | Models and prices | The models and their limits and prices. | Integrations › Models | audit |
| `gateway.routes` | Model per data class | Which model handles each data sensitivity. | same | audit |
| `codehost.merge_bypass` | Who may merge without the check | GitHub users allowed to merge around the factory check. | Project › Settings | audit |
| `audit.retention` | Data retention | How long each kind of data is kept. | Settings › Retention | audit |
| `notifications.channels` | Notification channels | Slack and email channels and who gets what. | Integrations › Notifications | audit |
| NEW `agents.config` | Agents on/off, models, turns, timeouts, budgets | Per agent: on or off, model, max turns, time limit and budget. | Agents | no |
| NEW `catalogue.*` (tracks, limits) | Tracks and limits | Which steps and approvals each track has, retry limits, rework limit, budget extension. | Settings › Tracks | no |
| NEW `gates.policy` | Who decides each approval | The role, two-person rule and "confirm it's you" for each approval. | Settings › Approvals | no |
| NEW `sandbox.coding_cap` (remove `CODING_SESSION_CAP`) | Coding sandboxes at once | Number of builds that may run at once. | Settings › Sandboxes | no |
| NEW `session.policy` | Sign-in session limits | Inactivity sign-out and maximum session length. | Settings › General | no |
| NEW `gates.timers` | Approval timers | When an approval is overdue, when it expires, how long "confirm it's you" lasts. | Settings › Approvals | no |
| NEW `readiness.policy` | Readiness rules | Scorecard expiry, waiver length, fact confirmation share. | Settings › Onboarding | no |
| Config revision | Settings change | A proposed change, shown with its effect, approved, then in force. | Settings | no |
| Revision `proposed` / `published` | Waiting for approval · In force | Where a settings change stands. | Settings | no |
| Factory layer / project layer | Factory-wide · This project | Where a setting applies. | Settings | no |
| Ops flag | Switch | A setting that takes effect immediately. | Operate | no |
| `stale_parent` | Someone changed this first | Reload and redo your change. | Settings | no |
| `unchanged` | Nothing changed | Your draft is the same as what is in force. | Settings | no |

---

## 19. Status words

| Word (internal) | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| `unknown` (anywhere) | Unknown | We could not tell; treated as not met. | everywhere | no |
| `unreadable` | Could not read | The factory could not read this; treated as not met. | Onboard, Settings | no |
| `met` / `not_met` / `unmet` | Met · Not met | Whether a requirement holds. | Onboard, Readiness | no |
| `recorded` | Noted | Recorded; does not block at this level. | Onboard | no |
| `not_evaluated` / `na` | Not checked at this level · Does not apply | Not part of this level, or not relevant. | same | no |
| `held` | On hold | Paused; reason beside it. | everywhere | no |
| `parked` | Waiting for answers / Paused: no answer | Paused for missing answers. | everywhere | no |
| `blocked` | Blocked | Cannot go on until something is fixed. | everywhere | no |
| `stale` | Out of date | Older than allowed; refresh. | everywhere | no |
| `stale_index` | Search out of date | The repo index is behind; it rebuilds on the next scan. | Agent console | no |
| `busy` | Full | No free slot right now. | Operate | no |
| `pending` | Waiting | Not decided or done yet. | everywhere | no |
| `void` / `refused` / `error` | Did not count · Refused · Failed to run | A check result that is not a pass. | Verify | no |
| `observed` / `intended` | As found · As intended | A draft spec from the code, or confirmed as intended behaviour. | Onboard | no |
| `affirmed` / `pending_projection` / `drift` / `absent` (served files) | Approved · Waiting for PR merge · Changed on GitHub · Missing | The state of a file the factory placed. | Project › Drift | no |
| `starter` | Needs starter files | See §7.2. | Onboard | no |
| `superseded` | Replaced | A newer version took its place. | everywhere | no |
| `expired` | Expired | Ran out of time; never approves. | everywhere | no |
| `sent_back` | Changes requested | Sent back with requested changes. | Inbox | no |
| `not_requested` | Not asked for | This level was not requested. | Readiness | no |
| `not built` | (must not appear) | Intent §7: no screen says "not built". | — | no |

---

## 20. Core nouns

| Code / internal term | Plain label | Tooltip | Where | Code kept? |
|---|---|---|---|---|
| Factory / fleet | Factory | All projects and everything they share. | Shell, Settings | no |
| Project | Project | One onboarded repo and its settings, people and work. | Projects | no |
| Repo / registered repo | Repo | A GitHub repository. | Projects, Onboard | no |
| Work item / item | Work item | One request and everything the factory does for it. | Items, Work item | no |
| Item key | Item number | The item's short id, for example PAY-42. | everywhere | no |
| Request / entry channel N1–N8 | Request (from: portal, Slack, API, GitHub issue) | Where the request came from. | Request tab | no |
| N6 | Factory suggestion | A fix the factory proposes after onboarding. | Request tab | audit |
| Issue twin | Linked GitHub issue | A GitHub issue linked to a request or gap. | Project, Work item | no |
| Floor | Floor | A live view of all work, by stage. | Floor | no |
| Fleet | All projects | The floor or list across every project. | Floor, Projects | no |
| Inbox | Inbox | Everything waiting on you. | Shell | no |
| Card | Decision card | One thing to decide, maybe several approvals together. | Inbox | no |
| Close-out record | Final record | What was done, checked and decided, kept for good. | Work item | no |
| Escape | Bug after merge | A problem found after the work closed. | Work item | no |
| Mode-E audit sample | Spot-check | A lightly reviewed merge picked for audit. | Inbox | no |
| Catalogue / catalogue version | Process version | The version of the tracks and limits this item runs under. | Work item (tooltip), Settings › Tracks | secondary |
| Pinned catalogue | Started under version 1.3 | An item keeps the process version it started with. | Work item | no |
| Correlation id / event id | (hidden) | Shown only in Decision log & audit. | — | audit |

---

## 21. Machine shape: glossary in the code

Describe, do not implement (the design-system squad builds it after the owner approves this file).

**Where:** `packages/contracts/src/glossary.ts`, exported from `@aisdlc/contracts`, so the web, the bff (error reasons, locked-button
reasons), the notifier (Slack and email text) and core (inbox card titles) all read the same words. The web's
`services/web/src/vocab.ts` and the `Record<Value, look>` tables of the foundation become thin readers of it.

**Shape:**

```ts
type Term = {
  label: string;            // ≤ 4 words, sentence case (a test checks both)
  tip: string;              // one sentence, ends with a full stop, ≤ 160 characters
  code: 'none' | 'audit' | 'secondary'; // when the code may show
  where?: readonly ScreenId[];          // optional: for the QA matrix
};

export const GLOSSARY = {
  stage:        {} as Record<StageId, Term>,
  step:         {} as Record<StepId, Term>,
  gate:         {} as Record<GateId, Term>,
  gateFamily:   {} as Record<GateFamily, Term>,
  toggleGroup:  {} as Record<ProjectToggleGroup, Term>,
  decision:     {} as Record<LedgerDecision, Term>,
  gateStatus:   {} as Record<GateStatus, Term>,
  cardStatus:   {} as Record<CardStatus, Term>,
  lane:         {} as Record<Lane, Term>,
  relane:       {} as Record<RelaneId, Term>,
  level:        {} as Record<Level, Term>,
  tier:         {} as Record<Tier, Term>,
  autonomy:     {} as Record<Autonomy, Term>,
  phase:        {} as Record<WorkItemPhase, Term>,
  wait:         {} as Record<WaitState, Term>,
  room:         {} as Record<FloorRoom, Term>,
  floorStatus:  {} as Record<FloorItemStatus, Term>,
  backEdge:     {} as Record<BackEdgeId, Term>,
  handoff:      {} as Record<HandoffId, Term>,
  trigger:      {} as Record<TriggerId, Term>,
  hold:         {} as Record<HoldReason, Term>,
  unitState:    {} as Record<UnitState, Term>,
  sessionState: {} as Record<AgentSessionState, Term>,
  role:         {} as Record<RoleId, Term>,
  action:       {} as Record<ActionId, Term>,
  viewLevel:    {} as Record<ViewLevel, Term>,
  dataClass:    {} as Record<DataClass, Term>,
  card:         {} as Record<CardKind, Term>,
  onboarding:   {} as Record<OnboardingStatus, Term>,
  readiness:    {} as Record<ReadinessStatus, Term>,
  pillar:       {} as Record<ReadinessPillar, Term>,
  lightFloor:   {} as Record<LightFloorId, Term>,
  blocker:      {} as Record<BlockerId, Term>,
  control:      {} as Record<ControlId, Term>,
  verifyCheck:  {} as Record<VerifyCheckId, Term>,
  verdict:      {} as Record<CheckVerdict, Term>,
  repairClass:  {} as Record<RepairClass, Term>,
  health:       {} as Record<HealthState, Term>,
  killState:    {} as Record<KillState, Term>,
  controlKind:  {} as Record<ControlKind, Term>,
  sandboxClass: {} as Record<SandboxClass, Term>,
  integrationKind: {} as Record<IntegrationKind, Term>,
  notificationKind: {} as Record<NotificationKind, Term>,
  agent:        {} as Record<AgentId, Term>,
  configKey:    {} as Record<RegisteredConfigKey, Term>,
  status:       {} as Record<'unknown' | 'unreadable' | 'met' | 'not_met' /* … §19 */, Term>,
} as const satisfies { [K: string]: Record<string, Term> };
```

**Why it fails the build:** each family is `Record<ContractEnum, Term>`, so adding a value to `GateId`, `Lane`, `ActionId`,
`RoleId`… is a type error until the value has a label. `configKey` is keyed by a union derived from the registered keys (a
`REGISTERED_CONFIG_KEYS` const the config registry exports), so a new setting fails the build too.

**Tests (one file, `glossary.test.ts`):**

- every label ≤ 4 words, sentence case, no code pattern (`/\b([SGLXEDMQBH]\d+|ET\d+|LF\d|KRL|PRR|SECT|SECR)\b/`) in a label or tip;
- every tip is one sentence;
- no two terms of one family share a label (except the deliberate shared words listed in §22);
- a web lint rule (`no-raw-vocab`) refuses a JSX string literal equal to an enum value (`"G4"`, `"L3"`, `"census"`): the screen must
  call `term('gate', 'G4').label`;
- a snapshot of the glossary is reviewed in the PR like the catalogue: changing a label is a visible diff the owner approves.

**Helpers:** `term(family, value)`, `<Term family value />` (label with the tooltip and, where `code` allows on that screen, the
code chip), `reason(edgeOrTrigger, limitsLeft)` for the one-line "what happened → what next" in §9.

**Not in the glossary:** free text from the record (titles, reasons people type), and agent output. Those are data.

---

## 22. Decided by the owner (2026-11-13, "approve with defaults")

1. **L1 "Quick fix" and L3 "Small change"** stay separate tracks with those names.
2. **"Ledger" is "Decision log"** on screens; the screen is **"Decision log & audit"**.
3. **"Gate" is "approval"** and **"lane" is "track"** everywhere, including Settings.
4. **"Unit" is "part"** (one part of the plan = one branch and one PR).
5. One word each for shared concepts: **"Security hold"** and **"Needs a person"**.
6. Onboarding blockers are written `OB-B1`… in exports; no code shows on screen.
7. **E4 "Choose what happens next"** is decided by the work's owner of record by default; who decides it is a setting
   (Settings › Approvals), and the factory admin can always decide it.
8. **Branch protection** is never set by the factory (its App never holds `administration`): the onboarding agent gives
   exact steps and a ruleset file the owner imports into GitHub in one step, then checks it is in force.
9. **Delete means delete** (portal-v2-intent.md): AGENTS.md's record rule gains that deleting an object removes its
   record data and read models while the ledger keeps entry hashes only.
