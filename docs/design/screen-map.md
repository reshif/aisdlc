# Portal v2 screen map

Status: draft for the owner's approval, 2026-11-13. Built on [`portal-v2-intent.md`](portal-v2-intent.md) (it wins) and the
agreed skeleton ("AISDLC portal layouts" canvas, page "AISDLC skeleton"). Every label here is from [`glossary.md`](glossary.md).
Written against the code on `origin/docs/portal-v2-intent`; the API names are the bff's (`services/bff`), which fronts core and the
other services.

How to read each screen:

- **Purpose** in one line, **who** uses it (roles as the glossary names them), **phone** yes or no.
- **Blocks** top to bottom.
- **Actions**: every button, who may press it (the PDP action that decides on the server) and what it changes.
- **Empty / error**: what shows when there is nothing, or when something fails. Every screen also has the shared states in §1.4.
- **API**: the existing route, or **NEW API Nn** (listed once in [§4](#4-new-apis)).
- **Gap** marks something the intent needs that the backend lacks today ([§6](#6-backend-gaps)).

Rule for every screen: the factory admin can do everything on every screen (intent, "nothing applies to the factory admin"). Where
other people are bound by a rule (two people, own request, a role), the factory admin sees a **Decide as factory admin** or **Apply
as factory admin** button that asks for a reason and records it. This is written once here and not repeated per screen.
This is **Gap G3** today.

Contents: [1 Shell](#1-shell-and-shared-states) · [2 Screens](#2-screens) · [3 Admin lifecycle](#3-admin-lifecycle-create-edit-delete) ·
[4 New APIs](#4-new-apis) · [5 Hard-coded settings](#5-hard-coded-settings-found-in-the-code) · [6 Backend gaps](#6-backend-gaps) ·
[7 Counts](#7-counts)

---

## 1. Shell and shared states

### 1.1 Sign-in (`/signin`)

| | |
|---|---|
| Purpose | Get into the portal: company SSO first, a local account second, security key when asked. |
| Who | Everyone. Local accounts: factory admins only (break-glass). |
| Phone | Yes |
| Blocks | Headline and the approval card beside it (option A); **Sign in with company SSO**; "or" divider; **Local account** (username, password, then security key); the session policy in one line ("Signed out after 30 min idle, 8 h at most"). |
| Actions | Sign in with company SSO (anyone; redirects to Keycloak / the OIDC provider). Sign in with local account (anyone with a Keycloak local account). |
| Empty / error | "Your account is suspended. Ask a factory admin." · "Sign-in provider is not answering. Try again, or use a local account if you are a factory admin." |
| API | `GET /auth/login`, `GET /auth/callback`, `POST /api/logout`, `POST /api/step-up`, `GET /api/me`. **Gap G5**: today the bff's own dev OIDC provider (`services/bff/src/dev-oidc/`) and a seed file (`IDENTITY_IDP_SEED_FILE`) stand in for Keycloak. |

### 1.2 The shell (every page)

| Block | Contents | Who | Phone |
|---|---|---|---|
| Top bar | Factory name; global search (items, projects, approvals, people; **NEW API N1**); **Ask for work**; inbox count; the assistant; **Stop agents** (red, only for those who hold `kill.request` somewhere); avatar menu (My access, My notifications, theme, Sign out). | everyone | Yes: search, inbox, Stop agents and the menu collapse into a bottom bar |
| Left nav (groups) | **Work**: Home, Inbox, Items, Floor. **Projects**: Projects, Onboard a repo. **Run**: Operate, Agents. **Govern**: Settings, Integrations, People, teams & roles, Decision log & audit. An entry the person cannot open is not listed; an empty group is not shown. | everyone | Yes (drawer) |
| Banners (top of content) | Agents stopped (scope) · Maintenance mode · Signing paused · Data may be stale · Notices posted by operators. Each says what it means and, for those who can, links to the fix. | everyone | Yes |
| Assistant panel | "Ask the factory" beside any page; answers only from what you can see; on the Onboard page it is the onboarding agent's chat. | `assistant.use` | Yes |

Actions in the shell:

| Button | Who (PDP) | What it changes | API |
|---|---|---|---|
| Ask for work | `work.request` on at least one project | opens Ask for work (§2.8) | — |
| Stop agents | `kill.request` | opens the emergency stop sheet (§2.15, Emergency stop) | `POST /api/kills/prepare`, `POST /api/kills` |
| Search | signed in | none (read) | **NEW API N1** |
| Ask the assistant | `assistant.use` | none (read) | `POST /api/assistant/ask`, `GET /api/assistant/threads` |
| Sign out | signed in | ends the session | `POST /api/logout` |

### 1.3 Personal pages

| Screen | Purpose | Blocks | Actions | API | Phone |
|---|---|---|---|---|---|
| My access (`/me/access`) | What I can do and why | My roles (in force or not, why); per project: view level, data class, what I can do; my access requests | Request access (signed in: creates an access request) | `GET /api/me/access`, `POST /api/me/decisions`, `POST /api/access/requests` | Yes |
| My notifications (`/me/notifications`) | What the factory told me | List newest first; preferences per kind and channel ("Always sent" ones locked) | Save preferences (self) | `GET /api/me/notifications`, `GET/PUT /api/me/notifications/preferences` | Yes |

### 1.4 Shared states

| State | What shows |
|---|---|
| 403 | "You can't open this. *Reason from the PDP.* Ask *names of who can grant it*." + Request access. |
| 404 | "Not found." The same for missing and invisible. |
| Loading | Skeleton blocks; never example data. |
| Unknown | "Unknown: treated as not met", never a tick. |
| Read model stale | "Data may be stale (last update 3 min ago)" banner on that block. |
| Write refused | Toast with the server's reason; nothing changed. |
| Locked button | Shows the button greyed with the reason on hover/tap and "Request access". The factory admin never sees a locked button: they see the override (§ intro). |

---

## 2. Screens

### 2.1 Home: needs you (`/`)

| | |
|---|---|
| Purpose | What needs me now, then what I am waiting for. |
| Who | Everyone; extra blocks for factory admin, auditor, security approver, viewer. |
| Phone | Yes |

| Block (top to bottom) | Contents | API |
|---|---|---|
| Needs you | Approvals waiting on me (oldest first, overdue in red), questions on my requests, handovers I must choose, onboardings waiting for my sign-off. Each row: plain approval name, item, project, age, one primary verb (opens Decide). | `GET /api/inbox`, `GET /api/items?mine=1` |
| My requests | My open work items with their stage strip and status pill. | `GET /api/items` |
| Waiting on others | My items blocked on someone else's approval, with that person's name. | `GET /api/items`, `GET /api/inbox` (scope team) |
| My projects | Readiness, agents on or stopped, items in progress. | `GET /api/projects` |
| Factory admin only | Integration health summary, open settings changes, onboardings in progress, emergency stops. | `GET /api/health`, `GET /api/config/keys`, `GET /api/kills/active` |
| Auditor only | Recent decisions, bypassed merges to review. | `GET /api/audit/decisions` |

| Action | Who | What it changes |
|---|---|---|
| Open (row) | anyone who sees it | navigates to Decide / Work item |
| Ask for work | `work.request` | opens §2.8 |

Empty: "Nothing needs you. Ask for work to start, or onboard a repo." (the second only for `project.onboard`).

### 2.2 Inbox (`/inbox`)

| | |
|---|---|
| Purpose | Every decision waiting on me, my team or (fleet roles) the factory. |
| Who | Everyone who decides anything. |
| Phone | Yes |

| Block | Contents | API |
|---|---|---|
| Tabs | Waiting on me · My team · Whole factory (factory admin, auditor) · Decided by me · Watching | `GET /api/inbox?scope=` |
| Filters | Project, approval, overdue only | — |
| List | Card per decision: plain approval name (`G3` chip only for auditors), item title and number, project, why it's mine ("You can decide" / "Overdue: you are the backup"), due ("Due in 1 working day"), "Needs two people: 1 of 2". "Nobody can decide" flagged in red with who could be given the role. | `GET /api/inbox` |
| Spot-checks | Lightly reviewed merges picked for audit (§9.5 step) | `GET /api/items/:id/closeout` |

| Action | Who | What it changes | API |
|---|---|---|---|
| Open | `gate.view` | to Decide | — |
| Approve (quick, only for cards with no evidence to read, e.g. settings changes the person proposed elsewhere: never for code review, release, security) | `gate.decide` / `card.decide` | records the decision | `POST /api/cards/:id/gate/decide` |
| Record a spot-check | `audit.record` | records ok / missed | `POST /api/items/:id/audit` |

Empty: "Nothing is waiting on you." Error: "The inbox could not load. Your approvals are safe; nothing expires approved."

### 2.3 Decide an approval (`/decide/:card`)

| | |
|---|---|
| Purpose | Read the evidence, then decide. Evidence first, decision rail on the right (skeleton). |
| Who | The deciding role of the approval (§12 of the glossary); viewers see it read-only. |
| Phone | Yes (the rail becomes a sticky bottom sheet) |

| Block | Contents | API |
|---|---|---|
| Header | Plain approval name + chip (auditors), item, project, track, "Always required" if so, due. | `GET /api/cards/:id/gate` |
| What you are approving | One paragraph in plain words, from the approval kind: e.g. "The plan for 3 parts, based on commit 3f2a91c." | `GET /api/cards/:id/gate` |
| Evidence (per approval kind) | Accept the request / Confirm the goal: request text marked untrusted, possible prompt injection, duplicates, agreed goal. Approve the spec / design / outline / plan: the documents with diffs to the last version. Code review: the PR summary, the factory check, the evidence pack, the checks with findings. Release: what merged, the evidence, the environment. Exceptions (irreversible action, protected file, new dependency, rule exception, locked test, security review): what the exception binds. Settings change: the before/after diff and the preview of its effect. Onboarding sign-off: the onboarding summary. | `GET /api/cards/:id/artefacts`, `GET /api/cards/:id/gate/context`, `GET /api/items/:id/verify`, `GET /api/items/:id/evidence`, `GET /api/revisions/:gate` |
| Decision rail | Who may decide and why (or why not you); two-person state ("Ana approved; one more needed"); Reason field; **Approve · Request changes · Reject**; "Confirm it's you" when the approval needs it; for code review in light mode **I'm not sure**. | `GET /api/cards/:id/gate` |
| History | Earlier rounds of this approval, decisions and reasons. | `GET /api/cards/:id` |

| Action | Who | What it changes | API |
|---|---|---|---|
| Approve | `gate.decide` (slot of the approval), not the requester (except Accept the result), not the plan or code author | ledger decision `approve`; the work moves on | `POST /api/cards/:id/gate/prepare`, `.../evidence`, `.../decide` |
| Request changes | same | ledger `request_changes`; the work goes back (glossary §9) | same |
| Reject | same | ledger `reject` | same |
| I'm not sure | `item.unsure` (code reviewer, light review) | asks for a full review | `POST /api/items/:id/review/unsure` |
| Choose what happens next: Resume · Re-plan · Rewrite spec · Take over · Stop the work | exception approver (E4) | the handover choice | `POST /api/items/:id/handoff/choose` |
| Decide as factory admin | factory admin | decides without the slot, the two-person rule or the own-request rule; reason required | **NEW API N2**, **Gap G3** |

Empty: n/a. Errors: "This approval was replaced by a newer version" (link) · "Expired, not approved" · "Agents stopped: decisions are paused" · "Maintenance mode: decisions are paused".

### 2.4 Work item (`/items/:key`)

| | |
|---|---|
| Purpose | Everything about one piece of work: where it is, what was written, what the agents did, what was checked. |
| Who | Requester, approvers, engineers on the project, viewers (titles cut at Overview level). |
| Phone | Yes for Now and Timeline; the other tabs read on phone but are desktop-first. |

Above the tabs (always):

| Block | Contents | API |
|---|---|---|
| Title bar | Title, item number, project, track, status pill, requester. | `GET /api/items/:id` |
| Stage strip | Intake → Research → Spec → Design → Plan → Build → Verify → Review and merge → Release → Close; skipped stages grey, current highlighted, sent-back arrows shown. | `GET /api/items/:id` |
| Properties (right column) | Track, process version, budget used of total, parts, PRs with commits, approvals with state, rework "1 of 5 used". | `GET /api/items/:id` |
| Approvals strip | Each approval on this item's route: waiting / decided / off. | `GET /api/items/:id` |

Tabs:

| Tab | Blocks | Actions (who · what) | API | Phone |
|---|---|---|---|---|
| **Now** | What is happening, in one sentence ("Waiting for Ana Ruiz to approve the plan"); the one thing you can do; questions to answer; handover notes; held reason with "what next"; the final record when closed. | Answer questions / Mark ready (`item.ready` · answers, moves to acceptance); Raise a concern (`item.observe` · spec gap or lighter track during design review); Write the plan (`item.plan` · after 2 send-backs); Hand back (requester or person who took over · gives work back once); Mark my work done (`item.human_done` · human-led work to checks); Ask to release again (`item.release`); Report a bug after merge (`item.escape` · new linked fix item); Withdraw (requester · NEW API N3); Abandon as factory admin (N3) | `GET /api/items/:id`, `POST /api/items/:id/ready`, `/answers`, `/observe`, `/plan`, `/hand-back`, `/human-done`, `/release/re-request`, `/escape`, `GET /api/items/:id/handoff`, `GET /api/items/:id/closeout` | Yes |
| **Request** | The text as kept, marked untrusted; possible prompt injection flags; duplicates and conflicts; track asked, picked and bound, and why; agreed goal. | none (read) | `GET /api/items/:id/request` | read |
| **Documents** | Every document by kind (decision brief, spec change, acceptance criteria, design, plan, parts…), versions, who wrote each, which approval approved which version, diff between versions. | Compare versions (read) | `GET /api/items/:id/documents` | read |
| **Agent console** | Per part: the agent runs (agent, step, state, verdict, spend, prompt version); the live session (steps 6.1–6.6, tool calls summarised, tripwires hit, budget meter, coding slot); the run transcript at Everything level only. | Stop session (`session.stop` · stops one sandbox session: **NEW API N4**, **Gap G9**) | `GET /api/agent-runs?item=`, `GET /api/agents/:id/runs`; live session stream **NEW API N5** | read |
| **Verify** | The five checks with verdicts and findings (cut to your data class), the approval each raised, the evidence pack (signed, commit, re-hashed), the factory check on the PR. | Open evidence pack; Verify offline (copy command) | `GET /api/items/:id/verify`, `/evidence`, `/evidence/:pack/signed`, `/gate-check` | read |
| **Timeline** | Every step and decision in order, plain words, actor glyphs, codes only on hover for auditors. | none | `GET /api/items/:id/timeline` | Yes |

Empty: a tab with nothing yet says what will appear and when ("Documents appear once research starts"). Error: 404 for invisible.

Evidence pack viewer (`/items/:key/evidence/:pack`): signed by the factory, commit, every check, file hashes; **Download** and
**Verify offline** (copy `aisdlc-verify-pack` command). API: `GET /api/items/:id/evidence/:pack/signed`. Phone: no.

### 2.5 Items (`/items`)

| | |
|---|---|
| Purpose | Find any work item. |
| Who | Everyone (only items they can see). |
| Phone | Yes (list only) |
| Blocks | Filters (project, track, stage, status, requester, mine); list or board toggle (board = columns by stage); each row: number, title, project, track, stage, status, age, waiting on whom. |
| Actions | Ask for work (`work.request`). Export CSV (`audit.read`; **NEW API N6**). |
| Empty / error | "No work items yet. Ask for work." |
| API | `GET /api/items` |

### 2.6 Floor (`/floor`, `/floor/:project`)

| | |
|---|---|
| Purpose | The live view of all work by stage, with what is stuck and where approvals wait. |
| Who | Everyone with `floor.read`; viewers without titles. |
| Phone | No (a list fallback on phone: stuck and waiting items only) |
| Blocks | Scope picker (all projects / one project); emergency-stop and stale banners; stations by stage with item chips; approval points with waiting initials; rooms (Queue, On hold, Security hold, Needs a person, Declined, Done); coding sandboxes; sent-back arrows; agent quality chips; track filter; item drawer, station drawer, approval drawer. |
| Actions | Open item / approval (read). Stop agents on a project or track (`kill.request`). Reset a paused track (`config.propose` · opens "Raise agent autonomy" approval). |
| Empty / error | "No work in progress." · "Cannot reach the stop switch: shown as stopped." |
| API | `GET /api/fleet`, `GET /api/floor/:project`, `GET /api/projects/:id/breakers`, `POST /api/projects/:id/breakers/:lane/reset` |

### 2.7 Projects (`/projects`)

| | |
|---|---|
| Purpose | All projects I can see, with their health at a glance. |
| Who | Everyone. |
| Phone | Yes (list) |
| Blocks | Search; list: project, repo, level, readiness 0–4, agents on/stopped, items in progress, approvals waiting, "Changes since onboarding" flag; private projects show only to members. |
| Actions | Onboard a repo (`project.onboard`). Open. |
| Empty | "No projects yet. Onboard a repo to start." |
| API | `GET /api/projects`, `GET /api/fleet` |

### 2.8 Ask for work (`/ask`, also a modal)

| | |
|---|---|
| Purpose | Send a request to the factory. |
| Who | Requesters (`work.request`). |
| Phone | Yes |
| Blocks | Project picker (only projects where I may ask); title; what you need (text, marked untrusted after sending); optional: track you expect, link to a GitHub issue; live hints: possible duplicates, possible prompt injection, "This repo allows: small changes, hotfixes" (eligibility), "Who decides: Ana Ruiz accepts the request". |
| Actions | Ask for work (`work.request` · creates the request, S1 starts). Save draft (self; NEW API N7). |
| Errors | "This repo is not ready for this kind of work (read only)." · "Agents are stopped on this project; your request will wait." |
| API | `POST /api/requests`, `GET /api/projects/:id/explain`; draft **N7** |

### 2.9 Project page (`/projects/:id`)

Header (all tabs): project name, repo link, level, risk tier, readiness 0–4, agents on or stopped; **Ask for work**, **Stop agents
on this project** (`kill.request`), **Pause agents** (`control.apply` · hold on the project).

| Tab | Purpose | Blocks | Actions (who · what) | API | Phone |
|---|---|---|---|---|---|
| **Overview** | The project at a glance | Readiness scorecard summary; work in progress by stage; approvals waiting; spend this month vs budget; suggestions from finished work (Learn); recent decisions | Suggest improvements (`learn.propose` · runs Learn, opens factory-change approvals) | `GET /api/projects/:id`, `/prr`, `/learn`, `POST /api/projects/:id/learn/run`, `GET /api/cost` | Yes |
| **Work** | This project's items | Items list (as §2.5, filtered); linked GitHub issues | Ask for work; File gaps as issues (`work.request` · issue batch); Link an issue | `GET /api/items?project=`, `GET/POST /api/projects/:id/issue-twin/*` | Yes |
| **Floor** | This project's floor | As §2.6 for one project; paused tracks with reset | Reset a paused track | `GET /api/floor/:project`, breakers routes | No |
| **Readiness** | What this repo is ready for | Scorecard: four pillars (Testing, Environment, Operations, Knowledge) with criteria met / not met / unknown and evidence; tracks allowed; level by folder; gaps with fix PRs / issues; expiry date; onboarding history (versions) | Raise the level (`project.onboard` · starts a level-up onboarding); Sign again (`project.onboard`); Re-onboard (`project.onboard`); Edit level by folder (`project.settings.edit` · M1) | `GET /api/projects/:id/prr`, `/knowledge`, `POST /api/projects/:id/onboarding-versions` | read |
| **People & gates** | Who decides what here | Each role with its people; each approval with who decides, two-person, "confirm it's you", feasibility ("Nobody can decide" flagged); "who can do what" for a chosen person | Change who decides what (`project.settings.edit` · settings change M1 → apply); Give a role / remove (`access.manage`); Check a person (`access.explain`) | `GET /api/projects/:id/explain`, `GET /api/access/bindings`, `POST /api/access/grants`, `/api/projects/:id/config/keys/project.role_map` | read |
| **Drift** | Changes on GitHub since onboarding | Each change (protection loosened, App widened, instructions edited, new secret), its effect (confirm again / agents suspended / security check); files the factory placed and their state; re-onboarding proposals | Re-check (`project.settings.edit`); Confirm again (`project.settings.edit` + confirm it's you); Restore (`project.settings.edit` · lifts suspension after re-check); Confirm security change (security approver); Accept / decline re-onboarding (project admin) | `GET /api/projects/:id/drift`, `POST .../drift/recheck`, `.../reaffirm`, `.../restore`, `.../security/confirm`, `.../reonboarding/decide` | read |
| **Settings** | Everything configurable for this project | Grouped: Approvals on/off per track; Two-person approvals; Who can stop agents; Releases (off or environment); Work-in-progress limit; Default budget; Integrations it may use (repos, models); Who may merge without the check; Agents may run code here; Pause agents. Each row: value in force, revision, who approved, **Change**. | Change (`project.settings.edit` · draft → preview → propose → approval → in force; factory admin: **Apply now** N2) · Pause / resume agents on this repo (`control.apply`/`control.lift`) · Delete project (factory admin, §3) | `GET /api/projects/:id/config/keys`, `/:key`, `POST /api/projects/:id/config/keys/:key/proposals`, `GET/POST /api/revisions/:gate/*`; preview **NEW API N8** | No |
| **Audit** | This project's record | Decision log for the project; merges seen by the factory check (gated / bypassed / without permission / before watch); exports | Export (`audit.read` · signed export) | `GET /api/projects/:id/ledger`, `GET/POST /api/audit/exports`; merges list **NEW API N9** | No |

Empty states: per tab, e.g. Drift "No changes since sign-off on 13 Nov 2026."

### 2.10 Onboard a repo (`/onboard`, `/onboard/:id`)

Agent-led (intent §4). Four steps on one page with a progress rail. The cards C1–C5 stay underneath as the record. **Gap G4**.

| | |
|---|---|
| Who | Anyone with `project.onboard` (factory admin, "Can onboard repos"); the onboarding signer signs; the factory admin may do everything alone. |
| Phone | No (the sign-off itself works on phone through Decide) |

| Step | Blocks | Actions (who · what) | API |
|---|---|---|---|
| **1. Pick a repo** | Repos the factory's GitHub App can see, with "already a project" marked; if none: "Install the GitHub App on a repo" with the link; level wanted (Read only / Small changes / All work), with what each allows; team. | Start onboarding (`project.onboard` · creates the onboarding, the agent starts); Install the App (opens GitHub) | `GET /api/onboard/repos`, `POST /api/onboard` |
| **2. Agent works** | Live checklist of what the agent does (read-only scan, owners, tests run, branch protection, App permissions, secrets, agent instructions, code map for All work); each finding as it lands; the fix PRs it opens (CODEOWNERS, AGENTS.md, `.factory/` files, starter files) with their GitHub state; things only a person can do on GitHub (e.g. protect main, required check) with a one-line instruction and **Re-check**; the onboarding agent's chat to answer its questions. | Answer a question (the person onboarding); Re-check (same); Retry test run (same); Pause / Withdraw (same) | `GET /api/s0/:id`, `GET /api/s0/:id/cards`, `POST /api/cards/:id/recheck`, `/probe/retry`; live progress and agent chat **NEW API N10**; fix PRs **NEW API N11** |
| **3. One summary** | One page with sections: Owners and risk (tier, owner); Repo facts (each with Confirm · Correct · Don't know, prefilled by the agent); Agent instructions (the text, editable); GitHub protection and the App; Who decides what (role map proposed from CODEOWNERS and collaborators, editable); Which approvals are on; Secrets found and what to do; Gaps: fix now (PR or issue) · track · accept; the readiness scorecard it will sign; what agents may then do (tracks). Everything adjustable in place. | Adjust any field (the person onboarding); Accept all agent suggestions (same) | `GET /api/s0/:id/cards`, `GET /api/cards/:id`, `POST /api/cards/:id/instructions`; one summary read and edit **NEW API N12** |
| **4. Sign off** | What you sign (level, tier, readiness, approvals on, people); "Needs two people" if the project says so; confirm it's you. | Sign off (onboarding signer · all cards' decisions and the onboarding sign-off in one step, each still ledgered); Sign off as factory admin (factory admin · alone, skipping any step, reason recorded); Send back to the agent | **NEW API N13** (one sign-off that decides the underlying cards C1/C2/C3/C4/C5/SECR/X2 and M4 atomically); today `POST /api/cards/:id/prepare|evidence|decide` per card |

Empty: "No repos visible. Install the factory's GitHub App on a repo, then come back." Errors: "GitHub App has a permission it must
not have (administration): remove it on GitHub, then Re-check." · "Tests did not run: the sandbox image is not set (Settings ›
Sandboxes)."

### 2.11 Settings (`/settings`, `/settings/:section`)

| | |
|---|---|
| Purpose | Everything configurable for the factory, nothing hard-coded (intent §3). Change → preview → approve; the factory admin applies alone. |
| Who | Factory admin (all); project admins see the factory values read-only; auditors read-only. |
| Phone | No |

Sections (left list) and what each holds:

| Section | Settings (glossary §18) | Exists as config today? |
|---|---|---|
| General | Working days; Who approves factory settings; Learning from finished work; Floor display; Sign-in session limits | yes except session limits (env, **H16**) |
| Tracks | Each track: steps, approvals, entry point, change size limit, default budget; retry limits per sent-back reason; rework limit; budget extension | **no** (catalogue in code, **H1–H5**) |
| Approvals | Each approval: who decides, two people, confirm it's you, can be switched off, overdue after, expires after | **no** (`GATE_POLICIES`, timers in code, **H6–H8**) |
| Onboarding | Retries and pauses; time limits; low risk needs confirmation; agent instructions template; when to re-onboard; readiness rules | partly (readiness rules **H10**) |
| Factory rules | No unapproved network access; migrations reversible; add a rule | yes |
| Sandboxes | Sandbox limits; coding sandboxes at once; repos agents may run code in; test-run image; coding image | yes, but the coding cap is ignored above 1 (**H9**) |
| Retention | Keep for, per data kind | yes |
| Access policy | Roles and what they can do (read-only view; editing roles is People, teams & roles) | read-only today (roles in code, **H11**) |

Change flow (one pattern for every setting, project settings too):

| Step | Blocks | Action (who · what) | API |
|---|---|---|---|
| Value in force | value, revision, who approved and when, link to the decision | Change (`config.propose`) | `GET /api/config/keys/:key` |
| Draft | form from the setting's schema; secrets are never here (they live in Integrations) | Preview (same) | — |
| Preview | the diff and its **effect**: "3 projects get a new approval on Feature; 2 items in flight keep the old process version"; "This lowers coding sandboxes from 2 to 1: 1 build will wait" | Propose (`config.propose` · opens "Approve a settings change"); **Apply now** (factory admin · proposes and approves in one step, reason recorded) | **NEW API N8** (preview); `POST /api/config/keys/:key/proposals`; apply-now **N2** |
| Waiting | who can approve, "Someone changed this first" if stale | Approve / Request changes / Reject (per "Who approves factory settings") · Withdraw (proposer) | `GET /api/config/revisions/:gate`, `POST /api/config/revisions/:gate/*` |
| History | every change with diff and decision | Revert to this (`config.propose` · a new change) | `GET /api/config/keys/:key` |

Empty: n/a. Error: "Someone changed this first. Reload and redo your change." · "Nothing changed."

### 2.12 Integrations (`/integrations`, `/integrations/:id`)

| | |
|---|---|
| Purpose | Connect GitHub, model providers, Slack and email, and sign-in; enter secrets; test; see health. |
| Who | Factory admin (edit); auditors and project admins (read, `quality.read`). |
| Phone | No |

| Section | Blocks | Actions (who · what) | API |
|---|---|---|---|
| Overview | Tiles: each integration with health (Healthy / Degraded / Down / Unknown), last check, last change | Add integration (factory admin) | `GET /api/integrations`, `GET /api/health` |
| GitHub | The Apps (Factory bot App, Check App, Release App, Issues App): created or not, permissions vs required, "permissions it must not have" warnings, installations and their repos, the required check `aisdlc/gate` per repo (set or not, from the scorecard) | Create App (factory admin · runs the manifest flow in the browser: **NEW API N14**, today the CLI wizard `platform/compose/setup-github-apps`); Re-check installation; Paste private key (write-only, Vault); Test; Disable; Delete (§3) | `GET /api/integrations/github-apps`; **N14**; secrets **N15**; test **N16** |
| Models & providers | Providers (Anthropic, OpenAI-compatible, Test model) with key status ("Secret saved 3 Nov", never the value); models with limits and prices; model per data class; **model per agent** | Add provider; Paste API key (write-only, Vault); Test; Reload; Add model; Change model per data class (settings change); Change model per agent (settings change) | `GET /api/models/providers`, `POST /api/models/reload`, `/api/config/keys/gateway.models|gateway.routes|integrations.registry`; secrets **N15**; test **N16**; model per agent **N17** |
| Notifications | Slack channels and email (SMTP): data-class cap, who gets what by default | Add channel; Paste webhook / SMTP password (write-only, Vault); Send test message; Disable | `/api/config/keys/notifications.channels`; secrets **N15**; test **N16** |
| Sign-in | Keycloak / OIDC: issuer, client, groups mapping; local accounts (factory admins only) | Edit (settings change); Paste client secret (Vault); Test sign-in; Add local admin account | **NEW API N18** (identity provider config and local accounts), **Gap G5** |
| Secrets | Every secret by name, where used, saved when, by whom; never the value | Replace secret (factory admin · write-only); Delete secret | **N15**, **Gap G1** |

Rules on this screen: a secret field is write-only: after **Save** the field empties and shows "Secret saved (13 Nov, by Lisa
Tan)". Nothing secret is ever sent back to the browser, logged or recorded (the record holds only the Vault path and a version).
Empty: "No model provider yet. Add one so agents can work." Error: "Test failed: Anthropic answered 401 (key refused). The saved
key was not changed."

### 2.13 People, teams & roles (`/people`, `/teams`, `/roles`, `/access-requests`, `/who-can`)

| | |
|---|---|
| Purpose | Who is in the factory, which teams, which roles, and who can do what. |
| Who | Factory admin (all), project admins (their project's roles: `access.manage`), auditors (read). |
| Phone | No (approving an access request works through Inbox on phone) |

| Tab | Blocks | Actions (who · what) | API |
|---|---|---|---|
| People | List: name, sign-in (SSO / local), teams, roles, status, last sign-in | Add person (factory admin · Keycloak user or invite); Edit; Suspend / reactivate (`identity.admin`); End sessions (`identity.admin`); Delete (§3) | `GET /api/directory`; **NEW API N19** (people create/edit/suspend/delete through identity with the PDP), **Gap G6** |
| Teams | Teams with members and projects | Add / edit / delete team (factory admin) | `GET /api/directory`; **N19** |
| Roles | Each role: plain name, what it can do (actions), view level, data class; custom roles | Add / edit / delete a custom role (factory admin · new PDP bundle through a settings change) | `GET /api/catalogue`; **NEW API N20**, **Gap H11** |
| Role assignments | Who holds which role where | Give a role / remove (`access.manage` · a settings change on the project's role map or a fleet binding) | `GET /api/access/bindings`, `GET/POST /api/access/grants` |
| Access requests | Open requests with the roles that would grant them | Approve / Reject (`access.manage`) | `POST /api/access/requests`; decide **NEW API N21** |
| Who can do what | Pick a project and a person or an approval: who can decide, why, what blocks | none (read) | `GET /api/projects/:id/explain` |
| Sign-ins | Recent sign-ins and sessions | End session (`identity.admin`) | **NEW API N22** |

Empty: "No teams yet." Error: "You can't give yourself a role." (still allowed for the factory admin with a reason).

### 2.14 Agents (`/agents`, `/agents/:id`)

| | |
|---|---|
| Purpose | Every agent: on or off, its model, limits and quality. |
| Who | Factory admin (edit); auditors, project admins (read, `quality.read`). |
| Phone | No |

| Block | Contents | Actions (who · what) | API |
|---|---|---|---|
| List | Plain name, what it does, steps, on/off, model, quality trend, runs this week, spend | Turn on / off (factory admin · settings change) | `GET /api/agents`, `GET /api/agents/:id/stats` |
| Agent page: settings | On/off; model (from the allowed list); max turns; time limit; budget per run (tokens and money); tools allowed (read-only: from its contract); most sensitive data (read-only) | Change (factory admin · settings change, preview shows items affected) | **NEW API N17** (`agents.config` key), **Gap H12** |
| Agent page: instructions | The prompt version in force (read-only; prompts are code), contract version | none | `GET /api/agents/:id` |
| Agent page: quality | Scores per prompt version, provider, model; evaluations with pass rate, baseline, real change or not | Run evaluation (factory admin · **NEW API N23**, today the `aisdlc-evals` CLI) | `GET /api/agents/:id/scores`, `GET /api/evals/summary`, `GET /api/evals/runs` |
| Agent page: runs | Recent runs with item, step, verdict, spend | Open in item's Agent console | `GET /api/agents/:id/runs` |

Empty: "No runs yet." Error: "Model not allowed for this agent's data."

### 2.15 Operate (`/operate`, tabs)

| | |
|---|---|
| Purpose | Run the factory: stop it, pause it, see capacity, sandboxes, health and spend. |
| Who | Factory admin; auditors (read); project admins and security approvers (their projects' stops and pauses). |
| Phone | Yes for Emergency stop; the other tabs desktop-first. |

| Tab | Blocks | Actions (who · what) | API |
|---|---|---|---|
| **Emergency stop** | Active stops (scope, who, why, since); restart waiting for second person; history | Stop agents (`kill.request` · scope: whole factory, project, track, session; confirm it's you); Restart agents (`kill.release` · two people; the factory admin alone with a reason **N2**) | `GET /api/kills`, `GET /api/kills/active`, `POST /api/kills/prepare`, `POST /api/kills`, `POST /api/kills/:id/release/prepare`, `POST /api/kills/:id/release` |
| **Pauses and notices** | Active controls (Pause, Limit, Halt, Maintenance) with scope and expiry; posted notices | Preview, then apply (`control.apply`); Lift (`control.lift`); Post a notice (`banner.publish`); Maintenance mode on/off (factory admin) | `GET /api/controls`, `POST /api/controls/preview`, `POST /api/controls`, `POST /api/controls/:id/lift`, `POST /api/banners`; maintenance via `/api/config/keys/ops.maintenance.mm2` |
| **Queue and capacity** | What waits to build and why (Waiting for an approver / coding slot / environment / too much in progress); coding slots used of total; parts waiting for a person (paused clock) | none (changes are in Settings › Sandboxes) | `GET /api/admission`, `GET /api/slots` |
| **Sandboxes** | Running sessions by kind (Read-only scan, Test run, Planning, Coding, Checks, Verify); limits per kind; tripwires hit; sandbox escape test result | Stop session (`session.stop` · **N4**, **Gap G9**) | `GET /api/slots`; sessions list **NEW API N24** |
| **Health** | Services and background jobs (Healthy / Degraded / Down / Unknown); signer and log witness; last log checkpoint | none | `GET /api/health`, `GET /api/degraded` |
| **Spend** | Spend by project, team, agent, model; budgets and burn; cost per merged item | Change budgets (settings change) | `GET /api/cost`, `GET /api/budgets` |

Empty: "No stops in force." Error: "Cannot reach the stop switch: agents are treated as stopped."

### 2.16 Decision log & audit (`/audit`, tabs)

| | |
|---|---|
| Purpose | The signed record of every decision, for auditors and admins; exports, legal holds, deletions. |
| Who | Auditor, factory admin; project admins see their projects. |
| Phone | No |

| Tab | Blocks | Actions (who · what) | API |
|---|---|---|---|
| **Decision log** | Every ledger entry: when (full timestamp), who, plain decision + code chip, subject, reason, hash; filters; chain status ("Verified up to checkpoint 1,204") | Verify the chain (read); Export (`audit.read`) | `GET /api/projects/:id/ledger`, fleet **NEW API N25**; `GET /api/audit/decisions` |
| **Access decisions** | Sampled permission decisions | none | `GET /api/audit/decisions` |
| **Exports** | Signed exports with scope and range | New export (`audit.read`); Download | `GET/POST /api/audit/exports`, `GET /api/audit/exports/:id/signed` |
| **Legal holds** | Holds in force | Place / release (`identity.admin`) | `GET/POST /api/audit/holds`, `POST /api/audit/holds/:id/release` |
| **Deletions** | Personal-data deletions and object deletions (§3) with state; what the log keeps (hashes) | Request / approve / reject (`identity.admin`; factory admin alone with reason) | `GET/POST /api/audit/erasures`, `POST /api/audit/erasures/:id/approve|reject`; object delete **N26** |
| **Retention** | What is kept how long; last sweep | Change (settings change) | `GET /api/audit/retention` |

### 2.17 Phone summary

| Works fully on phone | Read on phone | Desktop only |
|---|---|---|
| Sign-in, Home, Inbox, Decide an approval, Work item › Now and Timeline, Ask for work, Emergency stop, My access, My notifications, Projects list, Items list | Work item other tabs, Project Overview / Work / Readiness / People & gates / Drift, Floor (list fallback) | Floor plan, Onboard, Settings, Integrations, People, teams & roles, Agents, Operate tabs other than Emergency stop, Decision log & audit, Evidence pack viewer, Project Settings / Audit |

---

## 3. Admin lifecycle: create, edit, delete

One pattern for every object (intent §5). **Delete means delete** (intent, Decisions): all data and content of the object leave the
factory; the ledger keeps only each entry's hash. **Gap G2.**

| Object | Create | Edit | Delete (what goes, what stays) | Who | API |
|---|---|---|---|---|---|
| Project | Onboard (§2.10) | Project › Settings; level via Readiness | Everything of the project: items, documents, transcripts, PR links, evidence packs, settings, role map, read models, record events, object-store packs. The GitHub repo is untouched (fix PRs stay on GitHub). Ledger: hashes only. | factory admin | **N26** |
| Repo (re-point / remove from a project) | Onboard | Re-onboard, change level, pause agents | As project when it is the project's only repo; the App installation is left for the person to remove on GitHub (link shown). | factory admin, project admin (pause) | **N26**; pause `POST /api/controls` |
| Work item | Ask for work | Withdraw (requester), abandon (factory admin) | Its request, documents, transcripts, packs, events | factory admin | **N3**, **N26** |
| Person | People › Add | Edit, suspend | Name, handles, links, bindings, their notifications and preferences; their decisions stay in the ledger as hashes only and show as "Deleted person" | factory admin | **N19**, **N26** |
| Team | Teams › Add | Edit members | Team and its bindings | factory admin | **N19** |
| Role (custom) | Roles › Add | Edit actions | Role and its assignments; built-in roles cannot be deleted (safety floor) | factory admin | **N20** |
| Integration | Integrations › Add | Edit, disable | Row, its secrets in Vault (destroyed), its health; anything using it is shown first ("2 agents use this provider") | factory admin | **N27** (integration lifecycle) + **N15** |
| Secret | Integrations › Paste | Replace | Destroyed in Vault (all versions) | factory admin | **N15** |
| Setting (config key value) | — | Settings flow | Revert to default (a settings change) | factory admin | `POST /api/config/keys/:key/proposals` |
| Agent | — (agents are code) | Agents › settings | Turn off (agents are code; "delete" = off and hidden) | factory admin | **N17** |

Delete flow (every object):

1. **Delete** (red) → a page listing exactly what will be removed, counted ("412 record events, 37 documents, 3 evidence packs,
   1 Vault secret") and what stays ("The decision log keeps 58 hashes so the chain still verifies; nothing else can be read or
   restored"), and what blocks it (a legal hold blocks every delete; shown first).
2. Type the object's name; reason; confirm it's you.
3. The factory admin deletes alone. Recorded: who, what (by hash), when, reason.
4. Done page: "Deleted. 58 log entries now show as hashes only." The object returns 404 everywhere.

---

## 4. New APIs

Each is a bff route plus whatever core or another service needs behind it. Shapes go in `packages/contracts` first.

| Id | Route (proposed) | One line |
|---|---|---|
| N1 | `GET /api/search?q=` | Search items, projects, approvals and people the person can see; invisible answers like missing. |
| N2 | `POST /api/override` `{action, resource, reason, step_up}` (or an `override` flag on each decide/apply route) | The factory admin acts outside a rule (gate slot, two people, own request, bootstrap, onboarding step, settings approval, kill release); records who, what, reason. |
| N3 | `POST /api/items/:id/withdraw`, `POST /api/items/:id/abandon` | Requester withdraws; factory admin abandons with a reason. |
| N4 | `POST /api/sessions/:id/stop` | Stop one running sandbox session (sandbox-controller gains stop). |
| N5 | `GET /api/items/:id/sessions/:session/stream` (SSE) | Live agent session: step, tool calls summarised, tripwires, budget. |
| N6 | `GET /api/items/export.csv` | Items list as CSV for those who may read the audit trail. |
| N7 | `PUT /api/me/drafts/requests/:id` | Save a request draft (per person). |
| N8 | `POST /api/config/keys/:key/preview` and the project equivalent | Effect of a draft change: projects, items, approvals and capacity affected. |
| N9 | `GET /api/projects/:id/merges` | Merges the factory check saw: gated, bypassed, without permission, before watch. |
| N10 | `GET /api/s0/:id/live` (SSE) + `POST /api/s0/:id/chat` | The onboarding agent's live progress and its question/answer chat. |
| N11 | `GET /api/s0/:id/fix-prs`, `POST /api/s0/:id/fix-prs` | Fix PRs the onboarding agent proposes (CODEOWNERS, AGENTS.md, starter files) and their GitHub state. |
| N12 | `GET /api/s0/:id/summary`, `PATCH /api/s0/:id/summary` | The one onboarding summary, assembled from the cards, editable in place. |
| N13 | `POST /api/s0/:id/sign-off` `{step_up, reason?, override?}` | One sign-off that decides every underlying card and the onboarding sign-off atomically, in the lock order. |
| N14 | `POST /api/integrations/github-apps/manifest`, `GET .../callback` | Create a GitHub App from the portal (the manifest flow the CLI wizard runs today). |
| N15 | `PUT /api/secrets/:name` (write-only), `DELETE /api/secrets/:name`, `GET /api/secrets` (names and metadata only) | Secrets into Vault behind a `SecretStorePort`; never returned. |
| N16 | `POST /api/integrations/:id/test` | Test a connection with the saved secret; result only. |
| N17 | `/api/config/keys/agents.config` (new key) + gateway and core read it | Agents on/off, model, max turns, time limit, budget per agent. |
| N18 | `GET/POST /api/identity/provider`, `POST /api/identity/local-accounts` | Keycloak / OIDC settings and break-glass local admin accounts. |
| N19 | `POST/PATCH/DELETE /api/people/:id`, `/api/teams/:id`, `POST /api/people/:id/suspend` | People and teams, PDP-decided (identity writes have no PDP today). |
| N20 | `POST/PATCH/DELETE /api/roles/:id` | Custom roles: a new role catalogue version and PDP bundle via a settings change. |
| N21 | `POST /api/access/requests/:id/decide` | Approve or reject an access request. |
| N22 | `GET /api/sessions`, `POST /api/sessions/:id/end` | Sign-in sessions list and end. |
| N23 | `POST /api/evals/runs/start` | Run an evaluation from the portal (the `aisdlc-evals` CLI's run). |
| N24 | `GET /api/sandbox-sessions` | Running sandbox sessions with kind, item, part, age. |
| N25 | `GET /api/ledger?from=&to=&project=` | The fleet decision log with chain status. |
| N26 | `POST /api/delete/preview` `{kind, id}`, `POST /api/delete` `{kind, id, name, reason, step_up}` | Full delete of a project, repo, item or person: content gone, ledger hashes kept. |
| N27 | `POST/PATCH/DELETE /api/integrations/:id` | Integration lifecycle (today only a whole-registry settings change). |
| N28 | `/api/config/keys/catalogue.tracks`, `gates.policy`, `gates.timers`, `readiness.policy`, `session.policy`, `sandbox.coding_cap` (new keys) | The settings that are code today (§5) as config with preview and approval. |

---

## 5. Hard-coded settings found in the code

Each of these is something the intent says the factory owner must be able to change (intent §3) and is code or an environment
variable today. File:line on `origin/docs/portal-v2-intent`.

| # | Setting (plain name) | Value today | Where (file:line) | Proposed home |
|---|---|---|---|---|
| H1 | Tracks: steps and approvals per track | catalogue data | `packages/catalogue/src/lanes.ts:175` (`LANES`), snapshot `src/snapshots/*.json` | Settings › Tracks (new process version on save) |
| H2 | Retry limits per sent-back reason (B1 2 rounds + 5 days, B3 3, B5 2, B7 3/5 CI/2× time, B13 2, B23–B25 …) | numbers | `packages/catalogue/src/limits.ts:44-141` | Settings › Tracks |
| H3 | Rework limit (5 sends back, 10 working days) | 5, 10 | `packages/catalogue/src/limits.ts:163-164` | Settings › Tracks |
| H4 | Budget extension (once, at most 50%) | 1, 50% | `packages/catalogue/src/limits.ts:171-172` | Settings › Tracks |
| H5 | Default budget per track | `budget_cents: null` (none) | `packages/catalogue/src/lanes.ts:116` | Settings › Tracks |
| H6 | Who decides each approval, two people, confirm it's you | per gate | `packages/contracts/src/entities/gate-lifecycle.ts:216` (`GATE_POLICIES`) | Settings › Approvals |
| H7 | Which approvals need two people | X1, X2, E2, M4 | `packages/contracts/src/entities/projects.ts:129` (`TWO_PERSON_GATES`) | Settings › Approvals |
| H8 | Approval overdue after / expires after / confirm-it's-you lasts | 1 working day; 7 days; 300 s; nonce 10 min | `packages/catalogue/src/limits.ts:134`; `packages/decisions/src/internal.ts:29`, `:31`; `packages/contracts/src/entities/step-up.ts:19` | Settings › Approvals |
| H9 | Coding sandboxes at once | 1 (config `sandbox.caps.coding` above 1 has no effect) | `packages/contracts/src/entities/sandbox.ts:166`; `services/core/src/planning/plan.ts:280`; `services/core/src/admission/admit.ts:45` | Settings › Sandboxes |
| H10 | Readiness rules: scorecard valid for, waiver length, facts to confirm, share confirmed | 90 days, 90 days, ≤50, 90% | `packages/contracts/src/entities/readiness.ts:428`, `:61`; `packages/contracts/src/entities/onboarding-light.ts:315`, `:481` | Settings › Onboarding |
| H11 | Roles and what each can do | 14 roles, action table | `packages/contracts/src/entities/access.ts:290` (`ROLE_CATALOGUE`); `packages/contracts/src/entities/policy.ts:181` (`ACTION_CATALOGUE`); the emergency-stop service builds its own policy from code: `services/killswitch/src/service.ts:84` | People, teams & roles › Roles |
| H12 | Model, budget and time limit per agent | Sonnet (Opus+Sonnet for the planner); e.g. coder 2M tokens / $25 / 6 h | `packages/agents/src/spec-data.ts:61-324` (`models`, `budget: planning(...)`); default models `packages/contracts/src/entities/gateway.ts:80` | Agents |
| H13 | Coding agent max turns and time limits | 40 turns, 1800 s run, 600 s tests | `packages/build/src/coding-port.ts:606`, `:607`, `:291` | Agents |
| H14 | Agents on or off | always on (no switch exists) | `packages/agents/src/spec-data.ts:49` (`AGENT_SPECS`) | Agents |
| H15 | Budget share per part size | small 25%, medium 50%, large 100% | `services/core/src/planning/plan.ts:312` | Settings › Tracks |
| H16 | Sign-in session limits | 30 min idle, 8 h max (env `BFF_IDLE_SECONDS`, `BFF_ABSOLUTE_SECONDS`) | `services/bff/src/app.ts:118-119` | Settings › General |
| H17 | Max model calls per gateway process | 1000 (env) | `services/gateway/src/boot.ts:81` | Settings › General (safety ceiling) |
| H18 | Hotfix follow-up overdue after | 5 working days | `packages/catalogue/src/lanes.ts:187` | Settings › Tracks |
| H19 | Light-review spot-check suspension (miss rate, sample) | >10% over ≥20 | `packages/catalogue/src/limits.ts:124` | Settings › Approvals |
| H20 | Agent autonomy caps by tier, level, readiness, posture | table | `packages/catalogue/src/autonomy.ts:8-17` | Settings › Tracks |
| H21 | Which tracks each onboarding level allows | table | `packages/catalogue/src/eligibility.ts:21` | Settings › Tracks |
| H22 | Health reads unknown after | 2 min | `packages/contracts/src/entities/integrations.ts:286` | Settings › General |
| H23 | Health snapshot interval, alert after, checkpoint overdue | 30 s, 60 s, 15 min | `packages/contracts/src/entities/ops-health.ts:68`, `:244`, `:246` | Settings › General |
| H24 | Evaluation gate: score floor, confidence, resamples | 0.8, 0.90, 2000 | `packages/evals/src/compare.ts:19-20`; `packages/contracts/src/entities/evals.ts:17` | Agents |
| H25 | GitHub poll intervals | 10 min / 1 h / 1 day | `packages/loops/src/code-host-polls.ts:22-24` | Settings › General |
| H26 | Request text max length | 20,000 characters | `packages/work/src/taint.ts:28` | Settings › General |
| H27 | Test-run sandbox lease | 1200 s | `packages/contracts/src/entities/onboarding-probe.ts:46` | Settings › Sandboxes |
| H28 | Sandbox kinds' ceilings (memory, CPU, network, time) | per class | `packages/contracts/src/entities/sandbox.ts:64` (`SANDBOX_PROFILES`) | Settings › Sandboxes (raise only within a deployment ceiling) |
| H29 | Model provider keys and allowed hosts | env `GATEWAY_SECRET_REFS`, `GATEWAY_EGRESS_HOSTS`; secrets as `file:` / `env:` references | `packages/contracts/src/entities/integrations.ts:67` (`SECRET_REF_PATTERN`); `services/gateway/src/boot.ts` | Integrations (Vault) |

Kept as code on purpose (safety floors; shown read-only, never edited): the secret ruleset, the text lint, the tripwires, the
forbidden GitHub permissions, "the factory never merges", "unknown is not met", "expiry never approves", Code review always
required. The intent's factory-admin override (G3) acts on decisions, never on these floors.

---

## 6. Backend gaps

| Id | Gap | What exists today | What the intent needs | Screens |
|---|---|---|---|---|
| G1 | **Vault** | Secrets are files mounted by compose, named by `file:` / `env:` references (`SECRET_REF_PATTERN`, `integrations.ts:67`); keys are written by `./init-secrets` on the command line. No secret port, no Vault in the stack. | A `SecretStorePort` with a Vault adapter (local prod: Vault server in compose, persistent, auto-unseal on the owner's machine) and later AWS Secrets Manager; write-only bff route (N15); gateway, codehost, notifier, identity read through the port; the record keeps path + version only. | Integrations, Onboard (App key) |
| G2 | **Delete** | No DELETE route in any service. The record and ledger are append-only by rule (AGENTS.md). The audit service erases conversation payloads only, with two factory admins (`docs/specs/audit-api.md`). | Full delete of project, repo, item, person, integration: remove record events and read models and object-store packs, keep ledger entry hashes so the chain verifies (needs a design: e.g. payloads moved out of the hashed body, or per-object encryption keys destroyed); factory admin alone. Conflicts with "the record is the source of truth" as written; AGENTS.md needs the owner's new rule. | §3, every object |
| G3 | **Factory admin override** | `factory.admin` "decides no gate or card unless it holds the slot" (`packages/contracts/src/entities/access.ts:343`); the PDP generates gate permits from the slot (`packages/pdp/src/generate.ts:101`); two-person, own-request and bootstrap rules in `@aisdlc/decisions`; kill release needs two people. | One recorded override path (N2) through the PDP and the decision kernel: decide any approval, skip any onboarding step, apply any setting, release a stop alone; always a reason, recorded, never blocking. Never merges. | Decide, Onboard, Settings, Operate |
| G4 | **Agent-led onboarding** | Steps 0.1–0.5 run as five cards (C1–C5, SECR, BATCH, X2) the person decides one by one; A9 is defined; the onboarding pack (AGENTS.md, CLAUDE.md, `.factory/`, CODEOWNERS when absent) already lands as a draft PR after X2 (`packages/contracts/src/entities/onboarding-pack.ts:13-19`). No onboarding agent that drives the steps, no single summary, no one sign-off. | An onboarding agent that runs the steps, proposes the cards' contents, opens fix PRs, asks questions in chat (N10, N11); one summary (N12); one sign-off deciding every card atomically (N13). **Protect-main cannot be a PR**: it is a GitHub setting, and the factory's App may not hold `administration` (B4a). The agent can only give the exact steps (or a ruleset JSON to import); the owner should confirm this. | Onboard |
| G5 | **Keycloak** | The bff runs its own dev OIDC provider (`services/bff/src/dev-oidc/provider.ts`), identity is seeded from a file (`services/identity/src/boot.ts:116`). | Keycloak in compose with realms, SSO first, local break-glass accounts; identity syncs groups from it; the portal configures it (N18). | Sign-in, Integrations › Sign-in, People |
| G6 | **People and teams writes** | Identity writes are service-scoped with no PDP (`services/identity/src/app.ts`, portal-config §1.6); only the seed holds `write`. | PDP-decided create, edit, suspend, delete of people and teams from the portal (N19). | People, teams & roles |
| G7 | **Settings hard-coded** | §5: 29 settings in code or env. | Config keys with schemas, preview (N8), approval, factory-admin apply (N28, N17). The catalogue's immutability stays: a saved track change is a new process version; items keep theirs. | Settings, Agents |
| G8 | **Integrations lifecycle and tests** | One registry key changed whole (`integrations.registry`); health reported by services; the GitHub App wizard is a CLI (`services/codehost/src/setup-github-apps.ts`); no Slack/email test send. | Per-integration create/edit/delete (N27), test (N16), App creation in the browser (N14). | Integrations |
| G9 | **Stop one session** | `session.stop` is in the action catalogue but the sandbox-controller cannot stop a running session (portal-coverage §5 item 6). | Stop route (N4) and a live sessions list (N24). | Operate › Sandboxes, Agent console |
| G10 | **Model per agent** | The gateway routes by environment and data class (`gateway.routes`); each agent's allowed models are code (H12). | Model per agent as config (N17) checked against the agent's data class and the provider rows. | Integrations › Models, Agents |
| G11 | **Glossary in code** | `services/web/src/vocab.ts` and per-vocabulary look tables; `LANE_LABELS` has `null` for L1, L3–L5. | `GLOSSARY` in contracts (glossary §21). | every screen |

---

## 7. Counts

| What | Count |
|---|---|
| Screens (top-level pages) | 23: Sign-in, Home, Inbox, Decide, Work item, Evidence pack viewer, Items, Floor, Projects, Ask for work, Project page, Onboard, Settings, Integrations, People, teams & roles, Agents, Operate, Decision log & audit, My access, My notifications, Delete flow, 403/404 |
| Tabs and sub-screens | 6 work-item tabs, 8 project tabs, 4 onboarding steps, 8 settings sections, 6 integration sections, 7 people tabs, 6 operate tabs, 6 audit tabs |
| New APIs | 28 (N1–N28) |
| Hard-coded settings | 29 (H1–H29) |
| Backend gaps | 11 (G1–G11) |
