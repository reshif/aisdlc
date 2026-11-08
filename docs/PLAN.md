# AISDLC build plan

Status: living plan, revision 2 (2026-11-08). Revision 2 applies an independent audit of revision 1 against the four specs (ordering, coverage of every flow node and entity, runtime boundaries).

The specs in [`docs/specs/`](specs/) are the source of truth for behaviour:

| File | Short | What it fixes |
|---|---|---|
| [`flow-corrected.mmd`](specs/flow-corrected.mmd) | FL | The lifecycle: S0–S9, gates G0–G6, X/E/M/Q gates, back-edges B1–B28, lanes L0–L8, handoffs, quarantine, re-laning |
| [`domain-model.md`](specs/domain-model.md) | DM | Bounded contexts, entities, ports, state machines, and the gaps the earlier code base had (§8) |
| [`onboarding-roadmap.md`](specs/onboarding-roadmap.md) | OB | S0 onboarding: levels, tiers, floors, PRR, cards, security blockers, decisions DEC-1..30 |
| [`runtime-architecture-review.md`](specs/runtime-architecture-review.md) | RV | Which process boundaries are real (keys, sockets, egress, AR9 independence, origins) and which were accidental |

Those documents describe an earlier code base (`ai-software-factory`) that is not in this repo. References like `core/api/services.py:17` point there. This build keeps the behaviour and the trust boundaries, and starts from the target model so the gaps in DM §8 never appear. It does not copy that code.

---

## 1. Principles

1. **Target model from day one.** DM §9 lists the normalisation steps the old code needed. Here they are the starting shape: typed `Project`, `Repo`, `Unit`, `Team`, `Principal`; one `Scope{kind, ref}` value type; status enums defined once, as contracts; one `Handoff` id; one `Assumption` shape; Integration and ModelProvider registries as config rows; floor routes generated from the catalogue.
2. **The record is the source of truth.** `record_event` (append-only, hash-chained) and `ledger_entry` (hash-chained, Notary-signed) are authoritative. Everything else is a read model with a rebuild-from-record test. The only other write path is a **config revision** published through `config_publish` (M3.5).
3. **Inbox first.** Every inbound fact and every decision is committed to Postgres and, where it is a decision, to the ledger, *before* any engine or adapter acts on it. Every signal carries an idempotency key (FL INBOX).
4. **Contracts are the single vocabulary.** All entities, enums, events, gate kinds and the catalogue are Zod schemas in `packages/contracts`. The API, workers, the PDP and the portal import the same types. JSON Schema is generated for external consumers.
5. **Container boundaries only where they are real** (RV §2): a key, a Docker or socket right, network egress, an AR9 independence requirement, or an untrusted origin. Everything else is a module in `core` or a loop in one `core-worker`.
6. **Ports and adapters.** The domain talks to GitHub, model vendors, sandboxes, the Notary, notifications, issue trackers and identity providers only through ports. Every port has a deterministic fake.
7. **Fail closed.** Unknown means unmet. A scan that errors sets B2. A health snapshot older than 2 minutes reads `unknown`. Off means absent, never auto-approved. Expiry never approves. Automatic changes only tighten; loosening always needs a human.
8. **The factory never merges.** G4 is human, on GitHub. The factory never changes rulesets, branch protection, workflows, secrets, collaborators or settings (OB §5.5).
9. **Repo content is data, never instructions** (FIX 15). It cannot change a lane, a gate outcome, tool permissions or egress.

## 2. Stack (ADR-0001)

TypeScript end to end, on Node 22, in one npm-workspaces monorepo. The reasoning is in [`docs/adr/0001-stack.md`](adr/0001-stack.md).

| Concern | Choice |
|---|---|
| Contracts | Zod 4 schemas, exported as JSON Schema 2020-12 |
| Database | PostgreSQL 16. The record, read models and config share one database with a Postgres schema per bounded context. **Key holders and AR9 services get their own database and role**: notary, witness, kms-local, killswitch, gate-check, gate-relay. None has a route to core's write APIs |
| API | Fastify, behind the `bff` |
| Jobs and loops | graphile-worker (Postgres-native queue, cron tasks, jobs enqueued in the same transaction as the record write). It plays the role RV §2.2 gave Procrastinate. One `core-worker` process with per-loop supervision |
| Lifecycle engine | **D-T decided 2026-11-08: no Temporal.** A deterministic interpreter over the item's event stream, driven by the catalogue, with timers as worker jobs. A `WorkflowPort` keeps Temporal possible later. This departs from RV §2 and §10 items 4 and 9; see ADR-0001 |
| Policy | Cedar (`@cedar-policy/cedar-wasm`), embedded in-process at every enforcement point (AR2) |
| Signing | ES256 through a `KeyCustodyPort`: `kms-local` locally, AWS KMS in the cloud. The Notary is the only signer; the Witness co-signs checkpoints with its own key |
| Agents | Claude Agent SDK (TypeScript) inside the sandbox. Every model call goes through the `gateway` (AR5, AR7) |
| Portal | React plus Vite plus TanStack Query; the vocabulary comes from `packages/contracts` |
| Tests | Vitest; a real Postgres in tests; fakes only behind ports; injectable clock for every timer |
| Local prod | Docker Compose (target in §5) |

