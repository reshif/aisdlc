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

## 0. Where the build is (2026-11-12)

Resumed on 2026-11-12, sequentially: one milestone at a time, no parallel tracks (the user's choice).

- **Merged on main:** M0–M13 (M13 is reshif/aisdlc#12). M13's CI failure was a URL with credentials in this file, which the repo secret self-test flags; GitHub CI is now green with all 3638 tests and the Docker sandbox tests. ADR-0003 (the target architecture) and the user's 2026-11-11 decisions (§7a) are reshif/aisdlc#13.
- **In progress:** M14 on `build/m14`, including ADR-0003's M14 tasks (see M14 below).
- **Next:** M15 (S8/S9), M16 (Light onboarding — first real agent lanes L1–L3), M17, M18, M19 (floor, audit), M20 (dogfood).
- **How the build runs:** one task per agent, each reviewed; `npm run check` must exit 0 with `DATABASE_URL` pointing at the local CI-style cluster on 127.0.0.1:55433 (user and password `postgres`) (start that password Postgres from `/var/tmp/aisdlc-cipg` or the db test helper), then `timeout 600 npm run build`, `npm ci --dry-run`, and `npm run smoke:compose` (in a sandbox without apt, build the image from `aisdlc-sandbox-node-git:local` and run with `SMOKE_SKIP_BUILD=1`). PR per milestone; merge after GitHub CI is green (user authorised).
- **Open follow-ups to carry:** M7.7 single-flight S0 driver; M8.0b non-local genesis; M9.7 kill signing timeout, portal kill/control screens, L0/L7 eligibility (decided 2026-11-11: L0 from Light, L7 from Census; needs a catalogue version); M10.6 response redaction for non-streamed calls, per-model prices to confirm before real spend, install-absent semantics; M13 follow-ups: Handoff Pack as an artefact type, self-heal for a crash between push and receipt, B15 rebase path, codehost push in registry mode, compose wiring of real coding sessions.
- **Architecture:** ADR-0003 is the target (18 services, 22 containers locally, sandboxes on separate hosts); PLAN §5 lists what each milestone adds.
- **Portal:** the full portal is designed as a prototype (`docs/design/portal-prototype/`); what it covers and what is missing is in `docs/design/portal-coverage.md`; M21 lifts `services/web` to it after M20, and each milestone from M14 builds its own screens on the way. Six decisions it exposed are in coverage §5.
- **User actions pending:** live Census on their machine (`docs/runbooks/m8.5-live-census.md`); pin the real eval-store key (`aisdlc-evals pin`) before first eval; `issues:write` on the App at M16; share `floor.html` before M19 if available.

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
| M6.2b | Secret-rule recall (SEC-OB-5 early form): measure the shared ruleset against a held-out set of planted secrets written by a different author, including word-like passwords that the generic rule's placeholder skip (added in M6.2 so the repo self-test passes) would miss; tighten the skip so the self-test excludes test fixtures by path instead of weakening detection | Recall reported per rule; no planted secret in the held-out set is missed by the skip |
| M6.3 | Detectors: stack and task-contract commands, lockfiles, CODEOWNERS parse, tier-floor detectors (OB §2.2 table), instruction and harness inventory (AGENTS.md, CLAUDE.md, `.claude/**`, `.mcp.json`, hooks), B5 dangerous-workflow check (in-house, safe YAML parse), B6 apply-on-merge | Fixture repo per detector; detector-set version pinned in the PRR |
| M6.4 | Content lint (OB §3.4 "must not contain"): every doc whose body exists, repo front-matter ignored, claim and unknown text linted before indexing | `protected: true` front-matter and broken YAML are still linted |
| M6.5 | Census assembly: census record, RiskCategory with evidence, posture (red/amber/green from B1–B5), gap ledger (`gap:<repo_id>:<criterion>[:<area>]`), pre-score, probe `pending` (B7: only K-exec counts) | Census of fixture repos produces every PRR input |

| M6.6 | Presence detector for the criteria the Census could not observe (README, LICENSE, SECURITY.md, CONTRIBUTING, PR template, `.env.example` placeholders, Dependabot/Renovate, CI workflow running `check`, generated/vendored path declarations, quarantine manifest, decision records, runbook pointers, repo size/LFS/binaries) so a clean repo is not reported with ~19 unknown gaps | The clean golden census has no `no_detector` gaps; each newly observed criterion has a fixture test |

### M7 — Projects and S0 onboarding (OB R1b)

| Task | Deliverable | Acceptance |
|---|---|---|
| M7.1 | Project and Repo aggregates; a `ProjectSettingsPort` adapter replacing identity's fixture; publishing a project's role map through `config_publish` triggers identity `reconcileProject` (follow-up from M4.4); `project.onboard` request as `s0_ref = record:<intake event>` (DEC-2); S0Record state machine incl. `starter` for a blank repo | Rebuild test; illegal transitions refused |
| M7.2 | Step driver 0.1–0.5 (DEC-3), failure model DEC-9 (one send-back, PARK at 5 business days, BLOCKED after 3 retries with a cause code, sign below requested); a business-day calendar | Each failure edge has a named scenario test with a manual clock |
| M7.3 | Cards 1, 4, 5 and the security card (its finding-state decisions — rotated, false_positive, accepted_test_fixture — become ledgered decisions; M6.2 records them as record events only); card 4 proposes the role map from CODEOWNERS and collaborators, takes the H-attestations (bypass list, App scope, read-only `GITHUB_TOKEN`, secret scanning) and the gating profile; reduced 0.4 at Census | Card decisions ledgered with payload hashes |
| M7.4 | Bootstrap decider (user decision 2026-11-08): on a project's first onboarding, the requester (who needs `project.onboard`) is the provisional admin for that S0 record's cards 1, 4 and 5 only, recorded on the S0 record and ledgered; card 4's published role map replaces it; T2 still needs two people at M4. Close the finding-state bypass: knowledge's `POST /v1/security/findings/:id/state` accepts a change only with a reference to a decided, ledgered security-card decision (verified against the ledger), so the card is the only path (follow-up from M7.3). Then the PRR builder: level per area, tier raise-only with positive T0 attestation (DEC-4), pillars (composite = min), autonomy = min(tier, level, readiness, posture, probation A1 ≥4 weeks, earned), `writes: none` lets a read-only Census sign without B3, `fresh_until` 90 d, `review_by` | Golden test per cap |
| M7.5 | M4 on the S0 record UUID; 0.5 + M4 on one card as two ledgered decisions (DEC-6); M4 entry verifies offline against `record_hash` | Offline verification test |
| M7.6 | Eligibility: no active PRR → N8; level too low or suspended → L8 via the 1.4 rule (DEC-8); project-level M4 fan-out releases only eligible lanes | OB R1b exit: an L1 item is held; after a Census M4 it is not released, L8 is offered, no agent session starts |

### M8 — Portal v1 and the first live exit

| Task | Deliverable | Acceptance |
|---|---|---|
| M8.0b | Follow-ups from M8.0: wire the ledger reconciler and the Witness checkpoint loop into core-worker (the Witness has no caller yet); a non-local genesis for the first factory admin and the first PDP bundle (the local `aisdlc-seed` is refused outside FACTORY_ENV=local); verify the default `docker compose build` path that installs git with apt (untestable in this sandbox) on the user's machine at M8.5 | Checkpoints co-signed every 5 min in the running stack; verify-ledger passes against it |
| M8.1 | `services/web` shell through the bff; project list and detail; login rate limiting on `/auth/login` and the step-up start route (follow-up from M4.5) | Playwright smoke test |
| M8.2 | Onboarding wizard: request, App status ("0.1 waiting: App not installed"), step progress | Wizard reads one Project and one S0Record |
| M8.3 | Inbox and Decide for cards 1, 4, 5 and security, with step-up | Deciding in the browser writes a verifiable ledger entry |
| M8.4 | PRR view; ledger audit view | Each decision links to its ledger entry |
| M7.7 | Single-flight S0 driver: a per-S0-record lease (advisory lock or claimed-job row) so two core-worker instances never start two knowledge jobs for one record (found in M7.2; harmless while one worker runs) | Two concurrent drivers on one record start exactly one census job |
| M8.0 | Local-prod compose (also wires core's `SignedStepUp` in place of `NoStepUp` so M4 can be decided, `bootstrap: true` on core's card deps, the bootstrap eligibility wrapper in the bff, and core's `cardsLoop` with its Notary, codehost-read and knowledge `security`-scope clients, which M7.3 left unwired; cards open through the sync route until then): every service with its own port (bff dev-oidc and codehost both default to 8350 today), `aisdlc-migrate` run first, secrets as file references, the five boundary reasons checked per container | `docker compose up` brings the stack up healthy from a clean checkout |
| M8.3b | Found while building M8.3 (all done in it): the first-onboarding requester held only `factory.admin`, so the PDP denied them `card.decide` and they could never decide card 1 (M8.1 finding): `BootstrapPdpEntities` in `@aisdlc/onboarding` (core and bff) gives the live grantee the project admin role for `card.decide` on cards 1, 4, 5 of their record and `gate.decide` on the M1 gate over a config revision, nothing else; card 4's M1 revision had no UI or route (a "settings revision pending" page and `/v1/revisions/*`: prepare, evidence, decide, publish), so card 5 could never open; the code host's repo list did not say who owns the repo, so the PRR builder refused with `repo_facts_unknown` in the real wiring (`InstallationRepo.owner_type` from GitHub's `owner.type`, recorded by the driver) | `npm run e2e:compose` onboards the testbed in the browser through card 5 and the PRR is active |
| M8.5 | **Live exit:** Census onboarding of `reshif/asf-factory-testbed` on local prod; GitHub request log shows GETs only; PRR active after M4 | Recorded demo and log |

### M9 — Work lifecycle engine (stage work behind fake ports)

| Task | Deliverable | Acceptance |
|---|---|---|
| M9.0 | Grantable onboarding role (user decision): `project.onboard` held by a new `factory.onboarder` role grantable at fleet or team scope, and every administrative action for `factory.admin`, without giving admins any gate decision | PDP tests per role; an admin still cannot decide a gate it holds no slot for |
| M9.1 | Requests and WorkItems; S1 1.1–1.6 deterministic parts (normalise, taint-mark, de-dupe, eligibility 1.4); untrusted-input boundary with B27; Question entity; SpawnLink for "new linked item" edges | Injection-like text is fenced and flagged on the G0 card |
| M9.2 | Interpreter (also wires the real `WorkInFlightPort` into core-worker, replacing the M5.4 fake that reports no work, so effective rules are polled hourly while agent work is in flight): lane profile bound at G0, gates from the project's gating profile, stage ports (`PlanningPort`, `CodingPort`, `VerifyPort`, `ReleasePort`) with deterministic fakes; replay determinism | Every FL edge has a test against the fake stages; the rebuild drill that replaces Temporal's: kill core-worker mid-flight, wipe all execution state (jobs, timers, projections), refold from the record, and every item resumes in the same state |
| M9.3 | Holds and terminals: HELD H1–H3 and WIP, N8, PARK (5 bd), BLOCKED (→ L2 remediation item), DECLINED (B22), ABANDONED with cause codes, RELHOLD (B26), prior-phase resume; MM-2 maintenance (timers frozen, decisions disabled, drafts kept) | Test per terminal and hold |
| M9.4 | Back-edges B1–B28 with limits; per-item rework budget (B28 → E4); Handoff (one id) D1–D3 → E4 with its five choices, E3/E5 extension ≤ +50%, D4 hand-back and D5 complete; Assumption (one shape) | Scenario test per back-edge and E4 choice |
| M9.5 | Re-laning: R1 upshift (insert first missing stage), R2 downshift needs E1 and re-runs G0, R3 circuit breaker ET14 per project × lane, R4 hotfix follow-up blocking new agent items after 5 bd overdue | Scenario tests |
| M9.6 | Controls and kill: Control (hold, clamp, halt, maintenance), OpsAction with preview, Banner; `services/killswitch` with its own store, scoped kill (fleet admin-only, project by admin or delegated holder, lane, session), release under the two-person setting, KillReleaseApproval | Kill works with core stopped (AR9) |

### M10 — Gateway and registries

| Task | Deliverable | Acceptance |
|---|---|---|
| M9.7 | Follow-ups from M9: a short kill-specific signing timeout (a hanging key service delays an unsigned kill by the 10 s client timeout today); BFF kill and control routes for the portal; L0/L7 eligibility per level is unspecified in the roadmap (§2.1), so R4 cannot fire and L0/L7 route to L8 until the user decides | Kill applies within 1 s with the KMS hanging |
| M10.1 | `ModelProviderPort`; Anthropic and fake adapters in `services/gateway`, the only holder of vendor keys | Compose test: no other container can read the key file |
| M10.2 | ModelProvider, ProviderModel, Route as config revisions; routes per environment and data class; D3 never routed; a D2-or-lower route is a gated change | D3 request refused |
| M10.3 | Virtual keys per Unit, budget groups, hard stop, metered ModelCall events, redaction, per-Unit tool allow-list never widened by content, spend guard | Budget exhaustion stops a session and raises ET1 |
| M10.3b | Follow-ups from M10.3 (all done in M10.4's change): the gateway connects as its own least-privilege login role `gateway` (db-init, the gateway migration with row-level security on `gateway:` record streams, the effective-config view `config.genuine_publish`; it no longer migrates), proven by a test that applies the whole migration plan; streaming for the Anthropic adapter and `/v1/messages` (`stream: true`: SSE, redaction of streamed text across pieces, tool allow-list on streamed tool calls, metering from the final usage, settlement at the end or on abort); a reservation sweep that settles reservations older than a bound (default 15 min) as `abandoned` with a recorded event, without double-counting a call that completed; `services/core/test/work-drill.test.ts` (287 s against a 300 s timeout) split into one test case per scenario, each on its own database, over four files | Least-privilege test, SSE tests (incl. the real Anthropic SDK), sweep tests; the drill runs in under 60 s alone |
| M10.4 | Integration registry (DM §4.1): Integration, IntegrationCredential (references only, secret-scanned on every write), IntegrationScope with the D11 forbidden list, IntegrationInstall, IntegrationHealth (stale → unknown), IntegrationEvent (derived from the lineage, each with its M1 ledger entry); `packages/integrations`; the GitHub App and the model providers as the first rows (the seed); the codehost (adapter row read from core) and the gateway (rows read from the published config) follow the registry by revision with a reload endpoint, keys staying in their own files; both report health; core serves the tiles and the events (`/v1/integrations/*`) | Health tiles read from the registry |
| M10.5 | `OpenAICompatProvider` (chat completions, streaming, tool calls) for Codex and DeepSeek as rows of the registry (Codex is a model route through the gateway, decided 2026-11-08) | Contract suite against a fake OpenAI-compatible server |

### M11 — Agent runtime and evals foundation

| Task | Deliverable | Acceptance |
|---|---|---|
| M10.6 | Follow-ups from M10: redact non-streamed model responses on the way back (streamed text is already redacted); confirm per-model prices before any real spend (seed values are placeholders); decide whether an absent IntegrationInstall means fleet default (current reading) or no access | Planted secret in a non-streamed response is redacted |
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

### M12.5 — Portal actions for the planning stages (follow-up from M12)

Ready (1.6) decision endpoint and portal action; observed-signal actions for B4 (design reveals a spec gap) and R2 (smaller than lane) during G3d; the human-writes-plan form for B5; answers to S1 clarification questions in the portal. Built (core `POST /v1/items/:id/ready|answers|observe|plan`, bff `/api/items/:id/*`, web `/items/:id`; PDP actions `item.ready`, `item.observe`, `item.plan`; the compose e2e answers a clarification if the scripted fake asks one and decides Ready on the Census L4 to L8 item). A browser e2e that drives an L4 request to G3 needs a Full-level PRR (M17); until then the L1–L3 path is driven once Light exists (M16), and the L4 path is covered by core tests against the real gateway and planning port.

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

**M13.2 built.** `SandboxPort` (`packages/ports/src/sandbox.ts`, classes and profile ceilings in `packages/contracts/src/entities/sandbox.ts`: K, K-exec, P, W, O, V; `FakeSandbox` runs the same preflight, cap, output scan and coding-session cap); `services/docker-proxy` (the allow-list proxy, two instances in compose: `docker-proxy-cvw` narrow, `docker-proxy-coding` adds the per-session internal networks and the attach of the gateway and mirror; the only containers that mount the socket); `services/sandbox-driver` (`DockerSandboxDriver`: speaks only to a proxy; read-only repo copy bind from a scratch root, `/out` as a size-capped tmpfs shipped through the log stream as one tar, strict tar reader, canary and secret scan of `/out` and logs, cleanup of container, network and scratch); `services/package-mirror` (read-only stub, empty fixture set; real wheels are DEC-17); `platform/sandbox` (the sandbox image). Fix #25 (K and K-exec have `/out`) is in. The SEC-OB-3 hostile probe runs in `services/sandbox-driver/test/sec-ob-3.test.ts` and writes `docs/evidence/sec-ob-3.{json,md}`; the AR10 allowed-difference entry is `docs/adr/0002-sandbox-container-class.md`. This is the evidence DEC-18(b) waits for: the decision itself stays a human one, and no real repository's code runs in a sandbox until it is taken.

**M13.2 follow-ups (done with M13.3 to M13.5).** The tests no longer rewrite `docs/evidence`: the SEC-OB-3 probe writes to a scratch directory, and `npm run evidence:sec-ob-3` regenerates the committed evidence on demand. The docker proxies' TCP listener requires a per-caller bearer token (`DOCKER_PROXY_CALLERS=name=file:...`; a TCP listener without callers refuses to start; `/healthz` stays open for the container healthcheck; the unix socket is a filesystem permission), and the driver sends it. DEC-18's owner allow-list is config `sandbox.exec_allowed_repos` (factory layer, M1-gated, empty by default, an unreadable value allows nothing); a session of a class that runs repo code (W, K-exec, O) for a repo off it is refused, and the coding port turns the refusal into BLOCKED with cause `exec_not_allowed` (B6, no remediation item: nothing an L2 item could repair). B1 over classes: an open secret finding for the repo blocks P, W, O, V and K-exec sessions and never K (`checkSessionAllowed`, and `GuardedSandbox` in front of every session of every caller).

**M13.3 built (6.1 to 6.3).** `packages/build` (`AgentCodingPort`, `SessionStore`, `BuildSourcePort` with `FakeBuildSource` and `GitBundleFiles`, the oracle check, the Handoff Pack builder, `StoreWaitSnapshots`); core wires it with `CoreBuildSource` (the Unit's plan from the S5 artefacts and the oracle specs G2 approved) and `buildStagePorts`; core-worker turns it on with `CORE_WORKER_SANDBOX_PROXY_URL`. 6.1 provisions or rehydrates the session's WORKSPACE (the repo at the plan's base commit through the code host's bundle, or the tree a snapshot kept, or a cold rebuild after a quarantine's false positive). 6.2 runs the task contract's `test` (the census detectors' names, as argv) in an O session over the base tree: red or a broken environment is B6 (BLOCKED, with an L2 remediation item). 6.3 adds the oracle files bound at 5.4, checks them against the G2-approved specs by hash (a marker line names the spec each file implements), runs each in an O session (it must FAIL: exit 1; anything else that is not green is a broken environment) and locks them by hash; any deviation (missing, unbound, spec mismatch, no marker, duplicate, not red) is G3o, denied once it is ET8. L0 has no oracle specs: one failing repro test is the oracle. E6 (the Test Change Request) and G3o are raisable at 6.4 too (engine, `CONDITIONAL_GATES`: the coder's own request for a locked-test change, E6 then G3o then the coder resumes) and E6 at 6.3.

**M13.4 built (6.4, 6.5).** The coding agent is the Claude Agent SDK (`@anthropic-ai/claude-agent-sdk` 0.3.319, exact pin) inside the W sandbox image (`platform/sandbox/Dockerfile.agent`, built by `platform/sandbox/build-agent.sh`: the sandbox image plus the bundled runner `services/coding-runner` and the harness's native binary). The runner starts the harness with `settingSources: []` (nothing from the repo, the home directory or anywhere else: no CLAUDE.md, AGENTS.md, `.claude/`, `.mcp.json`, hooks; what the repo carries of them is listed as ignored), the factory's context (`buildContext`) as the system prompt, the coder contract's tools only, the gateway's `/v1/messages` as the base URL and the Unit's virtual key (lent from the `RunKeyVault` for the length of the run) as the API key: the key is the sandbox's gateway key env and nothing else, and the runner looks for it on disk at the end. One W session per task of the Unit; every tool call passes a PreToolUse hook AND is judged again from the model's own message. Tripwires: a write to a protected path, an edit of a locked oracle, a read of a credential, credential hunting, a stub test, a canary or the key on disk are ET10 (Q1); an irreversible operation is X1; a new dependency is X3 (stopped before it runs; approved, the session resumes the same task with the class approved; X3 denied: told to find an alternative); the agent's own blocker is E6, X1 or X3, `gave_up` is ET8, a spent budget ET1, a session over its time ET2. The factory checks the returned tree again against its own copy (the runner is not trusted). 6.5 runs the tests, `check` and every oracle in O sessions over the final tree and the tripwires over the whole diff: scope drift is B8 (the second time the engine goes to D1: ET9), a diff over the lane budget, a sensitive path or a new dependency is R1, a failing round is B7 counted against `et3_rounds` (the same failure again), `et2_ci_rounds` or `et2_time_multiple`, the same tree answering differently is ET12, A then B then A is ET11. Every stop builds the Handoff Pack (A11's schema, built from facts: what was tried, failing tests, diffs by hash) and binds its hash into the Handoff. HUMAN-WAIT's snapshot (`StoreWaitSnapshots`) is of the session's real workspace, content-addressed in the session store, and a later 6.4 rehydrates it.

**M13.5 built (Q1, SECT).** ET10 is not a handoff: the engine quarantines the item (`phase:Quarantined`, from S1, S6 or S7, with or without a hold), counts it toward ET14, releases the grant and the lease, and opens SECT for the security slot BEFORE any handoff. SECT approved is a false positive (a cold rebuild and a new session at 6.1, or 1.3 from S1); SECT refused is confirmed (the branch is quarantined and the item is L8 human-led with no hand-back; an item that never reached S6 is abandoned). Expiry never approves. All 11 pending FL edges are covered in the generated edge test (515 covered, 3 pending: the phase-table shortcuts no flow edge draws).

**M13.6 built (6.6 Push Broker, and 6.3's oracle code).** *Oracle authoring.* 6.3 stays a D step (the flow text says "D check", and the catalogue is immutable); the test agent A6 is its **specialist** (`AgentDefinition.specialist_steps`, `specialistAgentFor`): the work driver binds A6 and mints its key at 6.3 like any agent's, and its contract (1.1.0: Read, Grep, Glob, Edit, Write, never Bash; prompt `a6_test@1.1.0`) is the union of its 3.4 and 6.3 work (3.4 is one call and offers none of the write tools). Where the source holds no oracle files for the Unit, A6 writes ONE test file per G2-approved oracle spec in a **W session** (the coder's session class and runner: a session that only adds files to a repo copy and ships them back through `/out` is exactly what W is, so no class of its own), each file carrying the marker `// aisdlc-oracle id=<id> spec=<hash>`. It may only ADD files (an edit or deletion of anything in the repo is ET8). The deterministic D check is unchanged (every approved spec id has a file with the matching spec hash, no unapproved oracle file, no marker-less file; any deviation is G3o), then each oracle must run red in an O session, then the files are locked by hash. `CoreBuildSource` keeps the authored files as an `oracle_code` artefact (content-addressed, secret-scanned) and returns them from `oracleFiles` ever after (a redo does not write them again; edits after the lock are E6).

*The Push Broker* (`services/codehost`, the only writer to GitHub; mode `push` of `CODEHOST_MODE`, off by default and not in the compose stack). `CodeHostPort.apply_patch` is one write: blobs, tree and ONE commit through the Git Data API (the App's identity is author and committer; trailers name the item, unit, lease epoch and patch hash), then the branch ref (created, or moved forward with `force: false`), then a Draft PR (opened, or updated by title and body after a re-push: SK-1, the human never pushes). The checks are written once (`preflightPush` in `@aisdlc/ports`, used by the fake and the adapter) and run before any request: a ref outside `agent/<item>/<unit>`, a stale lease epoch or no lease, the shared secret ruleset over every file (rule ids only), path tricks (`..`, `.git`, backslash, absolute, duplicate, file-under-file), a symlink or submodule mode (not expressible), workflow files, a protected path (AGENTS.md, CLAUDE.md, CODEOWNERS, `.factory/**`, `.claude/**`, `.mcp.json`) unless an approved X2 decision in the ledger is bound to exactly this patch hash (SP-FID-3), a spike lane; then a branch that is not where the writer last left it is `non_fast_forward` (never forced). The Unit's owner answers the broker's two questions (`PushGuardsPort`: the lease and the item's lane from core's rows, X2 from the ledger fold `readGateState`: `CorePushGuards`, over core's `push_guard` routes for the codehost process). Allow-list: `PUSH_ALLOW_LIST` adds exactly the write calls with the `docs` role token (contents and pull requests write), each with a body check (agent/** refs only, `force` false, draft PRs only, PATCH of a PR carries title and body only, regular files only); there is no row for a merge, review, review request, approval, ruleset, workflow, delete, status or label, and `PUT/DELETE` are refused as methods. *Record-first (DEC-12(a))*: core's `CorePush` records `push.intended` BEFORE the broker is asked, then the receipt as a record event AND a ledger entry (`push.receipt`, one transaction, ledger lock first, entry last) and moves the Unit to Pushed with the head SHA; a refusal is a receipt too (`refused`, `refused_stale_epoch`, `no_lease`). `core.push_receipt` and `core.pull_request` are read models rebuilt from the events (`rebuildPushes`). X2 is raisable at 6.6 (`CONDITIONAL_GATES`: approved, the step runs again; denied, D1): the refused patch is stored as a `patch` artefact whose sha256 IS the patch hash and rides in the gate's facts and subject hash, so a decision is a decision on that patch.

**M13.7 built (L7 spike).** The route of L7 has no 6.6. At 6.5 the port ends the throwaway S6 in the SPIKE report instead of the self-check's rework loops (tripwires stand: a spike is not a licence to hunt for credentials): findings from facts (what the agent reported, how the repo tests answered, what changed), a recommendation derived from them, and the work archived as a content-addressed session snapshot (`archive_ref`), stored as a `spike_report` artefact; then 9.3. A spike never reaches the Push Broker by code path (the port refuses a 6.6 for L7), by the client (`CorePush` reads the lane from core and never calls the broker) and by the broker's guard (core's word for the lane).

### M14 — S7 Verify and the gate plane (plus ADR-0003's M14 tasks)

| Task | Deliverable | Acceptance |
|---|---|---|
| M14.0 | ADR-0003 first task: PLAN §5 follows the ADR (done in reshif/aisdlc#13) | — |
| M14.1 | Object store: `ObjectStorePort` (content-addressed put/get/head; a write-once bucket mode) with a deterministic fake and an S3-compatible adapter; MinIO in compose; Evidence Packs and new large blobs go through it | Contract suite runs on the fake and on MinIO; the write-once bucket refuses overwrite and delete |
| M14.2 | `services/sandbox-controller` (ADR-0003 §6–7): owns the sandbox driver, class ceilings and two caps per runner host (a total, default 4, and coding, default 1; config, M1-gated); core reaches it through an HTTP `SandboxPort` adapter; it starts only sessions core granted, and its state is disposable | Admission's H2 check reads the controller's free slots; over-cap sessions wait in core's queue; the existing sandbox tests pass through the controller |
| M14.3 | `services/verify` (the plan's `cvw`): kits with no secrets and no network; 7.1 deterministic checks, 7.2 test integrity (mutation, holdout, stub probe → Q1), 7.3 spec conformance, 7.4 secrets and dependencies (new findings only), 7.5 constitution check in every lane, X2 on protected paths | One test per check |
| M14.4 | 7.6 Evidence Pack assembly, signed, bound to the head SHA, stored in the object store; B9–B12 and D2 | The pack verifies offline |
| M14.5 | `services/gate-check` with its own narrow App (`checks:write`), built against the fake GitHub first (§7a): the check run passes only if the PR head SHA equals the Evidence Pack SHA and G3 is decided; S0 and L8 profiles and a laundering check for non-agent PRs (DEC-13(a)); the per-repo list of named bypass people (DEC-10 as refined: config, M1-gated, never an App), with every bypass merge recorded for X4 review | SP-FID-1 equivalent on the fake host; the live run on the testbed once the user has created the App |
| M14.6 | Portal: S7 results and the Evidence Pack viewer on the item page; gate screens for Q1, E6, X2, X3 and E2 (`docs/design/portal-coverage.md` §3) | Browser e2e decides one of each on the compose stack |

### M15 — S8 Integrate and release, S9 close-out

| Task | Deliverable | Acceptance |
|---|---|---|
| M15.1 | G4 review: mode C (codeowner) and mode E (evidence approver), B14 unsure → mode C, sensitive path → codeowner plus D37 step-up; B13 and D3 (ET7) | Tests per mode |
| M15.2 | 8.2 merge observed: the human merges on GitHub; the factory reconciles; B15a clean rebase → S7 re-run, B15b conflict → S6 | Tests |
| M15.3 | `services/gate-relay` with its own App (`deployments:write`): G5 binds merged SHA to evidence SHA; DeployMarker; RELHOLD and re-request; B16 rollback → new linked item | Tests |
| M15.4 | S9: 9.2 acceptance and G6, 9.3 close-out record, 9.5 mode-E audit sample (async) with B19 suspension at >10% over ≥20 samples, X4 break-glass review, B17 and B18 | Tests |
| M15.5 | 9.4 Learn: proposals into META gates M1, M2, M3, M5, M6 (config, variance, catalogue/permission, autonomy promotion, approver grant) | A promotion only happens through a decided M5 |

**M15.1 built (8.1 G4 review).** G4 is opened by the engine as before (never skipped); core adds its review (`services/core/src/review/`, contracts `review.ts`) when `WorkDriverDeps.review` is wired (core-worker wires it whenever S7's Evidence Packs are). `decideReviewMode` is pure: mode C (a CODEOWNERS owner of the changed paths) for `b14_unsure`, `sensitive_path` (the sensitive and protected globs; also the D37 step-up), `paths_unknown` (also the step-up), `codeowners_unreadable`, `no_governing_prr`, `posture` (the pinned catalogue's `g4_mode_c` posture, amber), `autonomy_a0`, `r3_zone`, `human_led` (L8 or a takeover); mode E (`evidence_sufficient`: any holder of the `g4` slot on the pack alone) only when none applies. `g4ReviewOf` reads the open PRs (`core.pull_request`), the passing Evidence Pack of exactly each head (`passingPackFor`), the changed paths (now on `push.intended`), CODEOWNERS at the base and the governing PRR; the G4 instance carries the review in `facts.g4_review` and in its subject hash, the pack as its evidence hash, the step-up when needed, and in mode C the owners' principals as the gate's `deciders` (a new `GateOpenedPayload` field that narrows the slot in open, prepare and vote, never widens it). The requester and the human authors (takeover, L8) are barred by the kernel's SoD rule. No PR or no passing pack for a head refuses the open (fail closed; the command is delivered again). B14 is `reviewerUnsure` (only a G4 decider, only in mode E, once: the engine reopens G4 with `review_mode: C`); B13 and its ET7 limit to D3 are the engine's, read from the pinned catalogue. `readG4Standing` is `head_moved` when a PR head is no longer the one the approval bound. Not yet: a portal screen and HTTP route for B14 and the review facts on the gate card view; gate-check does not require G4 (M14.5's verdict is pack plus G3; whether the check run also waits for G4 is for M15.2's reconcile); there is no dedicated evidence-approver slot in the ten-slot role map, so mode E is any `g4` holder.

**M15.2 built (8.2 merge observed).** A person merges on GitHub; the factory never does. `pr_status` (the Push Broker's read-only route, `CodeHostPort`) now says the base and its commit, the mergeability (`PrMergeability` from GitHub's `mergeable_state`: `current`, `behind`, `conflict`, `unknown`) and, once merged, the merge commit, time and merger. The `agent_pulls` poll (`packages/loops/src/agent-pulls.ts`, core-worker with the Push Broker) reads every agent PR of an item in flight (`DbWatchedPulls`) and records them as one inbound fact per repo when anything changed (record first; a PR that cannot be read writes nothing for its repo). Core's `merge_reconcile` loop (`services/core/src/review/merge.ts`, contracts `merge.ts`) reconciles each PR of the newest fact of each repo, as `merge.reconciled` on `merge:<item>` under a key of repo, PR, commit and outcome (seeing it again does nothing): merged with exactly the head the item's newest approved G4 and its passing Evidence Pack bind, at 8.2, is `completed`, and once every bound Unit is merged the item gets `item.merge_observed` (S8b where the project releases, else S9); any other merge (before G4, a head pushed after the approval, the pack not the bound one, the item ended or sent back) is `post_hoc_review` and opens X4 through `openMergeX4Once`, shared with gate-check's bypass and unauthorised merges (one X4 per repo, PR and merged head or merge commit, whoever saw it first, under an advisory lock). At 8.2 a conflict with the base on the approved head is B15b (S6); a new head on a moved base with no conflict (the PR rebased cleanly on the host) is B15a (S7): the PR's head in core moves to the rebased commit (folded from the record, `rebuildPushes`), S7's subject reads the PR head, the old approval is `head_moved`, and G4 opens again only on a pack of the rebased head; the engine counts the round against the pinned catalogue's `b15a_times` (recorded with the reconcile through `limitValue`). Fail closed: an unreadable read, a merge with no merge commit, a fact that does not parse is no completion. Not yet: the factory does not rebase itself (a clean rebase is the host's, a person's "update branch"), and gate-check's laundering rules may hold the check on such a rebased head (a person's commit on an agent branch) until it is reconciled with this; a PR closed without merging is recorded but not acted on; whether `aisdlc/gate` also waits for G4 is still open.

### M16 — Light onboarding, issue twin, after-onboarding lifecycle (OB R2a, R2b, R3, R4)

Starts with the R2a decisions (§7). Tasks: card 2 (claims ≤50 with evidence, intent questions, practices, instruction text with step-up, secret-scanned before storing, never affirmed in the session that proposed it); K-exec probe with mirror-only egress; LF1–LF8; the planted-instruction isolation test (LF4, SP-STD-1) and lint precision (SP-STD-3); affirmed pack record-first (DEC-12(a)) and its git projection through the X2 path (R2b); first N6 → G0 → L2 remediation PR; IssueTrackerPort with a GitHub Issues adapter, approved batches, marker dedupe, poll sync, disclosure golden test (SEC-OB-4); drift polling, suspension → L8, one-click restore with bypass re-attestation (DEC-21), expiry, level-up and re-affirm card.

### M17 — Full onboarding (OB R6) and per-area levels

0.3 full baseline, card 3, system map, CodeGraph, spec seeds, exam measured (not a gate), golden-task candidates, oracle lock through X2, FF1 and FF2 (L5 staging separation with ServiceEnv), per-area levels (DEC-25).

Follow-up from M13.1: a portal "Ask for work" form (requests come in through the API until then) belongs with the Conversation milestone below.

### M18 — Conversation and notifications

Thread, Turn, Draft, Citation, ProposalButton (actions only through buttons that call normal routes), RedactablePayload, AskSession ("Ask the factory"), the onboarding assistant, the `assistant_user_day` budget group; NotificationPort with PortalInbox as the authoritative channel and NotificationDelivery; Slack and email adapters; Teams stays deferred (on hold in the specs) behind the same port.

### M19 — Floor, observability and audit

Floor read models (ItemPosition, FlowWindow, SessionActivity, Heartbeat, GateFeasibility, HealthSnapshot, HealthTile, FloorProject) with lane routes generated from the catalogue; agent score chips from AgentScore and ScoreSignal; StepUpUse with backfill after a Notary outage. Audit as **two services** (RV §1.3): `audit-exporter` (export signing, write-once store) and `audit-backend` (pseudonym resolution, erasure, retention classes, legal hold, permission history, its own signed log); ledger types `audit.export` and `erasure.execute`.

### M20 — Dogfood (OB R5, R7)

Pre-push full-history scan, squashed push, multi-repo allow-list, Census + 0.4 + M4 of this repo, L8 merges through the L8 gate-check profile; later Full per area, the O4 cross-family reviewer, the first agent-led L2 on this repo. Gated by DEC-16, DEC-22..26.

### M21 — Portal lift (after M20)

The portal prototype (`docs/design/portal-prototype/`, published as the "AISDLC Portal" artifact) is the design reference for the whole portal: 40 routes, sign-in and sign-out, accounts, and a permission engine mirrored from the contracts. [`docs/design/portal-coverage.md`](design/portal-coverage.md) lists what it covers (§2), what is thin (§3), what is missing (§4) and the decisions it exposed (§5).

From M14 on, each milestone also builds the portal screens for what it adds (the coverage file names the milestone per row). M21 lifts `services/web` to the full portal:
- the component library from the prototype's tokens;
- server-side access hints (`GET /api/me/access` over the PDP), while the PDP still decides every write;
- OIDC sign-in, session policy and sign-out;
- every screen ported (home, inbox, item, all gate screens, floor on the M19 read models, projects and onboarding, operate, quality, govern, admin);
- the rows of coverage §3 and §4 not built earlier;
- Playwright runs per persona that prove the menu and buttons match the PDP's answers, and that a viewer sees no content.

Done when coverage §3 and §4 are empty or dropped by the user, §5 is decided, and the persona e2e is green in CI.

## 5. Target architecture (ADR-0003)

[ADR-0003](adr/0003-target-architecture.md) is the target, and the build follows it exactly. It replaces the 25-container list of revision 2:
- seven planes and 18 services, each with its reason to stand alone;
- sandboxes on separate runner hosts (microVMs in production);
- an object store for large content;
- scheduling ownership: core decides admission, the sandbox-controller only places sessions, people set the limits;
- two caps per runner host: a total (default 4) and coding sessions (default 1).

| | Local | Production (one copy each) |
|---|---|---|
| Containers you run | 22: the 18 services + Postgres, MinIO, kms-local, dev-oidc | 19: the 18 services + an OpenTelemetry collector; Postgres, the object store, KMS and the IdP are managed |
| Sandboxes | up to 4 at once | runner hosts that scale with the queue |

What each milestone adds to reach it:

| Milestone | Adds |
|---|---|
| M14 | the ADR's first task (this section), the object store, verify, gate-check, the sandbox-controller split and the total cap |
| M15 | gate-relay |
| M18 | notifier |
| M19 | audit, the collector, the outage drills, a load test |
| M19 or M20 | the microVM runner driver |

core-worker keeps one aggregated `/healthz` (503 while any loop is down or an access-sync alert is active), the access-sync lag metric, loop-prefixed logs and per-loop supervision (RV §3.1).

## 6. How the build runs

- The orchestrating session owns the plan, the briefs and the review of every task.
- Each task goes to one implementation agent with a written brief: goal, spec sections, files it may touch, acceptance tests. One task in flight at a time.
- After each task: review the diff, run `npm run check`, commit (Conventional Commits). Milestones end with a pull request for human review. A human merges.
- Decisions that belong to the user are asked at the milestone that needs them.

## 7a. Decisions taken by the user (2026-11-08)

| Topic | Decision |
|---|---|
| D-T | No Temporal (ADR-0001) |
| Team, role map | Team is factory-owned with an optional IdP group mapping; the wizard edits the ten-slot role map and bindings are generated |
| B21 backup approver | Notified only; gains no decision right |
| Bootstrap decider | On a project's first onboarding the requester decides that S0 record's admin-slot cards (C1, C4, C5) and the first M1 config gate until the role map is published; never the security card or M4 |
| Who may start an onboarding | A grantable onboarding role (any principal it is granted to, at fleet or team scope); factory admins hold every administrative action. Gate decisions still follow the project role map, two-person rules and the safety floor: no admin decides gates alone (G4 human code owner, no auto-approve, T2 two-person) |
| Pillar mapping | VRL = BT/ST/TH, ERL = EN/SEC/CC, ORL = ID/OP/PUB, KRL = AI/KN |
| Codex | A model route through the gateway (an OpenAI-compatible provider row), not a sandbox harness |
| Registries | One Integration registry for code hosts and model providers, with a shared health shape |
| Evals | Factory-wide, with an optional project tag |
| DEC-18 | Decided 2026-11-09 after the SEC-OB-3 evidence (`docs/evidence/sec-ob-3.md`: 74 attempts, 74 contained): container-class execution of repo code is allowed for repos the user owns (the testbed and the factory repo). Any repo the user did not write is re-decided before its code runs (with DEC-5's revisit); the factory must refuse execution for a repo not on the owner allow-list (config, M1-gated) |
| DEC-10, 11, 12, 13, 16, 17, 20 | The roadmap's recommendations: 10(a) the human never pushes, the factory pushes under an L8 gate-check profile; 11(a) affirmed text is fenced guidance, never control, with (c-i) step-up falling back to (c-ii); 12(a) record-first; 13(a) S0 and L8 gate-check profiles, (i) wait for the X2 path; 16(b) agent chores on T0/T1 only, T2 needs Full; 17 mirror wheels first, each scanner approved one at a time; 20(a) record is truth, issue is a twin, timing (i) right after R1b, blocking public-safe gaps by default |
| DEC-7 | Done by the user: `statuses:write` removed from the GitHub App |
| Refined 2026-11-11 | The user went through the M14–M16 questions one at a time on 2026-11-11. These rows refine or add to the rows above. |
| gate-check and gate-relay Apps (M14, M15) | Built and tested against the fake GitHub first; the user creates each narrow App (`checks:write`, `deployments:write`) only for the live test |
| DEC-13 | (a): an S0 profile, an L8 profile, and for non-agent PRs a laundering check plus human review; (i) the testbed oracle-lock PR waits for the X2 path |
| DEC-10 (refined) | The factory pushes by default: a human-led change is written on a card or as a patch and pushed as an `agent/*` PR under the L8 profile. **Plus a per-repo bypass list of named people**, which can be empty, can differ per repo, and never holds an App. Changing the list is an M1 config change on the ledger; gate-check records every bypass merge, which then gets an X4 review |
| G5 release (M15) | Chosen per project at onboarding (card 4: off, or a deploy target such as a GitHub environment); G5 applies only where it is on; changing it later is an M1 config change. The release path is built against a fake target |
| E4 | Decided by the item's owner of record, **and a factory admin may also decide it**. This is a deliberate exception to "admins decide no gate", recorded on the ledger as an admin decision. It is a contract change to `GATE_POLICIES` and the catalogue |
| Factory-wide M1 | By default a factory admin other than the proposer approves. Which role decides and whether it takes one or two people is itself config, and changing that setting needs this same approval |
| DEC-11 (refined) | Factory rules and defaults always win; a repo's AGENTS.md or CLAUDE.md can only add repo detail inside them. At onboarding each instruction file is checked against a **factory template** of what is taken (build and test commands, coding standards, architecture notes, conventions) and what never is (tools, permissions, network, rule-overrides, secrets). Card 2 shows each section as accepted or rejected, with the reason. Affirmed sections become fenced guidance. For rejected or missing sections the factory proposes edits to the file as a PR through X2 (a protected path) |
| DEC-12 | (a) record-first |
| DEC-16 | (b) T0/T1 only; T2 needs Full |
| DEC-17 (refined) | A **dedicated onboarding sandbox image** is built ahead of time with the scanners and common libraries baked in, each at an exact version and checksum; the probe runs with no internet. An image update is a reviewed config change. A repo's own dependencies still come through the read-only package mirror |
| DEC-20 | (a) the issue is a twin and the record is the truth; built straight away; blocking, public-safe gaps by default; security findings never on public repos. Needs `issues:write` on the App |
| DEC-15, DEC-19 | Accepted as written; each value stays a setting changeable by M1 |
| L0, L7 eligibility | L0 (hotfix) from Light, L7 (spike) from Census. This is a catalogue change, so it needs a new `CATALOGUE_VERSION` |

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
