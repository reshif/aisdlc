# AISDLC build plan

Status: living plan. Started 2026-11-08 for a greenfield build in `reshif/aisdlc`.

The specs in [`docs/specs/`](specs/) are the source of truth for behaviour:

| File | What it fixes |
|---|---|
| [`flow-corrected.mmd`](specs/flow-corrected.mmd) | The lifecycle: S0–S9, gates G0–G6, X/E/M/Q gates, back-edges B1–B28, lanes L0–L8, handoffs, quarantine, re-laning |
| [`domain-model.md`](specs/domain-model.md) | Bounded contexts, entities, ports, state machines, and the gaps the earlier code base had (§8) |
| [`onboarding-roadmap.md`](specs/onboarding-roadmap.md) | S0 onboarding: levels, tiers, floors, PRR, cards, security blockers, decisions DEC-1..30 |
| [`runtime-architecture-review.md`](specs/runtime-architecture-review.md) | Which process boundaries are real (keys, sockets, egress, AR9 independence, origins) and which were accidental |

Those documents describe an earlier code base (`ai-software-factory`) that is not in this repo. References like `core/api/services.py:17` point there. This build keeps the behaviour and the trust boundaries and avoids the gaps the domain model lists in §8. It does not copy that code.

---

## 1. Principles for this build

1. **Target model from day one.** The domain model §9 lists the normalisation steps the old code needed. Here they are the starting shape: typed `Project`, `Repo`, `Unit`, `Team`, `Principal`; one `Scope{kind, ref}` value type; status enums defined once, as contracts; one `Handoff` id; one `Assumption` shape; Integration and ModelProvider registries as config rows; the floor's routes generated from the catalogue.
2. **The record is the source of truth.** `record_event` (append-only, hash-chained) and `ledger_entry` (hash-chained, Notary-signed) are authoritative. Everything else is a read model that can be rebuilt from them, with a rebuild test. Config rows are the only other write path.
3. **Contracts are the single vocabulary.** All entities, enums, events, gate kinds and the catalogue are Zod schemas in `packages/contracts`. The API, workers, the PDP and the portal import the same types. JSON Schema is generated for external consumers.
4. **Container boundaries only where the review says they are real** (review §2): a key, a Docker or socket right, network egress, an AR9 independence requirement, or an untrusted origin. Everything else is a module in `core` or a loop in one `core-worker`.
5. **Ports and adapters.** The domain talks to GitHub, model vendors, sandboxes, the Notary, notifications and identity providers only through ports. Every port has a deterministic fake for tests.
6. **Fail closed.** Unknown means unmet. A scan that errors sets B2. A health snapshot older than 2 minutes reads `unknown`. Off means absent, never auto-approved.
7. **The factory never merges.** G4 is human, on GitHub. The factory never changes rulesets, branch protection, workflows, secrets, collaborators or settings (roadmap §5.5).
8. **Repo content is data, never instructions** (FIX 15). It cannot change a lane, a gate outcome, tool permissions or egress.

## 2. Stack (ADR-0001)

TypeScript end to end, on Node 22, in one npm-workspaces monorepo. The reasoning is in [`docs/adr/0001-stack.md`](adr/0001-stack.md).

| Concern | Choice |
|---|---|
| Contracts | Zod 4 schemas, exported as JSON Schema 2020-12 |
| Database | PostgreSQL 16, one database, one Postgres schema per bounded context; Drizzle ORM plus SQL migrations |
| API | Fastify, behind the `bff` |
| Jobs and loops | graphile-worker (Postgres-native queue, cron tasks, jobs enqueued in the same transaction as the record write). One `core-worker` process |
| Lifecycle engine | A deterministic interpreter over the item's event stream, driven by the catalogue. Timers are worker jobs. A `WorkflowPort` keeps Temporal possible later; AR1 says Temporal state is non-authoritative anyway |
| Policy | Cedar (`@cedar-policy/cedar-wasm`), embedded in-process at every enforcement point (AR2) |
| Signing | ES256 through a `KeyCustodyPort`: `kms-local` locally, AWS KMS in the cloud. The Notary is the only signer; the Witness co-signs checkpoints |
| Agents | Claude Agent SDK (TypeScript) inside the sandbox. Every model call goes through the `gateway` (AR5) |
| Portal | React plus Vite plus TanStack Query; the vocabulary comes from `packages/contracts` |
| Tests | Vitest; a real Postgres in tests (no database mocks); fakes only behind ports |
| Local prod | Docker Compose, about 20 containers (target in §5) |

