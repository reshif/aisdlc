# Local-prod compose

The whole factory as it exists after M7, on one machine, from a clean checkout:

```
cd platform/compose
./init-secrets && docker compose --profile fake-github up -d --wait
```

That builds one image, starts 12 long-running containers and 3 one-shot jobs, and returns when every
service is healthy. The `fake-github` profile runs an in-repo stand-in for GitHub with a seeded
testbed repository, so no credential is needed. When it is up:

| What                                                              | Where                                                                                  |
| ----------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| bff (the browser edge)                                            | <http://localhost:8340> (`/api/me`, `/auth/login`)                                     |
| dev identity provider (the browser is redirected here to sign in) | <http://dev-oidc.localhost:8390>                                                       |
| the people the seed knows                                         | `alice` (factory admin, GitHub login `reshif`) and `bob`, picked on the dev IdP's page |
| everything else                                                   | inside the Docker networks only                                                        |

`npm run smoke:compose` (or `platform/compose/smoke.sh`) does all of this, proves the services talk
and the boundaries hold, prints the fake GitHub's request log, and removes everything again.
`docker compose --profile fake-github down -v` removes the stack and its volumes.

Needs Docker with Compose v2 (tested on Docker 29, Compose 5) and `openssl`. The first build takes a
few minutes (`npm ci` and `npm run build` inside the image).

## One image, many services

