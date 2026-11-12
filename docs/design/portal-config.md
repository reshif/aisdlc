# Portal: configuration and maintenance

Status: 2026-11-12, written against `build/m14` at `cced4a0` (M14.1 to M14.4 merged into the branch; M14.5 gate-check in progress).
Companion to [`portal-coverage.md`](portal-coverage.md), which lists the screens. This file answers a narrower question: **what can the
factory be configured with, who may change it, through which route, and what the portal needs for it**. It is built from the code. Where a
spec says something is not configurable, this file says so. Where the prototype (`portal-prototype/src/views-govern.js`, `views-admin.js`,
`views-operate.js`) shows more than the backend supports, the difference is listed in §2.

How to read it:
- §1 is the inventory: config keys, how a revision is decided, the routes that exist, and what is code rather than config.
- §2 has one table row per configurable area.
- §3 is the one pattern every configuration screen uses.
- §4 is the onboarding agent console.
- §5 lists the gaps, each with a milestone.
- §6 lists what stays out of the portal on purpose.

Words: **key** is a dotted config key registered with `@aisdlc/config`. **Layer** is `factory` (one document for the fleet) or `project` (one
document per project). **M1** is the configuration gate. A revision is *proposed*, then its M1 is *decided*, then it is *published*.

---

## 1. Inventory from the code

### 1.1 Every registered config key

A key nobody registered is refused (`packages/config/src/registry.ts`, `validate`). `overridable: false` means factory layer only.

| Key | Layer | Schema (contracts) | Registered by | Read by | Default |
|---|---|---|---|---|---|
| `project.role_map` | project | `RoleMap` (`entities/projects.ts`) | `registerCoreConfig` (`services/core/src/settings.ts:63`) | core, identity (bindings generated, `role-map-sync.ts`), killswitch holders | `EMPTY_ROLE_MAP` (nobody; g4 = codeowners) |
| `project.two_person` | project | `TwoPerson` | same | decision kernel (`planQuorum`) | on when 2+ hold the role; T2 locked on |
| `project.gating_profile` | project | `GatingProfile` (gates per toggle group, `by_lane`, `schedule`) | same | work engine (lane profile bound at G0), gate-check | every group on, schedule `auto` |
| `project.kill_delegations` | project | `KillDelegation[]` | same | core | `[]` |
| `s0.failure_model` | factory | `S0FailureModel` (`entities/core-events.ts`) | same | S0 driver | 1 send-back, PARK at 5 bd, 3 retries |
| `s0.timeboxes` | factory | `S0TimeBoxes` | same | S0 driver | OB §6.2 column |
| `s0.calendar` | factory | `S0Calendar` | same | S0 timers, work lifecycle (PARK, item age) | weekend Sat/Sun, no holidays, UTC |
| `s0.t0_attestation_required` | factory | boolean | same | card 1 (DEC-4) | `true` |
| `factory.constitution` | factory | `Constitution` (`entities/planning.ts:264`; rule kinds `no_unapproved_egress`, `migrations_reversible_or_flagged`) | same | 4.5 and S7 7.5 (`packages/verify`) | `DEFAULT_CONSTITUTION` (C-EGRESS, C-MIGRATION) |
| `sandbox.exec_allowed_repos` | factory | `SandboxExecAllowedRepos` (`entities/sandbox.ts:249`) | same | `GuardedSandbox` (DEC-18) | `[]` (no repo may run code) |
| `sandbox.caps` | factory | `SandboxCapsConfig` (`entities/sandbox.ts:324`: total 1..32, coding 0..8, per-host rows) | `registerSandboxConfig` (`packages/config/src/sandbox.ts`) | sandbox-controller (`services/sandbox-controller/src/caps.ts`) | total 4, coding 1 |
| `ops.maintenance.mm2` | factory (ops flag) | boolean | `registerCoreConfig` | every timer and decide path (`maintenanceFrom`) | `false`; an unreadable value reads as on |
| `pdp.bundle` | factory | `PolicyBundle` (`entities/policy.ts:464`) | `registerPdpConfig` (`packages/pdp/src/bundle.ts:120`) | core, bff (every PDP) | `null` (deny everything) |
| `integrations.registry` | factory | `IntegrationRegistry` (`entities/integrations.ts`) + secret scan | `registerIntegrationConfig` (`packages/config/src/integrations.ts`) | codehost, gateway | `[]` |
| `integrations.installs` | factory (rows per project) | `IntegrationInstalls` (`repos_allowed`, `models_allowed`) | same | codehost, gateway | `[]` |
| `gateway.models` | factory | `GatewayModels` (limits and prices per model) | `registerGatewayConfig` (`packages/config/src/gateway.ts`) | gateway | `[]` |
| `gateway.routes` | factory | `GatewayRoutes` (`(environment, D0..D2) -> model_id`; no D3 in the schema) | same | gateway | `[]` (no route: every call refused) |
| `codehost.merge_bypass` | factory (rows per repo) | `MergeBypassConfig` (user logins with principal ids, max 10 per repo, never an App) | `registerGateCheckConfig` (M14.5, in progress) | gate-check | `{}` (nobody) |

Cross-key rules run on every proposal: a model must name an enabled `model_provider` row, a route must name a model, an enabled install must
name an enabled integration (`ConfigRegistry.rule`). Integration documents are run through the shared secret ruleset, and a finding names the
rule, never the value (`findSecrets`).

**Nothing else is config.** No key exists for agents, prompts, agent budgets, evals, roles, actions, gate policies, notifications, session
policy, a project WIP limit, a project envelope, a G5 deploy target, or the catalogue.

### 1.2 How a revision is decided

From `packages/config/src/store.ts` and `services/core/src/settings.ts`:

