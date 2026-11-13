# AISDLC: everyday commands. `make` (or `make help`) lists them.
#
# Every target wraps a command the repo already has (npm scripts, platform/compose scripts, docker compose), so the
# behaviour and its documentation stay in one place: docs/getting-started.md and platform/compose/README.md.
#
# Variables you can set on the command line, e.g. `make up GITHUB=real`:
#   GITHUB=fake|real      which GitHub the stack talks to (default fake: the in-repo fake GitHub)
#   PROJECT=aisdlc        the compose project name (COMPOSE_PROJECT_NAME)
#   REPO=owner/name       for `up-full`: the one repository agents may run code on (DEC-18: one you own)
#   TAG=local             for `images` and `up-full`: the tag of the four images (AISDLC_IMAGE_TAG)
#   RUNTIME_IMAGE=...  EXTRA_CA=/path/ca.pem  BUILD_PROXY=1  BUILD_NETWORK=host
#                         for `images`, behind a proxy or without apt (platform/compose/build-images.sh)
#   PROFILES=...          extra compose profiles, e.g. PROFILES="gate-check notifier"
#   SERVICE=core          for `logs`, `restart`, `shell`
#   DIR=./backups/x       for `backup` and `restore`
#   NAME=anthropic-api-key  FILE=/path/key.pem
#                         for `secret`: which key to put into Vault (and, for a multi-line value, the file it is in)
#   REMOTE=1              for `clean-branches`: also delete the merged branches on GitHub (needs `gh auth login`)

SHELL := bash
.SHELLFLAGS := -eu -o pipefail -c
.DEFAULT_GOAL := help

COMPOSE_DIR := platform/compose
GITHUB ?= fake
PROJECT ?= aisdlc
PROFILES ?=
SERVICE ?=
DIR ?=
NAME ?=
FILE ?=
REMOTE ?=
GITHUB_APP_ID ?=
GITHUB_INSTALLATION_ID ?=
REPO ?=
TAG ?= local
RUNTIME_IMAGE ?=
EXTRA_CA ?=
BUILD_PROXY ?=
BUILD_NETWORK ?=

ifeq ($(GITHUB),fake)
  GITHUB_PROFILE := --profile fake-github
else ifeq ($(GITHUB),real)
  GITHUB_PROFILE :=
else
  $(error GITHUB must be fake or real, not '$(GITHUB)')
endif

PROFILE_FLAGS := $(GITHUB_PROFILE) $(foreach p,$(PROFILES),--profile $(p))
# `down`, `ps` and `logs` see every profile, so nothing an earlier run started is left out
ALL_PROFILES := --profile fake-github --profile full --profile gate-check --profile gate-relay --profile notifier \
  --profile audit --profile telemetry --profile dev-oidc
DC := cd $(COMPOSE_DIR) && COMPOSE_PROJECT_NAME=$(PROJECT) docker compose
# the sandboxes and session networks this project's two Docker proxies made (labelled with their owner): a session that
# outlived its controller (`down` mid-session) is removed with the stack, never left running
SWEEP := for o in cvw coding; do \
  docker ps -aq --filter label=aisdlc.sandbox=1 --filter label=aisdlc.sandbox.owner=$(PROJECT)-$$o | xargs -r docker rm -f >/dev/null; \
  docker network ls -q --filter label=aisdlc.sandbox=1 --filter label=aisdlc.sandbox.owner=$(PROJECT)-$$o | xargs -r docker network rm >/dev/null; \
  done

.PHONY: help install check check-changed test test-fast lint format typecheck build \
  secrets secrets-real secret secrets-list github-apps images up up-full down reset ps logs restart shell portal \
  verify-ledger smoke e2e e2e-pr demo drill-restore backup restore census clean clean-docker clean-branches

help: ## list the commands
	@echo "AISDLC: make <target> [GITHUB=fake|real] [PROJECT=aisdlc] [REPO=owner/name] [TAG=local] [PROFILES=\"...\"] [SERVICE=...] [DIR=...]"
	@echo
	@awk 'BEGIN {FS = ":.*## "} /^[a-z][a-z0-9-]+:.*## / {printf "  \033[36m%-15s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "Try it on fakes:  make install && make secrets && make up && make portal"
	@echo "Real work:        make install && make images && make github-apps && make up-full REPO=owner/name GITHUB=real"
	@echo "                  then make secret NAME=anthropic-api-key  (keys live in Vault; you are asked for the value)"
	@echo "                  (make up is the light stack: no coding sessions, no PRs; coding needs up-full. docs/getting-started.md)"

## ---- code ---------------------------------------------------------------------------------------------------

install: ## install dependencies from the lockfile (npm ci)
	npm ci

check: ## everything that must pass before a commit (typecheck, lint, format, tests)
	npm run check

check-changed: ## the same over what changed vs origin/main: a fast first pass
	npm run check:changed

test: ## all tests (starts a throwaway Postgres)
	npm test

test-fast: ## all tests except the Docker ones
	npm run test:no-docker

lint: ## ESLint
	npm run lint

