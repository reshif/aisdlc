# Settings catalogue (portal v2)

Status: implemented on `v2/settings` (2026-11-13). Every hard-coded setting of [`screen-map.md` §5](screen-map.md#5-hard-coded-settings-found-in-the-code)
(H1 to H29) is listed here with the config key that now holds it, its plain name (from [`glossary.md` §18](glossary.md#18-settings)),
its type, its default (today's value), who may change it, what it does and when a change takes effect.

## How every setting works

- **One registry.** Each key is registered in `@aisdlc/config` (`registerSettingsConfig`, `registerCatalogueConfig`; `access.roles` in
  `@aisdlc/pdp` `registerRolesConfig`) with a Zod schema from `@aisdlc/contracts` (or `@aisdlc/catalogue` for the catalogue's sections).
  The config console turns the schema into a JSON Schema (`keySummary`), so the Settings screen renders a form for every key.
- **Today's value is the default.** A key nobody set reads exactly what the code did before (each key has a test that its default
  equals the old constant).
- **Who may change it.** Every key is **factory layer only** (a project cannot set it) and **M1-gated**: a change is a config revision
  proposed through the normal path (`proposeRevision`, the config console), decided at its M1 approval (by `factory.m1_policy`;
  the factory admin may apply alone through the override another squad adds), then published. Nothing below has another way in.
- **Fail closed.** A published value that no longer fits its schema is never replaced by a looser one: agents are not dispatched,
  the 5.5 envelope is not made, nothing new pins a catalogue, the approvals table and readiness rules fall back to the code's
  (shipped) ones, timers fall back to their defaults. Every reader is written that way and tested.
- **Env stays a bootstrap default only.** Where an environment variable set a value (`BFF_IDLE_SECONDS`, `BFF_ABSOLUTE_SECONDS`,
  `GATEWAY_MAX_PROVIDER_CALLS`, core-worker's poll and health intervals), the env value is used until the factory publishes a
  value different from the code's default; then the published value wins.
- **Read at runtime.** Services read through their `ConfigReader` on each use. Code with no reader (pure packages) reads what the
  process installed: `followSettings` (`@aisdlc/config`) installs the approvals table (`installGatePolicies`), the readiness rules
  (`installReadinessPolicy`), every scalar key (`installSetting`/`settingInForce`) and loads the catalogue's settings releases on
  every revision. Core, core-worker, the bff and the sandbox-controller call it at boot.

### Catalogue data stays immutable (H1-H5, H18-H21)

A change to a catalogue section never edits a released catalogue. When a factory revision that changes a `catalogue.*` key is
**published**, the catalogue it makes (the newest code release's data with those sections replaced) becomes a new version
`<base>+settings.<n>` (for example `1.4.0+settings.1`, then `.2`), hashed like every release and recorded once, with its full data,
as a `catalogue.released` event on the `catalogue:settings` stream, in the same transaction as the `config.published` event.
New requests, items and S0 records pin the release the published settings make (`pinCatalogue`); an item keeps the version it
pinned and `catalogueFor` reads both code and settings releases (a settings release is checked against its hash and its base
before it is loaded; one a process has not loaded is `CatalogueUnknown`: the item fails closed). The same settings on the same
base are the same release, so publishing an unrelated key, or going back to earlier values, makes no new version. A code
release that moves the base gets its settings release at the next pin (`ensureSettingsRelease`). gate-check loads a release it
does not know before it answers (its role reads only `catalogue.released` on that stream; migration `gate-check/0002`).

**Takes effect:** new items only. Running items keep the catalogue they pinned.

## The keys

"Now" means the next use after the publish, with no restart. "New items only" means new requests, items and S0 records.

### Catalogue (Settings › Tracks, Approvals, Onboarding)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `catalogue.lanes` | Tracks | record of track to `LaneDef` (steps, approvals, entry point, profile with default budget per part, hotfix follow-up, re-entry) | `LANES` of the newest code release | What each track runs and asks | H1, H5, H18 | new items only (new catalogue version) |
| `catalogue.back_edge_limits` | Retry limits per sent-back reason | record B1-B28 to limit (rounds, times, days, then) | `BACK_EDGE_LIMITS` (B1 2 rounds + 5 days, B3 3, B5 2, B7 3/5/2x, B13 2, B19 >10% over >=20, B21 1 working day, B23-B25 ...) | When a loop stops and where it goes | H2, H19, H8 (overdue after = B21) | new items only |
| `catalogue.rework_budget` | Rework limit | `ReworkBudget` | 5 sends back, 10 working days, then E4 | When a person takes over | H3 | new items only |
| `catalogue.envelope_extension` | Budget extension | `EnvelopeExtension` | once, at most 50%, via E3 | How far a budget may be extended | H4 | new items only |
| `catalogue.flow_limits` | Hand back and alternative limits | `FlowLimits` | D4 once, X3 once | | - | new items only |
| `catalogue.triggers` | Escalation triggers | record ET1-ET14 to effects and thresholds | `TRIGGERS` (ET14 trips at 3) | What each trigger does | - | new items only |
| `catalogue.gating` | Gating defaults | `GatingCatalogue` | `GATING` | Default approvals per group and track, T2 floor | - | new items only |
| `catalogue.eligibility` | Which tracks each onboarding level allows | `EligibilityCatalogue` | `ELIGIBILITY` | What a level opens | H21 | new items and new S0 records (the readiness record reads its S0 record's pin) |
| `catalogue.autonomy` | Agent autonomy caps | `AutonomyCatalogue` | `AUTONOMY` (tier, level, readiness, posture, probation) | The caps a readiness record issues with | H20 | new S0 records |
| `catalogue.criteria` | Readiness criteria | `CriteriaCatalogue` | `CRITERIA` | The criteria and floors | - | new S0 records |

### Approvals (Settings › Approvals)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `gates.policy` | Who decides each approval | `{ gates: record gate to {slot, own_request, step_up, consolidatable}, two_person_gates: gate[] }` | `GATE_POLICIES`; two people for X1, X2, E2, M4 (`TWO_PERSON_GATES`) | Who decides, the requester rule, confirm-it's-you, sharing a card, two people when the project's two-person setting is on. X, E, Q and M approvals never share a card (refused) | H6, H7 | now (approvals opened and decided from then on; installed for `gatePolicy` in core, core-worker and the bff) |
| `gates.timers` | Approval timers | `{ expires_after_s, step_up_ttl_s, nonce_ttl_s }` | 7 days, 300 s, 600 s | When an approval expires (never approves), how long confirm-it's-you and a prepared decision last | H8 | now |

### Onboarding (Settings › Onboarding)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `readiness.policy` | Readiness rules | `{ prr_fresh_days, max_waiver_days, max_light_claims, lf6_min_affirmed_or_unknown }` | 90 days, 90 days, 50, 0.9 | Scorecard valid for, waiver length, facts to confirm, share confirmed. The first three can only be lowered (a stored record is checked against the code's ceiling) | H10 | now (next readiness record, waiver, card 2, LF6) |

### Agents (Agents)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `agents.config` | Agents on/off, models, turns, timeouts, budgets | record agent to `{ enabled?, models?, budget?{max_tokens, max_cost_micro_usd, ttl_seconds}, max_turns?, run_time_s?, test_time_s? }` | each agent on, its contract's models and budget (`spec-data.ts`); the coder 40 turns, 1800 s a session, 600 s a test run | An agent off runs nothing (`agent_disabled`, recorded once, delivered again later); models and budget go into the key the gateway mints (still built by `agentKeyRequest`; tools and most sensitive data stay the contract's); the coder's turns and times go into every session. A model must be in the agent's contract or in `gateway.models` | H12, H13, H14 | now (next dispatch, next session) |
| `planning.size_share` | Budget share per part size | `{ small, medium, large }` (0 to 1) | 0.25, 0.5, 1 | The share of the coder's budget each part size may spend (5.5) | H15 | now (plans made from then on) |
| `evals.gate` | Evaluation gate | `{ floor, level, resamples }` | 0.8, 0.90, 2000 | The comparison with the baseline | H24 | now for in-factory comparisons; the `aisdlc-evals` CLI runs outside the factory and keeps its flags |

### General (Settings › General)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `session.policy` | Sign-in session limits | `{ idle_s, absolute_s }` | 30 min, 8 h (env bootstrap) | Sign-out after idle time and after the maximum | H16 | now (idle: next request; maximum: next sign-in) |
| `gateway.limits` | Model call safety ceiling | `{ max_provider_calls }` | 1000 (env bootstrap) | Most provider calls a gateway process makes | H17 | now |
| `ops.health` | Health timers | `{ stale_after_ms, snapshot_interval_ms, alert_after_ms, checkpoint_overdue_ms }` | 2 min, 30 s, 60 s, 15 min | Health reads unknown after, readings every, alert after, checkpoint overdue | H22, H23 | now, except the reading interval: at the next core-worker start |
| `codehost.polls` | GitHub poll intervals | `{ fast_ms, hourly_ms, daily_ms }` | 10 min, 1 h, 1 day (env bootstrap) | Heads and installations, protection while work is in flight, protection when idle | H25 | at the next core-worker start |
| `work.request` | Request text limit | `{ max_text_chars }` | 20,000 | A longer request is refused | H26 | now |

### Sandboxes (Settings › Sandboxes)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `sandbox.caps` (existing) | Sandbox limits / Coding sandboxes at once | `{ total, coding, hosts? }` | 4 total, 1 coding | `coding` is now honoured above 1, up to the **hard ceiling of 8** (`CODING_SESSION_HARD_CEILING`): the sandbox-controller, the driver's own gate, core's admission H2 and the plan's 5.6 all follow it. The docker socket proxy's default backstop is the ceiling (`DOCKER_PROXY_CODING_CAP` lowers it per deployment) | H9 | now |
| `sandbox.profiles` | Sandbox limits per kind | record kind to partial limits | `SANDBOX_PROFILES` (the deployment's ceilings) | Lower only: memory, CPU, processes, time, output, scratch per kind | H28 | now (next session) |
| `sandbox.probe` | Test-run sandbox lease | `{ grant_ttl_s }` | 1200 s | The onboarding test run's grant lapses after this | H27 | now |

### Access (People, teams & roles › Roles)

| Key | Plain name | Type | Default | Effect | H | Takes effect |
|---|---|---|---|---|---|---|
| `access.roles` | Roles and what they can do | `{ roles: RoleDef[], grants: record action to grant rules }` | `ROLE_CATALOGUE`, no grant changes (`ACTION_CATALOGUE`) | The roles (slot, view level, data class, where bound) and who holds each action. A proposal **regenerates `pdp.bundle`** in the same revision (`ConfigRegistry.prepare`), so the approver decides both; a document whose bundle is not the one its roles make, or whose bundle does not verify, is refused. The factory admin role stays, privileged | H11 | now (at publish, with the bundle) |

## Not done, and why

| H | What | Why not (yet) |
|---|---|---|
| H11 (part) | The role catalogue outside the PDP | The PDP decisions follow `access.roles` through the regenerated bundle. Code that reads `ROLE_CATALOGUE` directly (identity's binding checks, view levels in the bff, `services/killswitch/src/service.ts:84`'s own policy) still reads the code catalogue; moving them is a follow-up that touches identity and the kill switch (the kill switch has no route to config by design, AR9). |
| H6, H7 (part) | Approval rules pinned per item | `gates.policy` takes effect for approvals opened and decided from the publish on, in every process that follows settings. Pinning it per item through the catalogue needs the gate's open payload to carry its policy row; that is in `packages/decisions`, which the admin-override work is changing now. |
| H22 (part) | `integrationHealthState` in contracts | The contracts helper keeps the 2-minute constant (contracts cannot import the installed value without a cycle); the integrations tiles and the alerts read `ops.health`. |
| H24 (part) | The `aisdlc-evals` CLI | Runs outside the factory with no config reader; its `--floor` flag stays. |
| H29 | Model provider keys and allowed hosts | Owned by the Integrations and Vault squad (secrets are write-only and live in Vault, not in config). |