1. **Propose.** `proposeRevision` validates the **full document** of the layer (not a delta) and records `config.proposed`. The parent must be
   the layer's published head, or it is refused (`stale_parent`). A document equal to the head is refused (`unchanged`).
2. **M1 opens** with the revision hash as its subject hash and the proposer as the gate's `requester`. A new proposal on the same lineage
   **supersedes** the pending one. So each layer has at most one pending revision at a time: two people editing different factory keys
   replace each other's proposal.
3. **Decide.** `GATE_POLICIES.M1` is the `admin` slot, one approver, no step-up, `own_request: blocked`
   (`entities/gate-lifecycle.ts:195`). The proposer cannot decide their own revision unless they are the slot's only holder, which is stamped
   `sod_waiver` and never allowed on T2 (`packages/decisions/src/policy.ts`).
4. **Publish.** `configPublish` refuses unless the ledger holds an `approve` of exactly that hash. The M1 decision is the ledgered act; the
   `config.published` event references it. Consumers follow by revision (NOTIFY plus a poll), with no restart.

Who holds the `admin` slot:
- **Project layer:** the project's role map. The bootstrap grant lets the person who started the first onboarding decide the first M1
  (`packages/onboarding/src/live.ts`, PLAN §7a).
- **Factory layer:** the gate is opened on the pseudo-project `factory` (`configProjectOf`, `entities/config.ts:84`), and nothing gives that
  project a role map. Today the only factory revisions are the ones the seed proposes and decides itself with a `GenesisEligibility`
  (`services/core/src/seed.ts:312-360`: the policy bundle and the local routing table).

The user decided on 2026-11-11 that a factory admin other than the proposer approves factory M1, and that the deciding role and one-or-two
people are themselves config (PLAN §7a, "Factory-wide M1"). This is **not built**. It is the first gap in §5 and it blocks every factory
screen in §2.

### 1.3 Routes that exist for reading and changing configuration

PDP action names are from `ACTION_CATALOGUE` (`entities/policy.ts:178`).

| Service | Route | Guard | What it does |
|---|---|---|---|
| core | `GET /v1/projects/:id/settings` | scope `read` | the four project keys in force and the tier |
| core | `PUT /v1/projects/:id/settings` (`app.ts:1019`) | scope `settings`, PDP `project.settings.edit` | proposes a project revision (any of the four keys) → M1 |
| core / bff | `GET /v1/revisions/:gate`, `POST .../prepare\|evidence\|decide\|publish` (`app.ts:1308`); bff `/api/revisions/:gate/*` | PDP `gate.decide` on M1 | view and decide a **project settings** M1. `settingsRevision` (`portal-reads.ts:76`) parses only `ProjectSettingsDoc`, so a factory revision cannot be shown or decided here |
| core / bff | `GET /v1/s0/:id/revision`; bff `/api/s0/:id/revision` | scope `read` | the settings revision card 4 proposed |
| core | `GET /v1/integrations?kind=` | scope `registry` | the effective registry |
| core | `GET /v1/integrations/health`, `GET /v1/integrations/events` | scope `portal` | health tiles; each published change with its M1 ledger entry |
| core | `POST /v1/integrations/health` | scope `integrations` | the codehost reports health |
| gateway | `GET /v1/admin/integrations`, `POST /v1/admin/reload {force?}` | service token `read` / `admin` | adapters built or refused per row; `force` picks up a rotated key file |
| gateway | `POST /v1/admin/budget-groups`, `POST /v1/admin/vkeys`, `.../revoke`, `GET` of each | service token | core mints per-Unit and per-job keys; not a human route |
| codehost | `POST /v1/admin/reload` | service token | re-reads the registry |
| sandbox-controller | `GET /v1/slots`, `POST /v1/admin/reload` | service token | free slots per class; re-reads `sandbox.caps` |
| core | `POST /v1/controls/preview`, `POST /v1/controls`, `POST /v1/controls/:id/lift`, `POST /v1/banners` | PDP `control.apply`, `control.lift`, `banner.publish` | hold, clamp (`max_in_flight`), halt, maintenance; banners. No bff route (M9.7 follow-up) |
| core | `GET /v1/projects/:id/breakers`, `POST .../breakers/:lane/reset` | PDP `config.propose` | an R3 reset opens an M5 gate (`breaker.ts:275`) |
| killswitch | `GET/POST /v1/kills`, `POST /v1/kills/:id/release`, `GET/POST /v1/delegations`, `.../revoke`, `GET /v1/capabilities`, `PUT /v1/holders/:project` | its own embedded PDP (`kill.request`, `kill.release`, `project.settings.edit`) | kills, DEC-29 delegations, holders pushed by core-worker. No bff route |
| core / bff | `GET /v1/evals/summary`, `/v1/evals/runs`, `/v1/agents/:id/scores`, `/v1/agent-runs`, `/v1/agents/:id/stats`; bff `/api/*` | PDP `audit.read`, `project.view` | read only |
| core | `POST /v1/evals/runs` | scope `evals` | the `aisdlc-evals` CLI records a run |
| core / bff | `POST /v1/onboard`, `/v1/s0/:id/withdraw\|resume\|signable-level`, `/v1/s0/:id/cards/sync`; bff `/api/onboard`, `/api/s0/*`, `/api/cards/*` | PDP `project.onboard`, `card.decide` | onboarding (§1.6) |
| identity | `POST /v1/principals`, `/update`, `/status`, `/qualifications`, `/v1/identity-links`, `/v1/groups`, `/members`, `/members/remove`, `/v1/bindings`, `/:id/revoke`, `/v1/teams`, `/v1/idp/sync` (`services/identity/src/app.ts:225-500`) | service scope `write` or `sync` only; **no PDP** | identity writes. In compose only the `seed` caller holds `write` (`platform/compose/docker-compose.yml:507`) |
| identity | `GET /v1/projects/:project/explain`, `/v1/principals/:id/bindings`, `/v1/resolve`, `/v1/access-sync` | service scope `read` | effective access ("who can decide each gate"). Not proxied by the bff |

