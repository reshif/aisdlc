# Model gateway: HTTP contract (M10)

The gateway (`services/gateway`) is the only process that holds a model-vendor key (RV §2 "Model key custody"). Every model call of the factory goes through it. Sandboxes and the work engine never see a vendor key: a sandbox holds one **virtual key** per Unit, minted by the work engine through the admin API.

Contracts (Zod, `packages/contracts/src/entities/gateway.ts`) are the source of truth for every shape below.

## 1. Credentials

| Who | Credential | Opens |
|---|---|---|
| Sandbox, agent harness | a virtual key `aisk_<48 hex>` | `POST /v1/messages` only |
| Work engine (`core`), operator | a service token with scope `admin` and/or `read` (`Authorization: Bearer`) | `/v1/admin/*` |
| Anyone | none | `GET /healthz` |

A virtual key opens nothing of the admin API, and a service token is not a virtual key. The secret of a virtual key is returned **once**, at mint; only its sha256 is stored. A vendor key is never in any response, error, log line, record event or table.

## 2. `POST /v1/messages` (Anthropic Messages compatible subset)

To point the Claude Agent SDK (or any Anthropic client) at it:

```
ANTHROPIC_BASE_URL=http://gateway:8410
ANTHROPIC_API_KEY=<the unit's virtual key>        # sent as x-api-key (or as Authorization: Bearer, which the TypeScript SDK 1.x does)
ANTHROPIC_MODEL=<anything>                         # see "model" below
```