`Dockerfile` builds every bundle in a builder stage and copies only `dist/`, each service's
`migrations/` and the Cedar wasm into a `node:22.23.4-bookworm-slim` runtime (pinned by digest) with
`git` (codehost and knowledge run it) and a non-root user (uid 10001). Each service is that image
with a different `command` and environment (RV §5.2, "image x config"); there is no per-service
image because none has a different dependency set worth a second build. Containers run read-only,
with all capabilities dropped, `no-new-privileges`, an init process, a memory limit, a restart
policy and a `/healthz` health check (the dev IdP's is its discovery document). No container
mounts the Docker socket, except the two allow-list proxies of the optional `sandbox` profile (below); the smoke test checks it.

`migrate` builds the image and runs `aisdlc-migrate --notary --witness --killswitch` first, after `db-init` has
created the roles and databases; every other service waits for it (`service_completed_successfully`).
`seed` runs next (see below), then the services in dependency order.

## Why each container is a container

RV §2: a boundary is real when it separates **K**ey custody, a **D**ocker or socket right, network
**E**gress, an **I**ndependence requirement (AR9 and its kin), or an untrusted **O**rigin. No
container here needs a Docker right (sandboxes arrive with M13).

| Container                    | Port               | Published          | Networks                                                                                | Boundary      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------- | ------------------ | ------------------ | --------------------------------------------------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`                   | 5432               | no                 | data-\*                                                                                 | I             | record vs key-holder databases: one server here, four databases and four roles (`aisdlc`, `notary`, `witness`, `killswitch`); a role cannot connect to another's database                                                                                                                                                                                                                                                                                                   |
| `kms-local`                  | 8300               | no                 | kms-\*                                                                                  | K             | the only holder of the Notary, Witness, step-up and fingerprint keys; signs by key id, never hands one out                                                                                                                                                                                                                                                                                                                                                                  |
| `notary`                     | 8310               | no                 | kms-notary, notary-api, data-notary                                                     | K, I          | the only ledger signer (C08n); own database and role                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `witness`                    | 8320               | no                 | kms-witness, witness-api, data-witness                                                  | K, I          | the second signer (C33); own key, database and role, no route to the Notary                                                                                                                                                                                                                                                                                                                                                                                                 |
| `killswitch`                 | 8400               | no                 | kms-killswitch, killswitch-api, data-killswitch                                         | K, I          | the kill switch (AR9): own database, role and key (`dev:killswitch`), no dependency on core, no route to core's write or command APIs; core-worker reads and pushes to it                                                                                                                                                                                                                                                                                                   |
| `gateway`                    | 8410               | no                 | data-gateway, gateway-api, killswitch-gateway, gateway-egress                           | K, E          | the model gateway (M10): the only holder of a vendor key (`anthropic-api-key`, mounted nowhere else), routes by (environment, data class) from published config, builds its provider adapters from the integration registry's rows (reload without a restart), meters every call as a record event, holds the per-Unit virtual keys, budgets, redaction and tool allow-list, asks the kill switch before every call; no route to kms-local, the Notary, the Witness or core |
| `identity`                   | 8330               | no                 | app, data-record, kms-clients, notary-api                                               | I             | policy source and its journal are not shared with the systems it polices (AR2); PDP evaluation is embedded in core and the bff                                                                                                                                                                                                                                                                                                                                              |
| `bff`                        | 8340               | **yes**, 127.0.0.1 | edge, data-record, kms-clients                                                          | O, K          | the browser edge: tokens never reach the browser, session store and the IdP client secret stay out of core; signs step-up proofs through kms-local                                                                                                                                                                                                                                                                                                                          |
| `dev-oidc`                   | 8390               | **yes**, 127.0.0.1 | edge                                                                                    | O             | the stand-in identity provider, a different party the browser is redirected to; `FACTORY_ENV=local` only                                                                                                                                                                                                                                                                                                                                                                    |
| `codehost`                   | 8350               | no                 | app, egress                                                                             | K, E          | the only holder of the GitHub App key (mounted nowhere else) and the only container with a route out; reads only                                                                                                                                                                                                                                                                                                                                                            |
| `knowledge`                  | 8370               | no                 | app, data-record, kms-clients                                                           | O, E          | analyses untrusted repo content; holds no code-host credential, no HMAC key, and **has no route to GitHub**: it gets credential-free bundles from the codehost                                                                                                                                                                                                                                                                                                              |
| `core`                       | 8380               | no                 | app, data-record, kms-clients, notary-api                                               | none          | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `core-worker`                | 8360               | no                 | app, data-record, kms-clients, notary-api, witness-api, killswitch-api, objectstore-api | none          | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `object-store`               | 9000               | no                 | objectstore-api                                                                         | I             | S3-compatible store for large content (M14.1; Evidence Packs from M14.4): MinIO, root credentials as secret files, the adapter creates the buckets (write-once ones with Object Lock); core-worker is its one caller (M14.4: 7.6's signed Evidence Packs in the write-once bucket `evidence-packs`, a D2's Handoff Pack beside them), and it has no route out                                                                                                               |
| `fake-github`                | 8353 api, 8354 git | no                 | (codehost's own)                                                                        | stand-in      | not part of the factory: the far end of the codehost's egress; profile `fake-github`                                                                                                                                                                                                                                                                                                                                                                                        |
| `db-init`, `migrate`, `seed` | none               | no                 | data-\* (and app, kms, notary for `seed`)                                               | one-shot jobs | roles and databases; schemas; first-run bootstrap                                                                                                                                                                                                                                                                                                                                                                                                                           |

`core` and `core-worker` do **not** separate a key, an egress, an independence requirement or an
origin. They are two containers because PLAN §5 keeps the API and the one process that hosts every
loop apart (an API that keeps answering while a loop restarts, loops that never take a request). That
is a deploy choice, not a boundary: they could run as one process, and the boundary check says so
rather than inventing a reason.

### Networks

Docker has no packet filter inside a network, so a network is the unit of "can reach". The cuts below
make the forbidden paths not exist; between services that legitimately share a network only a token
and its scopes stand in the way.

| Network                                                             | Members                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge`                                                              | bff, dev-oidc                                                                 | the only network with published ports; not internal because a published port needs a route in                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `app` (internal)                                                    | core, core-worker, identity, knowledge, codehost, seed                        | the service-to-service calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `data-record` (internal)                                            | postgres, db-init, migrate, bff, core, core-worker, identity, knowledge, seed | the record database. The record services share it, so they can reach each other's ports; each API still demands its own token                                                                                                                                                                                                                                                                                                                                                                                                   |
| `data-notary`, `data-witness` (internal)                            | postgres and the Notary / the Witness                                         | the key holders' databases, on networks no record service joins                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `kms-notary`, `kms-witness` (internal)                              | kms-local and the Notary / the Witness                                        | the signers' route to their key: **the Notary and the Witness have no route to each other** (AR9, C33)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `kms-clients` (internal)                                            | kms-local, bff, core, core-worker, identity, knowledge, seed                  | public-key lookups, step-up signing (bff) and the fingerprint MAC (knowledge)                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `notary-api` (internal)                                             | notary, core, core-worker, identity, seed                                     | the ledger's writers. Knowledge, codehost, bff and the dev IdP are not on it                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `witness-api` (internal)                                            | witness, core-worker                                                          | the checkpointer's route (core-worker's `checkpointer` loop is the Witness's one caller)                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `data-killswitch`, `kms-killswitch`, `killswitch-api` (internal)    | postgres / kms-local / core-worker and the kill switch                        | the kill switch's own database, signer link and API. **Core, the Notary, the codehost and the bff are not on `killswitch-api`** (core-worker is, because it reads and pushes; it has no write or command API), and the kill switch is on none of theirs                                                                                                                                                                                                                                                                         |
| `egress`                                                            | codehost                                                                      | the only way out. **Knowledge is on no network with a route out**, so it cannot reach GitHub                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `gateway-api` (internal)                                            | gateway                                                                       | the gateway's HTTP surface. Nobody is on it yet: core (key minting, M11) and the sandboxes (M13) attach here and to no other network of the gateway                                                                                                                                                                                                                                                                                                                                                                             |
| `data-gateway` (internal)                                           | postgres, gateway                                                             | the gateway's own route to Postgres (the record database, as its own least-privilege role `gateway`). It is NOT on `data-record`, so it cannot reach identity, core or the bff there                                                                                                                                                                                                                                                                                                                                            |
| `killswitch-gateway` (internal)                                     | killswitch, gateway                                                           | the one link the gateway has into the trust plane: the kill switch's read API, asked before every call                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `gateway-egress`                                                    | gateway                                                                       | the gateway's own way out (the model vendor's API). Nobody else is on it. Docker cannot filter by host: the cloud target is a security group or egress proxy that allows `api.anthropic.com` only                                                                                                                                                                                                                                                                                                                               |
| `sandbox-controller-api`, `data-sandbox-controller` (internal)      | core-worker / postgres and the sandbox-controller                             | how core-worker asks the controller for a session and its free slots; the controller's own route to Postgres (as its role `sandbox_controller`), not `data-record`                                                                                                                                                                                                                                                                                                                                                              |
| `verify-api`, `data-verify`, `verify-codehost` (internal)           | core-worker / postgres / codehost and verify                                  | how core-worker asks the verify service for a step's check; verify's own route to Postgres (as its role `verify`), not `data-record`; its one link to the codehost (the bundle route). verify also joins `sandbox-controller-api` and `gateway-api`                                                                                                                                                                                                                                                                             |
| `objectstore-api` (internal)                                        | core-worker and object-store                                                  | where 7.6 stores the signed Evidence Packs (M14.4: the S3 adapter with the store's credentials as `file:` references; the Notary signs the pack through its `evidence` scope, which only core-worker holds). Nothing else is on it, and the store has no other network                                                                                                                                                                                                                                                          |
| `data-gatecheck`, `gatecheck-github` (internal), `gatecheck-egress` | postgres / codehost (the fake GitHub's door) and gate-check                   | gate-check's own route to Postgres (as its role `gate_check`: its tables and `gatecheck:` streams, read-only the ledger, the bypass list's config view and four core read models), its own way out to GitHub (its App is not the codehost's, so the codehost's `egress` is not shared), and, in the fake profile, the fake GitHub's port 8355 in the codehost's namespace (gate-check has no codehost token). gate-check also joins `kms-clients` (the Notary's public key) and `objectstore-api` (the signed packs, read only) |
| `data-gaterelay`, `gaterelay-github` (internal), `gaterelay-egress` | postgres / codehost (the fake GitHub's door) and gate-relay                   | gate-relay's own route to Postgres (as its role `gate_relay`: its tables and `gaterelay:` streams, read-only the `gate:` streams, the ledger, the release setting's config view, `core.evidence_pack` and `gatecheck.merge`), its own way out to GitHub (its App is neither the codehost's nor gate-check's) and, in the fake profile, the fake GitHub's port 8356 in the codehost's namespace. gate-relay also joins `kms-clients` (the Notary's public key) and `objectstore-api` (the signed packs, read only)               |

The `fake-github` container joins the codehost's network namespace (`network_mode: service:codehost`)
because the codehost accepts a plain-http GitHub only on loopback (it carries credentials), so the
fake listens on the codehost's `127.0.0.1:8353` (REST) and `:8354` (git) and is reachable from nowhere
else. The smoke test asserts the paths above that must not exist (knowledge to GitHub and the Notary,
the codehost to the trust plane and postgres, the Notary and the Witness to each other, ...).

## The integration registry, the gateway's role and the codehost's row (M10 follow-ups, M10.4)

The GitHub App and the model providers are rows of one integration registry (`integrations.registry`, published
through an M1 gate; the seed publishes the first rows: `fake`, `anthropic`, `github-app`). The rows carry key
**references**; the keys stay in their own files. The `codehost` runs in registry mode
(`CODEHOST_REGISTRY_INTEGRATION=github-app`): it reads its row from core, follows it by revision (5 s here) or on
`POST /v1/admin/reload` (token `tok-operator-codehost`), and refuses a row that names a key file or host that
its own `CODEHOST_SECRET_REFS` / `CODEHOST_EGRESS_HOSTS` do not list. The gateway does the same
(`GATEWAY_SECRET_REFS`, `GATEWAY_EGRESS_HOSTS`, `POST /v1/admin/reload`). Both report health per integration; core
serves the tiles (`GET /v1/integrations/health`, scope `portal`) and the events (`/v1/integrations/events`).

The gateway connects to the record database as the login role `gateway` (db-init creates it and the group role
`aisdlc_gateway`; the gateway migration grants it its own tables, INSERT and SELECT of its own `gateway:` record
streams, and the effective-config view, nothing else). It no longer migrates: `aisdlc-migrate` does.

## The model gateway (M10)

`gateway` is the only container that holds a model-vendor key (RV §2). The key is the file
`secrets/anthropic-api-key`, a compose secret that only `gateway` lists (a test reads this file and
fails if another service does, and `smoke.sh` checks the running containers: no other container can
read it, and it is in no environment and no log). `./init-secrets` writes a placeholder
(`.anthropic-key-placeholder`) that no vendor accepts; give it a real key with
`ANTHROPIC_API_KEY=... ./init-secrets` (it replaces a placeholder, never a real key unless `--rotate`).

Routes are config: the seed publishes, through the same M1 gate as the policy bundle, a local table
that routes D0-D2 in `local` to the deterministic fake provider and registers the Anthropic provider
and models unrouted. Pointing a route at Claude is a later gated revision; D3 has no route and the
registry cannot hold one. The gateway shares the record database (it appends `gateway.*` events:
ModelCall, ET1, key minted/revoked, and reads config), so it is on `data-gateway` (postgres is the only other member: it does not share `data-record` with core, identity and the bff); that, and its
egress, are why it has no route to kms-local, the Notary, the Witness or core. core-worker's
`gateway_triggers` loop turns a spent budget (ET1) into the item's D1 handoff. The HTTP contract is
`docs/specs/gateway-api.md`.

`GATEWAY_MAX_PROVIDER_CALLS` (default 1000) is the per-process hard ceiling on vendor calls.

## The kill switch (M9.6)

`killswitch` is a service of its own because AR9 asks that a kill needs nothing of core's. It has its
own database (`killswitch`, role `killswitch`), its own key (`dev:killswitch`, which kms-local lets no
other caller use), its own network, and **no token and no URL of core's**: it has no route to core's
write or command APIs, and it does not call anything but its signer. Who may kill is decided by the same
Cedar policies as everywhere (`kill.request`, `kill.release`, the fleet rule), over the kill switch's own
copy of who holds what: the factory admins are its configuration (`KILLSWITCH_FACTORY_ADMINS`), the
project admins and kill holders are PUSHED to it by core-worker's `kill_holders` loop, and delegations
are granted in it by the project admin. Every kill, release approval, release, delegation and holder
sync is an entry of its own signed, hash-chained journal.

How a kill reaches core's record without the kill switch calling core: core-worker's `kill_observer`
loop PULLS the journal, verifies the chain and every signature against the kill switch's public key
(looked up in kms-local, never taken from the kill switch's own answer), and records each entry as a
`kill.observed` fact and a `kill.event` ledger entry through the Notary. The work driver reads
`/v1/status` before it dispatches a stage command: a killed scope, or a kill switch that cannot be
reached, defers the command (it waits untouched, nothing is retried to death) and puts a `kill` hold
on the items. Humans can still decide gates. `GET /admission` on core-worker (internal network) shows
the verdict it would give a scope; `smoke.sh` uses it.

Stopping never waits for the KMS: a kill (any scope) takes effect at once even if kms-local is unreachable. It is journaled as an unsigned `pending_signature` entry (still hash-chained), and a backfill loop appends a signed `kill.signature_attested` entry that names it when the KMS is back; core-worker records the pending kill as `kill.observed` immediately and ledgers it when the attestation is observed. A release, a delegation and a holder sync widen rights, so they still need the signature (and a release the two-person rule) and are refused while the KMS is down.

The operator token (`tok-operator-killswitch`, scopes `act`, `read`) is how a person reaches the kill
switch when core is down; the BFF does not carry kill routes yet.

## Secrets are files

`./init-secrets` creates `secrets/` (git-ignored but for its README), mode 0600, owned by the uid the
containers run as. It generates one token per (caller, callee) pair, the Postgres passwords and the
database URLs built from them, the bff's OIDC client secret, and a throwaway GitHub App key. Each
service mounts only its own files at `/run/secrets/<name>` and reads them through `file:` references;
there are no secrets in environment variables or in the image. The bff keeps sessions in the
database, so it has no cookie signing key. Running it again changes nothing; `--rotate` makes new
tokens and passwords (down -v first). See `secrets/README.md` for who mounts what.

The files are read through a bind mount, so the containers must run as their owner:
`init-secrets` writes `AISDLC_UID`/`AISDLC_GID` into `.env` (your own uid; 10001 when run as root).

## First run: the seed

A new factory denies every decision (no policy bundle) and nobody holds any role, yet the bundle
can only be published through an M1 gate. `seed` (`aisdlc-seed`, built from `services/core`) breaks
that circle once, in the open, and refuses unless `FACTORY_ENV=local`: it syncs the dev IdP's people
into identity, makes `alice` a `factory.admin` through identity's own API (journal events), and
proposes, decides (as alice, a real Notary-signed ledger entry) and publishes the policy bundle.
What is not real is who clicked: its eligibility names alice as the only admin of the `factory`
pseudo-project and its step-up refuses everything, so a gate that needed a step-up would fail the
seed, not pass it. It is the local stub of "the first admin is provisioned with the cloud account"
and is idempotent. This is a design decision for you to confirm (see the report).

## What the stack proves

With the fake GitHub, `smoke.sh` has alice (the factory admin from the seed) ask core to onboard
`reshif/asf-factory-testbed`; step 0.1 then runs codehost -> knowledge -> census until the S0 record
waits at `card` with card 1 required, and core-worker's cards loop opens it by itself (Notary,
codehost reads and knowledge scopes `census` and `security` wired, bootstrap decider on, so alice
may decide it as the project's provisional admin). Core verifies step-up proofs with
`SignedStepUp`, with the public key of the bff's `dev:bff-stepup` key from kms-local (core never
signs). `docker compose logs fake-github` is the request log: GETs on resources, plus the App's
token mint and `git-upload-pack` fetches, never a push.

## Using a real GitHub App

(`live-census.sh` does all of this for you, see "The first live exit" below; the manual steps are:)

1. Create the App with read-only permissions (contents, metadata) and install it on the repo (OB §5.5).
2. Put its private key at `secrets/github-app.pem` (replacing the throwaway) and run
   `GITHUB_APP_ID=<id> GITHUB_INSTALLATION_ID=<id> ./init-secrets --real-github`. This rewrites `.env`
   (App id, installation id, and empty GitHub URLs, so the codehost uses api.github.com and github.com).
3. `docker compose up -d --wait` **without** `--profile fake-github`. The codehost is the only
   container that reaches out, and the only one that mounts the key.
4. Allow-list and onboard the repo through core as before (the registered repos come from core).

The dev IdP and the seed stay: the people who may sign in are still `alice` and `bob`. Set the
GitHub login of the person who owns the repo in `config/idp-seed.json` (alice's `logins`).

The default image build installs `git` with apt only when the base image has none: `git=1:2.39.*`
(the bookworm line, security fixes included; `--build-arg GIT_APT_VERSION=...` pins an exact version),
`--no-install-recommends`, `ca-certificates`, the apt lists removed in the same layer, and
`git --version` as the proof. That path cannot be run in a sandbox without apt; it runs on your machine
at M8.5.

Behind an egress allow-list or a TLS-inspecting proxy the image build may not reach apt or the npm
registry. Build the image yourself (the Dockerfile skips apt when `git` is already there) and let
compose use it:

```
docker build --network=host --secret id=extra_ca,src=/path/ca.pem --build-arg HTTPS_PROXY=... \
  --build-arg RUNTIME_IMAGE=<a node:22 bookworm-slim image that has git> \
  -f platform/compose/Dockerfile -t aisdlc/factory:local .
SMOKE_SKIP_BUILD=1 npm run smoke:compose      # or: docker compose up -d --wait (it uses the image)
```

## The planning agents (M12)

`core-worker` can run the work driver with the real planning port (S1 to S5): `CORE_WORKER_STAGE_PORTS=agents`
(default `none`; `e2e.sh` sets `agents`). It calls the model gateway with its own admin token
(`tok-core-worker-gateway`, mounted only in `core-worker` and `gateway`) to mint each run's key, and reads
knowledge with the `search` scope its token carries (the `KnowledgeSearch` tool). The seed registers the local
fake provider with `fixtures: planning`: it answers each planning step with one canned valid output (no model, no
key), so a local stack can run a request through the real port, the gateway and the gates. A Census project
cannot run L4 (OB §2.1 routes it to L8), so `e2e.sh` asks for L4, has the browser answer a clarification question
if the scripted fake asks one (it does not today) and decide Ready (1.6) on `/items/:id` (M12.5), and checks the
item stays on L8 and goes on to its gates; the L4 path to the plan approval is covered by `services/core` tests over the
same fixtures.

## The ledger loops (M8.0b)

core-worker runs two more loops when it has the Notary and the Witness (`CORE_WORKER_WITNESS_URL`,
`CORE_WORKER_WITNESS_TOKEN_REF`, the `tok-core-worker-witness` secret, mounted only there and in the
Witness): `ledger_reconciler` (every `CORE_WORKER_RECONCILE_INTERVAL_MS`, 60 s) finishes what a crashed
writer left, and `checkpointer` (the Notary gives core-worker the `checkpoint` scope for it) (every `CORE_WORKER_CHECKPOINT_INTERVAL_MS`, **5 min**) has the Notary
sign a tree head and the Witness co-sign it. Compose reads the interval from `CHECKPOINT_INTERVAL_MS`;
`smoke.sh`, `e2e.sh` and the live dry run set 15 s. `verify-ledger.sh [--wait S]` waits for a checkpoint
that covers the ledger head, then runs the bundled `verify-ledger` inside core-worker against the record
database with the Notary's and the Witness's public keys fetched from kms-local (read-only, nothing
written). `smoke.sh` runs it and it must pass.

## The first live exit (M8.5)

`live-census.sh` (`npm run live:census`) is the kit for onboarding a real repository with a real
read-only App on your own machine: it checks the prerequisites (docker, compose, the key at
`secrets/github-app.pem` with mode 0600, the App and installation ids), runs
`init-secrets --real-github`, builds the image the default way, starts the stack **without** the
`fake-github` profile and tells you where to sign in. `--wait-for-prr` waits for the readiness record;
`--report` prints the codehost's request log to GitHub grouped by method and path template (asserting
GETs on resources, the token mint listed apart, git fetches read-only), the installation's permissions
(asserting `statuses` is absent), the S0 status, the PRR status, level and `record_hash`, and a
`verify-ledger` run; `--down [--purge]` tears down. `--fake-github` is a dry run of every step but GitHub.
The codehost writes the log as one JSON line per request (`codehost: ghreq {...}`: method, path
template, status, role; no token, no header, no query values). The step-by-step guide for the person
running it is `docs/runbooks/m8.5-live-census.md`.

## What local-prod stubs, and the cloud target (RV §7)

| Piece                         | Here                                                                                                                                | Cloud target                                                   |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| Record and ledger database    | one Postgres container, three databases and roles; one owner role (`aisdlc`, with CREATEROLE) migrates and runs the record services | Aurora Multi-AZ, IAM auth, separate migrator and service roles |
| Key custody                   | `kms-local` (`dev:` keys, refuses unless `FACTORY_ENV=local`)                                                                       | AWS KMS asymmetric; Notary and Witness in separate accounts    |
| Identity provider             | `dev-oidc` plus the seed file (`alice`, `bob`)                                                                                      | Entra                                                          |
| First admin and policy bundle | `seed`, local only                                                                                                                  | provisioned with the account, bundle through the real M1 gate  |
| Code host                     | `codehost` plus the fake GitHub, or a real non-prod App                                                                             | `codehost-core` on ECS, App keys in KMS                        |
| Browser edge                  | bff on `localhost`, plain http, secure cookies off                                                                                  | CloudFront, WAF, Verified Access, TLS                          |
| Network separation            | Docker networks (reach, not packet filtering)                                                                                       | accounts, VPCs, security groups                                |
| Secrets                       | files in `secrets/`, bind-mounted                                                                                                   | Secrets Manager                                                |
| Core and core-worker          | two containers                                                                                                                      | ECS services, same images                                      |
| Not here yet                  | sandbox pieces, audit services                                                                                                      | later milestones                                               |

## The portal (M8.1 to M8.4)

The bff serves the web bundle (`services/web`, built inside the image to `/app/services/web/dist`,
`BFF_WEB_DIR`) on its own origin with `default-src 'self'` and `frame-ancestors 'none'`, and is the
only API the browser calls: `/api/projects`, `/api/onboard`, `/api/s0/...`, `/api/cards/...`. Each
route asks the PDP for the signed-in principal, then calls core (`BFF_CORE_URL`) with the bff's own
token (`tok-bff-core`, scopes `read`, `onboard`, `portal`, `work`); core gets the principal as `on_behalf_of`
from the session, never a browser cookie or token, and asks the PDP again for every write.
`/auth/login` and the step-up start are rate limited (token buckets, 429 with `Retry-After`).
`npm run e2e:compose` (`e2e.sh`) runs the whole Census onboarding of the fixture repo in Chromium as
alice (see below), checks accessibility and the strict CSP on every page, and checks the fake
GitHub's request log afterwards.

### Deciding in the portal (M8.3, M8.4)

More bff routes, all behind the same session, CSRF and PDP checks: `GET /api/inbox` (what waits for
the person, split into what they decide and what they only see, with who decides),
`GET /api/s0/:id/revision` and `/api/revisions/:gate` with `prepare`, `evidence`, `decide` and
`publish` (the M1 gate that publishes card 4's role map, decided by the admin slot), the card moves
(`/api/cards/:id/prepare|evidence|decide|recheck`, a card 5 decision carries the step-up proof from
`/api/step-up`), `GET /api/projects/:id/prr` (`project.view`) and `GET /api/projects/:id/ledger`
(`audit.read`, optionally `?s0=`).

The first onboarding of a project has no role map, so nobody holds any slot. The requester is its
provisional admin (M7.4). The PDP sees that too: `BootstrapPdpEntities` (in `@aisdlc/onboarding`,
wrapped around identity's entity source in core and in the bff) gives the live grantee the project
admin role for one request at a time, and only `card.decide` on cards 1, 4 and 5 of the record that
holds the grant and `gate.decide` on the M1 gate over a config revision. Never the security card,
M4, another project or anything else, and it ends the moment card 4's revision is published.

The e2e flow: alice requests the onboarding, decides card 1 (gaps, T0, regulatory, criticality),
card 4 (attestations, role map with alice in `admin` and `m4`, two-person off at T0), then the
settings revision card 4 proposed (a "Settings revision pending" page: card 5 cannot open until the
role map is published and identity has bound it), then card 5 after a step-up re-login at the dev IdP
bound to the record hash. The readiness record page and the ledger page then show the result.
Screenshots (deviceScaleFactor 2) are in `docs/screenshots/`.

Not done yet and visible here: the cards C2 and C3 (Light and Full) have no Decide screen because core has no card for them yet.

## The sandbox plane (profile `sandbox`, M13.2)

`docker compose --profile sandbox up -d --wait` adds five containers; `smoke.sh` always runs with them.

| Container             | Port | Networks                                                                      | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---- | ----------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `docker-proxy-cvw`    | 2375 | docker-cvw                                                                    | D        | allow-list in front of the Docker socket for the CVW: network-less sandboxes only. The ONLY kind of container that mounts the socket                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `docker-proxy-coding` | 2375 | docker-coding                                                                 | D        | the same list plus per-session internal networks and the attach of the gateway and the mirror, for the coding worker. Still no exec, build, pull, volume, privileged, host namespace, device, added capability, or bind mount other than the session's read-only repo copy; one coding session                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `package-mirror`      | 8420 | sandbox-mirror                                                                | E        | the one peer (with the gateway) a sandbox network has: read-only, no upstream, fixture directory `services/package-mirror/fixtures` (empty until DEC-17)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `sandbox-controller`  | 8430 | data-sandbox-controller, sandbox-controller-api, docker-coding                | D, I     | placement (M14.2, ADR-0003 §6-7): the ONLY client of the coding proxy (it holds that token; core-worker does not), owns the driver, the class ceilings and the two caps of the runner host (`sandbox.caps`, M1-gated: total 4, coding 1), starts only a session whose grant core recorded as active, answers `busy` over a cap (core's admission waits; it never queues) and reports the free slots H2 reads. State in memory only (disposable). Its own database role: the published-config view and `core.admission_grant`, nothing else. core-worker reaches it with `CORE_WORKER_SANDBOX_CONTROLLER_URL=http://sandbox-controller:8430`                                                                                       |
| `verify`              | 8440 | data-verify, verify-api, verify-codehost, sandbox-controller-api, gateway-api | O, I     | S7's checks 7.1 to 7.5 (M14.3, ADR-0003 §1 Control plane, the plan's `cvw`; `docs/specs/verify-api.md`): it reads untrusted repo content (the base and the Unit head, from the codehost's bundle route) and has its kits run untrusted repo code in O sessions the sandbox-controller places under the item's grant (no key, the mirror only); a load that spikes when items reach S7. It holds no vendor key, no code-host credential and no Docker right; the A5 reviewer of 7.3 and 7.5 is one gateway call under the run's own key, lent for that call and never recorded. Its own database role: its own table and its own `verify:` record streams. core-worker reaches it with `CORE_WORKER_VERIFY_URL=http://verify:8440` |

## gate-check (profile `gate-check`, M14.5)

`docker compose --profile fake-github --profile gate-check up -d --wait` adds it (against the fake GitHub, whose
second App is gate-check's: `FAKE_GITHUB_CHECKS_APP_ID`, the key `secrets/gate-check-app.pem` that `init-secrets` makes
when there is none). The live run needs the user's own narrow App (`checks: write`, pull requests read), its id and
installation in `.env` and its key at `secrets/gate-check-app.pem`; it is never the codehost's App.

| Container    | Port | Networks                                                                         | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ---- | -------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate-check` | 8450 | data-gatecheck, kms-clients, objectstore-api, gatecheck-github, gatecheck-egress | K, E, I  | the check run `aisdlc/gate` on every PR (ADR-0003 §1 Integration plane, `docs/specs/gate-check-api.md`): a key (its own App, `checks: write`; in codehost, one leak would give both powers), and the gate plane's independence (AR9: no route to core's write or command APIs, so a core outage cannot pass or block a merge by itself; it reads the record as its own role). It verifies each signed Evidence Pack itself with the Notary's public key, never merges, and records every merge (bypass and unauthorised merges get core's X4 review) |

## gate-relay (profile `gate-relay`, M15.3)

`docker compose --profile fake-github --profile gate-relay up -d --wait` adds it (against the fake GitHub, whose third
App is gate-relay's: `FAKE_GITHUB_DEPLOY_APP_ID`, the key `secrets/gate-relay-app.pem` that `init-secrets` makes when
there is none). The live run needs the user's own narrow App (`deployments: write`, metadata read), its id and
installation in `.env` and its key at `secrets/gate-relay-app.pem`; it is never the codehost's or gate-check's App. Core
follows it when core-worker has `CORE_WORKER_RELEASE=gate-relay`.

| Container    | Port | Networks                                                                         | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---- | -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate-relay` | 8460 | data-gaterelay, kms-clients, objectstore-api, gaterelay-github, gaterelay-egress | K, E, I  | G5 release (ADR-0003 §1 Integration plane, `docs/specs/gate-relay-api.md`): a key (its own App, `deployments: write`; in codehost or gate-check, one leak would give two powers), and the gate plane's independence (AR9: no route to core's write or command APIs; it reads the record as its own role). It consumes an approved G5 exactly once into a deployment of the merged commit only when the card's binding holds again here (gate-check's gated merge of the pack's head, the pack verified with the Notary's public key), and rolls an unhealthy release back (B16). It never merges or writes a status |

The proxies run as the factory uid with the socket's group added (`DOCKER_GID`, default 0; `smoke.sh` sets it from `stat`). They need the sandbox image (`docker build -t aisdlc/sandbox:local platform/sandbox`, nothing is fetched: the pinned node base is local) and a scratch directory the sandbox driver writes read-only repo copies to (`SANDBOX_SCRATCH`, default `/var/lib/aisdlc/sandbox-scratch`; the same path in the client and for the daemon). The gateway and the mirror carry the label `aisdlc.sandbox.peer` and a fixed container name so the coding proxy may attach them to a session network under their fixed aliases (`gateway`, `package-mirror`). `sandbox-smoke` (profile `sandbox-smoke`) is the smoke client: one K session and one K-exec session through the coding proxy, then the refusals (a create body with `Privileged=true`, host network, host PID, an added capability, the socket as a bind, a root user, exec, build, pull). The hostile-probe evidence is `docs/evidence/sec-ob-3.md`; the design is `docs/adr/0002-sandbox-container-class.md`.