The bff proxies **none** of these: project settings `PUT`, integrations, controls, kills, identity, the gateway. The web app has a revision
page for project settings only (`services/web/src/pages/RevisionPage.tsx`) and the card 4 form (`services/web/src/cards/C4Form.tsx`).

`config.propose` is in the action catalogue, but today the only route that uses it is the breaker reset. No route proposes a factory revision.

### 1.4 Code, not config: changed through a repo PR or a release

These are deliberately code. Nothing in the portal edits them. The portal shows them read-only, with the version and hash in force.

| What | Where | How it changes |
|---|---|---|
| The catalogue: lanes, stages, gates, back-edge limits, the rework budget, the envelope extension, eligibility by level, lane default envelopes (`budget_cents: null` today) | `packages/catalogue/src/*`, snapshots `src/snapshots/1.0.0..1.3.0.json`, `CATALOGUE_VERSION = '1.3.0'` | Bump the version, write the snapshot (`CATALOGUE_WRITE_SNAPSHOT=1 ...`), register it in `history.ts`, PR. Items keep the {version, hash} they pinned. The META gate M3 for this is **not wired** (no code opens an M3) |
| Roles, the action catalogue, gate policies (slot, two-person, step-up, consolidatable), `TWO_PERSON_GATES` | `entities/access.ts` (`ROLE_CATALOGUE`), `entities/policy.ts` (`ACTION_CATALOGUE`, `PDP_POLICY_VERSION = '1.3.0'`), `entities/gate-lifecycle.ts` | PR, a new `PDP_POLICY_VERSION`, then a new `pdp.bundle` published through a factory M1 (`proposeBundle`, `packages/pdp/src/bundle.ts`). The killswitch builds its bundle in-process from code (`StaticBundleSource(buildBundle())`, `services/killswitch/src/service.ts:96`) and does not read the published one |
| Agents: definitions A1–A12 and `coder`, the steps each may act at, contracts (input and output schemas, tools, `data_class_max`, the `models` allow-list, budget defaults) | `packages/agents/src/spec-data.ts`, `registry.ts`, `outputs.ts` | PR. A change of schema, tools or limits bumps `contract_version`. The registry throws at import on a bad definition |
| Agent prompts | `packages/agents/src/prompts/*.md`, pinned by `prompts.lock.json` (sha256 + contract version) | PR plus `npm run gen -w @aisdlc/agents`; a test fails when a prompt moves without the lock |
| Per-Unit envelopes | `budgetEnvelope` (`services/core/src/planning/plan.ts:321`): the coder contract's budget, split by Unit size, capped by the lane default envelope | Code and catalogue |
| The coding-session cap that admission and 5.6 use | `CODING_SESSION_CAP = 1` (`services/core/src/planning/plan.ts:279`, also `entities/sandbox.ts:166`) | Code. H2 takes the lower of this and the controller's free W slots (`admission/admit.ts:94`), so raising `sandbox.caps.coding` above 1 has no effect yet (§5) |
| The secret ruleset, the text lint, the tripwires, the D11 forbidden verbs, the sandbox class ceilings | `packages/secrets-rules`, `packages/text-lint`, `packages/tripwires`, `entities/integrations.ts` (`INTEGRATION_FORBIDDEN`), `entities/sandbox.ts` | Code. They are safety floors (§6) |
| Integration adapters (`github_app`, `fake_github`, `anthropic`, `openai_compat`, `fake`) | `IntegrationAdapter` enum | A new adapter is a class plus a name, never a free-text row. `notifier`, `tracker` and `identity` exist as kinds but have no adapter |
| The eval store: suites, cases, hidden graders, holdouts, baselines, the signed manifest | `AISDLC_EVAL_STORE`, a directory outside the repo (`packages/evals`) | The `aisdlc-evals` CLI (`init`, `add-case`, `baseline`, `sign`, `pin`, `run`, `compare`, `gate`). Core keeps only run history |

### 1.5 Deployment settings: environment variables, not config

Set by whoever runs the deployment (compose files, secrets as files). They bound what config may do. For example, a registry row can name
only a key file in `GATEWAY_SECRET_REFS` and a host in `GATEWAY_EGRESS_HOSTS` (`docs/specs/gateway-api.md` §5–6). The portal may show them
read-only; it never edits them (§6).

- **gateway:** `GATEWAY_ENVIRONMENT`, `GATEWAY_SECRET_REFS`, `GATEWAY_EGRESS_HOSTS`, `GATEWAY_MAX_PROVIDER_CALLS`, the sweep bounds, `GATEWAY_CALLERS`.
- **bff:** session policy `BFF_IDLE_SECONDS` and `BFF_ABSOLUTE_SECONDS`, `BFF_STEP_UP_MODE`, `BFF_OIDC_*`, `BFF_ALLOWED_ORIGINS`, `BFF_PDP_SAMPLE_RATE` (`services/bff/src/boot.ts`).
- **identity:** `IDENTITY_CALLERS`, `IDENTITY_IDP_SEED_FILE`, `IDENTITY_SYNC_INTERVAL_MS`.
- **sandbox-controller:** `SANDBOX_CONTROLLER_HOST_ID`.
- **every service:** its `*_CALLERS` service tokens.

### 1.6 Identity and onboarding, as built

**Identity** (`services/identity`, read models `packages/directory`):
- principals, groups and memberships, bindings `(group, role, scope)`, qualifications, identity links and teams, all journalled;
- an IdP sync from a seed file (`idp-sync.ts`);
- project bindings generated from the role map (`reconcile`);
- the effective-access explain (`explain.ts`).