format: ## Prettier, writing the fixes
	npm run format

typecheck: ## TypeScript, no emit
	npm run typecheck

build: ## build every package and service bundle
	npm run build

## ---- local factory ------------------------------------------------------------------------------------------

secrets: ## create the local secrets and .env for the fake GitHub (safe to re-run; never overwrites a real key)
	cd $(COMPOSE_DIR) && COMPOSE_PROJECT_NAME=$(PROJECT) ./init-secrets --fake-github

secrets-real: ## switch the secrets and .env to your real GitHub App: make secrets-real GITHUB_APP_ID=.. GITHUB_INSTALLATION_ID=..
	@test -n "$(GITHUB_APP_ID)" && test -n "$(GITHUB_INSTALLATION_ID)" || \
	  { echo "set both: make secrets-real GITHUB_APP_ID=123 GITHUB_INSTALLATION_ID=456"; exit 1; }
	cd $(COMPOSE_DIR) && COMPOSE_PROJECT_NAME=$(PROJECT) GITHUB_APP_ID="$(GITHUB_APP_ID)" GITHUB_INSTALLATION_ID="$(GITHUB_INSTALLATION_ID)" ./init-secrets --real-github

secret: ## put a key into Vault, the portal's way: make secret NAME=anthropic-api-key [FILE=key.pem] (asks for the value)
	@test -n "$(NAME)" || { echo "name the key: make secret NAME=anthropic-api-key   (make secrets-list shows every name)"; exit 1; }
	@bash $(COMPOSE_DIR)/secret.sh put "$(NAME)" $(if $(FILE),"$(abspath $(FILE))")

secrets-list: ## which keys Vault holds: name, version, who set it (never a value)
	@bash $(COMPOSE_DIR)/secret.sh list

github-apps: ## create the GitHub Apps through GitHub's manifest flow (the setup wizard)
	@test -x $(COMPOSE_DIR)/setup-github-apps || \
	  { echo "platform/compose/setup-github-apps is missing or not executable; create the Apps by hand: docs/getting-started.md section 4.3"; exit 1; }
	cd $(COMPOSE_DIR) && ./setup-github-apps

images: ## build the four images up-full runs: factory, sandbox, W (coding), onboarding probe [TAG= RUNTIME_IMAGE= EXTRA_CA= BUILD_PROXY=1 BUILD_NETWORK=host]
	AISDLC_IMAGE_TAG="$(TAG)" RUNTIME_IMAGE="$(RUNTIME_IMAGE)" EXTRA_CA="$(EXTRA_CA)" BUILD_PROXY="$(BUILD_PROXY)" \
	  BUILD_NETWORK="$(BUILD_NETWORK)" bash $(COMPOSE_DIR)/build-images.sh

up: ## the LIGHT stack: portal, onboarding, the record; no coding sessions and no PRs (that is up-full)
	$(DC) $(PROFILE_FLAGS) up -d --wait
	@$(MAKE) --no-print-directory portal

up-full: ## the full factory for real work on one repo: make up-full REPO=owner/name [GITHUB=real] (needs make images)
	@test -n "$(REPO)" || { echo "name the repository agents may work on: make up-full REPO=owner/name [GITHUB=real]"; exit 1; }
	COMPOSE_PROJECT_NAME=$(PROJECT) AISDLC_IMAGE_TAG="$(TAG)" bash $(COMPOSE_DIR)/up-full.sh --repo "$(REPO)" --github "$(GITHUB)"

down: ## stop the local factory (up or up-full); keeps the database, the ledger and the keys
	$(DC) $(ALL_PROFILES) down --remove-orphans
	@$(SWEEP)

reset: ## stop and DELETE everything: database, ledger, Vault and Keycloak data, up-full's scratch (asks first)
	@[[ "$(PROJECT)" =~ ^[a-z0-9][a-z0-9_-]*$$ ]] || { echo "PROJECT must be a compose project name, not '$(PROJECT)'"; exit 1; }
	@read -r -p "This deletes the record, the ledger and every volume of project '$(PROJECT)'. Type the project name to go on: " a; \
	  [ "$$a" = "$(PROJECT)" ] || { echo "nothing deleted"; exit 1; }
	$(DC) $(ALL_PROFILES) down -v --remove-orphans
	@$(SWEEP)
	rm -rf $(COMPOSE_DIR)/.scratch/$(PROJECT)

ps: ## show every container of the stack and its health
	$(DC) $(ALL_PROFILES) ps -a

logs: ## follow the logs (all, or SERVICE=core)
	$(DC) $(ALL_PROFILES) logs -f --tail=200 $(SERVICE)

restart: ## restart one service: make restart SERVICE=core
	@test -n "$(SERVICE)" || { echo "name the service: make restart SERVICE=core"; exit 1; }
	$(DC) $(ALL_PROFILES) restart $(SERVICE)

shell: ## a shell in one service: make shell SERVICE=core
	@test -n "$(SERVICE)" || { echo "name the service: make shell SERVICE=core"; exit 1; }
	$(DC) $(ALL_PROFILES) exec $(SERVICE) sh