## 3. Repository layout

```
packages/
  contracts/      Zod schemas, enums, catalogue types, JSON Schema export
  catalogue/      catalogue data (lanes, stages, gates, back-edges, criteria), versioned
  kernel/         ids, hashing (canonical JSON + sha256), Result/tagged errors, clock
  record/         record_event, ledger_entry, outbox, chain verification, rebuild harness
  pdp/            Cedar policies, schema, embedded evaluator
  ports/          port interfaces plus deterministic fakes
  db/             Drizzle schema per context, migrations, test DB helper
services/
  core/           API: projects, onboarding, work, gates, inbox, config, audit read
  core-worker/    all loops: outbox relay, lifecycle, timers, polls, checkpoints, gate expiry, access sync
  identity/       principals, groups, bindings journal; policy bundle signer
  notary/         the only signer
  witness/        independent checkpoint co-signer
  kms-local/      dev key custody (dev: keys refused outside local)
  killswitch/     independent of core and the engine (AR9)
  codehost/       the only code-host credential holder; adapters (GitHub App, fake)
  gate-check/     GitHub check publisher with its own narrow App
  gate-relay/     release decisions (G5) with its own narrow App
  knowledge/      census, detectors, secret scan, claims, packs; no credentials
  gateway/        every model call; provider adapters; virtual keys and budgets
  workflow/       planning activities (S1-S5)
  coding-worker/  S6 sessions; the only service allowed to start sandboxes (through a proxy)
  cvw/            S7 central verify workflow; runs verification kits through a proxy
  bff/            browser edge: OIDC client, server-side sessions
  web/            portal (static SPA)
  sandbox-origin/ attachment origin
  audit/          audit export and retention (exporter and backend roles)
docs/
  specs/          the four source documents
  adr/            architecture decisions
  PLAN.md         this file
platform/
  compose/        docker-compose files and the deploy script
```

Services are added when their milestone starts, not before.

## 4. Milestones

Each milestone ends with a demo that runs from the public CLI or API, not only unit tests. Tasks inside a milestone run **one at a time** (CB:480: one step in flight). Sizes: S is one agent task, M is 2–4, L is 5 or more.

### M0 — Foundation (S×4)

| Task | Deliverable | Acceptance |
|---|---|---|
| M0.1 | npm workspaces, TypeScript project references, ESLint, Prettier, Vitest, `.nvmrc`, `engines` pin | `npm ci && npm run check` passes on a clean clone |
| M0.2 | `packages/kernel`: canonical JSON (RFC 8785 JCS), sha256, branded ids (uuid v7), `Result` plus tagged errors, injectable clock | Property tests: canonicalisation is stable under key order; hash vectors from RFC 8785 |
| M0.3 | `packages/db`: Postgres test helper (a throwaway cluster from `/usr/lib/postgresql/16/bin`, or `DATABASE_URL`), Drizzle setup, migration runner | A test creates a schema, migrates, and tears it down |
| M0.4 | GitHub Actions CI (lint, typecheck, test against a Postgres service), `AGENTS.md` and `CLAUDE.md` (`@AGENTS.md`) for this repo, ADR-0001 | CI green on the first PR |

### M1 — Contracts and catalogue (M)