Writes are service-scoped with an optional `on_behalf_of`, and **no PDP decides them**. There is no access-request entity. The actions
`access.manage`, `identity.admin`, `ops.read`, `session.stop`, `quality.read` and `assistant.use` are only in the prototype (coverage §5.6).
Sessions are bff rows (`services/bff/src/sessions.ts`) with no route that lists or ends them.

**Onboarding:**
- Cards C1, C4, C5 and SECR are built (`services/core/src/cards/model.ts`: `HANDLED_CARDS`).
- Cards decide through the `admin` slot of M1 (C1, C4, C5) or of SECT (SECR).
- Card 4 proposes the project settings as a revision. It has a form in the web app.
- C2 (Light) and C3 (Full) are not built. A9 is defined (steps 0.1–0.3, 2.1b) but no service calls it.
- Levels: the request carries `level`, and `signable-level` lowers what may be signed.
- A project has a `deploys` boolean (`entities/projects.ts:58`) that turns on the T2 G5 floor. **No G5 deploy target is stored anywhere.**

---

## 2. Configurable areas, one row each

Column key:
- **Layer:** F = factory, P = project, R = repo row inside a factory key, code = §1.4.
- **Proposes:** the PDP action.
- **Decides:** gate and slot.
- **Status:** **exists** means route and backend are there; **partial** means a piece is missing; **missing** means neither.
- **Screen** uses the §3 pattern: V view, E edit form from the schema, D diff, P propose, H history, T test connection or health, C rotate credential reference. RO means read-only.

### 2.1 Integrations, models and routes

| Configures | Key / API | Layer | Proposes | Decides | Status | Screen | Milestone |
|---|---|---|---|---|---|---|---|
| Code hosts (GitHub App rows: app id, installation, mode, scopes, status) | `integrations.registry`; read `GET /v1/integrations`, `/health`, `/events` | F | `config.propose` (no route) | M1 at the factory admin slot (not built, §1.2) | partial: schema, rules, readers, health, events exist; no propose route, no factory M1 decider, no bff proxy | V E D P H T C | M21 screen, after the factory M1 (M15) |
| Model providers (anthropic, openai_compat rows for Codex and DeepSeek, fake) | same key, kind `model_provider`; gateway `GET /v1/admin/integrations` shows built or refused per row | F | same | same | partial, as above | V E D P H T C | same |
| Per-project installs (enable a provider or host for a project, `repos_allowed`, `models_allowed`) | `integrations.installs` | F (rows per project) | same | same. A project admin cannot change it: the key is not overridable | partial. Whether an absent install means the fleet default is open (PLAN M10.6) | V E D P H, shown on the project page too | M21; M10.6 decides the semantics |
| Credential rotation | a new revision with a new `file:` or `env:` reference, then `POST /v1/admin/reload {force:true}` | F | same | same | partial: the reference must already be in `GATEWAY_SECRET_REFS` (deployment) | C: field shows the reference only, plus a "reload" result per row | M21 |
| Models: limits and prices (`max_tokens_cap`, `usd_in/out_per_mtok`, `tools_capable`) | `gateway.models` | F | same | same | partial. Prices in the seed are placeholders (PLAN M10.6) | V E D P H | M21; prices confirmed in M10.6 before real spend |
| Routes `(environment, data class) -> model` | `gateway.routes` | F | same | same | partial | V E D P H; a D3 row cannot be drawn (no D3 in the schema) | M21 |
| Which model an agent may use | the contract's `models` allow-list | code | PR | review | n/a | RO on the agent page | — |

The prototype's "Propose route change (M1)" on an agent page (`views-govern.js:191`) implies a per-agent route. Routes are per
environment and data class only. A per-agent change is a contract change in code.

### 2.2 Agents and evals

| Configures | Key / API | Layer | Proposes | Decides | Status | Screen | Milestone |
|---|---|---|---|---|---|---|---|
| Registry: definitions, steps, contracts, tools, data class | code (§1.4) | code | PR | code review | exists as code; reads `GET /v1/agent-runs`, `/v1/agents/:id/stats` | RO: definition, contract version, prompt sha, JSON Schemas, tool list | — |
| Prompts | `prompts.lock.json` | code | PR | review, plus the eval gate run by hand | exists | RO: prompt ref and sha, lock entry; link to the PR | — |
| Budget defaults per agent | contract `budget` | code | PR | review | exists | RO | — |
| Budget groups per Unit or job | gateway admin API, minted by core from the contract | runtime | core only | — | exists, not human-set | RO: used, reserved, `exhausted_at` (`GET /v1/admin/budget-groups/:id`) | M19 (floor) |
| Enable or disable an agent | none: an agent is bound to a step by code (`STEP_PRIMARY_AGENT`) | — | — | — | missing. Kill and control scopes have no `agent` or `model` kind (coverage §5.2) | — | decide in M19 (kill scope vocabulary) |
| Promotion (autonomy level of a project, from evals and outcomes) | M5 | P | 9.4 Learn proposes | M5 at `admin` | missing (M15.5). M5 exists only for the breaker reset | V D H, M5 card with the eval comparison | M15 |
| Eval suites, cases, baselines, holdouts | `aisdlc-evals` CLI on the store outside the repo | outside | CLI holder of the store key | the signed manifest | exists (CLI) | RO run history and scores; never cases, graders or holdouts | — |
| Eval gate (`gateRun`) | CLI | outside | — | the gate's thresholds in code | exists (CLI). Nothing in core or CI blocks a change on it | RO: last gate result per agent, prompt sha, provider | M15.5 ties it to M5 |
| Run history | `POST /v1/evals/runs` (CLI), `GET /v1/evals/*` | — | — | — | exists | V H | M21 |

