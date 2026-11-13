# Local-prod compose

The whole factory as it exists after M7, on one machine, from a clean checkout:

```
cd platform/compose
./init-secrets && docker compose --profile fake-github up -d --wait
```

That builds one image, starts 12 long-running containers and 3 one-shot jobs, and returns when every
service is healthy. The `fake-github` profile runs an in-repo stand-in for GitHub with a seeded
testbed repository, so no credential is needed. When it is up:

| What                                                              | Where                                                                                                                                                                                      |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| bff (the browser edge)                                            | <http://localhost:8340> (`/api/me`, `/auth/login`)                                                                                                                                         |
| dev identity provider (the browser is redirected here to sign in) | <http://dev-oidc.localhost:8390>                                                                                                                                                           |
| the people the seed knows                                         | `alice` (factory admin, GitHub login `reshif`) and `bob`, then the eleven design personas (`lt`, `oh`, `rb`, `ar`, `pm`, `dn`, `ks`, `jm`, `mw`, `nf`, `tb`), picked on the dev IdP's page |
| everything else                                                   | inside the Docker networks only                                                                                                                                                            |

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

`volume-init` (`volume-init.sh`) runs before every service that writes a named volume (kms-local `/kms`, codehost,
knowledge and core-worker `/work`, the object store `/data`) and gives each volume to `AISDLC_UID:AISDLC_GID`, mode
0700 (file modes are kept: a key file stays 0600). A fresh named volume takes the owner of the image directory at
its mount point (10001 in the factory image, root in MinIO's), so without it a stack started by any uid but 10001 (a
normal user, a CI runner) fails with `EACCES` (kms-local: `open '/kms/dev_notary.key.json'`); a restored backup keeps
the numeric owners of the stack it came from, which is the same problem. It is the one container that runs as root:
the postgres image already pulled, no network, a read-only root, no secret, and only `CHOWN`, `FOWNER` (the chmod)
and `DAC_READ_SEARCH` (to walk a restored volume's 0700 directories). The scratch directory of the sandbox profile
is a bind mount, not a volume: `smoke.sh`, `e2e-pr.sh` and `e2e.sh` create it with `mktemp` and mode 1777, and a
stack of your own needs the same (docs/getting-started.md).
`seed` runs next (see below), then the services in dependency order.

## Why each container is a container

RV §2: a boundary is real when it separates **K**ey custody, a **D**ocker or socket right, network
**E**gress, an **I**ndependence requirement (AR9 and its kin), or an untrusted **O**rigin. No
container here needs a Docker right (sandboxes arrive with M13).

| Container                                   | Port               | Published          | Networks                                                                                                                                   | Boundary      | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | ------------------ | ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `postgres`                                  | 5432               | no                 | data-\*                                                                                                                                    | I             | record vs key-holder databases: one server here, four databases and four roles (`aisdlc`, `notary`, `witness`, `killswitch`); a role cannot connect to another's database                                                                                                                                                                                                                                                                                                   |
| `kms-local`                                 | 8300               | no                 | kms-\*                                                                                                                                     | K             | the only holder of the Notary, Witness, step-up and fingerprint keys; signs by key id, never hands one out                                                                                                                                                                                                                                                                                                                                                                  |
| `notary`                                    | 8310               | no                 | kms-notary, notary-api, data-notary                                                                                                        | K, I          | the only ledger signer (C08n); own database and role                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `witness`                                   | 8320               | no                 | kms-witness, witness-api, data-witness                                                                                                     | K, I          | the second signer (C33); own key, database and role, no route to the Notary                                                                                                                                                                                                                                                                                                                                                                                                 |
| `killswitch`                                | 8400               | no                 | kms-killswitch, killswitch-api, killswitch-bff, data-killswitch                                                                            | K, I          | the kill switch (AR9): own database, role and key (`dev:killswitch`), no dependency on core, no route to core's write or command APIs; core-worker reads and pushes to it                                                                                                                                                                                                                                                                                                   |
| `gateway`                                   | 8410               | no                 | data-gateway, gateway-api, killswitch-gateway, gateway-egress, gateway-bff                                                                 | K, E          | the model gateway (M10): the only holder of a vendor key (`anthropic-api-key`, mounted nowhere else), routes by (environment, data class) from published config, builds its provider adapters from the integration registry's rows (reload without a restart), meters every call as a record event, holds the per-Unit virtual keys, budgets, redaction and tool allow-list, asks the kill switch before every call; no route to kms-local, the Notary, the Witness or core |
| `identity`                                  | 8330               | no                 | app, data-record, kms-clients, notary-api, telemetry                                                                                       | I             | policy source and its journal are not shared with the systems it polices (AR2); PDP evaluation is embedded in core and the bff                                                                                                                                                                                                                                                                                                                                              |
| `bff`                                       | 8340               | **yes**, 127.0.0.1 | edge, data-record, kms-clients, gatecheck-api, notifier-api, sandbox-controller-api, audit-api, telemetry-bff, killswitch-bff, gateway-bff | O, K          | the browser edge: tokens never reach the browser, session store and the IdP client secret stay out of core; signs step-up proofs through kms-local; Quality › Models › Test and Reload through the gateway with scope `operate` only (`BFF_GATEWAY_URL`, `tok-bff-gateway`)                                                                                                                                                                                                 |
| `dev-oidc`                                  | 8390               | **yes**, 127.0.0.1 | edge                                                                                                                                       | O             | the stand-in identity provider, a different party the browser is redirected to; `FACTORY_ENV=local` only                                                                                                                                                                                                                                                                                                                                                                    |
| `codehost`                                  | 8350               | no                 | app, egress, telemetry                                                                                                                     | K, E          | the only holder of the GitHub App key (mounted nowhere else) and the only container with a route out (M16: it also holds the issue twin's tracker App key, `secrets/tracker-app.pem`, a separate App with `issues: write`, served to core-worker only under scope `tracker`; core-worker has no route out); reads only                                                                                                                                                      |
| `knowledge`                                 | 8370               | no                 | app, data-record, kms-clients, telemetry                                                                                                   | O, E          | analyses untrusted repo content; holds no code-host credential, no HMAC key, and **has no route to GitHub**: it gets credential-free bundles from the codehost                                                                                                                                                                                                                                                                                                              |
| `core`                                      | 8380               | no                 | app, data-record, kms-clients, notary-api, objectstore-api, gateway-api, audit-core, core-activity, telemetry                              | none          | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `core-worker`                               | 8360               | no                 | app, data-record, kms-clients, notary-api, witness-api, killswitch-api, objectstore-api, telemetry                                         | none          | see below                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `object-store`                              | 9000               | no                 | objectstore-api                                                                                                                            | I             | S3-compatible store for large content (M14.1; Evidence Packs from M14.4): MinIO, root credentials as secret files, the adapter creates the buckets (write-once ones with Object Lock); core-worker is its one caller (M14.4: 7.6's signed Evidence Packs in the write-once bucket `evidence-packs`, a D2's Handoff Pack beside them), and it has no route out                                                                                                               |
| `object-store-init`                         | none               | no                 | objectstore-api                                                                                                                            | K             | one-shot, every up (portal v2, delete means delete): makes the deletion's own MinIO user `aisdlc-core-purge` and its one policy (list versions, lift a legal hold, delete a version in `evidence-packs` and `audit-exports`; no read, write or bucket setting) with the store's root credential and the store's own image (it ships `mc`); core waits for it                                                                                                                |
| `otel-collector` (profile `telemetry`)      | 4318               | no                 | telemetry, telemetry-bff, telemetry-<service> (11)                                                                                         | O             | M19 (ADR-0003 §2 Telemetry): the one OpenTelemetry collector. A container because it is third-party code that receives from many services: it holds no secret, has no route out (locally `debug` only prints counts), and the services export to it only content-free spans and request histograms (`OTEL_EXPORTER_OTLP_ENDPOINT=http://otel-collector:4318`, off by default). Pinned by digest, non-root, read-only root, no capabilities; nothing depends on it           |
| `fake-github`                               | 8353 api, 8354 git | no                 | (codehost's own)                                                                                                                           | stand-in      | not part of the factory: the far end of the codehost's egress; profile `fake-github`                                                                                                                                                                                                                                                                                                                                                                                        |
| `db-init`, `volume-init`, `migrate`, `seed` | none               | no                 | data-\* (and app, kms, notary for `seed`; none for `volume-init`)                                                                          | one-shot jobs | roles and databases; the named volumes' owner; schemas; first-run bootstrap                                                                                                                                                                                                                                                                                                                                                                                                 |

`core` and `core-worker` do **not** separate a key, an egress, an independence requirement or an
origin. They are two containers because PLAN §5 keeps the API and the one process that hosts every
loop apart (an API that keeps answering while a loop restarts, loops that never take a request). That
is a deploy choice, not a boundary: they could run as one process, and the boundary check says so
rather than inventing a reason.

### Networks

Docker has no packet filter inside a network, so a network is the unit of "can reach". The cuts below
make the forbidden paths not exist; between services that legitimately share a network only a token
and its scopes stand in the way.

There are more networks than Docker's default address pools hold (about 30), so each has its own /24 under
`AISDLC_SUBNET_PREFIX` (default `10.231`, so `10.231.1.0/24` to `10.231.59.0/24`). Two stacks at once need two
prefixes: `smoke.sh` uses `10.232` and `e2e.sh` `10.233`. Change it if the range is used on your machine. The sandbox
sessions' own networks still come from the default pools.

| Network                                                             | Members                                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `edge`                                                              | bff, dev-oidc                                                                 | the only network with published ports; not internal because a published port needs a route in                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `app` (internal)                                                    | core, core-worker, identity, knowledge, codehost, seed                        | the service-to-service calls                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `data-record` (internal)                                            | postgres, db-init, migrate, bff, core, core-worker, identity, knowledge, seed | the record database. The record services share it, so they can reach each other's ports; each API still demands its own token                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `data-notary`, `data-witness` (internal)                            | postgres and the Notary / the Witness                                         | the key holders' databases, on networks no record service joins                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `kms-notary`, `kms-witness` (internal)                              | kms-local and the Notary / the Witness                                        | the signers' route to their key: **the Notary and the Witness have no route to each other** (AR9, C33)                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `kms-clients` (internal)                                            | kms-local, bff, core, core-worker, identity, knowledge, seed, audit           | public-key lookups, step-up signing (bff) and the fingerprint MAC (knowledge)                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `notary-api` (internal)                                             | notary, core, core-worker, identity, seed, audit                              | the ledger's writers. Knowledge, codehost, bff and the dev IdP are not on it                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `witness-api` (internal)                                            | witness, core-worker                                                          | the checkpointer's route (core-worker's `checkpointer` loop is the Witness's one caller)                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `data-killswitch`, `kms-killswitch`, `killswitch-api` (internal)    | postgres / kms-local / core-worker and the kill switch                        | the kill switch's own database, signer link and API. **Core, the Notary, the codehost and the bff are not on `killswitch-api`** (core-worker is, because it reads and pushes; it has no write or command API), and the kill switch is on none of theirs                                                                                                                                                                                                                                                                                        |
| `egress`                                                            | codehost                                                                      | the only way out. **Knowledge is on no network with a route out**, so it cannot reach GitHub                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `gateway-api` (internal)                                            | gateway, core-worker, verify, core                                            | the gateway's HTTP surface: core-worker mints the agents' keys and the planning port calls `/v1/messages` (M11, M12), verify's A5 reviewer calls it with a lent run key (M14.3), core's assistant mints a per-ask key on the person's day budget group and calls `/v1/messages` with it (M18, token `tok-core-gateway`, scopes `admin`, `read`); the sandboxes reach it on their per-session networks. None of them is on another network of the gateway                                                                                       |
| `data-gateway` (internal)                                           | postgres, gateway                                                             | the gateway's own route to Postgres (the record database, as its own least-privilege role `gateway`). It is NOT on `data-record`, so it cannot reach identity, core or the bff there                                                                                                                                                                                                                                                                                                                                                           |
| `killswitch-gateway` (internal)                                     | killswitch, gateway                                                           | the one link the gateway has into the trust plane: the kill switch's read API, asked before every call                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `killswitch-bff` (internal)                                         | killswitch, bff                                                               | RC-UI-1: the portal's kill and release. The bff forwards a person's act with that person's own step-up proof (the kill switch verifies it and takes the actor from it); nothing of core, the Notary or the record is on it                                                                                                                                                                                                                                                                                                                     |
| `gateway-bff` (internal)                                            | gateway, bff                                                                  | P2-5: the portal's Quality › Models › Test and Reload. The bff's token at the gateway (`tok-bff-gateway`) has scope `operate` alone: a provider's connection test and a reload of the published config, never a key, a budget group or `/v1/messages`; the bff asks its PDP (`config.propose` on the fleet) for the person first. The bff is on no other network of the gateway's                                                                                                                                                              |
| `gateway-egress`                                                    | gateway                                                                       | the gateway's own way out (the model vendor's API). Nobody else is on it. Docker cannot filter by host: the cloud target is a security group or egress proxy that allows `api.anthropic.com` only                                                                                                                                                                                                                                                                                                                                              |
| `sandbox-controller-api`, `data-sandbox-controller` (internal)      | core-worker / postgres and the sandbox-controller                             | how core-worker asks the controller for a session and its free slots (the bff reads the slots too, token `tok-bff-sandbox-controller`, scope `read`); the controller's own route to Postgres (as its role `sandbox_controller`), not `data-record`                                                                                                                                                                                                                                                                                             |
| `core-activity` (internal)                                          | sandbox-controller and core                                                   | M19: the sandbox-controller posts the heartbeat of each running session to core (`POST /v1/sessions/heartbeat`, token `tok-sandbox-controller-core`, scope `activity` and nothing else), so a busy session with no model call is not drawn stuck on the floor                                                                                                                                                                                                                                                                                  |
| `telemetry`, `telemetry-bff` (internal)                             | core, core-worker, identity, knowledge, codehost / bff and otel-collector     | M19: the collector's inbound networks. `telemetry` joins only services that already share `app`, so it opens no path between them; the bff has its own. build/m19c: every other service built on the kit (notary, witness, killswitch, kms-local, gateway, sandbox-controller, verify, gate-check, gate-relay, notifier, audit) has its own `telemetry-<service>` network with the collector and nobody else, so telemetry opens no path between services                                                                                      |
| `verify-api`, `data-verify`, `verify-codehost` (internal)           | core-worker / postgres / codehost and verify                                  | how core-worker asks the verify service for a step's check; verify's own route to Postgres (as its role `verify`), not `data-record`; its one link to the codehost (the bundle route). verify also joins `sandbox-controller-api` and `gateway-api`                                                                                                                                                                                                                                                                                            |
| `objectstore-api` (internal)                                        | core-worker, core, gate-check, audit, object-store-init and object-store      | where 7.6 stores the signed Evidence Packs (M14.4: the S3 adapter with the store's credentials as `file:` references; the Notary signs the pack through its `evidence` scope, which only core-worker holds); core (the portal's pack viewer, M14.6) and gate-check read them back. Nothing else is on it, and the store has no other network                                                                                                                                                                                                   |
| `data-gatecheck`, `gatecheck-github` (internal), `gatecheck-egress` | postgres / codehost (the fake GitHub's door) and gate-check                   | gate-check's own route to Postgres (as its role `gate_check`: its tables and `gatecheck:` streams, read-only the ledger, the bypass list's config view and four core read models), its own way out to GitHub (its App is not the codehost's, so the codehost's `egress` is not shared), and, in the fake profile, the fake GitHub's port 8355 in the codehost's namespace (gate-check has no codehost token). gate-check also joins `kms-clients` (the Notary's public key) and `objectstore-api` (the signed packs, read only)                |
| `data-gaterelay`, `gaterelay-github` (internal), `gaterelay-egress` | postgres / codehost (the fake GitHub's door) and gate-relay                   | gate-relay's own route to Postgres (as its role `gate_relay`: its tables and `gaterelay:` streams, read-only the `gate:` streams, the ledger, the release setting's config view, `core.evidence_pack` and `gatecheck.merge`), its own way out to GitHub (its App is neither the codehost's nor gate-check's) and, in the fake profile, the fake GitHub's port 8356 in the codehost's namespace. gate-relay also joins `kms-clients` (the Notary's public key) and `objectstore-api` (the signed packs, read only)                              |
| `data-notifier`, `notifier-api` (internal), `notifier-egress`       | postgres / bff and notifier                                                   | the notifier's own route to Postgres (as its role `notifier`: its tables and `notifier:` streams, read-only the gate, card and kill events it notifies about, identity's read model and the channel rows' config view), the bff's way to it (its only caller, scope `people`), and its own way out to Slack's webhooks and the SMTP relay (nobody else is on it; the hosts a channel row may name are bounded by `NOTIFIER_EGRESS_HOSTS`)                                                                                                      |
| `data-audit`, `audit-api`, `audit-core` (internal)                  | postgres / bff / core and audit                                               | the audit service's own route to Postgres (as its role `audit`: its read models and `audit-` streams, its four ledger entry types, read-only the record, the checkpoints, identity's read model and the config view), the bff's way to it (its only caller, scopes read, export, govern), and its one link to core (the erasable payloads, scope `erasure`). It is also on `notary-api` (scopes ledger, read, audit_export), `kms-clients` (public-key reads only) and `objectstore-api` (the write-once bucket `audit-exports`). No route out |

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
switch when core is down; the BFF does not carry kill routes yet. The token says which process calls,
never who acts (RC-SEC-3, `docs/specs/killswitch-api.md`): every kill, release approval, delegation and
revocation carries the acting person's step-up proof for exactly that act (`killActHash`), which the
kill switch verifies itself with the bff's public step-up key and consumes once. A person gets one from
the bff (`POST /api/step-up` with the act's hash, sign in again, `GET /api/step-up/:id`); `smoke.sh`
stands in for alice's and bob's sign-ins with `kill-proof.mjs`, run inside the bff container. One token
and one person's proofs are one person: a two-person release needs two people's proofs.

## Secrets are files

`./init-secrets` creates `secrets/` (git-ignored but for its README), mode 0600, owned by the uid the
containers run as. It generates one token per (caller, callee) pair, the Postgres passwords and the
database URLs built from them, the bff's OIDC client secret, and a throwaway GitHub App key. Each
service mounts only its own files at `/run/secrets/<name>` and reads them through `file:` references;
there are no secrets in environment variables or in the image. The bff keeps sessions in the
database, so it has no cookie signing key. Running it again changes nothing; `--rotate` makes new
tokens and passwords (down -v first). See `secrets/README.md` for who mounts what.

The files are read through a bind mount, so the containers must run as their owner:
`init-secrets` writes `AISDLC_UID`/`AISDLC_GID` into `.env` (your own uid; 10001 when run as root). Any uid
works: `volume-init` hands the named volumes to the same uid.

## Secrets pasted in the portal: Vault (portal v2)

The secrets a person enters in the portal (a model provider's API key, a GitHub App's private key, a Slack webhook, an
SMTP password) go into **HashiCorp Vault** (`vault`, KV version 2 at `aisdlc/`), never into a file, the record, a log or
the browser after submit. The owner pastes a value once:

    PUT /api/secrets/<name>   {"value": "..."}     (the bff, as the signed-in person; PDP config.propose on the fleet)
    GET /api/secrets                                (names and metadata only: set, version, when, by whom)
    DELETE /api/secrets/<name>                      (every version destroyed)

The value travels browser -> bff -> core -> Vault once; core records `secret.stored` {name, version, by, at} with a
ledger entry over exactly that (never the value or a hash of it). The names are an allow-list
(`packages/contracts/src/entities/secrets.ts`), each owned by the one service that reads it, and configuration names
them by reference: `vault:<owner>/<name>#value` (next to `file:` and `env:`). Every service resolves `vault:`
references at start (`runService` primes the ones its environment names) and refreshes them every 30 s, so a pasted
or rotated value is picked up without a restart (the gateway rebuilds its provider, an App key re-reads itself).

Least privilege, in Vault's own policies (`vault/policies/*.hcl`) and the networks: one AppRole per service
(`secrets/vault/approle-<service>`, made by `init-secrets`, registered by `vault-init`), each reads only
`aisdlc/data/<service>/*`; core is the one writer and has no read of a value (create, update, metadata, destroy);
one network per client (`vault-<client>`), so Vault's clients do not reach each other through it. Vault's audit device
writes to its log with every value HMAC'd.

What uses Vault by default: the Anthropic key (`AISDLC_ANTHROPIC_KEY_REF`, default `vault:gateway/anthropic-api-key#value`;
`file:/run/secrets/anthropic-api-key` keeps the mounted file) and the notifier's channel secrets. The GitHub Apps' keys
stay files by default (setup-github-apps writes them); `AISDLC_GITHUB_APP_KEY_REF=vault:codehost/github-app-key#value`
(and `AISDLC_PUSH_BROKER_KEY_REF`, `AISDLC_GATE_CHECK_KEY_REF`, `AISDLC_GATE_RELAY_KEY_REF`) reads them from Vault
instead (`npm run e2e:pr` does, pasting the key through the portal first).

**LOCAL PROD ONLY.** Vault runs in server mode with file storage on the named volume `vault-data`, plain http on its
internal networks, ONE unseal key share, and unseals itself: `vault-init` initialises it at the stack's first start and
writes the unseal key and the root token to `secrets/vault/<project>/` (mode 0600, one pair per compose project), and
the `vault` container opens itself with that key after every restart. That is convenient on the owner's machine and
wrong anywhere else: in production the same `SecretStorePort` is AWS Secrets Manager (`AwsSecretsManagerStore`, a
tested stub, not wired) or a Vault with a KMS seal, no key beside the server. A key pair whose volume was removed
(`down -v`) is moved aside as `*.orphaned-<time>` at the next first start.

## Sign-in: Keycloak (portal v2)

The bff signs people in against **Keycloak** (`keycloak`) by OpenID Connect discovery (`BFF_OIDC_ISSUER`, default
`http://keycloak.localhost:<AISDLC_OIDC_PORT>/realms/aisdlc`; any OIDC provider in production, `AISDLC_OIDC_ISSUER`):
authorization code with PKCE (S256), the bff a confidential client. Keycloak keeps its own database `keycloak` in the
stack's Postgres under its own role (persistent and in every backup like the other databases; its dev-file H2 mode is
not supported for production and backup.sh would not see it). The realm `aisdlc` is imported at the first start from
`keycloak/realm-aisdlc.json`, GENERATED from the one IdP seed (`npm run gen -w @aisdlc/bff`; a test fails when it is
stale): every test person (alice, bob and the eleven personas) as a user whose id is their IdP subject and whose
username is their principal id, their groups, the bff client, brute-force protection (five tries, 15 minutes), an
authenticator app (OTP) available and optional, and the break-glass local account `factory-admin` (a factory admin).
Passwords are files made by `init-secrets` (`secrets/keycloak-persona-password` for the test people,
`keycloak-factory-admin-password`, `keycloak-bootstrap-admin` for Keycloak's own `kc-admin`); the realm takes them at
its first import and they are changed in Keycloak afterwards. Groups become identity bindings as before: identity syncs
`config/keycloak-idp-seed.json` (the same people with Keycloak's issuer) and the seed binds the groups to their roles.
The sign-in page is the agreed AISDLC look as a minimal Keycloak theme (`keycloak/themes/aisdlc`). Keycloak is
published on 127.0.0.1 like the portal (`AISDLC_OIDC_PORT`, default 8390): its issuer is one name for the browser (a
loopback name) and the bff (a network alias).

The dev IdP stays only as a test fake behind the same configuration: compose profile `dev-oidc` with
`AISDLC_OIDC_ISSUER=http://dev-oidc.localhost:<port>`, `AISDLC_IDP_SEED_FILE=./config/idp-seed.json` and
`AISDLC_OIDC_LOGIN_HINT=subject` (the load test runs that way).

### Sign-in profiles: local (test people) and enterprise (system administrator)

Two realms, one set of services (`idp-profile.sh` exports what `docker-compose.yml` reads; `make up IDP=...`,
`up-full.sh --idp ...`):

|               | `local` (what a bare `docker compose up`, the smoke, the e2e runs, the demo and the load test use) | `enterprise` (the default of `make up` and `make up-full`)                                                                                |
| ------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Realm file    | `keycloak/realm-aisdlc.json`                                                                       | `keycloak/realm-aisdlc-enterprise.json`                                                                                                   |
| People        | alice, bob, the eleven personas, the break-glass `factory-admin`                                   | **one: the system administrator `admin`**                                                                                                 |
| Password      | files made by `init-secrets`                                                                       | default **`admin`**, marked **temporary**: Keycloak forces a new password (at least 12 characters, not the username) at the first sign-in |
| Sign-in page  | theme `aisdlc`: the "LOCAL · KEYCLOAK" badge and the Test people panel                             | theme `aisdlc-enterprise` (a child of `aisdlc`): no badge, no test people, no local-stack wording                                         |
| Identity seed | `config/keycloak-idp-seed.json`                                                                    | `config/keycloak-idp-seed-enterprise.json`: `admin` in `grp-factory-admins` only                                                          |
| Seed job      | `SEED_FACTORY_ADMIN=alice`, `SEED_PERSONAS=1`                                                      | `SEED_FACTORY_ADMIN=admin`, `SEED_PERSONAS=0`; the kill switch's factory admins are `["admin"]`                                           |

Both realm files, the identity seeds and the theme's test-people list are GENERATED by `npm run gen -w @aisdlc/bff`
(`services/bff/src/dev-oidc/keycloak.ts`); a test fails when one is stale. The enterprise realm keeps the bff client,
PKCE, brute-force protection (five tries, 15 minutes) and optional OTP of the local one.

**The default credentials are shared and public (`admin` / `changeme-admin`, in this repository).** They are safe only because the
password is temporary: Keycloak will not let anyone past the first sign-in without choosing a new one, and the stack
listens on 127.0.0.1. Sign in as `admin` and change it before you do anything else, and do not publish the stack's port
to a network before that first sign-in (anyone who reaches the page first chooses the administrator's password).
Keycloak's own console admin `kc-admin` (`secrets/keycloak-bootstrap-admin`) is separate and unchanged.

`make secret` signs in as the local profile's `factory-admin` and so does not work on an enterprise stack: paste keys
in the portal (Integrations), signed in as `admin`.

A one-person factory: the system administrator is a factory admin, and "nothing applies to the factory admin" (portal v2
intent): where a rule needs a second person (a factory M1 change the admin proposed, a two-person gate) the portal offers
the admin's override with a reason, recorded as an `admin.override` on the ledger. The seed's own M1s are decided by the
genesis eligibility (the admin alone) as before.

#### Switching a running stack's sign-in profile

Keycloak imports a realm only while the realm `aisdlc` does not exist, so a running stack keeps the realm it has.
To move it to the other profile, empty Keycloak's database (its realm, users and sessions only; no other database is
touched) and start it again with the profile:

```bash
cd platform/compose
docker compose stop keycloak
docker compose exec -T -e PGPASSWORD="$(cat secrets/pg-superuser)" postgres \
  psql -U postgres -d keycloak -c 'DROP SCHEMA public CASCADE' -c 'CREATE SCHEMA public AUTHORIZATION keycloak'
cd ../.. && make up IDP=enterprise      # or IDP=local; for the full stack: make up-full REPO=owner/name IDP=enterprise
```

`up` recreates Keycloak (new realm file), identity (new IdP seed) and runs the seed again (the admin is bound as
`factory.admin`). The record, the ledger and every other database are kept, so the people of the old profile stay in
identity's read models (they can no longer sign in, because Keycloak has no such user); `make reset` is the clean slate.

## Delete means delete and the portal's identity writes (portal v2)

`docs/specs/deletion.md`. Core's `DELETE /v1/{projects,repos,items,people,teams,bindings}/:id` and
`POST /v1/deletions/preview` (scope `delete`, held by the bff alone; the PDP decides `<kind>.delete` for the person)
run on a login of their own, `core_purge` (`CORE_PURGE_DATABASE_URL`, `secrets/db-url-purge`): db-init makes it the one
member of the group role `aisdlc_purge`, which record/0005 and ledger/0002 grant DELETE on the record and the read
models and the redaction UPDATE of the ledger, each still refused by the triggers unless the transaction took the role
(`SET LOCAL ROLE aisdlc_purge`) and the change is purge-shaped. Core's normal login `aisdlc` is not a member, so
nothing but the delete routes can purge. (db-init also gives `aisdlc` the ADMIN option on `aisdlc_app`:
PostgreSQL 16 needs it for record/0005 to make the purge role a member of `aisdlc_app`.) A deleted object's packs and
audit exports are purged with the store user `aisdlc-core-purge` (`CORE_PURGE_OBJECT_STORE_*`,
`secrets/object-store-purge-*`, made by `object-store-init`): it may list an object's versions, lift a legal hold and
delete a version in the two write-once buckets, and read, write or reconfigure nothing; core knows the two buckets
without asking (`knownBuckets`). Only core mounts it (and the init job that makes it). The rest of the stack still
uses the store's root credential: narrowing those is not part of this.

The portal's people, team, group and binding writes go to identity's API under scope `admin` (`BFF_IDENTITY_URL`,
`tok-bff-identity`, held by the bff alone), which identity's PDP decides for the person (`identity.admin`,
`access.manage`); the bff reaches identity on `data-record`, which both already joined. smoke.sh creates, previews and
deletes a team, a binding and a person through the bff as a factory admin, probes the store credential from core
(`purge-probe.mjs`: the three requests a purge sends; a read and a write refused) and runs `verify-ledger.sh --allow-redacted`
(the deletions' redacted entries are checked by their stored hash).

## Backup and restore (RC-OPS-1)

`./backup.sh <dir>` takes every database and role (Keycloak's too), the object store's, key custody's and Vault's
volumes, `secrets/` and
`.env` (a secret itself: keep it encrypted); `./restore.sh <dir>` puts them back onto a fresh stack (no Postgres
volume) before it is brought up. `npm run drill:restore` (`drill-restore.sh`) proves it end to end. What is taken,
in which order and why, how to check a restore, and the RPO and RTO: `docs/runbooks/backup-restore.md`. The image
name is `AISDLC_FACTORY_IMAGE` (default `aisdlc/factory:local`).

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

With `SEED_PERSONAS=1` (set here) it also binds the design personas' IdP groups
(`services/bff/src/dev-oidc/personas.ts`, the groups and members in `config/idp-seed.json`): `lt` and `oh`
factory admins, `nf` the factory auditor, `mw` the web team's onboarder, and the direct project viewers
(`ar` on ledger, `pm` on web, `tb` a guest on payments whose binding expires after 90 days). Project slot
roles (admin, intent, g4, ...) come only from a published role map, so a persona holds them once a project
of that id (`payments`, `ledger`, `web`, `identity`, `mobile`) is onboarded with `personaRoleMap(id)`
in card 4; `services/core/test/personas.test.ts` signs every persona in with those role maps.

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

The dev IdP and the seed stay: the people who may sign in are still `alice`, `bob` and the personas. Set the
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
| Identity provider             | Keycloak (realm `aisdlc`, local accounts, plain http on loopback) plus the IdP seed file; `dev-oidc` as a test fake                 | Entra or any OIDC provider                                     |
| First admin and policy bundle | `seed`, local only                                                                                                                  | provisioned with the account, bundle through the real M1 gate  |
| Code host                     | `codehost` plus the fake GitHub, or a real non-prod App                                                                             | `codehost-core` on ECS, App keys in KMS                        |
| Browser edge                  | bff on `localhost`, plain http, secure cookies off                                                                                  | CloudFront, WAF, Verified Access, TLS                          |
| Network separation            | Docker networks (reach, not packet filtering)                                                                                       | accounts, VPCs, security groups                                |
| Secrets                       | files in `secrets/`, bind-mounted; pasted ones in Vault (one unseal key on disk, auto-unseal)                                       | Secrets Manager                                                |
| Core and core-worker          | two containers                                                                                                                      | ECS services, same images                                      |
| Not here yet                  | sandbox pieces, audit services                                                                                                      | later milestones                                               |

## The portal (M8.1 to M8.4)

The bff serves the web bundle (`services/web`, built inside the image to `/app/services/web/dist`,
`BFF_WEB_DIR`) on its own origin with `default-src 'self'` and `frame-ancestors 'none'`, and is the
only API the browser calls: `/api/projects`, `/api/onboard`, `/api/s0/...`, `/api/cards/...`. Each
route asks the PDP for the signed-in principal, then calls core (`BFF_CORE_URL`) with the bff's own
token (`tok-bff-core`, scopes `read`, `onboard`, `portal`, `work`, and `ops` for the portal's control previews, applies and lifts); core gets the principal as `on_behalf_of`
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
| `sandbox-controller`  | 8430 | data-sandbox-controller, sandbox-controller-api, docker-coding, core-activity | D, I     | placement (M14.2, ADR-0003 §6-7): the ONLY client of the coding proxy (it holds that token; core-worker does not), owns the driver, the class ceilings and the two caps of the runner host (`sandbox.caps`, M1-gated: total 4, coding 1), starts only a session whose grant core recorded as active, answers `busy` over a cap (core's admission waits; it never queues) and reports the free slots H2 reads. State in memory only (disposable). Its own database role: the published-config view and `core.admission_grant`, nothing else. core-worker reaches it with `CORE_WORKER_SANDBOX_CONTROLLER_URL=http://sandbox-controller:8430`. M19: it beats each running session to core (`core-activity`, scope `activity`)       |
| `verify`              | 8440 | data-verify, verify-api, verify-codehost, sandbox-controller-api, gateway-api | O, I     | S7's checks 7.1 to 7.5 (M14.3, ADR-0003 §1 Control plane, the plan's `cvw`; `docs/specs/verify-api.md`): it reads untrusted repo content (the base and the Unit head, from the codehost's bundle route) and has its kits run untrusted repo code in O sessions the sandbox-controller places under the item's grant (no key, the mirror only); a load that spikes when items reach S7. It holds no vendor key, no code-host credential and no Docker right; the A5 reviewer of 7.3 and 7.5 is one gateway call under the run's own key, lent for that call and never recorded. Its own database role: its own table and its own `verify:` record streams. core-worker reaches it with `CORE_WORKER_VERIFY_URL=http://verify:8440` |

## gate-check (profile `gate-check`, M14.5)

`docker compose --profile fake-github --profile gate-check up -d --wait` adds it (against the fake GitHub, whose
second App is gate-check's: `FAKE_GITHUB_CHECKS_APP_ID`, the key `secrets/gate-check-app.pem` that `init-secrets` makes
when there is none). The live run needs the user's own narrow App (`checks: write`, pull requests read), its id and
installation in `.env` and its key at `secrets/gate-check-app.pem`; it is never the codehost's App.

| Container    | Port | Networks                                                                         | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | ---- | -------------------------------------------------------------------------------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate-check` | 8450 | data-gatecheck, kms-clients, objectstore-api, gatecheck-github, gatecheck-egress | K, E, I  | the check run `aisdlc/gate` on every PR (ADR-0003 §1 Integration plane, `docs/specs/gate-check-api.md`): a key (its own App, `checks: write`; in codehost, one leak would give both powers), and the gate plane's independence (AR9: no route to core's write or command APIs, so a core outage cannot pass or block a merge by itself; it reads the record as its own role). It verifies each signed Evidence Pack itself with the Notary's public key, never merges, and records every merge (bypass and unauthorised merges get core's X4 review) |

## The Push Broker and request to merged PR (profiles `push-broker` and `full`, RC-E2E-2)

`push-broker` is the codehost image in `CODEHOST_MODE=push` with the key `secrets/push-broker-app.pem` (contents and
pull requests write): the factory's one writer, a commit on `agent/<item>/<unit>` through the Git Data API and a
Draft PR, after its own checks (lease epoch and X2 from core, scope `push_guard`). In the default two-App layout
(`./setup-github-apps`, docs/getting-started.md §4) that key is the factory App's, the same as `github-app.pem`, and
`PUSH_BROKER_APP_ID`/`_INSTALLATION_ID` are the codehost's; in the stricter layout it is an App of its own. Either way
gate-check's App is never it. core-worker reaches it with `CORE_WORKER_PUSH_BROKER=1` and
`CORE_WORKER_PUSH_BROKER_URL=http://push-broker:8350` (its own token there). On the fake GitHub it comes in on its own
door (8358, network `pushbroker-github`): the main App when `PUSH_BROKER_APP_ID` is `GITHUB_APP_ID` (the installation
then holds the union), else a fifth App; `AISDLC_PUSH_BROKER_KEY=github-app` mounts the main key as the broker's. What
it writes is mirrored into the git server's repository, so S7 fetches the Unit head like any branch. `npm run e2e:pr`
runs the two-App layout (`E2E_APPS=split`: the fifth App).

Profile `full` is everything the request-to-PR path needs: the Push Broker, the sandbox plane (both Docker proxies,
the package mirror, the sandbox-controller), verify and gate-check. `npm run e2e:pr` (`e2e-pr.sh`, `e2e-pr.mjs`) runs
it on fakes end to end in a real Chromium, every gate decided by its slot holder (the design personas): the Light
onboarding of the testbed (the probe in a K-exec session, SP-STD-1 recorded for the W image, the seed's
`SEED_EXEC_ALLOWED_REPOS`, `SANDBOX_ONBOARDING_IMAGE` and `SANDBOX_AGENT_IMAGE_ID`), a request on Ask for work, S1 to
S5 on the planning port (the gateway's fake provider on `SEED_FAKE_FIXTURES=testbed`), S6 in W sessions through the
real gateway, S7 in the verify service, the signed Evidence Pack, the Draft PR, `aisdlc/gate`, G4, a person's merge on
the fake GitHub (a personal token `ghp_fake_<login>` of `FAKE_GITHUB_PEOPLE`; the merge needs `aisdlc/gate` from
gate-check's App), G6 and Done, then `verify-ledger`. It runs on its own ports (`AISDLC_BFF_PORT` 8640,
`AISDLC_OIDC_PORT` 8690), project and subnets (10.236), beside another stack. CI: `.github/workflows/e2e-pr.yml`
(nightly and on demand). `DRILL_DATA=pr npm run drill:restore` backs up and restores that data.

## The owner's full stack (`make up-full`, `up-full.sh`)

`make up` starts the light stack (no coding sessions, no PRs: core-worker's stage ports are `none` by default).
`make up-full REPO=<owner>/<repo> [GITHUB=fake|real]` (`up-full.sh`) starts profile `full` with core-worker on the
real ports. The setup is `full-env.sh`, sourced by `up-full.sh` and `e2e-pr.sh` alike, so the owner's stack and the one
the e2e proves are wired by the same lines: the four images by name from `AISDLC_IMAGE_TAG` (`build-images.sh`,
`make images`), the W image and the probe image pinned by digest (`SANDBOX_AGENT_IMAGE_ID`, `SANDBOX_ONBOARDING_IMAGE`,
`SANDBOX_ONBOARDING_LOCK_SHA256`), `CORE_WORKER_STAGE_PORTS=agents`, `CORE_WORKER_SANDBOX_CONTROLLER_URL`,
`CORE_WORKER_VERIFY_URL` (real verify: `CORE_WORKER_FAKE_VERIFY=default`), `CORE_WORKER_PUSH_BROKER=1` and its URL,
`SEED_EXEC_ALLOWED_REPOS`, `DOCKER_GID`, `SANDBOX_SCRATCH`, the two-App layout on the fake GitHub, the IdP seed on
another port, and SP-STD-1 (run once per W image, then posted to core). What the owner's path chooses differently:

|                                 | `up-full.sh` (the owner)                                                                                          | `e2e-pr.sh` (the test)                                  |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| project, ports, subnets         | `aisdlc`, 8340 and 8390, `10.231` (each overridable)                                                              | `aisdlc-e2e-pr`, 8640 and 8690, `10.236`                |
| GitHub                          | `fake` or `real` (`real` refuses to start without both Apps: ids in `.env`, keys in `secrets/`, none a throwaway) | the fake                                                |
| allow-listed repo               | `REPO`                                                                                                            | `reshif/asf-factory-testbed`                            |
| the fake provider's fixtures    | `planning` (the seed's default); the model routes are the owner's M1 decision, and the seed never reverts them    | `testbed` (scripts the coding sessions and the reviews) |
| scratch and the SP-STD-1 report | persistent: `.scratch/<project>/` (gitignored; `AISDLC_STATE_DIR` moves it)                                       | a `mktemp` directory, removed                           |
| at the end                      | left running; `make down` keeps the volumes, `make reset` deletes them and the scratch                            | `down -v`                                               |

`E2E_ATTACH=1 ./e2e-pr.sh` runs the browser journey and `verify-ledger` against a stack that is already running (it
checks core-worker's wiring and that the fake provider has the `testbed` fixtures), and leaves it running: started
with `SEED_FAKE_FIXTURES=testbed make up-full REPO=reshif/asf-factory-testbed`, it proves the owner's stack itself.

## gate-relay (profile `gate-relay`, M15.3)

`docker compose --profile fake-github --profile gate-relay up -d --wait` adds it (against the fake GitHub, whose third
App is gate-relay's: `FAKE_GITHUB_DEPLOY_APP_ID`, the key `secrets/gate-relay-app.pem` that `init-secrets` makes when
there is none). The live run needs the user's own narrow App (`deployments: write`, metadata read), its id and
installation in `.env` and its key at `secrets/gate-relay-app.pem`; it is never the codehost's or gate-check's App. Core
follows it when core-worker has `CORE_WORKER_RELEASE=gate-relay`.

| Container    | Port | Networks                                                                         | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------ | ---- | -------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gate-relay` | 8470 | data-gaterelay, kms-clients, objectstore-api, gaterelay-github, gaterelay-egress | K, E, I  | G5 release (ADR-0003 §1 Integration plane, `docs/specs/gate-relay-api.md`): a key (its own App, `deployments: write`; in codehost or gate-check, one leak would give two powers), and the gate plane's independence (AR9: no route to core's write or command APIs; it reads the record as its own role). It consumes an approved G5 exactly once into a deployment of the merged commit only when the card's binding holds again here (gate-check's gated merge of the pack's head, the pack verified with the Notary's public key), and rolls an unhealthy release back (B16). It never merges or writes a status |

## audit (profile `audit`, M19)

`docker compose --profile audit up -d --wait` adds it (ADR-0003 names one audit service; PLAN M19's audit-exporter and
audit-backend are its two halves, `docs/specs/audit-api.md`). Govern › Audit in the portal reads and writes through
it; without the profile only the bff's `/api/audit/*` routes answer 502. An export is checkable offline:
`node packages/ledger/dist/verify-ledger.js verify-export --file <downloaded.json> --notary-key <jwk> --witness-key
<jwk>` (the public JWKs from kms-local). Retention erases nothing until a factory revision of `audit.retention` (M1)
sets a class.

| Container | Port | Networks                                                                    | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------- | ---- | --------------------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `audit`   | 8480 | data-audit, audit-api, audit-core, notary-api, kms-clients, objectstore-api | I        | the Trust plane's audit (ADR-0003 §1: auditors may need access the factory itself does not have): signed exports into the write-once bucket (each signed by the Notary under its own purpose and checked offline before it is stored), legal holds and erasure of the payloads kept off the hash chain under two factory admins, retention from config. It holds no key, reads the record as its own role and reaches core only for the erasable payloads |

## notifier (profile `notifier`, M18)

`docker compose --profile notifier up -d --wait` adds it. It has no channel until a factory revision of
`notifications.channels` (M1) adds one, and a row may name only a key file listed in `NOTIFIER_SECRET_REFS` and a host
in `NOTIFIER_EGRESS_HOSTS` (default `hooks.slack.com`), so mount a Slack webhook URL or an SMTP password as a secret
and list its `file:` path there first. Without the profile the bff's `/api/me/notifications` routes answer 502 and
nothing else changes: the portal inbox is the record of what waits for a person (`docs/specs/notifier-api.md`).

| Container  | Port | Networks                                     | Boundary | Why                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------- | ---- | -------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `notifier` | 8460 | data-notifier, notifier-api, notifier-egress | K, E     | Slack and email delivery (ADR-0003 §1 Integration plane): it holds the channel credentials (a webhook URL is one) and absorbs their outages (retries with backoff, then given up, per delivery), and it decides nothing. It reads what waits for a person from the record as its own role, renders at the lower of the channel's and the person's class (never free text, never D2), and records every delivery |

M19: each proxy labels what it creates with its owner (`DOCKER_PROXY_OWNER`, compose `<project>-cvw` / `<project>-coding`) and lists, inspects and removes only that; the sandbox-controller sweeps its proxy's sandboxes at boot (a predecessor that died mid-session left them running) and every 60 s after (`drill.sh runner`, docs/runbooks/drill-runner.md). The proxies run as the factory uid with the socket's group added (`DOCKER_GID`, default 0; `smoke.sh` sets it from `stat`). They need the sandbox image (`docker build -t aisdlc/sandbox:local platform/sandbox`, nothing is fetched: the pinned node base is local) and a scratch directory the sandbox driver writes read-only repo copies to (`SANDBOX_SCRATCH`, default `/var/lib/aisdlc/sandbox-scratch`; the same path in the client and for the daemon). The gateway and the mirror carry the label `aisdlc.sandbox.peer` and a fixed container name so the coding proxy may attach them to a session network under their fixed aliases (`gateway`, `package-mirror`). `sandbox-smoke` (profile `sandbox-smoke`) is the smoke client: one K session and one K-exec session through the coding proxy, then the refusals (a create body with `Privileged=true`, host network, host PID, an added capability, the socket as a bind, a root user, exec, build, pull). The hostile-probe evidence is `docs/evidence/sec-ob-3.md`; the design is `docs/adr/0002-sandbox-container-class.md`.

## The load test (M19)

`npm run load:compose` (`load.sh`) brings up its own stack (project `aisdlc-load`, subnets `10.234.*`, the bff and the
dev IdP published on 18340/18390 so it can run beside another stack), with `CORE_WORKER_STAGE_PORTS=fake`, and runs the
one-shot `load` service (profile `load`, never started by `up`): `aisdlc-load seed` writes N projects with an active
PRR and their settings through M1 (FACTORY_ENV=local only; the first decisions under a genesis eligibility, as `seed`
does for the factory), `aisdlc-load run` submits the items through core's API with the bff's token, acts for the
people (Ready, every gate, the merge) and reads the floor, the fleet and the inbox at core and at the bff (signed in
through the dev IdP like a browser) while `load.sh` samples every container's memory and Postgres's connections.
`load-report.mjs` writes `docs/evidence/load-m19.{json,md}`. `AISDLC_FACTORY_IMAGE` names the image tag (default
`aisdlc/factory:local`), so a stack of another branch can share the daemon.
