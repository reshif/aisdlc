# Getting started: from zero to your first request

This guide is for the owner of the factory. It takes you from a clean machine to a repository onboarded and a first
work request submitted and followed. Read it top to bottom once before you start. It describes `origin/main` as of
2026-11-13.

The request-to-PR path (the Push Broker, real coding sessions, a draft PR on GitHub) and role grants in the portal
have both landed. Where a step below still says "available after … lands", it is done; treat the step as available.

The factory never merges. A person merges on GitHub, every time.

## Quick commands

Run `make` in the repository root to list every command. The everyday ones:

| Command | What it does |
| --- | --- |
| `make install` | install dependencies (`npm ci`) |
| `make secrets` | create local secrets and `.env` for the fake GitHub (safe to re-run) |
| `make secrets-real GITHUB_APP_ID=… GITHUB_INSTALLATION_ID=…` | switch to your real GitHub App |
| `make github-apps` | create the GitHub Apps with the setup wizard (once it has landed) |
| `make up` / `make up GITHUB=real` | start the factory and wait until healthy; add `PROFILES="gate-check notifier"` for more |
| `make portal` | print the portal's address |
| `make ps` / `make logs SERVICE=core` | see containers and their health / follow logs |
| `make down` | stop; the database, ledger and keys are kept |
| `make reset` | stop and delete everything (asks you to type the project name first) |
| `make verify-ledger` | verify the ledger offline |
| `make backup DIR=./backups/now` / `make restore DIR=…` | back up / restore the whole stack |
| `make demo` | the full request-to-PR stack on fakes, left running for you to click through (port 8640) |
| `make smoke` / `make e2e-pr` / `make drill-restore` | whole-stack checks on a throwaway stack |
| `make check` | everything that must pass before a commit |

Each target runs a command named in the sections below, so the steps there and the targets stay the same thing.

---

## 1. What you need

1. **A machine** running Linux or macOS. Docker should have at least 8 GB of memory: the containers' memory limits
   add up to about 5.7 GB with every profile on (`mem_limit` in `platform/compose/docker-compose.yml`). Keep about
   10 GB of disk free for the images and volumes. That disk figure is an estimate, not a measurement.
2. **Docker with Compose v2.** The stack is tested on Docker 29 and Compose 5. Check that both are there:

   ```bash
   docker compose version
   ```

   You should see `Docker Compose version v2...` or later.
3. **`openssl` and `curl`.** `init-secrets` needs `openssl`. `live-census.sh` needs both.
4. **Node 22 and npm.** You do not need them to run the stack, because the image builds itself. You do need them to
   build the sandbox images (step 6.4) and to run the tests. Check:

   ```bash
   node --version
   ```

   You should see `v22.x`.
5. **Ports 8340 and 8390 free** on `127.0.0.1`. The portal uses 8340 and the stand-in sign-in page uses 8390.
6. **A GitHub account or organisation** where you can create GitHub Apps.
7. **A testbed repository that you own**, with no production use, no real data and nobody depending on it. This is
   what lets you sign tier T0 on card 1 (DEC-4). Agents may run code only in repositories you own (DEC-18, step 6.4).
   To reach Light later, the repository needs a test command that runs without downloading anything. The package
   mirror serves nothing yet (`services/package-mirror/fixtures` is empty until DEC-17). A few `pytest` or
   `node --test` tests with no dependencies are enough.
8. **An Anthropic API key.** You need it only once you point the model routes at Claude (section 5). Until then the
   factory uses a deterministic fake model and needs no key.

---

## 2. Start the local factory

All `docker compose` commands in this guide run from `platform/compose`, with the same compose project name in your
shell. Run the first two steps in every new terminal.

1. Go to the compose folder:

   ```bash
   cd platform/compose
   ```

2. Fix the project name, so every command, script and container name refers to the same stack:

   ```bash
   export COMPOSE_PROJECT_NAME=aisdlc
   ```

3. Let the work driver run the planning agents. The compose default is `none`, and with `none` a request never moves:

   ```bash
   export CORE_WORKER_STAGE_PORTS=agents
   ```

4. Generate the secrets: service tokens, database passwords, the OIDC client secret, a placeholder Anthropic key and
   throwaway GitHub App keys. This also writes `.env`:

   ```bash
   ./init-secrets
   ```

   You should see a line like
   `init-secrets: 1xx secret files in .../secrets (owner uid ..., mode 0600), GitHub App key: fake, Anthropic key: placeholder`.
   You can run it again safely: it keeps existing files.

5. Start the stack on the **fake GitHub**. This is an in-repo stand-in with a seeded repository,
   `reshif/asf-factory-testbed`, so you need no credentials yet:

   ```bash
   docker compose --profile fake-github up -d --wait
   ```

   The first run builds the image, which takes a few minutes. The command returns only when every service is
   healthy.

6. Check that the stack is healthy:

   ```bash
   docker compose --profile fake-github ps -a
   ```

   Every long-running service should say `(healthy)`. The three one-shot jobs `db-init`, `migrate` and `seed` should
   say `Exited (0)`.