Request headers: the key as `x-api-key: <key>` or `Authorization: Bearer <key>`; `content-type: application/json`; optionally `x-aisdlc-data-class: D0|D1|D2|D3` (default: the key's `data_class_max`). `anthropic-version` is accepted and ignored.

Request body (anything else is ignored, never forwarded):

| Field | Notes |
|---|---|
| `model` | **Advisory.** The gateway serves the model its route names for `(environment, data class)`; the response says which. The key's `models` allow-list applies to the routed model |
| `max_tokens` | required; clamped to the routed model's `max_tokens_cap` and to what the key's budget group can still pay for |
| `messages` | `user`/`assistant`; content is a string or blocks `text`, `tool_use`, `tool_result`. **Image and thinking blocks are refused (400)** |
| `system` | string or text blocks (joined) |
| `tools`, `tool_choice` | only tools on the key's allow-list; `tool_choice: {type:"tool", name}` likewise. A `tool_use` in `messages` naming a tool outside it is also refused |
| `temperature`, `stop_sequences` | passed on |
| `stream` | `true` answers with server-sent events (section 2.1). The routed model's provider must stream (`ModelProviderPort.stream`: the Anthropic and OpenAI-compatible adapters do); one that cannot is a 400 `invalid_request` before any byte is sent |

Success: `200`, an Anthropic message: `{id, type:"message", role:"assistant", model, content:[text|tool_use], stop_reason, stop_sequence:null, usage:{input_tokens, output_tokens}}`. `model` is the factory's model id (`gateway.models[].model_id`).

Errors: `{"type":"error","error":{"type":<anthropic type>,"code":<code>,"message":...}}`.

### 2.1 Streaming (`stream: true`)

Every check before the vendor is the same as for a plain call and a refusal is still a JSON error (nothing of a stream has been written yet), so a spent budget is `429 budget_exhausted` and raises ET1 as before. A vendor that fails before its first event is a JSON `502 provider_error`, nothing charged. Otherwise `200 text/event-stream` in the Messages wire format: `message_start`, then per block `content_block_start`, `content_block_delta`s (`text_delta`, or one `input_json_delta` for a tool call), `content_block_stop`, then `message_delta` (stop reason and the final usage) and `message_stop`. The Anthropic TypeScript SDK (and so the Claude Agent SDK, M13) runs against it unchanged (`client.messages.stream(...)`; a test does exactly that).

- **Redaction of the answer.** Streamed text passes through `StreamRedactor`: it holds the last 256 characters (and everything from an unclosed `-----BEGIN` block), scans the whole held buffer with the shared ruleset on every piece, replaces what it finds with `[REDACTED:<rule>]`, and releases only text that cannot still be the start of a secret, cut at whitespace. A secret split across pieces is caught; a secret longer than 64 KiB with no whitespace is the one thing not (bounded memory). Short answers are therefore delivered at the end of their block, not token by token. A tool call's input is held whole, redacted, and sent as one `input_json_delta`. The count is `response_redactions` in the ModelCall event. A non-streaming answer is not redacted on the way back (unchanged from M10.3).
- **Tool allow-list.** A `tool_use` is checked when it starts. Outside the key's list: the vendor call is aborted, nothing of the tool is delivered, an `error` event (`tool_not_allowed_in_response`) ends the stream, and the call is recorded `tool_blocked` and charged for what was produced. Text that came before the tool call has already been delivered.
- **Metering.** The vendor's final usage is what is charged. The call is metered (settled, ModelCall event, ET1 if it ran the budget out) BEFORE the closing `message_delta` and `message_stop` are sent, so a stream that could not be metered ends in an `error` event (`metering_failed`), never a success.
- **Abort.** The client going away, the vendor failing part-way (an `error` event ends the stream), or a malformed stream aborts the vendor call and settles the reservation with what was produced: the vendor's input count if it said, else the estimate; output estimated at one token per three characters received (at least 1, never above the reserved maximum). The ModelCall event is `aborted` (`tool_blocked` for a tool violation). Whatever the redactor still held is dropped, not delivered.

| HTTP | `code` | When |
|---|---|---|
| 401 | `unauthenticated` | no key, malformed or unknown key (not recorded) |
| 401 | `key_revoked`, `key_expired` | |
| 400 | `invalid_request` | bad body, bad data-class header, `stream: true` to a provider that cannot stream |
| 400 | `tools_unsupported` | tools offered to a model that cannot take them |
| 403 | `d3_never_routed` | the call's data class is D3, whatever the key says |
| 403 | `data_class_exceeds_key` | asked class above the key's `data_class_max` |
| 403 | `no_route` | no route for `(environment, data class)` (fail closed) |
| 403 | `model_not_allowed` | the routed model is not on the key's allow-list, or the project's install of the provider is disabled or leaves the model out (section 4) |
| 403 | `tool_not_allowed` | the request names a tool outside the key's allow-list; the request is refused as a whole |
| 403 | `budget_unknown` | the key's budget group is gone |
| 423 | `killed` | the kill switch covers the key's project, lane or session |
| 429 | `budget_exhausted` | the budget group is spent (tokens or cost). First time: ET1 is raised |
| 429, 400, 502 | `provider_error` | the vendor failed (rate limit, refusal, down); nothing is charged |
| 502 | `tool_not_allowed_in_response` | the model asked for a tool outside the allow-list; the output is dropped, the tokens are charged |
| 503 | `spend_guard` | this process made `GATEWAY_MAX_PROVIDER_CALLS` vendor calls |
| 503 | `kill_switch_unreachable` | the kill switch could not be asked (unreachable means killed) |
| 503 | `route_broken` | the route leads to a missing or disabled model or provider, or an adapter the gateway does not hold |
| 503 | `metering_failed` | the call could not be recorded; its output is not delivered (a stream: an `error` event instead of the end) |

Order of checks: key, body, spend guard, kill switch, data class, route, model allow-list, tool allow-list, redaction, budget reservation, vendor call, response tool check, settlement. Every call of a known key is recorded as one `gateway.model_call` record event, refusals included.

## 3. Admin API (`Authorization: Bearer <service token>`)

Errors: `{"error":{"code","message"}}`.

| Method and path | Scope | Body / result |
|---|---|---|
| `POST /v1/admin/budget-groups` | admin | `{group_id, max_tokens, max_cost_micro_usd}` -> `201` (created) or `200` (exists with the same limits; other limits: `400`) -> `BudgetGroupView` |
| `GET /v1/admin/budget-groups/:id` | read | `BudgetGroupView` (`used_*`, `reserved_*`, `exhausted_at`) |
| `POST /v1/admin/vkeys` | admin | `VKeyMint` -> `201 {vkey: VKeyView, key}`; the budget group must exist |
| `GET /v1/admin/vkeys/:id` | read | `VKeyView` (never the secret) |
| `POST /v1/admin/vkeys/:id/revoke` | admin | `VKeyView`; effective on the next call |
| `POST /v1/admin/reload` | admin | `{force?: bool}` -> `{revision, integrations:[{integration_id, adapter, state: built\|refused, detail}]}`: re-reads the published config now and rebuilds the adapters that changed (all of them with `force`, which is how a rotated key file is picked up); reports health straight away. Without it the gateway follows the config by itself (NOTIFY and a poll) |
| `GET /v1/admin/integrations` | read | the same view, without reloading |

`VKeyMint`: `scope {kind: unit|job|session, ref}`, `project_id`, `lane?`, `data_class_max`, `models[]` (factory model ids), `tools[]`, `budget_group`, `expires_at`, `item_id?`, `unit_id?`, `step?` (where ET1 is attributed; default 6.4). The kill switch is asked with `{project_id, lane?, session_id (scope session)}`.

## 4. Routing, budgets, redaction, tools

- **Routes are config** (`gateway.models` and `gateway.routes`, factory layer, published through `config_publish` behind an M1 gate; the providers are rows of the integration registry, section 6). A route is `(environment, data class in D0..D2) -> model_id`; the schema has no D3, and D3 is also refused at call time. The gateway reads the effective config on every call, so a published revision applies from the next call, with no restart. A model must name a `model_provider` integration of the registry and a route a model of the table, or the document is refused when proposed.
- **Install rows narrow, never widen.** A model-provider integration is fleet-wide once enabled. An `IntegrationInstall` row for a project can switch it off for that project (`enabled: false`) or limit its models (`overrides.models_allowed`); no row means the fleet-wide default. (DM §4.1 does not say what an absent install means; this reads it as "no restriction", because the alternative needs one row per project before any key works.)
- **Budgets** are hard stops in tokens and in cost (micro-USD; the price per model is `usd_in_per_mtok`/`usd_out_per_mtok`, which is micro-USD per token). A call reserves `estimated input + clamped output` under the group's row lock, so calls in flight cannot overspend; settlement adds what the vendor reported. Spent (>= 100% of either limit) raises `gateway.budget_exhausted` (ET1) once per group; core turns it into the item's D1 handoff.
- **Redaction**: the shared ruleset (`@aisdlc/secrets-rules`) runs over the system prompt, message text, tool results, tool-call inputs and tool descriptions before anything leaves for the vendor; a found value becomes `[REDACTED:<rule>]` and the count is in the `ModelCall` event.
- **Tool allow-list**: the key's, fixed at mint. A request cannot widen it (text in a prompt changes nothing; naming a tool outside it is a refusal), and a `tool_use` the model returns outside it is dropped.
- **Reservations.** A call's hold on its budget group is a row (`gateway.reservation`: `open`, `settled`, `abandoned`). A recovery sweep (every `GATEWAY_SWEEP_INTERVAL_MS`) settles the rows still open after `GATEWAY_RESERVATION_MAX_AGE_MS` (default 15 minutes: longer than any call) as `abandoned`: the hold is released under the group's row lock and a `gateway.reservation_abandoned` event is recorded. A call that completes after that adds its usage and does not release the hold again, so nothing is counted twice; a call that settled first leaves nothing for the sweep.
- **Record events** (`gateway.*`, no text ever): `model_call` (ids, hashes of the redacted request and of the response content, token counts, cost, latency, outcome `ok|refused|provider_error|tool_blocked|aborted`, redaction counts, `stream`), `budget_exhausted`, `vkey_minted`, `vkey_revoked`, `reservation_abandoned`.

## 5. Configuration (environment)

| Variable | Meaning |
|---|---|
| `GATEWAY_DATABASE_URL` | the record database (`file:`/`env:` reference) **as the least-privilege role `gateway`** (section 7) |
| `GATEWAY_ENVIRONMENT` | `local`, `staging` or `prod`: which routes apply; the `fake` adapter is refused in `prod` |
| `GATEWAY_CALLERS` | `{caller: {token_ref, scopes: [admin, read]}}` |
| `GATEWAY_SECRET_REFS` | JSON array of the secret references (its mounted key files) a registry row may name. Default none |
| `GATEWAY_EGRESS_HOSTS` | JSON array of the hosts a vendor key may be sent to. Default none |
| `GATEWAY_KILLSWITCH_URL`, `GATEWAY_KILLSWITCH_TOKEN_REF` | the kill switch's read API |
| `GATEWAY_MAX_PROVIDER_CALLS` | hard ceiling of vendor calls per process (default 1000) |
| `GATEWAY_RESERVATION_MAX_AGE_MS`, `GATEWAY_SWEEP_INTERVAL_MS` | the sweep's bound (default 900000) and period (60000) |
| `GATEWAY_HEALTH_INTERVAL_MS` | how often it reports integration health (default 30000) |
| `GATEWAY_HOST`, `GATEWAY_PORT` | default `127.0.0.1:8410` |

`GATEWAY_PROVIDER_ADAPTERS` is gone: the providers are registry rows.

## 6. The integration registry (M10.4)

One registry for code hosts and model providers (decided 2026-11-08), as config: `integrations.registry` (Integration rows with their credential REFERENCES and scopes) and `integrations.installs` (a row per project), factory layer, every change an M1 gate and a `config_publish`. A model provider is an Integration of kind `model_provider`; its `integration_id` is its `provider_id`. The gateway builds one adapter per **enabled** row (`anthropic`, `openai_compat`, `fake`) from the effective config:

- the row names the adapter, the non-secret `config` (`base_url`, ...) and a credential reference (`file:/run/secrets/...`); the key is read from that file by the adapter alone, once per build;
- the DEPLOYMENT decides what a row may do: a reference outside `GATEWAY_SECRET_REFS`, or a base URL whose host is outside `GATEWAY_EGRESS_HOSTS`, refuses the row (`secret_ref_not_allowed`, `egress_not_allowed`; also `secret_unreadable`, `config_invalid`, `credential_missing`, `fake_not_allowed`). A published revision can switch providers on and off and point routes at them; it cannot make the gateway read a file it was not given or send a key somewhere new;
- it follows the config by revision (a `ConfigReader` subscription: Postgres NOTIFY plus a 5 s poll) and `POST /v1/admin/reload`; no restart. The gateway's role may not fold the config read model, so it reads what core and core-worker (and every publish) have folded;
- health, in the shared shape (`ok degraded down unknown`, a code, `as_of`), is reported per enabled provider to `integrations.integration_health` every `GATEWAY_HEALTH_INTERVAL_MS`: `down` with the refusal code for a row that could not be built, otherwise from what the calls showed (`ok` after a good call in the last 15 minutes, `down/auth_failed`, `degraded/rate_limited`, `degraded/unavailable`; nothing recent is `unknown`: a vendor is never called to paint a tile). A report older than two minutes reads `unknown` for every reader.

**OpenAI-compatible providers (M10.5).** Codex and DeepSeek are two rows of the one `openai_compat` adapter (`POST {base_url}/chat/completions`, a bearer key, no SDK): `config.base_url` (the version segment included: `https://api.openai.com/v1`, `https://api.deepseek.com`), optional `request_timeout_ms` and `max_tokens_param` (`max_completion_tokens` for models that want it), the models in `gateway.models` (`provider_model` is the vendor's id). Mapping to the Messages vocabulary: `system` is a system message, `tool_use` blocks are `tool_calls`, `tool_result` blocks are `tool` messages, `tool_choice` `any` is `required`, `finish_reason` `stop|length|tool_calls` is `end_turn|max_tokens|tool_use`, usage is `prompt_tokens`/`completion_tokens` (a reply without it is refused: it could not be metered). Streaming uses `stream_options.include_usage`; text is passed on as it arrives, a tool call is assembled per `index` and sent whole at the end.

## 7. The database role

The gateway no longer connects as `aisdlc`. db-init creates the NOLOGIN group role `aisdlc_gateway` and the login role `gateway` (a member); the gateway migration (`0003_gateway_role.sql`) grants the group exactly: SELECT, INSERT, UPDATE on `gateway.*` (never DELETE); SELECT and INSERT on `record.record_event` **of `gateway:%` streams only** (row-level security; never UPDATE, DELETE or TRUNCATE) and SELECT, UPDATE on `record.global_counter` (what an append needs: the head and idempotency reads, the counter lock); SELECT on the view `config.genuine_publish` (the effective-config join with the ledger, done by the view's owner, so no ledger or config table is readable); SELECT, INSERT, UPDATE on `integrations.integration_health`. No DDL: the `migrate` job owns the schema and the gateway no longer migrates at start. `least-privilege.test.ts` applies the whole migration plan and proves that every other table of every other context is refused, and that the record cannot be updated or deleted or forged on another stream.