| Task | Deliverable | Acceptance |
|---|---|---|
| M1.1 | Shared value types: `Scope{kind, ref}` (one kind enum for bindings, controls, kill and budget), `DataClass` D0–D3, `Tier` T0–T2, `Level` census/light/full, `Autonomy` A0–A3, `Lane` L0–L8, `StageId` S0–S9 (+S8a, S8b), `GateId` (G0–G6, G1f, G3d, G3s, G3o, X1–X4, E1–E6, M1–M6, Q1), back-edge ids B1–B28, ET1–ET14 | Every enum has exactly one definition; JSON Schema export snapshot |
| M1.2 | Status enums as contracts: `OnboardingStatus`, `PrrStatus`, `GateStatus`, `LedgerDecision`, `WorkItemPhase`, `TerminalState`, `UnitState`, `AgentSessionState`, `HealthState` (from domain model §6) | State-machine transition tables typed against the enums; tests reject unknown transitions |
| M1.3 | Entity schemas for the first slices: Project, Repo, Team, Principal, Group, Binding, ProjectSettings (role map, two-person, gating profile, kill delegations), S0Record, OnboardingStep, Card, PRR (`prr/1`, roadmap §2.4), Gap, Criterion (`CRITERIA_V2`), RecordEvent, LedgerEntry, GateInstance, Checkpoint | Round-trip tests; `record_hash` computed exactly as roadmap §2.4 (canonical JSON minus `m4`, `status`, `freshness`) |
| M1.4 | `packages/catalogue` v1.0.0: lanes and their stage subsets, gate positions, back-edges with limits (the `(tune)` numbers as config), the gating-profile safety floor and defaults (§1C), level→lane eligibility (§2.1), autonomy caps (§2.3), criteria catalogue (§3.3) with classes per level | Catalogue validates against M1 schemas; a lint test fails if a lane names a gate that does not exist; the always-required set (G4, X1–X3, E-gates, Q1, M4, 7.1–7.6) cannot be turned off |

### M2 — Record, ledger and Notary (M)

| Task | Deliverable | Acceptance |
|---|---|---|
| M2.1 | `record` schema: `record_event` (stream, seq, type, body, prev_hash, hash), append-only (no UPDATE/DELETE grants; a trigger refuses them), per-stream optimistic concurrency, transactional outbox | Concurrent appends to one stream serialise; tampering with a row breaks `verify_chain` |
| M2.2 | `services/kms-local` and `KeyCustodyPort`: ES256 keys by key id, `sign(digest)`, `public_key()`; `dev:` key ids refused unless `FACTORY_ENV=local` | Signatures verify with WebCrypto; a `dev:` key in `FACTORY_ENV=prod` is refused |
| M2.3 | `services/notary`: two-phase sign (reserve seq → sign → commit) of ledger entries; the ledger entry body carries gate id, subject hash, decision, actor, `sod_waiver`, policy bundle version | A ledger entry verifies offline with only the public key and the chain; a reserved-but-uncommitted entry is re-imported by the reconciler loop |
| M2.4 | `services/witness` plus the checkpoint loop: signed tree head every 5 min, co-signed by the Witness with its own key | `asf verify-ledger` checks the chain, every signature and every checkpoint, offline |
| M2.5 | Read-model rebuild harness: `rebuild(model)` drops and refolds a projection from the record; a shared test asserts rebuilt = live for every projection | Harness used by M3 onward |

### M3 — Identity and PDP (M)

| Task | Deliverable | Acceptance |
|---|---|---|
| M3.1 | `services/identity`: principals, groups, memberships, bindings `(group, role, Scope)`, a journal of access events; the `IdentityProviderPort` with a local dev seed adapter | Bindings change only through journal events; `access` ledger entries within 60 s (SLO) |
| M3.2 | `packages/pdp`: Cedar schema and policies generated from the role catalogue; one action catalogue (`project.onboard`, `gate.decide`, `kill.request`, ...); embedded evaluator with bundle version stamped on every decision | Policy tests per role; a decision without a loaded bundle fails closed |
| M3.3 | Project role map as config: the ten slots (admin, requesters, intent, design, g4, g5, x, sec, m4, kill) map to role + scope, and bindings are generated from it (fixes domain-model gap 3); two-person rules per project; `sod_waiver` when a slot has one person; T2 locks two-person on | The effective-access explain query returns who can decide each gate for a project |
| M3.4 | `services/bff` plus a dev OIDC adapter: server-side sessions, tokens never reach the browser; a step-up confirm bound to a hash (`text_sha256`, `subject_hash`) for D37 uses (DEC-11(c-ii) fallback) | Login, session, step-up flow covered by an API test |