The prototype's "Run eval suite" and "Re-run gate on latest" buttons (`views-govern.js:191`, `:329`) have no backend. Runs need the eval store
and its signing key, which live outside the factory's services by design (§6).

### 2.3 Access: roles, teams, people, bindings

| Configures | Key / API | Layer | Proposes | Decides | Status | Screen | Milestone |
|---|---|---|---|---|---|---|---|
| Roles, actions, gate policies | code + `pdp.bundle` | code, then F | PR, then a bundle revision | M1 at the factory admin slot (not built); the seed today | partial | RO matrix (prototype `roles`); the bundle version and hash in force | — (M3 META gate not wired; see §5) |
| Policy bundle | `pdp.bundle` | F | `proposeBundle` (no route) | factory M1 | partial: seed only | V D H (bundle version, hash, policy diff) | M21 after the factory M1 |
| People (principals: create, update, suspend) | identity `POST /v1/principals*` | identity | none: no PDP action exists | none | partial: journalled writes, seed-only caller, no PDP | V E H | M21 (needs `identity.admin` in the catalogue, an M3-class change) |
| Groups and memberships | identity `/v1/groups*` | identity | none | none | partial, as above | V E H | M21 |
| Teams (factory-owned, optional IdP group mapping, PLAN §7a) | identity `POST /v1/teams`, `/v1/idp/sync` | identity | none | none | partial, as above | V E H | M21 |
| Bindings `(group, role, scope)` at fleet or team scope | identity `/v1/bindings`, `/revoke` | identity | none | none. The decision log is the access journal plus `access` ledger entries (M4.1) | partial, as above | V E H; explain | M21 (`access.manage`) |
| Project bindings | generated from `project.role_map` (never edited directly) | P | `project.settings.edit` | M1 at `admin` | exists | edited through the role map (§2.4) | — |
| Access requests | none | — | — | — | missing: no entity, no route | prototype `access-requests` | M21 |
| Effective access explain | identity `GET /v1/projects/:project/explain` | — | `access.explain` (V3) | — | partial: no bff route | V | M21 |
| Qualifications, identity links | identity routes | identity | none | none | partial | V E | M21 |
| Sessions: list, end, sign-ins | bff sessions table | — | — | — | missing: no route | V, end session | M21 |
| Session policy, step-up mode | `BFF_IDLE_SECONDS`, `BFF_ABSOLUTE_SECONDS`, `BFF_STEP_UP_MODE` | deployment | — | — | env only | RO | — (§6) |

The prototype's org settings propose an `identity.settings` revision (`views-admin.js:235`). That key does not exist.

### 2.4 Projects

| Configures | Key / API | Layer | Proposes | Decides | Status | Screen | Milestone |
|---|---|---|---|---|---|---|---|
| Role map (ten slots) | `project.role_map`, `PUT /v1/projects/:id/settings` | P | `project.settings.edit` (admin slot, factory.admin) | M1 at the project `admin` slot | exists in core; bff `PUT` missing; decide page exists | V E D P H | M14.6 or M16 (first after-onboarding edit) |
| Two-person setting | `project.two_person` | P | same | same; T2 cannot turn it off (`projectSettingsTierViolations`) | exists, as above | V E D P H | same |
| Gating profile (G0+G1, G2, G3d, G3/G3s, G5, G6 on or off, `by_lane`, `schedule`) | `project.gating_profile` | P | same | same; the T2 floor (`gatingFloorViolations`) refuses the proposal | exists, as above. Items pin the profile they started with | V E D P H, floor violations shown before propose | same |
| G5 release target (off, or a deploy target such as a GitHub environment, PLAN §7a) | none; only `Project.deploys` (boolean) | P | — | M1 (decided 2026-11-11) | missing | E on card 4 and in settings | M15 (M15.3 gate-relay) |
| Kill delegations | `project.kill_delegations` (config) **and** killswitch `/v1/delegations` (direct, journalled, PDP `project.settings.edit`) | P | `project.settings.edit` | M1 for the key; none for the killswitch route | partial: two stores for one concept | V E H | decide one store in M19; screen M21 |
| Kill holders | derived: kill slot of the role map plus delegations, pushed by core-worker (`PUT /v1/holders/:project`) | P | via the role map | M1 | exists | RO, "who can kill" | M21 |
| WIP limit | none. The `WIP` hold is a lease another holder has. `clamp {max_in_flight}` is a control, not config | P | ADR-0003 §6: project admin, M1 | — | missing as config; the clamp control exists (`POST /v1/controls`) | E D P H | M15 (with admission) |
| Default envelope | none: `budgetEnvelope` from the coder contract and the catalogue lane default | P | ADR-0003 §6: project admin, M1 | — | missing | E D P H | M15 |
| Merge bypass list (DEC-10) | `codehost.merge_bypass` | F (rows per repo) | `config.propose` (no route) | factory M1 (not built) | partial (M14.5): schema and reader; every bypass merge opens X4 | V E D P H, shown on the project page | M14.6 screen, decidable after the factory M1 |
| Exec allow-list (DEC-18) | `sandbox.exec_allowed_repos` | F | same | same | partial: key and enforcement, no route | V E D P H | M20 (multi-repo allow-list) |
| Integrations for the project | `integrations.installs` | F rows | §2.1 | §2.1 | §2.1 | shown on the project page | M21 |
| Controls (hold, clamp, halt, maintenance) and banners | `POST /v1/controls*`, `/v1/banners` | P or fleet | `control.apply`, `control.lift`, `banner.publish` | preview, nonce, applied (not a gate) | exists in core; no bff route | operate screens | M9.7 follow-up, M21 |
| R3 breaker reset | `POST /v1/projects/:id/breakers/:lane/reset` | P | `config.propose` | M5 at `admin` | exists in core; no bff route | button plus M5 card | M15 |