portal: ## print the portal's address and how to sign in (Keycloak)
	@port=$${AISDLC_BFF_PORT:-$$(grep -E '^AISDLC_BFF_PORT=' $(COMPOSE_DIR)/.env 2>/dev/null | cut -d= -f2 || true)}; \
	  idp=$${AISDLC_OIDC_PORT:-$$(grep -E '^AISDLC_OIDC_PORT=' $(COMPOSE_DIR)/.env 2>/dev/null | cut -d= -f2 || true)}; \
	  echo "Portal:   http://localhost:$${port:-8340}"; \
	  echo "Sign-in:  Keycloak at http://keycloak.localhost:$${idp:-8390} (the portal sends you there)"; \
	  echo "  test people (alice, lt, oh, ...): password in $(COMPOSE_DIR)/secrets/keycloak-persona-password"; \
	  echo "  break-glass factory admin 'factory-admin': password in $(COMPOSE_DIR)/secrets/keycloak-factory-admin-password"; \
	  echo "  who is who: docs/getting-started.md section 3"

verify-ledger: ## verify the ledger offline (Notary and Witness signatures)
	cd $(COMPOSE_DIR) && COMPOSE_PROJECT_NAME=$(PROJECT) ./verify-ledger.sh

backup: ## back up the whole stack into DIR (holds secrets: keep it safe)
	@test -n "$(DIR)" || { echo "name the folder: make backup DIR=./backups/$$(date +%Y%m%d-%H%M)"; exit 1; }
	COMPOSE_PROJECT_NAME=$(PROJECT) bash $(COMPOSE_DIR)/backup.sh "$(abspath $(DIR))"

restore: ## restore a backup from DIR onto an empty stack (docs/runbooks/backup-restore.md)
	@test -n "$(DIR)" || { echo "name the folder: make restore DIR=./backups/<name>"; exit 1; }
	cd $(COMPOSE_DIR) && COMPOSE_PROJECT_NAME=$(PROJECT) bash ./restore.sh "$(abspath $(DIR))"

census: ## the live Census run against your real GitHub App (docs/runbooks/m8.5-live-census.md)
	npm run live:census

## ---- checks of the whole stack ------------------------------------------------------------------------------

smoke: ## start a throwaway stack, check every service, remove it
	npm run smoke:compose

e2e: ## onboarding end to end in a real browser, on a throwaway stack
	npm run e2e:compose

e2e-pr: ## a request typed in the portal to a merged PR, every gate in the browser, on a throwaway stack
	npm run e2e:pr

demo: ## the request-to-PR stack on fakes, left running for you to click through (portal on port 8640)
	E2E_UP_ONLY=1 npm run e2e:pr
	@echo "Demo stack up (project aisdlc-e2e-pr): http://127.0.0.1:8640 . Remove it with:"
	@echo "  cd $(COMPOSE_DIR) && COMPOSE_PROJECT_NAME=aisdlc-e2e-pr AISDLC_SUBNET_PREFIX=10.236 docker compose --profile fake-github --profile full down -v"

drill-restore: ## back up, wipe, restore and prove the ledger, read models, packs and kill state survive
	npm run drill:restore

## ---- housekeeping -------------------------------------------------------------------------------------------

clean: ## remove build output (each package's dist/) and tool caches; never secrets, .env, worktrees or a stack's data
	find packages services -mindepth 2 -maxdepth 2 -type d -name dist -exec rm -rf {} +
	rm -rf node_modules/.cache
	@echo "clean: done (make build, or the next typecheck and lint, make them again)"

clean-docker: ## free disk: dangling images and the build cache (keeps every stack, its volumes and tagged images)
	docker image prune -f
	docker builder prune -f
	@docker system df

clean-branches: ## delete local branches already merged into main [REMOTE=1: also on GitHub, needs gh auth login]
	git fetch --prune origin
	@cur=$$(git branch --show-current); \
	  git branch --merged origin/main --format='%(refname:short)' | grep -v -x -e main -e "$$cur" | xargs -r git branch -d
	@git worktree prune
	@if [ "$(REMOTE)" = 1 ]; then \
	  command -v gh >/dev/null || { echo "REMOTE=1 needs the GitHub CLI: install gh, then gh auth login"; exit 1; }; \
	  gh auth status >/dev/null 2>&1 || { echo "sign the GitHub CLI in first: gh auth login"; exit 1; }; \
	  gh auth setup-git >/dev/null; \
	  b=$$(git branch -r --merged origin/main | sed 's#^ *origin/##' | grep -v -e '^main$$' -e '^HEAD' || true); \
	  if [ -z "$$b" ]; then echo "no merged branches left on GitHub"; else echo "$$b" | xargs git push origin --delete; fi; \
	else \
	  n=$$(git branch -r --merged origin/main | grep -v -E 'origin/(main|HEAD)' | wc -l); \
	  echo "$$n merged branch(es) still on GitHub: make clean-branches REMOTE=1 deletes them"; \
	fi