## 3. Repository layout

```
packages/
  kernel/      ids, canonical JSON + sha256, Result/tagged errors, clock
  db/          pg + Drizzle, migrations, test database helper
  contracts/   Zod schemas, enums, events, JSON Schema export
  catalogue/   versioned catalogue data: lanes, stages, gates, back-edges, ET triggers, terminals, criteria
  record/      record_event, outbox, chain verification, rebuild harness
  ledger/      ledger_entry and checkpoint tables (scope `ledger`), writer (reserve, sign, insert, confirm), reconciler, checkpoint loop, offline verifier and `aisdlc verify-ledger`
  decisions/   gate kernel: GateInstance, votes, quorum, SoD, nonces, step-up binding; inbox cards, list payloads, B21 SLA sweep
  config/      layered config revisions, registry of keys, config_publish (M1 gate), ConfigReader
  pdp/         Cedar schema, policies, embedded evaluator
  ports/       port interfaces plus deterministic fakes (KeyCustody, Notary, Witness so far)
  service-kit/ bearer service tokens, Fastify helpers, JSON client for the services
  secrets-rules/ the one shared secret ruleset (onboarding, push broker, S7 7.4)
services/      one directory per deployable service, added when its milestone starts (kms-local, notary, witness so far)
docs/          PLAN.md, adr/, specs/
platform/      compose files, deploy script
```

## 4. Milestones

Order follows the dependencies: kernel and contracts, then the record and the gate kernel that every later decision uses, then identity, then the onboarding read path (R0, R1a), then onboarding sign-off (R1b), then the lifecycle. Each milestone ends with an **exit demo** run through the public API or CLI. Tasks run one at a time. A task's detailed brief is written when it starts; the acceptance column here is binding.

Spikes from OB §10.1 become tests or demos where they still apply to a rebuild; the task that owns each is named.

### M0 — Foundation

| Task | Deliverable | Acceptance |
|---|---|---|
| M0.1 | npm workspaces, strict TypeScript, ESLint, Prettier, Vitest, Node pin | `npm ci && npm run check` passes on a clean clone |
| M0.2 | `kernel`: RFC 8785 canonical JSON, sha256, UUID v7 ids, `Result`, tagged errors, injectable clock | RFC 8785 vectors; key-order property test |
| M0.3 | `db`: Postgres test helper (throwaway cluster or `DATABASE_URL`), Drizzle, migration runner | Create, migrate, query, tear down; no orphan postgres processes |
| M0.4 | CI on GitHub Actions (SHA-pinned actions, read-only token), `AGENTS.md`, ADR-0001 | CI green on the first PR |

### M1 — Contracts and catalogue