7. Open the portal at <http://localhost:8340>. Press **Sign in**. You are sent to the stand-in identity provider at
   `http://dev-oidc.localhost:8390`. Use a browser that resolves `*.localhost` to your own machine; current Chrome
   and Firefox do. After you sign in, **Operate › Health** (`/health`) shows the service tiles. Tiles for profile
   services read `unknown`, never healthy, because core-worker cannot reach them (`CORE_WORKER_HEALTH_TARGETS`).

8. Optional: run the whole smoke test, which starts its own stack, checks it and removes it again:

   ```bash
   npm run smoke:compose
   ```

To **stop** the stack and keep its data (the record, the ledger and the keys):

```bash
docker compose --profile fake-github down
```

To **reset** it completely. This deletes the database and every ledger entry with it:

```bash
docker compose --profile fake-github down -v
```

If the `10.231.x.x` address range is already used on your machine, set `AISDLC_SUBNET_PREFIX` (for example `10.240`)
before `up`. See `platform/compose/README.md`, "Networks".

---

## 3. Sign in: the test people

The stand-in sign-in page lists 13 accounts: `alice` and `bob`, then the 11 design personas. The personas are defined
in `services/bff/src/dev-oidc/personas.ts`, and their groups are in `platform/compose/config/idp-seed.json`. The seed
binds their fleet, team and viewer roles (`SEED_PERSONAS=1`).

A persona's **project** roles (admin, intent, design, ...) exist only after a project whose id is `payments`,
`ledger`, `web`, `identity` or `mobile` is onboarded, and its card 4 role map names them. `personaRoleMap(project)`
(same file) is that role map. Section 6 uses `payments`.

Two rules apply to everyone:

- A factory admin holds no gate or card decision unless a project role map gives them the slot (`ROLE_CATALOGUE` in
  `packages/contracts/src/entities/access.ts`).
- Nobody decides a gate on their own request, except G6 (`own_request: 'blocked'`, `GATE_POLICIES` in
  `packages/contracts/src/entities/gate-lifecycle.ts`).