### 2.5 Onboarding

| Configures | Key / API | Layer | Proposes | Decides | Status | Screen | Milestone |
|---|---|---|---|---|---|---|---|
| Start an onboarding (repo, level Census/Light/Full, team, attestations) | `POST /api/onboard` | — | `project.onboard` (factory.admin, factory.onboarder) | the cards | exists | `onboard` (exists in web) | — |
| Signable level, withdraw, resume | `/v1/s0/:id/signable-level\|withdraw\|resume` | — | `project.onboard` | — | exists in core; bff for some | S0 page actions | M16 |
| Card 1 (owners, tier raise-only, T0 attestation, gap dispositions) | `/api/cards/:id/*` | — | the S0 driver | `admin` slot (bootstrap grant first) | exists | C1 form | — |
| Card 4 (controls attestations, role map, two-person, gating profile) | same; proposes `project.*` → M1 | P | the card | `admin` | exists | C4 form + revision page | — |
| Card 5 (sign-off + M4, step-up) | same | — | — | `admin` + M4 at `m4`, step-up | exists | C5 panel | — |
| Security card | same | — | — | `sec` | exists | SECR form | — |
| Card 2 (Light) and card 3 (Full) | — | — | A9 and the deterministic driver | `admin` | missing | C2, C3 forms | M16, M17 |
| Per-area levels (DEC-25), level-up, re-affirm, restore after drift (DEC-21), expiry | — | — | — | M4 for a new version | missing | after-onboarding screens | M16, M17 |
| S0 tunables: failure model, time boxes, calendar, T0 attestation | `s0.*` | F | `config.propose` (no route) | factory M1 | partial: keys only | V E D P H | M21 after the factory M1 |
| Factory template for instruction files (DEC-11 refined) | none | F | — | M1 (each value a setting, PLAN §7a) | missing | V E D P H | M16 |
| Onboarding sandbox image (DEC-17 refined: "an image update is a reviewed config change") | none | F | — | M1 | missing | V (image digest, scanner versions) D P H | M16 |
| DEC-15, DEC-19 values ("each value stays a setting changeable by M1") | none yet | F | — | M1 | missing | V E D P H | M16 |
| Onboarding agent console | §4 | — | — | — | missing | §4 | M18 |

### 2.6 Factory-wide operations

| Configures | Key / API | Layer | Proposes | Decides | Status | Screen | Milestone |
|---|---|---|---|---|---|---|---|
| Sandbox caps (total, coding, per host) | `sandbox.caps` | F | `config.propose` (no route) | factory M1 | partial: the controller enforces it; core's H2 and 5.6 still cap coding at the constant 1 | V E D P H T (`GET /v1/slots`) | M21 screen; the constant fix is a §5 gap |
| Constitution (rules, egress allow-hosts) | `factory.constitution` | F | same | factory M1 | partial: key and evaluator (4.5, 7.5) | V E D P H; an E2 card links to the version | M21 |
| Maintenance MM-2 | `ops.maintenance.mm2`, and control kind `maintenance` | F | same, or `control.apply` at fleet | factory M1, or a control | partial | toggle with preview | M21 |
| Kill switch (fleet, project, lane) | killswitch API | F/P | `kill.request` | two-person release | exists, no bff | kill screen | M9.7 follow-up |
| Notifications (channels, Slack and email, per-person preferences) | none; `notifier` is an integration kind with no adapter | F + person | — | M1 for channel rows | missing | V E D P H T C | M18 |
| Catalogue | code (§1.4) | code | PR | review; M3 not wired | exists as code | RO: version, hash, snapshots, which items pin which | — |
| L0 and L7 eligibility (decided 2026-11-11) | catalogue | code | PR, new `CATALOGUE_VERSION` | review | missing | RO | M15 or next catalogue release |

The prototype's "Propose 1.5.0 (M3)" (`views-govern.js:800`) opens an M3 card. No code opens an M3, and a catalogue release is a repo PR.
The prototype's `ops.flags` revision (`views-operate.js:559`) is, in the code, the single key `ops.maintenance.mm2`.
The prototype's M1 card asks for step-up; `GATE_POLICIES.M1.step_up` is `false`.

---

## 3. The one configuration pattern

Every row of §2 marked E uses the same screen. The pattern follows the existing mechanism (§1.2) and adds no rule of its own.

1. **Effective value and lineage.**
   - Show the value in force for the key: the published revision's value, or the registry default when no layer sets it.
   - Show which layer it comes from (default, factory, project), the revision hash, who proposed it, who decided its M1, when, and a link to the ledger entry.
   - Show any pending revision of the same lineage, with its proposer and its M1 state.
   - The data: `loadEffective` and `readLineage` (`packages/config/src/projection.ts`, `lineage.ts`). For integrations, `GET /v1/integrations/events` already returns this.
2. **Draft form from the schema.**
   - The form is generated from the key's Zod schema (contracts). No screen re-lists an enum.
   - Cross-key rules and tier rules are evaluated on the draft before propose, using the same functions the server runs (`ConfigRegistry.validate` and its rules, `gatingFloorViolations`, `projectSettingsTierViolations`). The person sees each problem as text.
3. **Diff.**
   - A canonical-JSON diff of the full layer document against the published head, per key.
   - The draft's parent is the head. If the head moves while someone edits, propose is refused (`stale_parent`) and the screen rebases.
   - If another revision is pending on the lineage, the screen warns that proposing **supersedes** it.
4. **Propose.**
   - One button. The PDP action is `config.propose` (factory) or `project.settings.edit` (project).
   - The server records `config.proposed` and opens an **M1 card**. Nothing changes yet.
   - The screen shows the M1 deciders from the eligibility port, with the proposer marked as barred (the `own_request` rule; a sole holder gets a `sod_waiver`).