### M4 — Projects and S0 onboarding core (L) — roadmap R0 + R1b logic

| Task | Deliverable | Acceptance |
|---|---|---|
| M4.1 | Project and Repo aggregates (config rows plus read models); `project.onboard` request recorded as `s0_ref = record:<intake event>` (DEC-2); S0Record state machine (§6.3) | Rebuild test; illegal transitions refused |
| M4.2 | Step driver for 0.1–0.5 (DEC-3: 0.2/0.3 only if requested; 0.4, 0.5, M4 always); failure model DEC-9 (1 send-back, PARK at 5 business days, BLOCKED after 3 retries, sign below requested) | Scenario tests for each failure edge |
| M4.3 | Cards 1, 4, 5 and the security card as `Card` entities in the inbox, with list payloads (per-gap disposition, per-criterion attest) — this settles SP-PROC-2 by design | Card decisions are ledgered; the payload hash is in the entry |
| M4.4 | PRR builder: level per area, tier with raise-only floor and positive T0 attestation (DEC-4), pillars VRL/ERL/ORL/KRL (composite = min), autonomy = min of caps (§2.3), gating profile and role map, gaps, `record_hash` | Golden tests for each cap; a T2 project cannot switch off G2/G3d/G3 for L4–L6 |
| M4.5 | M4 gate with the **S0 record UUID as gate subject** (fix #32), one SOLO card carrying sign-off and M4 as two ledgered decisions (DEC-6), `sod_waiver` only when the M4 slot has one person or two-person is off, never for T2 | M4 entry verifies offline against `record_hash`; a T2 single-person M4 is refused |
| M4.6 | Eligibility producer: no active PRR → N8 hold; level too low or PRR suspended → L8 via the 1.4 rule (DEC-8); project-level M4 → N8 fan-out releasing only eligible lanes | The R1b exit test: an L1 item is held; after a Census M4 it is not released to L1, L8 is offered, no agent session starts |

### M5 — Code host (M) — roadmap R1a, R1b reads

| Task | Deliverable | Acceptance |
|---|---|---|
| M5.1 | One `CodeHostPort` in `packages/ports` (list_repos, read_at_sha, bundle, rules_for_branch, codeowners_errors, installation, apply_patch, pr_status) with the forbidden-verb list (merge, enqueue, approve, auto_merge, force, delete, dismiss, admin); a fake GitHub | Contract tests run against the fake and, when enabled, the real App |
| M5.2 | `services/codehost` GitHub App adapter: token broker with `FORBIDDEN_PERMS`, request allow-list (`GET /rules/branches/{b}` allowed, `GET /rulesets` refused), repo allow-list = installation repos ∩ repos with an S0 record (P-MUST-3), GETs only for Census | A request log shows GETs only during Census; B4a/B4b detected from installation permissions |
| M5.3 | Credential-free `git bundle` of all refs (or `refs_covered: default_only` recorded), size cap 256 MiB, head = `X-Base-Sha` | Bundle verified by knowledge; no credential string in any artefact (test greps) |
| M5.4 | Poll loops in `core-worker` (no webhooks): default-branch head 10 min, installation 10 min, effective rules hourly with work in flight else nightly; one inbox table for inbound facts | Poll results land as record events; idempotent on repeat |

### M6 — Knowledge census (L) — roadmap R0 fixes, R1a

| Task | Deliverable | Acceptance |
|---|---|---|
| M6.1 | Bundle intake into a hardened bare mirror, git objects read only, per-file size and per-job time caps; anything over a cap becomes an unscanned coverage item (DEC-5 conditions) | Oversized and malformed inputs produce coverage items, never silent skips |
| M6.2 | Secret scan over full history and all refs, **fail-closed** (any git error → `scan_status: error` → B2), cap recorded as `truncated` → B2, HMAC fingerprints via kms-local (the key never enters knowledge), one shared ruleset package used later by the push broker and S7 7.4 | SEC-OB-2 cases (git failure, cap overflow, unreadable object) all give B2; no value or fingerprint in any output except the Security store |
| M6.3 | Detectors: stack and task-contract commands, CODEOWNERS parse, tier-floor detectors (data class, exposure, blast radius), instruction and harness file inventory (AGENTS.md, CLAUDE.md, `.claude/**`, `.mcp.json`, hooks), lockfiles | Fixture repos per stack; the detector set version is pinned in the PRR |
| M6.4 | Content lint (L-rules, §3.4 "must not contain"): runs on every doc whose body exists, ignores repo front-matter entirely, lints claim and unknown text before indexing | A doc with `protected: true` front-matter or broken YAML is still linted |
| M6.5 | Census assembly: census record, RiskCategory with evidence, gap ledger v1 (`gap:<repo_id>:<criterion>[:<area>]`), pre-score, probe `pending` | Census for a fixture repo produces the documented PRR inputs |

### M7 — Portal v1 and first live exit (L)

| Task | Deliverable | Acceptance |
|---|---|---|
| M7.1 | `services/web` shell: login through bff, project list, project detail | Playwright smoke test |
| M7.2 | Onboarding wizard: request (repo, level), App-installation status ("0.1 waiting: App not installed"), step progress | Wizard reads one Project and one S0Record |
| M7.3 | Inbox and Decide: cards 1, 4, 5 and the security card, step-up where required, ledger receipt | Deciding a card in the browser writes a verifiable ledger entry |
| M7.4 | PRR view and ledger audit view | Shows level, tier, caps, lanes, gaps; links each decision to its ledger entry |
| M7.5 | **Live exit:** Census onboarding of `reshif/asf-factory-testbed` end to end on local prod, GitHub sees GETs only, PRR active after M4 | Recorded demo plus the request log |

### M8 — Work lifecycle engine (L)

| Task | Deliverable | Acceptance |
|---|---|---|
| M8.1 | Requests and WorkItems on the item stream; S1 intake: normalise, taint-mark, de-dupe; the untrusted-input boundary (FIX 15, B27) | Injection-like text is fenced as data and flagged on the G0 card |
| M8.2 | Catalogue-driven interpreter: stages per lane profile bound at G0 (FIX 7), gates from the project's gating profile, holds as overlays, prior-phase resume | Replay test: same events → same state; every flow edge in `flow-corrected.mmd` has a test |
| M8.3 | GateInstance lifecycle (pending, decided, superseded, expired, closed), quorum, consolidated SOLO cards (never auto-approve), SLA B21 to a backup approver | A gate never decides itself; expiry never approves |
| M8.4 | Back-edges B1–B28 with limits, the per-item rework budget (B28 → E4), handoffs D1–D3 → E4 with one `Handoff` id, R1 upshift, R2 downshift, R3 circuit breaker (ET14) | Scenario test per back-edge |
| M8.5 | `services/killswitch`: scoped kill (fleet, project, lane), project kill by admin or delegated holder (DEC-29), release under the two-person setting, no dependency on core or the engine (AR9) | Kill works with core stopped |

### M9 — Model gateway and registries (M)

| Task | Deliverable | Acceptance |
|---|---|---|
| M9.1 | `ModelProviderPort` plus Anthropic and fake adapters in `services/gateway`; the gateway is the only holder of vendor keys | No other container can read the key file (compose test) |
| M9.2 | ModelProvider, ProviderModel and Route as config rows; routes per environment and data class; D3 never routed; adding a D2-or-lower route is a gated config change | Route resolution tests; a D3 request is refused |
| M9.3 | Virtual keys per Unit, budget groups, hard stop, metered events to the record, redaction, per-Unit tool allow-list never widened by content | Budget exhaustion stops a session and raises ET1 |
| M9.4 | Integration registry (domain model §4.1): Integration, IntegrationCredential (references only), IntegrationScope with the forbidden list, IntegrationInstall per project, IntegrationHealth (older than 2 min → unknown); a reload path so settings changes are not deploys | The GitHub App is a registry row; health tiles read from it |

### M10 — Planning agents, S1–S5 (L)

AgentDefinition registry, prompts lock, Proposal and Artefact entities, one Assumption shape, grounding from affirmed knowledge with the context precedence of roadmap §3.4, intent block, spec delta, oracle specs, design, plan per Unit, budget envelope. Acceptance: a planted instruction in repo text never changes an output field; an eval suite with the fake provider blocks an injected regression.

### M11 — Sandbox and S6 Build (L)

`SandboxPort`, the Docker driver behind an allow-list socket proxy (review §3.4: no raw socket for any service), per-session internal network with only the gateway and the package mirror as peers, the Push Broker (agent/** only, lease epoch check, protected paths refused unless an X2 decision is bound to the patch hash), the Unit read model, HUMAN-WAIT policy, tripwires and ET triggers, Q1 quarantine.

### M12 — S7 Verify, S8, S9 (L)

CVW with verification kits (no secrets, no network), Evidence Pack signed and bound to the head SHA, gate-check publishing the check run (PR head SHA == Evidence Pack SHA), S0 and L8 gate-check profiles (DEC-13(a)), gate-relay for G5 linking merged SHA to evidence SHA, close-out record, G6, Learn proposals into M-gates.

### M13 — Light onboarding and after-onboarding lifecycle (L) — roadmap R2a, R3, R4

Card 2 (claims, intent, practices, instruction text with step-up, secret-scanned before storing), real K-exec probe with mirror-only egress, LF1–LF8, the planted-instruction isolation test (LF4), the record-first affirmed pack (DEC-12(a)), the issue twin (DEC-20), drift polling, suspension to L8, one-click restore (DEC-21), expiry and level-up.

### M14 — Floor, evals, audit (M)

Floor read models (ItemPosition, FlowWindow, SessionActivity, Heartbeat, GateFeasibility, HealthSnapshot) with the lane routes generated from the catalogue; EvalSuite, EvalRun and AgentScore with run history; audit search, signed export, retention and erasure.

## 5. Target local-prod topology (after M12)

About 20 containers: postgres, oidc (dev IdP), bff, web, core, core-worker, identity, kms-local, notary, witness, killswitch, codehost, gate-check, gate-relay, knowledge, gateway, workflow, coding-worker, cvw, docker-proxy (two allow-lists), package-mirror, sandbox-origin, audit. Each extra container must cite one of the five boundary reasons in principle 4.

## 6. How the build runs

- I (the orchestrating session) own the plan, the briefs and the review of every task.
- Each task goes to one implementation agent with a written brief: the goal, the spec sections to read, the files it may touch, and the acceptance tests. One task in flight at a time, so agents never edit the same files.
- After each task: I review the diff, run `npm run check`, and commit with a Conventional Commit message. Milestones end with a pull request for human review. The factory's own rule applies to this repo too: a human merges.
- Decisions that belong to the user are listed in §7 and asked at the milestone that needs them, not before.

## 7. Decisions still open for the user

Decided already: DEC-27, DEC-28, DEC-29, DEC-30 (roadmap §12.6). This build takes the roadmap's recommendation as the default for the "decide now" set (DEC-1..9, DEC-14) and implements it behind config, so a different answer is a config change, not a rewrite. Still to ask, at the milestone that needs them:

| When | Decision |
|---|---|
| M5 | DEC-7: remove `statuses:write` from the GitHub App (you do this on GitHub) |
| M7.5 | DEC-4 attestation for the testbed ("no prod, no real data, no dependants") |
| M11 | DEC-18: allow the container-class sandbox to execute repo code after the SEC-OB-3 hostile-probe evidence |
| M13 | DEC-10, DEC-11, DEC-12, DEC-13, DEC-16, DEC-17, DEC-20 |
| Later | DEC-21..26 (dogfood) |
