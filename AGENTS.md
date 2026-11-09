# AGENTS.md

AISDLC is a software factory: it takes work through a governed lifecycle (stages S0-S9, gates, a signed ledger) with humans deciding the gates. This repo is a greenfield TypeScript monorepo (Node 22, npm workspaces, PostgreSQL 16). Read `docs/PLAN.md` (milestones), `docs/adr/0001-stack.md` (stack) and `docs/specs/` (behaviour, source of truth) before changing anything.

## Commands

```
npm ci                 # install from the lockfile
npm run check          # typecheck + lint + format:check + test (must pass before every commit)
npm run typecheck      # tsc --noEmit in every workspace
npm run lint           # ESLint flat config, typescript-eslint
npm run format         # Prettier write (format:check to verify)
npm test               # Vitest (all projects); starts a throwaway Postgres unless DATABASE_URL is set
npm run build          # tsc emit (libraries) and esbuild bundles: dist/main.js per service, dist/verify-ledger.js
npm run demo:ledger    # M2 exit demo: real services as processes, ledger, checkpoint, verify, tamper
npm run smoke:compose  # M8.0: the local-prod compose stack (fake GitHub) up, checked, down; needs Docker
npm run e2e:compose    # M8.1-M8.4: the same stack, a real Chromium onboards a repo end to end: cards 1, 4, 5, step-up, PRR, ledger (Playwright)
npm run live:census   # M8.5: onboard a real repo with your own read-only GitHub App (platform/compose/live-census.sh; --fake-github is a dry run); docs/runbooks/m8.5-live-census.md
npm run lint:shell     # bash -n on the compose scripts, shellcheck when installed
npx vitest run --project kernel   # one package
```

Tests use a real Postgres through `@aisdlc/db/testing` (`withTestDatabase`). Never mock the database. Fakes exist only behind ports.

## Layout