5. **Pending.** The M1 card is decided in the inbox through prepare, evidence viewed, decide. The evidence is the diff. Expiry never approves.
6. **Published.**
   - The worker publishes a decided approve (`publishDecided`). The publish can be retried with `POST /v1/revisions/:gate/publish`.
   - Readers follow by revision. Where a consumer has a reload or health route (gateway `GET /v1/admin/integrations`, sandbox-controller `GET /v1/slots`), the screen shows that consumer's answer: for each row, did it build or was it refused, and why.
7. **History.**
   - Every revision of the lineage: proposed, superseded, published, each with its M1 entry.
   - Rollback is a new revision whose document equals an older one. Nothing is edited in place.

**Secret references.**
- A credential field holds a reference, `file:/...` or `env:NAME` (`SecretRef`). It never holds a value.
- The form shows the reference as text and refuses anything else client-side. The server refuses it again: the shape check plus the secret ruleset on the whole document.
- Rotation means proposing a new reference. After publish, a forced reload is needed to read the new file. The screen shows the gateway's per-row result (`secret_ref_not_allowed`, `secret_unreadable`, `credential_missing`).
- No screen reads, shows, uploads or tests a secret value. "Test connection" shows only the health the service already reports (`integrations.integration_health`; older than 2 minutes reads `unknown`).

**Read-only areas** (the §1.4 code) use steps 1 and 7 of the same layout, with the version and hash in force and a link to the source in the repo.

---

## 4. The onboarding agent console

**What the specs say.**
- PLAN M18 lists "the onboarding assistant" with Thread, Turn, Draft, Citation, ProposalButton ("actions only through buttons that call normal routes"), RedactablePayload, AskSession and the `assistant_user_day` budget group.
- The onboarding spec says the S0 wizard "is **not a chat**: FD-D18 allows actions by buttons only, and A3.1 is on hold". Its voice is the cards, and human input arrives only through cards (`docs/specs/onboarding-roadmap.md` §6.4).
- The domain model's Conversation context has `AssistantTurn` keyed by `(s0_id, oid, seq)` with kinds `message answer guide drafts refusal` (`docs/specs/domain-model.md` §3.2, §3.9). That describes the predecessor repo; none of it exists here.
- The agent that does onboarding work is A9 (steps 0.1–0.3, raise-only proposals; `packages/agents/src/spec-data.ts`). The registry has no assistant agent; A7, A8 and A10 are unbound.

**So the console is an assistant beside the S0 page, not a second wizard.**

It may:
- answer questions about the S0 record, its steps, the controls report, gaps, claims and caps, from what the person may see, each answer with citations (file and line at the census SHA, gate, ledger entry);
- explain why a step waits (`S0Overview.waiting`), what a card will ask, and what a level would unlock (OB §2.1);
- draft text the person then puts on a card, such as an intent answer or a correction to a claim, as a Draft the person edits;
- offer proposal buttons that call the normal routes under the person's own PDP decision: open the card, re-check a control (`/api/cards/:id/recheck`), lower the signable level, withdraw.

It may not:
- decide or affirm a card, or click anything for the person. Card 2's instruction text is "never affirmed in the session that proposed it" and needs the D37 step-up (coverage §3).
- take instructions from repo content. Repo text reaches it only as fenced data through `buildContext`, merged-SHA grounding only, `text-lint` on every piece (`packages/agents/src/context.ts`). A planted instruction changes nothing.
- push, write the repo, change GitHub settings or apply a ruleset. The human applies ruleset fixes on GitHub and the factory never fixes a control (OB §6.2, 0.4).
- see secrets or security findings beyond the person's data class. Secret findings stay on the security card.
- raise a level or lower a tier. Tier is raise-only, and only a person loosens a cap (OB §2.2–2.3).
- use tools beyond read-only retrieval (`KnowledgeSearch` at the census SHA), or spend past its budget group.

**Screen, in prose.**
- The S0 page keeps its step list and cards on the left. The console is a right-hand panel titled with the repo and the census SHA it is grounded on.
- Each answer shows its citations as chips that open the cited file at the line, the card, or the ledger entry.
- A proposal button looks like the page's own buttons and goes through the same PDP. A locked one explains itself, as elsewhere.
- Drafts appear as a card-shaped block with "Use in card N", which copies the text into the card's field. The person still submits the card.
- When the knowledge index is stale (`409 stale_index`) or the head has moved, the panel says so and answers nothing about the new head.
- The panel shows the budget left for the day (`assistant_user_day`) and a refusal turn when it is spent or when a question asks for something outside the person's view.
- The thread is per person and per S0 record. It is never shown to others; the cards are the shared record.

**Backend it needs (all missing):**
- a Conversation module in core: Thread and Turn as record events, Citation, ProposalButton, Draft;
- an assistant agent definition, contract and prompt in `packages/agents` (a code change with a lock entry);
- a per-person budget group minted through `AgentKeyPort`;
- bff routes.

All are M18.

---

## 5. Gap list

The first gap blocks every factory-layer screen.