| Id | Name (label) | From the seed | Project slots on `payments` (from `personaRoleMap`) | Use them for |
| --- | --- | --- | --- | --- |
| `alice` | Alice Example (factory admin) | `factory.admin` (the seed's admin); GitHub login `reshif`; one of the kill switch's two factory admins (`KILLSWITCH_FACTORY_ADMINS`) | none unless you add her (section 6 does) | **onboarding**: request it, decide cards 1, 2, 4 and 5 and the settings revision; kills |
| `bob` | Bob Example | none | none | the second person of a kill release; a person who holds nothing |
| `lt` | Luis Torres (Factory owner) | `factory.admin` | none | proposing factory configuration (routes, allow-lists) |
| `oh` | Omar Haddad (Deputy factory admin) | `factory.admin` | `kill` on `identity` | **approving** factory configuration that `lt` proposed. A factory M1 needs a factory admin other than the proposer (`DEFAULT_FACTORY_M1_POLICY`) |
| `rb` | Rana Begum (Project admin) | none | `admin`, `kill`, `design`, `m4` | project settings, design and plan gates (G3d, G3, G3s), M4, project kills |
| `ar` | Alex Rivera (Approver and code owner) | `project.viewer` on `ledger` | `intent`, `design`, `g4` | G0, G1, G2; G3; G4 merge review |
| `pm` | Priya Menon (Product owner) | `project.viewer` on `web` | `intent`, `requesters`, `g5`, `m4` | G0 to G2 on someone else's request; G5 release (step-up); M4 |
| `dn` | Daniel Novak (Engineer, requester) | none | `requesters` | **submitting the request**; Ready (1.6); G6 acceptance |
| `ks` | Keiko Sato (Security) | none | `sec` | Q1 and SECT (the security card) |
| `jm` | Jonas Meyer (Exception approver) | none | `x` | X1 to X4, E1 to E6 (exceptions, handoff approval E4) |
| `mw` | Mei Wong (Web lead, onboarding a repo) | `factory.onboarder` at team `web` | none on `payments` | onboarding requests that name team `web` only; not used here |
| `nf` | Nora Field (Auditor) | `factory.auditor` | none | reading everything (view level V3); decides nothing |
| `tb` | Tom Becker (Viewer guest) | `project.viewer` on `payments`, expires 90 days after the seed ran | none | checking what a read-only guest sees |

To sign in as someone else, sign out and pick another account. A step-up (cards 2 and 5, G5) sends you back to the
same page: pick the **same** person again.

---

## 4. Create the GitHub Apps

The factory talks to GitHub only through Apps that it holds keys for. Each App does one kind of thing, so that one
leaked key never gives two powers (`platform/compose/README.md`, the `gate-check` and `gate-relay` sections). The
factory polls; it uses no webhooks ("Polling, no webhooks", `packages/loops/src/code-host-polls.ts:9`).

These settings apply to every App below:

- GitHub: your avatar › Settings › Developer settings › GitHub Apps › **New GitHub App**.
- Webhook: clear **Active**. No events are needed.
- "Where can this GitHub App be installed?": **Only on this account**.
- Permissions: exactly the ones listed. Leave everything else at **No access**. The factory refuses `administration`
  and `workflows` at any level, and `statuses` too (DEC-7). It also refuses any `admin` level
  (`GITHUB_FORBIDDEN_PERMS`, `packages/contracts/src/entities/codehost.ts:47`). If the installation holds
  `administration` or `workflows`, M4 is blocked entirely (B4a, `packages/ports/src/b4.ts`).
- After you create the App: **Generate a private key** downloads a `.pem` file. Note the **App ID**, a number (not
  the Client ID).
- Install the App: **Install App** › your account › **Only select repositories** › your testbed repository only. The
  installation id is the number at the end of the installation page's URL (`/installations/<number>`).
- Every key goes into `platform/compose/secrets/` with mode 600. Never commit it or paste it anywhere.

| Role | Needed for a first run? | Permissions (from the code) | Key file | Settings |
| --- | --- | --- | --- | --- |
| **read** (codehost, Census) | **yes** | Contents: Read, Metadata: Read. Tokens are minted per role from `CODEHOST_ROLE_PERMISSIONS` (`packages/contracts/src/entities/codehost.ts:95-100`): `hub` = contents read and metadata read (`:96`), `posture` = metadata read (`:97`) | `secrets/github-app.pem` (mounted in `codehost` only) | `GITHUB_APP_ID`, `GITHUB_INSTALLATION_ID` in `.env` (written by `init-secrets --real-github`); compose passes them to the seed's registry row (`SEED_GITHUB_*`) |
| **push** (Push Broker) | no. **Available after `build/e2e-pr` lands** | the `docs` role: Contents: Read and write, Pull requests: Read and write, Metadata: Read (`codehost.ts:98`). It writes only the `agent/<item>/<unit>` branch and a draft PR (`PUSH_ALLOW_LIST`, `services/codehost/src/allow-list.ts:123`) | on `main` the Push Broker is the codehost in `CODEHOST_MODE=push`, and it mints `docs` tokens from the **same** App key, `secrets/github-app.pem` (`services/codehost/src/token-broker.ts:109-111`). Whether it gets its own App is settled on `build/e2e-pr` | `CODEHOST_MODE=push` and `CORE_WORKER_PUSH_BROKER=1` are not in `docker-compose.yml` on `main`. gate-check recognises agent PRs by `GATE_CHECK_PUSH_BROKER_LOGIN` (default `aisdlc[bot]`; set it to your App's `<slug>[bot]`) |
| **gate-check** | no (profile `gate-check`) | Checks: Read and write, Pull requests: Read, Metadata: Read (`GATE_CHECK_APP_PERMISSIONS`, `packages/contracts/src/entities/gate-check.ts:24`) | `secrets/gate-check-app.pem` | `GATE_CHECK_APP_ID`, `GATE_CHECK_INSTALLATION_ID` in `.env` |
| **gate-relay** | no (profile `gate-relay`) | Deployments: Read and write, Metadata: Read (`GATE_RELAY_APP_PERMISSIONS`, `packages/contracts/src/entities/gate-relay.ts:23`) | `secrets/gate-relay-app.pem` | `GATE_RELAY_APP_ID`, `GATE_RELAY_INSTALLATION_ID` in `.env`; core follows it only with `CORE_WORKER_RELEASE=gate-relay` |
| **tracker** (gap issues) | no | Issues: Read and write, Metadata: Read (`TRACKER_APP_PERMISSIONS`, `packages/contracts/src/entities/issue-twin.ts:41`) | `secrets/tracker-app.pem` (held by `codehost`, never with the read App's key: `services/codehost/src/config.ts`, `trackerConfigFromEnv`) | `TRACKER_APP_ID`, `TRACKER_INSTALLATION_ID`, `TRACKER_LOGIN` (`<slug>[bot]`) in `.env`. Leave `TRACKER_APP_ID` empty and the `issue_twin` loop does not run |

Why the Apps are separate:

- **read** reads only. In Census mode the codehost refuses to mint any token that writes
  (`services/codehost/src/token-broker.ts:109-111`).
- **push** writes only the `agent/*` branch and its draft PR. No allow-list row exists for a merge, a review, a
  status, a check or a ruleset.
- **gate-check** writes only the check run `aisdlc/gate`. In the codehost, one leaked key would give both pushing and
  passing the check.
- **gate-relay** writes only deployments of a merged commit after an approved G5.
- **tracker** can only file issues for approved onboarding gaps. The tracker comment in `issue-twin.ts` says neither
  the Push Broker nor gate-check can write an issue.

### 4.1 Put the read App's key in place and switch to real GitHub

1. Stop and remove the fake-GitHub stack from section 2. Its database holds the fake repository's record:

   ```bash
   docker compose --profile fake-github down -v
   ```

2. Remove the throwaway key from a fake-GitHub run, if you did one. `init-secrets --real-github` removes it by
   itself only when it is still the exact key it generated, and keeps a key you copied over it, but removing it
   yourself makes the state obvious:

   ```bash
   rm -f secrets/github-app.pem secrets/github-app.pub.pem secrets/.github-app-fake
   ```

3. Move the downloaded key into place:

   ```bash
   mv ~/Downloads/<your-app>.private-key.pem secrets/github-app.pem
   ```

4. Lock it down:

   ```bash
   chmod 600 secrets/github-app.pem
   ```

5. Put your GitHub login in alice's `"logins"` in `config/idp-seed.json`, in place of `reshif`. Do this before the
   first start: the seed syncs the file once. The role map proposed on card 4 maps CODEOWNERS and collaborators to
   people through these logins.

6. Write the real settings into `.env`:

   ```bash
   GITHUB_APP_ID=<App ID> GITHUB_INSTALLATION_ID=<installation id> ./init-secrets --real-github
   ```

   The line should end `GitHub App key: real`. `.env` now has your ids and empty GitHub URLs, so the codehost uses
   `api.github.com` and `github.com`. The gate-check and gate-relay ids are `REPLACE_ME` until you set them. They are
   only read when their profiles are on.

7. Start without the fake profile:

   ```bash
   docker compose up -d --wait
   ```

   `./live-census.sh` (without `--fake-github`) does the same and then runs the Census checks; it passes the fake
   profile only on a dry run.

### 4.2 Optional Apps

- **gate-check:** put its key at `secrets/gate-check-app.pem` (chmod 600), set `GATE_CHECK_APP_ID` and
  `GATE_CHECK_INSTALLATION_ID` in `.env`, then start it with
  `docker compose --profile gate-check up -d --wait`. Then, on GitHub, make the `aisdlc/gate` check run from that
  App a required check on the default branch. The factory never changes branch protection, and today it does not
  check that you did this (`docs/readiness-challenge.md`, RC-E2E-8).
- **gate-relay:** put its key at `secrets/gate-relay-app.pem` and set its ids, then start it with
  `export CORE_WORKER_RELEASE=gate-relay` and `docker compose --profile gate-relay up -d --wait`. The project also
  needs a release target: card 4 › Release, or Project › Settings › Release (G5).
- **tracker:** put its key at `secrets/tracker-app.pem`, set `TRACKER_APP_ID`, `TRACKER_INSTALLATION_ID` and
  `TRACKER_LOGIN`, then run `docker compose up -d --wait` again.

`init-secrets` writes a throwaway key for each of these three Apps when none exists. A real key you copy over it is
never overwritten.

---

## 5. Add the Anthropic key

The key lives in one file, `platform/compose/secrets/anthropic-api-key`. Only the `gateway` container mounts it, at
`/run/secrets/anthropic-api-key`. The configuration refers to it only as the reference
`file:/run/secrets/anthropic-api-key`:

- the seed's registry row `anthropic` (`services/core/src/seed.ts`, `localIntegrationRegistry`);
- the gateway's allow-list of key files, `GATEWAY_SECRET_REFS` (`docker-compose.yml`), next to
  `GATEWAY_EGRESS_HOSTS: ["api.anthropic.com"]`.

Never type the key into the portal, a config revision, `.env` or a commit. The secret scanner and the registry accept
only references.

1. Read the key without echoing it or saving it in your shell history:

   ```bash
   read -rs ANTHROPIC_API_KEY
   ```

2. Export it so that `init-secrets` can see it:

   ```bash
   export ANTHROPIC_API_KEY
   ```

3. Write it into the file. This replaces the placeholder:

   ```bash
   ./init-secrets
   ```

   The line should now end `Anthropic key: set`.

4. Clear it from the shell:

   ```bash
   unset ANTHROPIC_API_KEY
   ```

5. Restart the gateway so it reads the file:

   ```bash
   docker compose restart gateway
   ```

6. **Set a call ceiling first.** `GATEWAY_MAX_PROVIDER_CALLS` is the per-process hard limit on vendor calls (default
   1000). Over it, every call is refused with `spend_guard`. Pick a low number for a first run, then recreate the
   gateway:

   ```bash
   export GATEWAY_MAX_PROVIDER_CALLS=200
   ```

   ```bash
   docker compose up -d --wait gateway
   ```

7. **Point the routes at Claude.** This is a factory configuration revision with its M1 gate:

   1. Sign in as `lt`. Open **Quality › Models** (`/models`): the Anthropic models `claude-opus-5-5`,
      `claude-sonnet-5-5` and `claude-haiku-5-5` are registered, and every route says `fake-model`.
   2. Press **Open in Configuration** next to Routes (`/config/gateway.routes`). In the draft, change `model_id` from
      `fake-model` to `claude-sonnet-5-5` on the `local` rows for D0, D1 and D2. Every agent contract allows Sonnet
      (`packages/agents/src/spec-data.ts`). If you do not want D2 data sent to the vendor, leave the D2 row on
      `fake-model`; D2 calls then get canned answers. D3 never has a route.
   3. Press **Propose this change**. Nothing changes yet: the toast names the M1 gate.
   4. Sign out, sign in as `oh`, open the pending revision from that key's page or from **Inbox**, press **I have read
      the changes**, then **Approve**. Approving publishes it, and the gateway follows the new revision.
   5. The `anthropic` row in `integrations.registry` (`/integrations`) is already `enabled`. You do not need an
      `integrations.installs` row: an install can only narrow a project's models.

8. **Check that it works.** Sign in as `lt` and open **Ask the factory** (`/ask`). The assistant calls the gateway
   under its own key. A real model answers in prose; before the change, the fake provider answered with canned text.
   Then:

   ```bash
   docker compose logs --tail 50 gateway
   ```

   A refused key or a broken route shows a refusal code such as `route_broken` or `no_route`. The Integrations tile
   for Anthropic reads `unknown` (`no_recent_call`) until the first call.

9. **Budgets.**
   - Each agent run has a fixed budget in its contract (`packages/agents/src/spec-data.ts`), and S5 builds each Unit's
     envelope from it. These cannot be changed in the portal (RC-CFG-2).
   - Cap any one Unit with **Project › Settings › Default envelope** (`project.default_envelope`: `max_tokens`,
     `max_cost_micro_usd`; 1 USD = 1,000,000), and the number of Units at once with **WIP limit**.
   - The model prices in `gateway.models` are placeholders "to be reviewed before any real spend"
     (`services/core/src/seed.ts`). Review them on `/config/gateway.models`.
   - There is no fleet-wide or project-wide spend ceiling yet (RC-LIVE-2). Also set a spend limit on the Anthropic
     side.

---

## 6. Onboard your repository

You need the stack from step 4.1 running against real GitHub, with the read App installed on the testbed.

### 6.1 Census (read only)

At Census the factory reads the repository; people do the work. Every request is routed to L8, human-led. The
step-by-step runbook is `docs/runbooks/m8.5-live-census.md`, and its card answers apply here. In short:

1. Sign in as **alice**. Open **Onboard a repo** (`/onboard`). Enter the owner, the name, project slug **`payments`**
   (so the persona role map applies) and level **Census**. Press **Request onboarding**. You land on the S0 page
   (`/s0/<id>`). Within a minute or two it waits for card 1. "0.1 waiting: App not installed" means the App is not
   installed on this repository, or the installation id is wrong.
2. **Inbox › Card 1** (gaps, tier, regulatory, criticality): choose **Fix later** for each gap (or **Fix now** where
   that is the only choice), **T0** with "no prod, no real data, no dependants", tick the regulatory and criticality
   statements, then **Approve card 1**.
3. **Card 4** (settings and who does what):
   - No control should read **Not met**. Fix it on GitHub, then press **Re-check**.
   - Tick only what you have checked on GitHub.
   - Answer the GitHub plan question truthfully. "I do not know" leaves gap RS-ID-4 open, and the record cannot be
     signed.
   - Fill **Who can do what** from `personaRoleMap('payments')`, and add `alice` to `admin` and `m4` so that you can
     finish card 5 as the same person. Separate ids with commas:

     | Slot | Person ids |
     | --- | --- |
     | admin | `alice, rb` |
     | requesters | `pm, dn` |
     | intent | `ar, pm` |
     | design | `rb, ar` |
     | g4 | clear "the code owners on GitHub review merges" and enter `ar`, or leave it ticked if your CODEOWNERS names your login |
     | g5 | `pm` |
     | x | `jm` |
     | sec | `ks` |
     | m4 | `alice, rb, pm` |
     | kill | `rb` |

   - Turn the **two-person rule off**. T0 allows it, and otherwise every slot with two people needs a second
     approval.
   - Leave the gating profile, release and kill delegations as they are, then **Approve card 4**.
4. **Settings revision.** On the S0 page, open **Decide the settings revision** and **Approve and publish these
   settings**. Card 5 opens only after this is published and identity has bound the role map.
5. **Card 5.** Tick "I have read this readiness record", press **Confirm my identity**, pick **alice** again on the
   sign-in page, tick the box again, then press **Sign off and approve M4**.
6. **Project › Readiness** (`/projects/payments/readiness`) should say **active**, level **census**.
7. Optional: produce the report (requests sent to GitHub, the App's permissions, S0 and readiness status,
   `verify-ledger`). It ends with `live-census: PASS`:

   ```bash
   ./live-census.sh --report
   ```

If card 5 never opens, `docker compose logs core` shows the refusal, for example `blocking_gap_open` or
`risk_unattested`.

### 6.2 Light (agents may do small work, L1 to L3)

On `main`, no script runs Light end to end in compose. The steps below are what the code requires. Expect to need
help with them.

Light adds **card 2**, decided by the admin slot with a step-up:

- each claim about the repository: affirm, correct (say what is true) or unknown;
- the intent and practices questions, and the practices attestation;
- the review of `AGENTS.md` and `CLAUDE.md` against the factory template (`AGENTS.md` must be affirmable);
- the **Light floors**. LF3, "the repository's own setup and tests ran once, in the sandbox, and passed", must be
  met, and cannot be waived. LF4 is the isolation test for the worker image. LF8 is the package-mirror needs.

Ask for Light either as a first onboarding (pick **Light** on `/onboard`) or, after a Census sign-off, from the
project's drift page (`/projects/payments/drift` › **Request Light**). A level-up re-runs 0.1 and every card of the
new level.

LF3 needs the onboarding **probe**: a K-exec sandbox session. It runs only when **all** of the following hold. Any
one missing, and nothing runs: the probe records `no_image`, `not_allowed`, `b1_blocked` or `no_test_command`, and
LF3 stays unknown (`services/core/src/cards/probe.ts`).

1. Build the plain sandbox image (from the repository root):

   ```bash
   docker build -t aisdlc/sandbox:local platform/sandbox
   ```

2. Build the onboarding probe image. The script prints the image digest (`sha256:...`):

   ```bash
   platform/sandbox/onboarding/build.sh
   ```

3. Note the lock's sha256 (the first field):

   ```bash
   sha256sum platform/sandbox/onboarding/pins.json
   ```

4. Make a scratch directory that the sandboxes can use (the default path is `SANDBOX_SCRATCH`):

   ```bash
   sudo mkdir -p /var/lib/aisdlc/sandbox-scratch
   ```

   ```bash
   sudo chmod 1777 /var/lib/aisdlc/sandbox-scratch
   ```

5. In the same shell as the stack, allow the probe image, give the Docker proxies the socket's group, and point
   core-worker at the sandbox-controller:

   ```bash
   export SANDBOX_ONBOARDING_IMAGE=sha256:<digest from step 2>
   ```

   ```bash
   export DOCKER_GID="$(stat -c %g /var/run/docker.sock)"
   ```

   ```bash
   export CORE_WORKER_SANDBOX_CONTROLLER_URL=http://sandbox-controller:8430
   ```

6. Start the sandbox plane: the two Docker socket proxies, the package mirror, the sandbox-controller and verify:

   ```bash
   docker compose --profile sandbox up -d --wait
   ```

7. Publish two factory configuration revisions, each proposed by `lt` on `/config/<key>` and approved by `oh`:
   - `sandbox.exec_allowed_repos`: `["<owner>/<repo>"]`. DEC-18: only repositories you own. The default is `[]`, and
     a repository not on the list runs nothing.
   - `onboarding.sandbox_image`: `{"image": "sha256:<digest>", "lock_sha256": "<sha256 of pins.json>"}`. The default
     is `null`, so no probe runs.

8. LF4 also needs `onboarding.light_tests.worker_image` set to the W image's digest (step 6.4). It also needs an
   SP-STD-1 isolation report for that exact image, produced by `services/coding-runner/test/isolation.test.ts` and
   posted by an operator to core's `POST /v1/onboarding/spikes` (`services/core/src/cards/spikes.ts`). The portal
   has no button for this.

### 6.3 The role map later

Change who holds a slot on **Project › Settings › Who decides** (`/projects/payments/settings`). That is a project
revision decided by the admin slot. Granting roles from **Admin › People / Roles** is **available after
`build/p1-roles` lands**.

### 6.4 What coding (S6) needs, and why it refuses without it

Agent coding runs in a W sandbox: the `aisdlc/sandbox-agent:local` image, with the Claude Agent SDK harness and the
Unit's gateway key. It is fail-closed:

- **A repository not on `sandbox.exec_allowed_repos`** is BLOCKED with `exec_not_allowed`, never run silently
  (`packages/contracts/src/entities/sandbox.ts`, DEC-18).
- **An open secret finding** on the repository blocks the P, W, O, V and K-exec classes (`b1_blocked`).
- **Over the cap** (`sandbox.caps`: total 4, coding 1), the controller answers `busy`. Admission waits; nothing
  queues in the sandbox.
- **With no kill switch reachable**, no agent work is admitted at all.

To build the W image (needs `npm ci` first, from the repository root):

```bash
npm ci
```

```bash
platform/sandbox/build-agent.sh
```

It prints `built aisdlc/sandbox-agent:local (runner <sha256>)`. The rest of the wiring is **available after
`build/e2e-pr` lands**. On `main`, compose sets none of `CORE_WORKER_PUSH_BROKER`, `CORE_WORKER_SESSION_STORE` or
`CORE_WORKER_CODER_MODEL`, and has no codehost in `CODEHOST_MODE=push` (RC-E2E-2).

---

## 7. Submit your first request and follow it

### 7.1 Ask for work

1. Sign in as **`dn`**, a requester on `payments`. Do not use someone who decides G0: they may not decide their own
   request.
2. Open **Ask for work** (`/ask-for-work/payments`). Choose the repository, describe the change in a few
   paragraphs, optionally hint a lane, and send it.
3. The receipt shows the text as the factory keeps it (normalised, taint-marked, with any injection flags), the lane
   it runs as and why, and who decides G0 and G1. On a Census repository an agent lane is not open (reason
   `level_too_low`), so the request runs as L8: "a person does the work, the factory checks it". The compose e2e asks
   for L4 on a Census project and gets L8. With no active readiness record, the request is held (N8).
4. Open the item (`/items/<id>`). S1 runs with the planning agents: the fake model, or Claude if you did section 5.
   If the factory asks questions, answer them there. Press **Say it is ready** (Ready, 1.6). `dn`, `ar`, `pm` and
   `rb` may.

### 7.2 The gates and who decides them

Each gate arrives in the decider's **Inbox** (`/inbox`) and opens as a card (`/cards/<id>`). Its slot is fixed by
`GATE_POLICIES`:

| Gate | When | Slot (on `payments`) |
| --- | --- | --- |
| G0, G1 (intent) | after 1.6, every lane | intent: `ar` or `pm` (not the requester) |
| G2 (spec and oracles) | L1 to L6, after S3 | intent |
| G3d, G3, G3s (design, plan, skeleton) | where S4 and S5 run and the gating profile keeps them on | design: `rb` or `ar` |
| G3o, X1, X3 (oracle deviation, irreversible operation, new package) | raised in S6 | G3o design; X1, X3 `jm` |
| E6, X2, E2 (locked test, protected path, constitution) | raised in S7 | `jm` |
| Q1, SECT (security) | when S7 quarantines or a security card opens | `ks` |
| **G4** (merge review) | after 7.6, **every lane, always** | g4: `ar` (or your code owners) |
| G5 (release, step-up) | when the project releases | `pm` |
| G6 (acceptance) | after S9's 9.2 | requesters: `dn` may accept his own |
| X4 (break-glass review) | after a bypass or unauthorised merge | `jm` |

**On a Census repository (L8)** the route is: G0 and G1, then a developer does the work and records it on the item
page (**I have done the work (D5)**, with a PR number or a commit). Then S7 runs (on fakes unless verify is wired),
then G4, then G6. The factory pushing the developer's change as an `agent/*` PR is not built (RC-E2E-3). A person's
own PR never passes `aisdlc/gate`; gate-check marks it `action_required` (`gate-check.ts`, `GateCheckProfile`).

**On a Light repository (L1 to L3)**, **available after `build/e2e-pr` lands**: S6 codes in the W sandbox, and the
Push Broker writes the branch `agent/<item>/<unit>` and a **draft pull request** on your repository, authored by the
App's bot. S7 checks exactly that head. 7.6 signs the Evidence Pack. gate-check passes `aisdlc/gate` only for a pack
signed for that head. `ar` decides G4 in the portal.

**Who merges:** a person, on GitHub, as with any other PR. The factory has no merge verb. gate-check records each
merge:

- `merge_gated`: merged after `aisdlc/gate` passed;
- `bypass_merge`: merged by someone on `codehost.merge_bypass`;
- `unauthorised_merge`: merged by anyone else.

The last two open an X4 review for `jm`. After the merge, S8b releases (gate-relay, or the fake by default; G5 if
the project releases), `dn` accepts at G6, and the close-out is at `/items/<id>/closeout`.

### 7.3 Evidence and the ledger

- **The item's Verify tab** (`/items/<id>`) shows the S7 checks. **The Evidence Pack viewer**
  (`/items/<id>/evidence`) shows the signed pack. The bff re-hashes the stored bytes against their object key.
- **Project › Ledger** (`/projects/payments/ledger`, needs `audit.read`) lists every decision with its ledger entry.
  The fleet ledger is at `/ledger`.
- **Check the whole ledger offline** with the Notary's and the Witness's public keys. The script waits for a
  checkpoint that covers the head; checkpoints are every 5 minutes unless `CHECKPOINT_INTERVAL_MS` is set before
  `up`:

  ```bash
  ./verify-ledger.sh --wait 420
  ```

  You should see `ledger OK: <n> entries, chain intact, every Notary signature valid` and `checkpoints OK: ...`.

---

## 8. When something goes wrong

### Stop agent work

- **From the portal:** use **Operate › Controls** (`/controls`) to put a hold on a project or lane (preview, then
  apply). **Operate › Kill switch** (`/kill`) shows the kill journal but cannot request or release a kill yet
  (RC-UI-1).
- **At the kill switch itself** (works even when core is down). This uses the operator token. The kill switch's
  factory admins are `alice` and `bob` (`KILLSWITCH_FACTORY_ADMINS`). The project admins and kill holders (`rb`
  here) are pushed to it by core-worker. To kill project `payments`:

  ```bash
  docker compose exec -T -e TOKEN="$(cat secrets/tok-operator-killswitch)" killswitch node -e 'const r = await fetch("http://127.0.0.1:8400/v1/kills", { method: "POST", headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ on_behalf_of: "alice", scope: { kind: "project", ref: "payments" }, reason: "stop agent work" }) }); console.log(r.status, await r.text());'
  ```

  You should see `201` and the kill with its `kill_id`. To release it, approve as `alice` and then, while it says
  `release_pending`, as `bob` (two people):

  ```bash
  docker compose exec -T -e TOKEN="$(cat secrets/tok-operator-killswitch)" killswitch node -e 'const r = await fetch("http://127.0.0.1:8400/v1/kills/<kill_id>/release", { method: "POST", headers: { authorization: `Bearer ${process.env.TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ on_behalf_of: "alice" }) }); console.log(r.status, await r.text());'
  ```

  A kill stops agent work, not people: gates can still be decided. An unreachable kill switch counts as a kill. The
  drill is `docs/runbooks/drill-killswitch.md`.

### Handoffs

When the agent cannot go on, the item is handed to a person. The item page's handoff panel shows why: the trigger
and the Handoff Pack by hash. `jm` approves E4, and then a choice is offered: answer and resume, or a developer takes
it.

- D1: from S6.
- D2: from S7.
- D3: from G4.
- D4: hand back once.
- D5: the developer says done.

Common triggers (`TRIGGER_DESCRIPTIONS`, `packages/contracts/src/flow.ts`):

- ET1: budget spent; the gateway refuses with `budget_exhausted`.
- ET3: three failed repair rounds.
- ET8: the agent gave up, or its output stayed invalid after the retries.
- ET10: misbehaviour; tripwires and quarantine.

### Messages and what they mean

| You see | It means | Do |
| --- | --- | --- |
| "0.1 waiting: App not installed" | the read App is not installed on this repository, or `GITHUB_INSTALLATION_ID` is wrong | fix the installation, `docker compose down`, fix `.env`, start again |
| `blocking_gap_open`, `risk_unattested` (core log) | card 5 is blocked by a gap or a missing attestation | go back to cards 1 and 4 |
| "You do not hold the role that decides this card" | you are not in the gate's slot | sign in as the slot holder (section 3) |
| "Your identity confirmation is missing, used up or not for this record" | the step-up is missing or stale | press Confirm my identity again |
| "This decision form was used or has timed out" / "What you were shown has changed" | nonce expired, or the card moved on; nothing was decided | reload and decide again |
| receipt: routed to L8, `level_too_low` | the repository's level does not open the lane | onboard at a higher level, or let a person do it |
| receipt: held (N8), `no_active_prr` | no active readiness record | finish onboarding |
| gateway `no_route`, `route_broken`, `model_not_allowed` | the routing table has no usable model for that data class | fix `gateway.routes` or `gateway.models` |
| gateway `spend_guard` | `GATEWAY_MAX_PROVIDER_CALLS` was reached | raise it on purpose, then recreate the gateway |
| gateway `killed`, `kill_switch_unreachable`; red banner "Kill switch unreachable: treated as killed" | a kill covers the work, or the kill switch is down | `docker compose logs killswitch core-worker` |
| probe `no_image`, `not_allowed`, `no_test_command`, `b1_blocked` | LF3 cannot be met yet | section 6.2 |
| BLOCKED `exec_not_allowed` | the repository is not on `sandbox.exec_allowed_repos` | section 6.2, step 7 |
| `aisdlc/gate` `pending` or `action_required` | no passing signed pack for this head, or a person's PR | see 7.2 |

### Logs

All services log to Docker:

```bash
docker compose logs --tail 200 core core-worker
```

The codehost logs one JSON line per GitHub request (`codehost: ghreq {...}`), with no tokens or headers:

```bash
docker compose logs codehost
```

The Notary, kill switch and Postgres drills are in `docs/runbooks/`.

---

## 9. What is not ready yet

The independent review `docs/readiness-challenge.md` lists the full set with evidence. The items that matter for a
first run:

- **No request has gone end to end to a merged PR** on any deployment. S6 to S9 run on fakes in compose (RC-E2E-2).
  **Available after `build/e2e-pr` lands.**
- **L8 carries no code.** D5 takes a PR number or a commit, but nothing pushes a person's change as an `agent/*` PR
  (RC-E2E-3).
- **Agent lanes need Light**, and Light needs container execution, which DEC-18 allows only for repositories you
  own. A real team's repository reaches Census at most until a stronger sandbox (a microVM driver) and a new
  decision exist (RC-E2E-4).
- **No real model has done the work yet.** Prompts, contracts and costs are untested against Claude (RC-E2E-5).
  Evals gate nothing yet (RC-LIVE-3).
- **Nothing has run against real GitHub yet**, beyond what the M8.5 kit checks (RC-E2E-6).
- **Nothing checks that `aisdlc/gate` is a required check** (RC-E2E-8).
- **Release is fake by default** (RC-E2E-9).
- **There is one coding session for the whole factory** (RC-E2E-10).
- **The kill switch has no portal controls**; kills use the operator token (RC-UI-1, RC-SEC-3).
- **There is no fleet or project spend ceiling** (RC-LIVE-2).
- **Per-agent models and budgets are not configurable** (RC-CFG-2).
- **The local stack stubs** key custody (`kms-local`), the identity provider (`dev-oidc`) and the first admin (the
  seed). See the table in `platform/compose/README.md`, "What local-prod stubs". There is no backup or restore drill
  and no production deployment (RC-SEC-1, RC-SEC-2, RC-OPS-1, RC-OPS-2).

RC-E2E-1 (no request form) predates the **Ask for work** page now on `main`.

**Real production needs two decisions from you first:**

1. **The deployment target:** where the factory runs, with real key custody, identity provider and database
   (RC-CFG-3, RC-OPS-2; the cloud column of the README's stub table).
2. **Which repositories agents may run code on:** DEC-18 today is "repositories I own". Widening it needs the
   stronger sandbox and SEC-OB-3 evidence for every class (RC-E2E-4).