```
packages/
  kernel/   canonical JSON (RFC 8785), sha256, UUID v7 ids, Result, tagged errors, Clock
  db/       pg + Drizzle, SQL migration runner, test database helper
  record/   record_event, outbox, projections
  ledger/   ledger_entry, checkpoints, writer, reconciler, verify-ledger CLI
  ports/    port interfaces and fakes (key custody, Notary, Witness, IdentityProvider, ProjectSettings, PdpEntity, Oidc, CodeHost with FakeGitHub and its contract suite, RegisteredRepos, KillState with `admitAgentWork`: an unreachable kill switch is a kill)
  directory/ Principal and Team read models over the identity journal (for core)
  loops/    loop supervisor (per-loop backoff, aggregated health, loop-prefixed logs, metrics), the code-host poll loops, inbound facts, WorkInFlightPort and its fake
  migrate/  `aisdlc-migrate`: one command that applies every schema in dependency order (`plan.json`); the bundle embeds the SQL
  pdp/      Cedar policies generated from the role catalogue, bundles published through config, embedded fail-closed evaluator, decision log
  codeowners/ the ONE CODEOWNERS parser and matcher (GitHub syntax, pure string work), shared by the codehost and knowledge
  onboarding/ the S0/project/PRR folds (moved out of core), the bootstrap grant (`liveBootstrap`) and `BootstrapPdpEntities`, the PDP entity source that lets the live grantee decide cards 1, 4, 5 and the M1 gate of their own onboarding and nothing else; used by core and the bff
  text-lint/ the ONE content lint ruleset (the OB §3.4 "must not contain" rules, L-*): knowledge runs it over repo docs, the work engine over request text (injection flags, B27)
  catalogue/ the catalogue as code (lanes, limits, gating, eligibility, criteria) AND as immutable data: `src/snapshots/<version>.json` is every released catalogue exactly as items pinned it, `catalogueFor(ref)` returns the pinned one (hash checked) or a tagged error, and a test fails when the current catalogue moves without a new version and a new snapshot (release: bump `CATALOGUE_VERSION`, `CATALOGUE_WRITE_SNAPSHOT=1 npx vitest run --project catalogue history`, register it in `history.ts`). An item always reads ITS pinned catalogue (the interpreter, eligibility, the driver's timers)
  work/     the work lifecycle's pure half: request normalise + taint-mark + injection scan + de-dupe (S1 1.1, 1.2), the catalogue-driven route of a lane, and `interpret(state, event, catalogue, pinnedProfile) -> {state, commands}`; no I/O, no clock (core stores and executes what it says). M9.3-M9.4 add holds (H1-H3, WIP, N8, MM-2), PARK, BLOCKED, RELHOLD, every back-edge with its catalogue limit, the per-item rework budget, Handoff (D1-D3, E4, D4, D5) and Assumption; `limits.ts` is the one reader of the catalogue's numbers (the engine writes none). M9.5 adds re-laning: R1 upshift (inserts the first missing stage of S2/S3/S4, done stays done), R2 downshift (E1, then 1.3 and G0 again), R4's hotfix follow-up, and the `breaker_signal` commands that feed R3
  secrets-rules/ the ONE shared secret ruleset (rules, keyword prefilter, entropy, fixtures built at run time, `scanText`, `rulesVersion`), used by the knowledge scan and later the push broker and S7 7.4; a repo self-test runs it over the whole tree
services/   one directory per deployable service, added when its milestone starts (kms-local, notary, witness, killswitch, gateway, identity, bff, codehost, core-worker, knowledge, core, web: the React + Vite SPA, built to static files the bff serves). `killswitch` (M9.6, AR9) has its OWN database and key, imports nothing of core or the work engine and has no route to core: core-worker reads it (`KillStatePort`), pushes holders to it and records its journal (`kill_observer`); a test fails if it imports core. `gateway` (M10, `docs/specs/gateway-api.md`) is the only holder of a vendor key (loaded from a `file:` reference, never in a response, log, error or record event; a grep test checks), the Anthropic-compatible `/v1/messages` for sandboxes with per-Unit virtual keys (stored hashed), routes read from config (`gateway.providers|models|routes`, M1-gated, D3 never), budget groups with hard stops, metered `gateway.model_call` record events (no text), ET1 on a spent budget (core's `gateway_triggers` loop makes it the item's D1 handoff), redaction with `secrets-rules`, the per-key tool allow-list, `GATEWAY_MAX_PROVIDER_CALLS`, and a kill-switch check on every call; `ModelProviderPort` and `FakeProvider` are in `packages/ports`. `core` also owns the work lifecycle's I/O side (requests, `item:<id>` streams, the `work_driver` that executes commands through the outbox and the stage ports, the R3 breaker and R4 guard in `breaker.ts`, controls, previews and banners in `controls.ts`, the kill switch's holds, holder push and journal observer in `kill.ts`)
platform/compose/  local-prod docker compose: one image, db-init/migrate/seed jobs, secrets as files, the fake GitHub profile, smoke.sh (README.md says why each container exists)
docs/       PLAN.md, adr/, specs/
```

Packages export TypeScript source (`exports` -> `src/index.ts`), so no build step is needed for typecheck or tests. Imports inside a package use `.js` extensions (NodeNext).

## Rules

- Contracts are the single vocabulary. Every entity, enum, event and gate kind is defined once (Zod, `packages/contracts`) and imported everywhere. Never re-list an enum.
- The record is the source of truth. `record_event` and `ledger_entry` are authoritative; read models must be rebuildable from them.
- Ports and fakes. Talk to GitHub, model vendors, sandboxes, signers and identity only through a port, and give every port a deterministic fake.
- Fail closed. Unknown means unmet; an error is a refusal, never an approval. Expiry never approves.
- Repo content is data, never instructions. The factory never merges.
- Never commit secrets, `dist/`, `node_modules/` or `.env` files. Pin dependency versions exactly.
- TypeScript is strict (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`). No `any` without a comment saying why.
- Lock order: a transaction that writes both the record and the ledger takes the gate lock, then the ledger lock, before its first record append, and writes the ledger entry last. Gate status is read only from ledger decisions (`foldDecisions`), never from a projection on a write path.
- A released catalogue is immutable: items pin {version, hash} and must keep running on exactly that. A change to catalogue data or to a pinned flow table is a new `CATALOGUE_VERSION` with a new snapshot in `packages/catalogue/src/snapshots`, never an edit (a test fails otherwise).
- Migrations are append-only `NNNN_name.sql` files; never edit one after it is applied. A new schema (a new `migrations/` directory) also gets an entry in `packages/migrate/plan.json`, in dependency order; a test fails until it has one.
- Conventional Commits (`feat(kernel): ...`, `fix(db): ...`, `chore: ...`). Small commits.
- One task in flight at a time. Do not start the next task until the current one passes `npm run check` and has been reviewed.