| # | Gap | What exists | Suggested milestone |
|---|---|---|---|
| 1 | **Factory-wide M1 decider.** The factory M1 opens on the pseudo-project `factory` and nobody holds its `admin` slot; only the seed decides factory revisions. Decided 2026-11-11: a factory admin other than the proposer; role and one-or-two are config, changed under the same approval | `GATE_POLICIES.M1`, `configProjectOf`, `GenesisEligibility` in the seed | M15 (M15.5 builds the META gates); needed before any screen in §2.1, §2.6 |
| 2 | **A propose route for the factory layer** (`config.propose` at fleet) and a generic revision view: `settingsRevision` parses only project settings, so a factory revision cannot be viewed or decided in the portal | `proposeRevision`, `proposeBundle`, `/v1/revisions/:gate` for projects | M15, with #1 |
| 3 | **Read routes for effective config and lineage** per layer and key (§3 step 1, step 7) | `loadEffective`, `readLineage`, `listRevisions` in `packages/config`; integration events only | M15 |
| 4 | **One pending revision per layer**: a proposal supersedes the pending one, so concurrent edits of unrelated factory keys clobber each other. Either per-key lineages or a rebase UX | store behaviour (§1.2) | decide in M15; the UX in §3 handles it meanwhile |
| 5 | **bff proxies** for project settings `PUT`, integrations, controls, kills, breakers, explain | core and killswitch routes | the milestone of each screen; controls and kills are the M9.7 follow-up |
| 6 | **Identity admin is not PDP-guarded**: identity writes are service-scope only and only the seed holds `write`. Needs `access.manage` and `identity.admin` in `ACTION_CATALOGUE` (an M3-class change), bff routes, and an access-request entity | journalled identity commands, explain | M21 (the action catalogue change before the screens) |
| 7 | **Sessions**: list, end, sign-in history | bff session rows | M21 (sign-in history with M19 audit) |
| 8 | **G5 release target** per project, chosen at card 4, changed by M1 | `Project.deploys`, the `g5` switch | M15 (M15.3) |
| 9 | **Project WIP limit and default envelope** as project config (ADR-0003 §6) | `clamp` control; `budgetEnvelope` from the contract and the catalogue | M15 |
| 10 | **Coding cap is a constant in core**: H2 and 5.6 use `CODING_SESSION_CAP = 1` (defined twice), so `sandbox.caps.coding > 1` has no effect | the controller reads `sandbox.caps` | M15 or the next admission change; also coverage §5.1 |
| 11 | **Kill delegations in two stores** (`project.kill_delegations` and the killswitch table); the killswitch uses an in-process bundle, not the published one | both stores | M19 (with the kill scope vocabulary, DM §8 gap 8) |
| 12 | **No M3 gate**: catalogue releases and permission changes have no META decision in the factory; they are PRs | `CATALOGUE_VERSION`, snapshots, the PDP bundle via M1 | M15.5 (M3 is listed there); until then the portal shows them read-only |
| 13 | **Autonomy promotion (M5) from evals and outcomes**, and the eval gate tied to it | `foldAgentScores`, `gateRun` (CLI), M5 for the breaker only | M15 (M15.5) |
| 14 | **Agent enable or disable**: no switch exists; kill and control scopes have no agent or model kind | step binding in code | M19 (decide the scope vocabulary first) |
| 15 | **Onboarding settings DEC-11, DEC-15, DEC-17, DEC-19** (instruction template, exam and A9 values, onboarding image, per-area values) as M1 settings | none | M16 |
| 16 | **Cards 2 and 3, per-area levels, level-up, re-affirm, restore** | cards 1, 4, 5, SECR | M16, M17 |
| 17 | **Onboarding agent console and Ask** (§4) | `buildContext`, `KnowledgeSearch`, `AgentKeyPort` | M18 |
| 18 | **Notifications**: the notifier service, adapters, channel rows as integrations, per-person preferences | the `notifier` integration kind | M18 |
| 19 | **Install-absent semantics** and confirmed per-model prices | the installs rule; placeholder prices | M10.6 follow-up, before real spend |
| 20 | **Exec allow-list for more than the owner's repos** | `sandbox.exec_allowed_repos` | M20 (multi-repo allow-list, DEC-18 re-decided per repo) |

---

## 6. Out of the portal on purpose

| Stays out | Why |
|---|---|
| Secret values: vendor keys, App private keys, tokens, signing keys | Only references are config (`SecretRef`). Keys live in mounted files read by their one holder (the gateway, the codehost, kms-local); a grep test keeps them out of responses and logs. The portal never uploads or reveals one |
| Deployment bounds: `GATEWAY_SECRET_REFS`, `GATEWAY_EGRESS_HOSTS`, `GATEWAY_MAX_PROVIDER_CALLS`, `*_CALLERS`, the bff session and step-up settings | They bound what a published revision may do ("it cannot make the gateway read a file it was not given or send a key somewhere new", gateway-api §6). Making them editable from the portal removes the bound. Shown read-only at most |
| Agent prompts, contracts, tools and output schemas | Pinned by hash and `contract_version`, checked by tests, and the evidence of every run names them. A prompt edited in a browser would bypass the lock and the eval gate |
| A released catalogue | Immutable by rule. Items pin {version, hash}; a change is a new version and snapshot in the repo |
| The safety floors: G4 always human, X1–X3, E-gates, Q1, M4, verification in every lane, D11 forbidden verbs, no D3 route, T2 two-person and gating floor, "off means absent, never auto-approved", the factory never merges | OB §1C, §5.5 and AGENTS.md. Each is enforced by schema or code (no D3 in `GatewayRoutes`, `gatingFloorViolations`, `INTEGRATION_FORBIDDEN`). The portal explains them; it has no switch for them |
| The eval store: cases, hidden graders, holdouts, baselines | It lives outside the repo and every service so that agents and their builders cannot read the answers (`packages/evals`; holdouts read by `holdout.ts` only). The portal shows run history and scores only |
| Repo settings on GitHub: rulesets, bypass actors, workflows, branch protection | The App has no such permission and the factory never fixes a control: the human applies it on GitHub (OB §6.2, 0.4; §6.5 "Never" row). The portal shows the controls report and an instruction card |
| The ledger, record and Notary | Append-only and signed; correction is a new entry. Erasure and legal hold go through the M19 audit backend, not configuration |
| Pushing or merging | The human never pushes and the factory never merges (DEC-10 refined, D11). The merge bypass list names people who merge on GitHub; it is not a merge button |