| Task | Deliverable | Acceptance |
|---|---|---|
| M1.1 | Value types: `Scope{kind, ref}` with one kind enum covering bindings, controls, kill and budgets (`enterprise org team project repo service_env environment lane session item role model release budget fleet`); `DataClass` D0–D3; `Tier`; `Level`; `Autonomy`; `Lane` L0–L8; stages S0–S9 with S8a/S8b and step ids (0.1…9.5); entry channels N1–N8 | One definition per enum; JSON Schema snapshot |
| M1.2 | Gate ids and kinds: G0–G6, G1f, G3d, G3s, G3o; X1–X4; E1–E6; M1–M6; Q1; SECT. Back-edges B1–B28; ET1–ET14; handoffs D1–D5; re-lane R1–R4; holds H1–H3 and N8; terminals (Done, Declined, Abandoned+cause, Parked, Blocked, Withdrawn, HandedOverClosed, Superseded, Deferred, RelHold, SpikeReport) | Every node and edge in FL resolves to an id (test parses the `.mmd`) |
| M1.3 | Status enums with transition tables from DM §6: WorkItem, GateInstance, OnboardingRecord (incl. `starter`, `withdrawn`), ReadinessRecord, Unit, AgentSession, Health | Transition tables typed; unknown transitions rejected |
| M1.4 | Entity schemas grouped by context (DM §3), first for the slices up to M7: Project, Repo, Team, Principal, Group, Membership, Binding, Qualification, SodRule, ProjectSettings (role map, two-person, gating profile, kill delegations), S0Record, OnboardingStep, Card, PRR `prr/1` (every field in OB §2.4, incl. `writes`, `fresh_until`, `review_by`, `security_summary`, `controls`, `affirmed`, `r3_zones`), Gap, Criterion (`CRITERIA_V2`), RecordEvent, LedgerEntry, GateInstance, GateVote, Checkpoint, ConfigRevision | Round trips; `record_hash` = sha256(canonical JSON minus `m4`, `status`, `freshness`) |
| M1.5 | `catalogue` v1.0.0: lanes with stage subsets and gate positions; lane profiles (envelope default, oracle source, mandatory checks; 7.1–7.6 and G4 in every lane); back-edge limits and the `(tune)` numbers; ET table with the effect of each trigger; the gating-profile floor and defaults (OB §1C); level→lane eligibility (OB §2.1) and the L0/L7 rows marked `unspecified`; autonomy caps (OB §2.3); criteria catalogue with classes per level (OB §3.3) | Lint test: no lane names a missing gate; the always-required set cannot be switched off; T2 floor enforced |
| M1.6 | Catalogue pinning: every request and item records the catalogue revision it started with | Changing the catalogue leaves in-flight items on their pin |

### M2 — Record, ledger, Notary, Witness

| Task | Deliverable | Acceptance |
|---|---|---|
| M2.1 | `record`: `record_event` per stream with seq, prev_hash and hash; append-only enforced by grants and a trigger; optimistic concurrency per stream; transactional outbox with idempotency keys | Concurrent appends serialise; a tampered row breaks `verifyChain`; duplicate signal is a no-op |
| M2.2 | `services/kms-local` and `KeyCustodyPort`: ES256 by key id; `dev:` keys refused unless `FACTORY_ENV=local`; also serves HMAC (for secret fingerprints) without exporting the key | WebCrypto verification; `dev:` refused in prod mode |
| M2.3 | `services/notary`: the only signer; two-phase sign of ledger entries (reserve, sign, commit), own database; reconciler loop that re-imports signed-but-uncommitted entries | Entry verifies offline with the public key and chain; crash between sign and commit recovers |
| M2.4 | `services/witness` and the checkpoint loop: signed tree head every 5 min (injectable clock), co-signed with the Witness's own key and database | `aisdlc verify-ledger` checks chain, signatures and checkpoints offline |
| M2.5 | Rebuild harness: drop and refold any projection; shared test asserts rebuilt = live | Used by every later projection |
| M2.6 | Runnable services: a build step that makes each service start with plain `node` (bundle per service), `start` scripts, config from env/file references | **M2 exit demo:** kms-local, notary and witness start as separate processes; a script writes ledger entries, runs a checkpoint, and `aisdlc verify-ledger` passes against the real processes |
| M2.7 | Migration runner for bundles: a `migrate` entrypoint (or core's) that applies record, ledger and each service's schemas in order, since a bundled service can only find its own `migrations/` (follow-up from M4.1); wired into the M8 local-prod compose | Fresh database: one command migrates everything; services start without manual steps |

### M3 — Decision kernel, inbox and config publishing

Pulled ahead of onboarding because M4 sign-off and every card need it.

| Task | Deliverable | Acceptance |
|---|---|---|
| M3.1 | `decisions`: GateInstance lifecycle (pending, decided, superseded, expired, closed); subject = item id **or** S0 record id (fix #32); subject hash; facts; TTL sweep that only expires. **Gate status is a projection of ledger decisions**: a Notary-signed entry survives a rolled-back caller transaction (M2.3), so nothing may read a decision from anywhere but the ledger, and the ledger entry is written last in its transaction | A sweep never decides; a decided instance is never changed; a decision whose caller transaction rolled back still shows as decided after reconcile |
| M3.2 | Votes and quorum; SoD rules; two-person rules per project; `sod_waiver` stamped only when the role has one person or two-person is off, never for T2; decisions `approve reject request_changes supersede expire withdraw` | Table-driven tests per gate kind; a T2 single-person M4 is refused |
| M3.3 | PreparedDecision with a server nonce and evidence-viewed check; step-up binding to a hash (`subject_hash`, `text_sha256`) for D37 uses; the decision writes one ledger entry through the Notary | Replayed nonce refused; decision without evidence viewed refused |
| M3.4 | Inbox: `Card` read model (one card can carry several ledgered decisions, e.g. 0.5 + M4), list payloads (per-gap disposition, per-claim affirm), SOLO consolidation rules (FL PROFILES), SLA timer B21 escalating to a backup approver, never auto-approving | SP-PROC-2 equivalent: a 50-row payload decides and hashes into one entry |
| M3.5 | ConfigRevision and `config_publish`: layered config (factory, project), settings and ops flags as revisions; publishing is an M1 gate decision; consumers reload by revision (no redeploy) | A publish without a decided M1 gate is refused; a consumer sees the new revision without restart |

### M4 — Identity and PDP

| Task | Deliverable | Acceptance |
|---|---|---|
| M4.1 | `services/identity`: principals, groups, memberships, bindings `(group, role, Scope)`, qualifications, an access journal; `IdentityProviderPort` with a local seed adapter; IdentityLink for external identities | Bindings change only through journal events; `access` ledger entries within the 60 s SLO, lag exposed as a metric |
| M4.2 | Principal and Team read models in core (DM §9 step 4) | Rebuild test |
| M4.3 | `pdp`: Cedar schema and policies generated from the role catalogue; one action catalogue; embedded evaluator stamping bundle version; PdpDecision log; policy bundles published through `config_publish` | Policy test per role; no bundle loaded → deny |
| M4.4 | Project role map as config: ten slots → role + scope, bindings generated (fixes DM gap 3); effective-access explain query | Explain lists who can decide each gate on a project |
| M4.5 | `services/bff` and a dev OIDC adapter: server-side sessions; tokens never reach the browser; step-up flow (D37 fallback DEC-11(c-ii)) | API test for login, session, step-up |

### M5 — Code host (OB R1a, R1b reads)

| Task | Deliverable | Acceptance |
|---|---|---|
| M5.1 | One `CodeHostPort` (list_repos, installation, read_at_sha, bundle, rules_for_branch, codeowners_errors, collaborators, apply_patch, pr_status) with the forbidden verbs (merge, enqueue, approve, auto_merge, force, delete, dismiss, admin); a fake GitHub with a request log | Contract suite runs against the fake and, when enabled, the real App |
| M5.2 | `services/codehost` GitHub App adapter (also feeds CODEOWNERS owners into the generated `g4` slot group, which has no holders until then — follow-up from M4.4): token broker with forbidden permissions; request allow-list (`GET /rules/branches/{b}` and `/codeowners/errors` allowed, `GET /rulesets` refused); repo allow-list = installation repos ∩ repos with an S0 record (P-MUST-3); B4a/B4b/B4c from installation permissions | Fake-GitHub log shows GETs only for a Census run; B4a fixture blocks M4 |
| M5.3 | Credential-free `git bundle` of all refs, or `refs_covered: default_only` recorded; 256 MiB cap; head = `X-Base-Sha`; size and time measured (SP-PROC-4) | No credential string in any artefact (grep test); timings logged |
| M5.4 | Poll loops in core-worker (no webhooks): default-branch head and installation every 10 min; effective rules hourly with work in flight, else nightly; one inbound-facts inbox; registry reload path. Outbox delivery gets a max-attempts limit with backoff and a dead-letter state surfaced as a health alert (follow-up from M2.1, RV §3.1 poison row) | Idempotent on repeat; latency equals the poll interval; a permanently failing message is dead-lettered and does not delay the others |
| M5.5 | Live read-only check of the testbed App: `rules/branches` returns required checks with `integration_id`; bypass actors not visible (SP-FID-2) | Recorded output; feeds the H-attestation on card 4 |

### M6 — Knowledge: census, security blockers (OB R0 fixes, R1a)

| Task | Deliverable | Acceptance |
|---|---|---|
| M6.1 | `services/knowledge`: bundle intake into a hardened bare mirror; git objects read only; no credential, no HMAC key in the container; per-file and per-job caps, over-cap = coverage item (DEC-5 conditions) | Malformed and oversized inputs produce coverage items, never silent skips |
| M6.2 | Secret scan over full history and all refs in `secrets-rules`, fail-closed (git error, cap hit, unreadable object → B2, SEC-OB-2), HMAC fingerprints via kms-local, human-only states (`open → rotated / false_positive / accepted_test_fixture`), Security-only store, no live verification | SEC-OB-2 cases all give B2; no value or fingerprint outside the Security store |
| M6.3 | Detectors: stack and task-contract commands, lockfiles, CODEOWNERS parse, tier-floor detectors (OB §2.2 table), instruction and harness inventory (AGENTS.md, CLAUDE.md, `.claude/**`, `.mcp.json`, hooks), B5 dangerous-workflow check (in-house, safe YAML parse), B6 apply-on-merge | Fixture repo per detector; detector-set version pinned in the PRR |
| M6.4 | Content lint (OB §3.4 "must not contain"): every doc whose body exists, repo front-matter ignored, claim and unknown text linted before indexing | `protected: true` front-matter and broken YAML are still linted |
| M6.5 | Census assembly: census record, RiskCategory with evidence, posture (red/amber/green from B1–B5), gap ledger (`gap:<repo_id>:<criterion>[:<area>]`), pre-score, probe `pending` (B7: only K-exec counts) | Census of fixture repos produces every PRR input |

### M7 — Projects and S0 onboarding (OB R1b)

| Task | Deliverable | Acceptance |
|---|---|---|
| M7.1 | Project and Repo aggregates; a `ProjectSettingsPort` adapter replacing identity's fixture; publishing a project's role map through `config_publish` triggers identity `reconcileProject` (follow-up from M4.4); `project.onboard` request as `s0_ref = record:<intake event>` (DEC-2); S0Record state machine incl. `starter` for a blank repo | Rebuild test; illegal transitions refused |
| M7.2 | Step driver 0.1–0.5 (DEC-3), failure model DEC-9 (one send-back, PARK at 5 business days, BLOCKED after 3 retries with a cause code, sign below requested); a business-day calendar | Each failure edge has a named scenario test with a manual clock |
| M7.3 | Cards 1, 4, 5 and the security card; card 4 proposes the role map from CODEOWNERS and collaborators, takes the H-attestations (bypass list, App scope, read-only `GITHUB_TOKEN`, secret scanning) and the gating profile; reduced 0.4 at Census | Card decisions ledgered with payload hashes |
| M7.4 | PRR builder: level per area, tier raise-only with positive T0 attestation (DEC-4), pillars (composite = min), autonomy = min(tier, level, readiness, posture, probation A1 ≥4 weeks, earned), `writes: none` lets a read-only Census sign without B3, `fresh_until` 90 d, `review_by` | Golden test per cap |
| M7.5 | M4 on the S0 record UUID; 0.5 + M4 on one card as two ledgered decisions (DEC-6); M4 entry verifies offline against `record_hash` | Offline verification test |
| M7.6 | Eligibility: no active PRR → N8; level too low or suspended → L8 via the 1.4 rule (DEC-8); project-level M4 fan-out releases only eligible lanes | OB R1b exit: an L1 item is held; after a Census M4 it is not released, L8 is offered, no agent session starts |

### M8 — Portal v1 and the first live exit

| Task | Deliverable | Acceptance |
|---|---|---|
| M8.1 | `services/web` shell through the bff; project list and detail | Playwright smoke test |
| M8.2 | Onboarding wizard: request, App status ("0.1 waiting: App not installed"), step progress | Wizard reads one Project and one S0Record |
| M8.3 | Inbox and Decide for cards 1, 4, 5 and security, with step-up | Deciding in the browser writes a verifiable ledger entry |
| M8.4 | PRR view; ledger audit view | Each decision links to its ledger entry |
| M8.5 | **Live exit:** Census onboarding of `reshif/asf-factory-testbed` on local prod; GitHub request log shows GETs only; PRR active after M4 | Recorded demo and log |

### M9 — Work lifecycle engine (stage work behind fake ports)

| Task | Deliverable | Acceptance |
|---|---|---|
| M9.1 | Requests and WorkItems; S1 1.1–1.6 deterministic parts (normalise, taint-mark, de-dupe, eligibility 1.4); untrusted-input boundary with B27; Question entity; SpawnLink for "new linked item" edges | Injection-like text is fenced and flagged on the G0 card |
| M9.2 | Interpreter: lane profile bound at G0, gates from the project's gating profile, stage ports (`PlanningPort`, `CodingPort`, `VerifyPort`, `ReleasePort`) with deterministic fakes; replay determinism | Every FL edge has a test against the fake stages; the rebuild drill that replaces Temporal's: kill core-worker mid-flight, wipe all execution state (jobs, timers, projections), refold from the record, and every item resumes in the same state |
| M9.3 | Holds and terminals: HELD H1–H3 and WIP, N8, PARK (5 bd), BLOCKED (→ L2 remediation item), DECLINED (B22), ABANDONED with cause codes, RELHOLD (B26), prior-phase resume; MM-2 maintenance (timers frozen, decisions disabled, drafts kept) | Test per terminal and hold |
| M9.4 | Back-edges B1–B28 with limits; per-item rework budget (B28 → E4); Handoff (one id) D1–D3 → E4 with its five choices, E3/E5 extension ≤ +50%, D4 hand-back and D5 complete; Assumption (one shape) | Scenario test per back-edge and E4 choice |
| M9.5 | Re-laning: R1 upshift (insert first missing stage), R2 downshift needs E1 and re-runs G0, R3 circuit breaker ET14 per project × lane, R4 hotfix follow-up blocking new agent items after 5 bd overdue | Scenario tests |
| M9.6 | Controls and kill: Control (hold, clamp, halt, maintenance), OpsAction with preview, Banner; `services/killswitch` with its own store, scoped kill (fleet admin-only, project by admin or delegated holder, lane, session), release under the two-person setting, KillReleaseApproval | Kill works with core stopped (AR9) |

### M10 — Gateway and registries

| Task | Deliverable | Acceptance |
|---|---|---|
| M10.1 | `ModelProviderPort`; Anthropic and fake adapters in `services/gateway`, the only holder of vendor keys | Compose test: no other container can read the key file |
| M10.2 | ModelProvider, ProviderModel, Route as config revisions; routes per environment and data class; D3 never routed; a D2-or-lower route is a gated change | D3 request refused |
| M10.3 | Virtual keys per Unit, budget groups, hard stop, metered ModelCall events, redaction, per-Unit tool allow-list never widened by content, spend guard | Budget exhaustion stops a session and raises ET1 |
| M10.4 | Integration registry (DM §4.1): Integration, IntegrationCredential (references only), IntegrationScope with the forbidden list, IntegrationInstall, IntegrationHealth (stale → unknown), IntegrationEvent, ProviderHealth; GitHub App as the first row; reload path for gateway and codehost | Health tiles read from the registry |
| M10.5 | OpenAI-compatible adapter with streaming, for Codex and DeepSeek routes (pending decision on Codex placement, §7) | Contract suite against a fake server |

### M11 — Agent runtime and evals foundation

| Task | Deliverable | Acceptance |
|---|---|---|
| M11.1 | AgentDefinition registry (A1–A12, coder), AgentContract and OutputSchema per agent, prompts lock | Every agent output validates against its schema |
| M11.2 | AgentRun, ModelCall link, AgentRunOutcome from gate decisions and back-edges | Rebuild test |
| M11.3 | Eval store outside the repo (signed manifest, pinned public key, refuses a store inside the repo tree), EvalSuite, EvalCase, EvalTrial, EvalBaseline, EvalRun with history, holdout isolation | Holdout isolation test; a regression on the fake provider fails the gate |
| M11.4 | Context builder with the precedence of OB §3.4, merged-SHA grounding only, provenance headers, repo text fenced as data | Planted-instruction test: the fields `lane`, `gate`, `tools`, `egress`, `budget` of every output are unchanged |

### M12 — Planning S2–S5

| Task | Deliverable | Acceptance |
|---|---|---|
| M12.1 | S2 Shape: 2.1 grounding, 2.1b focused reverse-engineering, 2.2 impact, 2.3 options and decision brief, 2.4–2.5 L6 initiative and G1f; B2, R2 from 2.3 | Lane-specific path tests |
| M12.2 | S3 Specify: 3.1 locate, 3.2 delta spec, 3.3 validator (B3: 3 auto, then ET8), 3.4 oracle specs, 3.5 clean-context review, G2 with oracle specs; B10, B23 | G2 approves spec and oracle specs together |
| M12.3 | S4 Design: 4.1 ADRs, 4.2 contracts, 4.3 data and migration, 4.4 NFR and threat, 4.5 constitution check, 4.6 review, G3d, E2; B4, B24, B25, R2 from 4.6 | E2 grant and denial paths |
| M12.4 | S5 Plan: 5.1 Units, 5.2 sequence, 5.3 task plan, 5.4 verification binding, 5.5 budget envelope, 5.6 capacity input, 5.7 scheduling (automatic by default), 5.8 approval, G3 SHA-bound with G3s skeleton; B5 | Plan hash binds to G3 |

### M13 — Sandbox, admission and S6 Build

| Task | Deliverable | Acceptance |
|---|---|---|
| M13.1 | Unit entity, Lease with epoch, AdmissionGrant; SCHED admission 6.0 (lease, approver slot, envelope), HELD on failure, FIFO by priority | Stale epoch write refused |
| M13.2 | `SandboxPort`; Docker driver through allow-list socket proxies (one for cvw, a wider one for coding-worker; no raw socket, `EXEC=0`); per-session internal network with gateway and package mirror only; concurrency cap of one coding session; `mem_limit`; AR10 allowed-difference entry (not VM-class, D40) | SEC-OB-3 hostile-probe repo is contained (DNS, HTTP, metadata IP, env, out-of-tree writes) |
| M13.3 | S6 6.1–6.3: provision/rehydrate, baseline (B6 → BLOCKED), oracles red checked against G2 specs, G3o on deviation, E6 test change requests | Tests per edge |
| M13.4 | 6.4–6.5: task loop in the sandbox, tripwires, B1 admission over P/W/O/V/K-exec, ET triggers with D1 (Handoff Pack, session killed, tokens revoked), X1 and X3 with approve and deny exits, HUMAN-WAIT (snapshot, lease and slot released, clock paused) | Scenario tests |
| M13.5 | Q1 quarantine (ET10 misbehaviour) and SECT security triage (false positive → cold rebuild; confirmed → L8, autonomy demoted) | Planted credential-hunting run lands in Q1 |
| M13.6 | 6.6 Push Broker: `agent/**` only, lease epoch match, shared secret ruleset, protected paths refused unless an X2 decision is bound to the patch hash (SP-FID-3); factory re-push after card edits (SK-1) | Planted-secret and planted-path patches refused |
| M13.7 | L7 spike path: throwaway S6, SPIKE report, branch archived, never reaches the Push Broker or G4 | Test |

### M14 — S7 Verify and the gate plane

| Task | Deliverable | Acceptance |
|---|---|---|
| M14.1 | `services/cvw`: kits with no secrets and no network; 7.1 deterministic checks, 7.2 test integrity (mutation, holdout, stub probe → Q1), 7.3 spec conformance, 7.4 secrets and dependencies (new findings only), 7.5 constitution check in every lane, X2 on protected paths | One test per check |
| M14.2 | 7.6 Evidence Pack assembly, signed, bound to the head SHA; B9–B12 and D2 | Pack verifies offline |
| M14.3 | `services/gate-check` with its own narrow App (`checks:write`): check run passes only if PR head SHA == Evidence Pack SHA and G3 is decided; S0 profile and L8 profile (DEC-13(a)); laundering-check for non-agent PRs | SP-FID-1 equivalent on the fake host, then live on the testbed |

### M15 — S8 Integrate and release, S9 close-out

| Task | Deliverable | Acceptance |
|---|---|---|
| M15.1 | G4 review: mode C (codeowner) and mode E (evidence approver), B14 unsure → mode C, sensitive path → codeowner plus D37 step-up; B13 and D3 (ET7) | Tests per mode |
| M15.2 | 8.2 merge observed: the human merges on GitHub; the factory reconciles; B15a clean rebase → S7 re-run, B15b conflict → S6 | Tests |
| M15.3 | `services/gate-relay` with its own App (`deployments:write`): G5 binds merged SHA to evidence SHA; DeployMarker; RELHOLD and re-request; B16 rollback → new linked item | Tests |
| M15.4 | S9: 9.2 acceptance and G6, 9.3 close-out record, 9.5 mode-E audit sample (async) with B19 suspension at >10% over ≥20 samples, X4 break-glass review, B17 and B18 | Tests |
| M15.5 | 9.4 Learn: proposals into META gates M1, M2, M3, M5, M6 (config, variance, catalogue/permission, autonomy promotion, approver grant) | A promotion only happens through a decided M5 |

### M16 — Light onboarding, issue twin, after-onboarding lifecycle (OB R2a, R2b, R3, R4)

Starts with the R2a decisions (§7). Tasks: card 2 (claims ≤50 with evidence, intent questions, practices, instruction text with step-up, secret-scanned before storing, never affirmed in the session that proposed it); K-exec probe with mirror-only egress; LF1–LF8; the planted-instruction isolation test (LF4, SP-STD-1) and lint precision (SP-STD-3); affirmed pack record-first (DEC-12(a)) and its git projection through the X2 path (R2b); first N6 → G0 → L2 remediation PR; IssueTrackerPort with a GitHub Issues adapter, approved batches, marker dedupe, poll sync, disclosure golden test (SEC-OB-4); drift polling, suspension → L8, one-click restore with bypass re-attestation (DEC-21), expiry, level-up and re-affirm card.

### M17 — Full onboarding (OB R6) and per-area levels

0.3 full baseline, card 3, system map, CodeGraph, spec seeds, exam measured (not a gate), golden-task candidates, oracle lock through X2, FF1 and FF2 (L5 staging separation with ServiceEnv), per-area levels (DEC-25).

### M18 — Conversation and notifications

Thread, Turn, Draft, Citation, ProposalButton (actions only through buttons that call normal routes), RedactablePayload, AskSession ("Ask the factory"), the onboarding assistant, the `assistant_user_day` budget group; NotificationPort with PortalInbox as the authoritative channel and NotificationDelivery; Slack and email adapters; Teams stays deferred (on hold in the specs) behind the same port.

### M19 — Floor, observability and audit

Floor read models (ItemPosition, FlowWindow, SessionActivity, Heartbeat, GateFeasibility, HealthSnapshot, HealthTile, FloorProject) with lane routes generated from the catalogue; agent score chips from AgentScore and ScoreSignal; StepUpUse with backfill after a Notary outage. Audit as **two services** (RV §1.3): `audit-exporter` (export signing, write-once store) and `audit-backend` (pseudonym resolution, erasure, retention classes, legal hold, permission history, its own signed log); ledger types `audit.export` and `erasure.execute`.

### M20 — Dogfood (OB R5, R7)

Pre-push full-history scan, squashed push, multi-repo allow-list, Census + 0.4 + M4 of this repo, L8 merges through the L8 gate-check profile; later Full per area, the O4 cross-family reviewer, the first agent-led L2 on this repo. Gated by DEC-16, DEC-22..26.

## 5. Target local-prod topology (after M15)

| Group | Containers |
|---|---|
| Data | postgres (record, read models, config, queue), plus separate databases on the same server for notary, witness, kms-local, killswitch, gate-check, gate-relay |
| Edge and identity | web, bff, oidc (dev IdP), identity |
| Core | core, core-worker |
| Trust plane | kms-local, notary, witness, killswitch, sandbox-origin, audit-exporter, audit-backend |
| Code and gate plane | codehost, gate-check, gate-relay, cvw, docker-proxy-cvw, docker-proxy-coding, package-mirror |
| Agents and models | workflow, coding-worker, gateway, knowledge |

That is 25 containers, against RV §8.2's 26: no temporal, postgres-temporal or temporal-ui (D-T), no minio until audit exports exist, one extra socket proxy. core-worker exposes one aggregated `/healthz` (503 while any loop is down or an access-sync alert is active), the access-sync lag metric, loop-prefixed logs, and per-loop supervision so a poison row in one loop cannot stall the others (RV §3.1).

## 6. How the build runs

- The orchestrating session owns the plan, the briefs and the review of every task.
- Each task goes to one implementation agent with a written brief: goal, spec sections, files it may touch, acceptance tests. One task in flight at a time.
- After each task: review the diff, run `npm run check`, commit (Conventional Commits). Milestones end with a pull request for human review. A human merges.
- Decisions that belong to the user are asked at the milestone that needs them.

## 7. Decisions still open for the user

Decided already: DEC-27..30 (OB §12.6). For the OB "decide now" set (DEC-1..9, DEC-14) the build implements the roadmap's recommendation behind config.

| When | Decision |
|---|---|
| Defaulted at M4 (2026-11-08, user did not object; change by config later) | DM §9 Q1: a Team is owned by the factory, with an optional mapping to an IdP group. Q2: the wizard edits the ten-slot role map and bindings are generated from it. B21: a backup approver is notified only and gains no decision right |
| M5 | DEC-7: remove `statuses:write` from the GitHub App (on GitHub) |
| M8.5 | DEC-4 attestation for the testbed ("no prod, no real data, no dependants") |
| M10 | DM §9 Q4: one Integration registry for code hosts and model providers (default) or two. RV §11 Q1: is Codex a model route in the gateway or a harness in the sandbox? |
| M11 | DM §9 Q3: evals per project or per factory (default: per factory, with an optional project tag) |
| M13 | DEC-18: allow the container-class sandbox to run repo code after the SEC-OB-3 evidence |
| M16 | DEC-10, DEC-11, DEC-12, DEC-13, DEC-16, DEC-17, DEC-20 |
| M20 | DEC-21..26 |
